"""Scoped Python AST probes for local CBM development captures (Python >=3.9).

No source rewrite, bytecode cache write, dependency execution or value equality
matching. Each invocation owns its scalar binding versions. Unknown heap reads,
opaque calls, suspended execution and unsupported statements are explicit gaps.
"""
import argparse
import ast
import contextvars
import hashlib
import http.client
import importlib.abc
import importlib.machinery
import json
import math
import os
from pathlib import Path
import queue
import runpy
import secrets
import sys
import threading
import types
from urllib.parse import urlsplit

_PENDING = contextvars.ContextVar("cbm_capture_call", default=None)
_EXCLUDED = {".git", ".venv", "venv", "node_modules", "__pycache__", "site-packages"}
_MAX_SOURCE = 4 * 1024 * 1024


def eligible_source(path, root):
    try:
        relative = Path(path).resolve(strict=True).relative_to(Path(root).resolve(strict=True))
        return Path(path).suffix == ".py" and not _EXCLUDED.intersection(relative.parts) and Path(path).stat().st_size <= _MAX_SOURCE
    except (OSError, ValueError):
        return False


class Runtime:
    def __init__(self, sink, *, values_enabled=False, allowed_fields=(), max_events=10000):
        self.sink = sink
        self.values_enabled = values_enabled
        self.allowed_fields = frozenset(allowed_fields)
        if len(self.allowed_fields) > 64 or any(type(f) is not str or not f or "*" in f or len(f.encode()) > 200 or any(ord(c) < 32 for c in f) for f in self.allowed_fields):
            raise ValueError("Use at most 64 exact field names")
        self.max_events = max(1, min(int(max_events), 10000))
        self.sequence = 0
        self.invocation = 0
        self.lock = threading.RLock()
        self.buffer = []
        self.disabled = False

    def emit(self, frame, operation, line, *, inputs=(), access_path=None, value=None, detail=None):
        with self.lock:
            if self.disabled or self.sequence >= self.max_events:
                return None
            self.sequence += 1
            event = {"sequence": self.sequence, "operation": operation,
                     "invocation_id": frame.invocation, "value_id": "v%d" % self.sequence,
                     "inputs": list(dict.fromkeys(i for i in inputs if i))[:64],
                     "source": {"file_path": frame.path, "source_hash": frame.digest,
                                "line": max(1, line)}}
            if len(frame.symbol.encode("utf-8", "replace")) <= 1024:
                event["source"]["symbol"] = frame.symbol
            # Never shorten an identity into a different allowed field name.
            if access_path and len(access_path.encode("utf-8", "replace")) <= 200:
                event["access_path"] = access_path
            if detail:
                event["detail"] = detail[:512]
            if self.sequence == self.max_events:
                event.update(operation="gap", inputs=[], detail="Producer event budget reached; subsequent execution is unobserved.")
            elif self.values_enabled and "access_path" in event and access_path in self.allowed_fields:
                # Exact builtin types only: never inspect properties, repr, str,
                # serializers, iterators, custom numeric types or arbitrary objects.
                if value is None or type(value) is bool:
                    event["preview"] = value
                elif type(value) is int and abs(value) <= 9007199254740991:
                    event["preview"] = value
                elif type(value) is float and math.isfinite(value):
                    event["preview"] = value
                elif type(value) is str:
                    event["preview"] = value.encode("utf-8", "replace")[:256].decode("utf-8", "ignore")
            self.buffer.append(event)
            if len(self.buffer) >= 128:
                self.flush()
            return event["value_id"] if event["operation"] != "gap" else None

    def flush(self):
        with self.lock:
            events, self.buffer = self.buffer, []
            if events:
                try:
                    self.sink(events)
                except Exception:
                    # Probes must not replace an application's result/exception.
                    self.disabled = True

    def frame(self, path, digest, symbol, line, parameters=()):
        with self.lock:
            self.invocation += 1
            invocation = "i%d" % self.invocation
        frame = Frame(self, path, digest, symbol, invocation)
        pending = _PENDING.get()
        code = sys._getframe(1).f_code
        if pending is not None and pending["code"] is code and not pending["consumed"]:
            pending["consumed"] = True
            frame.call = pending
        for name, value in parameters:
            inputs = [frame.call["parameters"].get(name)] if frame.call else []
            frame.bindings[name] = self.emit(frame, "value", line, inputs=inputs, access_path=name, value=value)
        return frame


class Frame:
    def __init__(self, owner, path, digest, symbol, invocation):
        self.owner, self.path, self.digest, self.symbol, self.invocation = owner, path, digest, symbol, invocation
        self.bindings, self.sites, self.primitives = {}, {}, {}
        self.pending_assignments = {}
        self.call = None

    @staticmethod
    def primitive(value):
        return value is None or type(value) in (str, bool, int, float)

    def observe(self, operation, site, line, value, inputs=(), access_path=None):
        if operation == "transform" and not all(self.primitives.get(item, False) for item in inputs):
            self.gap(line, "Overloaded or nonprimitive operation has no builtin scalar transfer proof.")
            operation, inputs = "value", ()
        ids = [self.sites.get(item) for item in inputs]
        self.sites[site] = self.owner.emit(self, operation, line, inputs=ids, access_path=access_path, value=value)
        self.primitives[site] = self.primitive(value)
        return value

    def read(self, site, line, name, value):
        if not self.primitive(value):
            self.gap(line, "Nonprimitive read may invoke user operators; prior scalar assumptions invalidated.")
        self.sites[site] = self.owner.emit(self, "copy", line, inputs=[self.bindings.get(name)], access_path=name, value=value)
        self.primitives[site] = self.primitive(value)
        return value

    def safe_old_binding(self, load):
        # The temporary reference exists only before STORE, while the original
        # binding still owns the object. Never retain it or the loading closure.
        try:
            return self.primitive(load())
        except NameError:
            return True

    def assign(self, site, line, names, value, input_site, old_bindings, publish=True):
        primitive = self.primitive(value)
        safe = publish and primitive and all(self.safe_old_binding(load) for load in old_bindings)
        source = self.sites.get(input_site)
        if not primitive:
            self.gap(line, "Nonprimitive assignment has no object-state transfer proof.")
            source = None
        if not safe:
            # This event is the evaluated RHS supplied to the syntax, never a
            # post-STORE binding. Finalization may replace or delete the target.
            if primitive:
                for name in names:
                    self.owner.emit(self, "copy", line, inputs=[source], access_path=name,
                                    value=value, detail="Assignment RHS; destination retention is unverified.")
            self.gap(line, "STORE may release an unknown object or evaluate an annotation; binding effects are unverified.")
        # Keep only proven builtin primitives for optional post-STORE previews.
        # Never hold an object across STORE, reload a target after STORE, or
        # compare values to infer retention. The assignment remains unchanged.
        self.pending_assignments[site] = (names, source, primitive, safe,
                                          value if primitive and safe else None)
        return value

    def assigned(self, site, line):
        pending = self.pending_assignments.pop(site, None)
        if pending is None or not pending[3]:
            self.gap(line, "STORE completed without a lifetime proof; finalizers may have rebound any visible name.")
            return
        names, source, primitive, _, value = pending
        for name in names:
            self.bindings[name] = self.owner.emit(self, "copy", line, inputs=[source],
                                                   access_path=name, value=value)
        self.sites[site] = self.bindings[names[-1]]
        self.primitives[site] = primitive

    def returning(self, site, line, value, input_site):
        if not self.primitive(value):
            self.gap(line, "Object return has no heap-state transfer proof.")
        identifier = self.owner.emit(self, "return", line, inputs=[self.sites.get(input_site)])
        self.sites[site] = identifier
        self.primitives[site] = self.primitive(value)
        if self.call is not None:
            self.call["return"] = identifier
        return value

    def gap(self, line, detail):
        self.bindings.clear()
        self.sites.clear()
        self.primitives.clear()
        self.pending_assignments.clear()
        self.owner.emit(self, "gap", line, detail=detail)

    def opaque(self, site, line, value, detail):
        self.gap(line, detail)
        self.sites[site] = self.owner.emit(self, "value", line)
        self.primitives[site] = self.primitive(value)
        return value

    def field(self, site, line, path, value):
        self.gap(line, "Field/accessor result observed once; prior heap state transport is not proven.")
        self.sites[site] = self.owner.emit(self, "field", line, access_path=path, value=value)
        self.primitives[site] = self.primitive(value)
        return value

    def invoke(self, site, line, function, args, kwargs, arg_sites, kw_sites):
        # Only exact Python function code identity can bind argument -> formal.
        # Name similarity, equal values, wrappers and C extension calls cannot.
        actual = function if type(function) is types.FunctionType else None
        code = actual.__code__ if actual is not None else None
        supported = code is not None and not (code.co_flags & (0x20 | 0x80 | 0x200))
        parameter_ids = {}
        if supported:
            for name, source in zip(code.co_varnames[:code.co_argcount], arg_sites):
                parameter_ids[name] = self.sites.get(source)
            for name, source in kw_sites.items():
                if name in code.co_varnames[:code.co_argcount + code.co_kwonlyargcount]:
                    parameter_ids[name] = self.sites.get(source)
        pending = {"code": code, "parameters": parameter_ids, "consumed": False, "return": None}
        token = _PENDING.set(pending if supported else None)
        try:
            result = function(*args, **kwargs)
        except BaseException:
            self.gap(line, "Call raised; no result value was produced.")
            raise
        finally:
            _PENDING.reset(token)
        # A matching return proves that result, not the absence of side
        # effects in the caller's globals, captured cells or callbacks.
        self.gap(line, "Call may mutate caller-visible bindings; previous versions invalidated.")
        if pending["consumed"] and pending["return"]:
            self.sites[site] = self.owner.emit(self, "call", line, inputs=[pending["return"]])
        else:
            self.gap(line, "Opaque, generator or async call: no argument/return lineage proof.")
            self.sites[site] = self.owner.emit(self, "value", line)
        self.primitives[site] = self.primitive(result)
        return result


runtime = Runtime(lambda events: None)


def _literal(value):
    if isinstance(value, tuple):
        return ast.Tuple(elts=[_literal(item) for item in value], ctx=ast.Load())
    return ast.Constant(value=value)


class Transformer(ast.NodeTransformer):
    def __init__(self, path, digest, helper, frame, symbol="<module>"):
        self.path, self.digest, self.helper, self.frame, self.symbol = path, digest, helper, frame, symbol

    def key(self, node):
        return "%s:%d:%d" % (type(node).__name__, getattr(node, "lineno", 1), getattr(node, "col_offset", 0))

    def call(self, method, args, node):
        return ast.copy_location(ast.Call(func=ast.Attribute(value=ast.Name(id=self.frame, ctx=ast.Load()), attr=method, ctx=ast.Load()), args=args, keywords=[]), node)

    def gap(self, node, detail):
        return ast.copy_location(ast.Expr(value=self.call("gap", [_literal(node.lineno), _literal(detail)], node)), node)

    def observe(self, node, value, operation, children=()):
        return self.call("observe", [_literal(operation), _literal(self.key(node)), _literal(node.lineno), value,
                                     _literal(tuple(self.key(child) for child in children))], node)

    def body(self, statements):
        result = []
        for statement in statements:
            converted = self.visit(statement)
            result.extend(converted if isinstance(converted, list) else [converted])
        return result

    def visit_FunctionDef(self, node):
        unsafe = (ast.Global, ast.Nonlocal)
        reflection = {"eval", "exec", "locals", "globals", "vars", "super"}
        if any(isinstance(n, unsafe) or (isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in reflection) for n in ast.walk(node)):
            return [self.gap(node, "Function uses dynamic scope, closure writes or frame introspection; body left unchanged."), node]
        symbol = node.name if self.symbol == "<module>" else self.symbol + "." + node.name
        frame = self.helper + "_frame"
        transform = Transformer(self.path, self.digest, self.helper, frame, symbol)
        original = node.body
        doc = original[:1] if original and isinstance(original[0], ast.Expr) and isinstance(original[0].value, ast.Constant) and isinstance(original[0].value.value, str) else []
        parameters = node.args.posonlyargs + node.args.args + node.args.kwonlyargs
        if node.args.vararg:
            parameters.append(node.args.vararg)
        if node.args.kwarg:
            parameters.append(node.args.kwarg)
        values = ast.Tuple(elts=[ast.Tuple(elts=[_literal(arg.arg), ast.Name(id=arg.arg, ctx=ast.Load())], ctx=ast.Load()) for arg in parameters], ctx=ast.Load())
        entry = ast.Assign(targets=[ast.Name(id=frame, ctx=ast.Store())], value=ast.Call(
            func=ast.Attribute(value=ast.Attribute(value=ast.Name(id=self.helper, ctx=ast.Load()), attr="runtime", ctx=ast.Load()), attr="frame", ctx=ast.Load()),
            args=[_literal(self.path), _literal(self.digest), _literal(symbol), _literal(node.lineno), values], keywords=[]))
        ast.copy_location(entry, node)
        node.body = doc + [entry] + transform.body(original[len(doc):])
        if isinstance(node, ast.AsyncFunctionDef) or any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in ast.walk(node)):
            node.body.insert(len(doc) + 1, transform.gap(node, "Suspended function has isolated bindings; caller transport is not proven."))
        return [self.gap(node, "Function declaration replaces a binding; decorator/default side effects are not modeled."), node]

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        # Keep metaclass/decorator/base evaluation and class namespace intact.
        body = []
        for child in node.body:
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                converted = self.visit(child)
                body.extend(converted if isinstance(converted, list) else [converted])
            else:
                body.append(child)
        node.body = body
        return [self.gap(node, "Class declaration replaces a binding; metaclass side effects are not modeled."), node]

    def visit_Name(self, node):
        if not isinstance(node.ctx, ast.Load):
            return node
        return self.call("read", [_literal(self.key(node)), _literal(node.lineno), _literal(node.id), node], node)

    def visit_Constant(self, node):
        return self.observe(node, node, "value")

    def visit_BinOp(self, node):
        children = [node.left, node.right]
        return self.observe(node, ast.copy_location(ast.BinOp(left=self.visit(node.left), op=node.op, right=self.visit(node.right)), node), "transform", children)

    def visit_UnaryOp(self, node):
        child = node.operand
        return self.observe(node, ast.copy_location(ast.UnaryOp(op=node.op, operand=self.visit(child)), node), "transform", [child])

    def visit_Assign(self, node):
        if all(isinstance(target, ast.Name) for target in node.targets):
            original = node.value
            node.value = self.call("assign", [_literal(self.key(node)), _literal(node.lineno), _literal(tuple(t.id for t in node.targets)), self.visit(original), _literal(self.key(original)), self.old_bindings(node.targets)], node)
            return [node, ast.copy_location(ast.Expr(value=self.call("assigned", [
                _literal(self.key(node)), _literal(node.lineno)], node)), node)]
        return [self.gap(node, "Destructured or heap assignment is outside scalar binding coverage."), node]

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name) and node.value:
            original = node.value
            # Function-local variable annotations are not evaluated. Module
            # annotations can run user code after STORE and need a boundary.
            node.value = self.call("assign", [_literal(self.key(node)), _literal(node.lineno), _literal((node.target.id,)), self.visit(original), _literal(self.key(original)), self.old_bindings([node.target]), _literal(self.symbol != "<module>")], node)
            return [node, ast.copy_location(ast.Expr(value=self.call("assigned", [
                _literal(self.key(node)), _literal(node.lineno)], node)), node)]
        return [self.gap(node, "Annotation without a supported scalar assignment."), node]

    def old_bindings(self, names):
        # A Name lookup has no property/descriptor evaluation. It runs after
        # the RHS and before STORE; absent names are classified by the runtime.
        return ast.Tuple(elts=[ast.Lambda(
            args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
            body=ast.Name(id=name.id, ctx=ast.Load())) for name in names], ctx=ast.Load())

    def visit_Return(self, node):
        original = node.value or ast.copy_location(ast.Constant(value=None), node)
        node.value = self.call("returning", [_literal(self.key(node)), _literal(node.lineno), self.visit(original), _literal(self.key(original))], node)
        return node

    def visit_Call(self, node):
        if any(isinstance(arg, ast.Starred) for arg in node.args) or any(keyword.arg is None for keyword in node.keywords):
            return self.call("opaque", [_literal(self.key(node)), _literal(node.lineno), node, _literal("Expanded arguments have no resolved binding proof.")], node)
        return self.call("invoke", [_literal(self.key(node)), _literal(node.lineno), node.func,
            ast.Tuple(elts=[self.visit(arg) for arg in node.args], ctx=ast.Load()),
            ast.Dict(keys=[_literal(k.arg) for k in node.keywords], values=[self.visit(k.value) for k in node.keywords]),
            _literal(tuple(self.key(arg) for arg in node.args)),
            ast.Dict(keys=[_literal(k.arg) for k in node.keywords], values=[_literal(self.key(k.value)) for k in node.keywords])], node)

    def opaque_expression(self, node):
        # Preserve short-circuiting, accessor count, comprehension scope, async,
        # walrus and exception evaluation exactly; don't invent internal edges.
        return self.call("opaque", [_literal(self.key(node)), _literal(node.lineno), node,
                                    _literal("%s has no scalar lineage rule." % type(node).__name__)], node)

    def access_path(self, node):
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = self.access_path(node.value)
            return base + "." + node.attr if base else None
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) and type(node.slice.value) in (str, int):
            base = self.access_path(node.value)
            if base:
                key = node.slice.value
                return base + ("." + key if type(key) is str and key.isidentifier() else "[" + json.dumps(key, ensure_ascii=True) + "]")
        return None

    def visit_Attribute(self, node):
        path = self.access_path(node)
        if isinstance(node.ctx, ast.Load) and path:
            return self.call("field", [_literal(self.key(node)), _literal(node.lineno), _literal(path), node], node)
        return self.opaque_expression(node)

    visit_Subscript = visit_Attribute
    visit_BoolOp = opaque_expression
    visit_Compare = opaque_expression
    visit_IfExp = opaque_expression
    visit_Lambda = opaque_expression
    visit_NamedExpr = opaque_expression
    visit_Await = opaque_expression
    visit_Yield = opaque_expression
    visit_YieldFrom = opaque_expression
    visit_ListComp = opaque_expression
    visit_SetComp = opaque_expression
    visit_DictComp = opaque_expression
    visit_GeneratorExp = opaque_expression
    visit_JoinedStr = opaque_expression
    visit_Tuple = opaque_expression
    visit_List = opaque_expression
    visit_Set = opaque_expression
    visit_Dict = opaque_expression

    def unsupported_statement(self, node):
        return [self.gap(node, "%s invalidates scalar binding assumptions." % type(node).__name__), node]

    visit_AugAssign = unsupported_statement
    visit_Delete = unsupported_statement
    visit_Match = unsupported_statement
    visit_Import = unsupported_statement
    visit_ImportFrom = unsupported_statement

    def visit_For(self, node):
        # Iteration can mutate visible state during __iter__, __next__, empty
        # iteration, exhaustion, or an exception before the body is entered.
        node.body = [self.gap(node, "Loop target binding has no per-element provenance.")] + self.body(node.body)
        if node.orelse:
            node.orelse = [self.gap(node, "Iterator exhaustion may mutate visible bindings.")] + self.body(node.orelse)
        return self.lifecycle(node, "Iterator lifecycle has no verified side-effect summary.")

    visit_AsyncFor = visit_For

    def visit_With(self, node):
        node.body = [self.gap(node, "Context manager target has no resolved provenance.")] + self.body(node.body)
        return self.lifecycle(node, "Context manager entry/exit may mutate visible bindings.")

    visit_AsyncWith = visit_With

    def lifecycle(self, node, detail):
        # A plain statement after the construct would miss raised exceptions,
        # break/continue/return, and failed context entry. Do not evaluate the
        # iterator/context expression or any accessor a second time.
        guarded = ast.Try(body=[node], handlers=[], orelse=[],
                          finalbody=[self.gap(node, detail)])
        return [self.gap(node, detail), ast.copy_location(guarded, node)]

    def visit_Try(self, node):
        node.body = self.body(node.body)
        node.handlers = [self.visit(handler) for handler in node.handlers]
        node.orelse = self.body(node.orelse)
        if node.finalbody:
            # An accessor/operator can mutate and raise before its wrapping
            # observation is called; finally must not inherit those old sites.
            node.finalbody = [self.gap(node, "Finally may follow an unobserved failing side effect.")] + self.body(node.finalbody)
        return node

    visit_TryStar = visit_Try

    def visit_ExceptHandler(self, node):
        node.body = [self.gap(node, "Exception handler bindings have no value-flow proof.")] + self.body(node.body)
        return node


def instrument(source, path, *, source_hash=None):
    raw = source.encode("utf-8")
    if len(raw) > _MAX_SOURCE:
        raise ValueError("Python source exceeds the 4 MiB instrumentation limit")
    tree = ast.parse(source, filename=path)
    digest = source_hash or hashlib.sha256(raw).hexdigest()
    if sum(1 for _ in ast.walk(tree)) > 100000:
        raise ValueError("Python AST exceeds the 100,000 node instrumentation limit")
    reflective = {"eval", "exec", "locals", "globals", "vars", "super", "__builtins__"}
    reflective.update({"_getframe", "currentframe"})
    if any((isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in reflective)
           or (isinstance(node, ast.Attribute) and node.attr in reflective)
           or (isinstance(node, ast.Import) and any(alias.name == "builtins" for alias in node.names))
           or (isinstance(node, ast.ImportFrom) and
               (node.module == "builtins" or any(alias.name in reflective for alias in node.names)))
           or (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and
               node.func.id == "getattr" and len(node.args) >= 2 and
               isinstance(node.args[1], ast.Constant) and type(node.args[1].value) is str and
               node.args[1].value in reflective)
           for node in ast.walk(tree)):
        # Even a helper import changes globals()/locals(). Keep the complete
        # reflective module untouched, including aliases of these builtins.
        runtime.frame(path, digest, "<module>", 1).gap(
            1, "Module uses dynamic scope or frame introspection; executes without probes.")
        return tree
    helper = "_cbm_capture_" + digest[:12]
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    while helper in names or helper + "_frame" in names:
        helper += "x"
    transform = Transformer(path, digest, helper, helper + "_module")
    prefix = []
    while tree.body and ((isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Constant) and type(tree.body[0].value.value) is str) or (isinstance(tree.body[0], ast.ImportFrom) and tree.body[0].module == "__future__")):
        prefix.append(tree.body.pop(0))
    bootstrap = ast.parse("import cbm_capture_python as %s\n%s_module = %s.runtime.frame(%r, %r, '<module>', 1)" % (helper, helper, helper, path, digest)).body
    tree.body = prefix + bootstrap + transform.body(tree.body)
    return ast.fix_missing_locations(tree)


class SourceLoader(importlib.machinery.SourceFileLoader):
    def __init__(self, fullname, path, root):
        super().__init__(fullname, path)
        self.root = root

    def get_code(self, fullname):
        source = self.get_data(self.path)
        # decode_source honors Python's encoding declaration; the hash below
        # must identify actual original bytes, not normalized newlines/encoding.
        import tokenize
        import io
        encoding, _ = tokenize.detect_encoding(io.BytesIO(source).readline)
        text = source.decode(encoding)
        relative = str(Path(self.path).resolve().relative_to(self.root))
        digest = hashlib.sha256(source).hexdigest()
        try:
            tree = instrument(text, relative, source_hash=digest)
        except (RecursionError, ValueError):
            runtime.frame(relative, digest, "<module>", 1).gap(1, "Instrumentation budget exceeded; module executes without probes.")
            return compile(source, self.path, "exec", dont_inherit=True)
        return compile(tree, self.path, "exec", dont_inherit=True)


class SourceFinder(importlib.abc.MetaPathFinder):
    def __init__(self, root):
        self.root = Path(root).resolve()

    def find_spec(self, fullname, path=None, target=None):
        if fullname == "cbm_capture_python":
            return None
        spec = importlib.machinery.PathFinder.find_spec(fullname, path)
        if spec and type(spec.loader) is importlib.machinery.SourceFileLoader and spec.origin and eligible_source(spec.origin, self.root):
            spec.loader = SourceLoader(fullname, spec.origin, self.root)
            return spec
        return None


class LocalTransport:
    def __init__(self, endpoint, token):
        parsed = urlsplit(endpoint)
        if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or parsed.username or parsed.password or parsed.fragment or parsed.path != "/v1/cbm/lineage" or not parsed.port:
            raise ValueError("Capture endpoint must be an explicit local HTTP lineage receiver")
        if not token or len(token) > 256 or any(c in token for c in "\r\n"):
            raise ValueError("Capture token is required")
        self.host = "127.0.0.1" if parsed.hostname == "localhost" else parsed.hostname
        self.port, self.path = parsed.port, parsed.path + "?" + parsed.query
        self.token = token
        self.producer = "python-" + secrets.token_hex(12)
        self.queue = queue.Queue(maxsize=16)
        self.failed = False
        self.thread = threading.Thread(target=self.run, name="cbm-capture", daemon=True)
        self.thread.start()

    def send(self, events):
        try:
            self.queue.put_nowait(events)
        except queue.Full:
            self.failed = True

    def run(self):
        while True:
            events = self.queue.get()
            if events is None:
                self.queue.task_done()
                return
            try:
                body = json.dumps({"schema_version": 1, "producer": {"id": self.producer, "language": "python"}, "events": events}, ensure_ascii=True, allow_nan=False).encode()
                connection = http.client.HTTPConnection(self.host, self.port, timeout=0.3)
                try:
                    connection.request("POST", self.path, body, {"Content-Type": "application/json", "Authorization": "Bearer " + self.token})
                    response = connection.getresponse()
                    response.read(4096)
                    if response.status != 200:
                        self.failed = True
                finally:
                    connection.close()
            except Exception:
                self.failed = True
            finally:
                self.queue.task_done()

    def close(self):
        try:
            self.queue.put(None, timeout=0.2)
        except queue.Full:
            self.failed = True
        self.thread.join(timeout=1)
        if self.failed or self.thread.is_alive():
            print("CBM capture: some observations were not delivered.", file=sys.stderr)
        self.token = ""


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run a development Python program with scoped, reversible CBM probes.")
    parser.add_argument("--root", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--script")
    group.add_argument("--module")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    root = Path(args.root).resolve(strict=True)
    transport = LocalTransport(os.environ.get("CBM_CAPTURE_ENDPOINT", ""), os.environ.get("CBM_CAPTURE_TOKEN", ""))
    global runtime
    runtime = Runtime(transport.send, values_enabled=os.environ.get("CBM_CAPTURE_VALUES") == "1", allowed_fields=json.loads(os.environ.get("CBM_CAPTURE_FIELDS", "[]")))
    # The inserted import must resolve this very runtime even under `python -m`.
    sys.modules["cbm_capture_python"] = sys.modules[__name__]
    finder = SourceFinder(root)
    sys.meta_path.insert(0, finder)
    arguments = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
    try:
        if args.script:
            path = Path(args.script).resolve(strict=True)
            if not eligible_source(path, root):
                raise ValueError("Entry script must be an eligible source inside --root")
            sys.argv = [str(path)] + arguments
            sys.path.insert(0, str(path.parent))
            code = SourceLoader("__main__", str(path), root).get_code("__main__")
            application = types.ModuleType("__main__")
            application.__dict__.update({"__file__": str(path), "__package__": None,
                                         "__spec__": None, "__cached__": None, "__builtins__": __builtins__})
            previous = sys.modules.get("__main__")
            sys.modules["__main__"] = application
            try:
                exec(code, application.__dict__)
            finally:
                if previous is not None:
                    sys.modules["__main__"] = previous
        else:
            sys.path.insert(0, str(root))
            sys.argv = [args.module] + arguments
            runpy.run_module(args.module, run_name="__main__", alter_sys=True)
    finally:
        runtime.flush()
        transport.close()
        sys.meta_path.remove(finder)


if __name__ == "__main__":
    main()
