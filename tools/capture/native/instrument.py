#!/usr/bin/env python3
"""Explicit Clang AST to temporary development-overlay generator."""
import argparse
import hashlib
import json
from pathlib import Path
import os
import subprocess
import tempfile
import resource
import stat


SCALARS = {"bool", "_Bool", "char", "signed char", "unsigned char", "short",
           "unsigned short", "int", "unsigned int", "long", "unsigned long",
           "long long", "unsigned long long"}

def read_source(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as handle:
        identity = os.fstat(handle.fileno())
        if not stat.S_ISREG(identity.st_mode) or identity.st_size > 4 * 1024 * 1024:
            raise ValueError("Select a regular source of at most 4 MiB")
        contents = handle.read(4 * 1024 * 1024 + 1)
        version = (identity.st_dev, identity.st_ino, identity.st_mtime_ns, identity.st_ctime_ns)
        return contents, version


def scalar(node):
    kind = node.get("type", {}).get("qualType", "")
    return "volatile" not in kind and kind.replace("const ", "").strip() in SCALARS


def span(node):
    bounds = node.get("range", {})
    begin, end = bounds.get("begin", {}), bounds.get("end", {})
    if "spellingLoc" in begin or "expansionLoc" in begin or "spellingLoc" in end or "expansionLoc" in end:
        raise ValueError("Macro source ranges are not rewritten")
    if "offset" not in begin or "offset" not in end:
        raise ValueError("Source occurrence has no raw byte range")
    return begin["offset"], end["offset"] + end.get("tokLen", 1)


def apply(source, begin, end, changes):
    result, cursor = [], begin
    for left, right, text in sorted(changes, key=lambda item: item[0]):
        if left < cursor or right > end:
            raise ValueError("Overlapping or out-of-range AST occurrences")
        result.append(source[cursor:left].decode())
        result.append(text)
        cursor = right
    result.append(source[cursor:end].decode())
    return "".join(result)


class Rewrite:
    def __init__(self, source, path, digest, prefix, cpp, function):
        self.source, self.path, self.digest = source, path, digest
        self.prefix, self.cpp, self.function = prefix, cpp, function
        self.frame = prefix + "_frame"
        self.slots = {}
        self.names = {}
        self.site_ids = {}
        self.return_type = function.get("type", {}).get("qualType", "").split("(")[0].strip()
        self.symbol = function.get("name", "<function>")
        self.gaps = []
        self.collect(function)

    def collect(self, node):
        if node.get("kind") in {"ParmVarDecl", "VarDecl"} and scalar(node):
            self.slots[node["id"]] = len(self.slots)
            self.names[node["id"]] = node.get("name", "")
        for child in node.get("inner", []):
            self.collect(child)

    def line(self, node):
        return self.source[:span(node)[0]].count(b"\n") + 1

    def site(self, node):
        key = str(span(node))
        if key not in self.site_ids:
            self.site_ids[key] = len(self.site_ids)
        if len(self.site_ids) > 256:
            raise ValueError("Function occurrence budget exceeded")
        return self.site_ids[key]

    def raw(self, node):
        left, right = span(node)
        return self.source[left:right].decode()

    def gap(self, node, detail):
        return f'{self.prefix}_gap(&{self.frame},{self.line(node)},{json.dumps(detail)});'

    def call(self, operation, node, value, slot=-1, inputs=(-1, -1), name=""):
        site = self.site(node)
        return (f'{self.prefix}_{operation}(&{self.frame},{site},{self.line(node)},'
                f'{slot},{inputs[0]},{inputs[1]},{json.dumps(name)},({value}))'), site

    def expression(self, node):
        kind, children = node.get("kind"), node.get("inner", [])
        if not scalar(node):
            raise ValueError("Non-scalar expression has no exact value probe")
        if kind in {"ImplicitCastExpr", "ParenExpr", "CStyleCastExpr", "CXXStaticCastExpr"} and len(children) == 1:
            child = children[0]
            rewritten, source_id = self.expression(child)
            begin, end = span(node)
            left, right = span(child)
            value = apply(self.source, begin, end, [(left, right, rewritten)])
            if (kind in {"CStyleCastExpr", "CXXStaticCastExpr"} or
                    node.get("castKind") in {"IntegralCast", "IntegralToBoolean", "BooleanToSignedIntegral"}):
                if kind == "ImplicitCastExpr":
                    value = "((" + node["type"]["qualType"] + ")(" + value + "))"
                return self.call("TRANSFORM", node, value, inputs=(source_id, -1))
            return value, source_id
        if kind in {"IntegerLiteral", "FloatingLiteral", "CharacterLiteral", "CXXBoolLiteralExpr"}:
            return self.raw(node), -1
        if kind == "DeclRefExpr":
            declaration = node.get("referencedDecl", {})
            if declaration.get("id") not in self.slots:
                raise ValueError("External/captured storage has no lexical binding")
            slot = self.slots[declaration["id"]]
            return self.call("READ", node, self.raw(node), slot, name=declaration.get("name", ""))
        if kind == "BinaryOperator" and node.get("opcode") in {"+", "-", "*", "/", "%", "<", "<=", ">", ">=", "==", "!=", "&", "|", "^", "<<", ">>"} and len(children) == 2:
            left, lsite = self.expression(children[0])
            right, rsite = self.expression(children[1])
            begin, end = span(node)
            lbegin, lend = span(children[0])
            rbegin, rend = span(children[1])
            value = apply(self.source, begin, end, [(lbegin, lend, left), (rbegin, rend, right)])
            return self.call("TRANSFORM", node, value, inputs=(lsite, rsite))
        if kind == "UnaryOperator" and node.get("opcode") in {"+", "-", "!", "~"} and len(children) == 1:
            value, input_id = self.expression(children[0])
            begin, end = span(node)
            left, right = span(children[0])
            return self.call("TRANSFORM", node, apply(self.source, begin, end, [(left, right, value)]), inputs=(input_id, -1))
        if kind == "MemberExpr" and not node.get("isArrow") and len(children) == 1 and children[0].get("kind") == "DeclRefExpr":
            return self.call("FIELD", node, self.raw(node), name=node.get("name", ""))
        if kind in {"CallExpr", "CXXMemberCallExpr"}:
            return self.call("OPAQUE", node, self.raw(node))
        raise ValueError("Expression shape has no proven scalar semantics")

    def statement_span(self, node):
        left, right = span(node)
        if node.get("kind") not in {"CompoundStmt"}:
            after = right
            while after < len(self.source) and self.source[after:after+1] in b" \t\r":
                after += 1
            if self.source[after:after+1] == b";":
                right = after + 1
        return left, right

    def original_statement(self, node):
        left, right = self.statement_span(node)
        return self.source[left:right].decode()

    def statement(self, node, function_body=False):
        kind, children = node.get("kind"), node.get("inner", [])
        try:
            if kind == "CompoundStmt":
                begin, end = span(node)
                changes = []
                for child in children:
                    left, right = self.statement_span(child)
                    changes.append((left, right, self.statement(child)))
                rewritten = apply(self.source, begin, end, changes)
                # A declaration probe runs before the lifetime ends. A later
                # scalar assignment can therefore establish fresh provenance
                # that a destructor invalidates at the closing brace. Observe
                # that boundary only after the original scope has completed;
                # never retain, wrap, or move the application's objects.
                def has_unmodeled_lifetime(current):
                    if current.get("kind") == "VarDecl":
                        return (not scalar(current) or any(
                            child.get("kind") == "CleanupAttr"
                            for child in current.get("inner", [])))
                    return any(has_unmodeled_lifetime(child)
                               for child in current.get("inner", []))
                if not function_body and has_unmodeled_lifetime(node):
                    detail = "Automatic storage left its scope; destructor/cleanup effects are unmodeled"
                    self.gaps.append(detail)
                    rewritten += self.gap(node, detail)
                return rewritten
            if kind == "DeclStmt" and len(children) == 1 and children[0].get("kind") == "VarDecl":
                declaration = children[0]
                slot = self.slots.get(declaration.get("id"))
                values = declaration.get("inner", [])
                if slot is None or len(values) != 1:
                    raise ValueError("Declaration requires one initialized scalar binding")
                value, input_id = self.expression(values[0])
                begin, end = self.statement_span(node)
                left, right = span(values[0])
                rewritten = apply(self.source, begin, end, [(left, right, value)])
                record, _ = self.call("ASSIGN", node, declaration["name"], slot, (input_id, -1), declaration["name"])
                return rewritten + record + ";"
            if kind == "BinaryOperator" and node.get("opcode") == "=" and len(children) == 2:
                declaration = children[0].get("referencedDecl", {})
                slot = self.slots.get(declaration.get("id"))
                if children[0].get("kind") != "DeclRefExpr" or slot is None:
                    raise ValueError("Write destination is not a scalar lexical binding")
                value, input_id = self.expression(children[1])
                begin, end = self.statement_span(node)
                left, right = span(children[1])
                rewritten = apply(self.source, begin, end, [(left, right, value)])
                record, _ = self.call("ASSIGN", node, declaration["name"], slot, (input_id, -1), declaration["name"])
                return rewritten + record + ";"
            if kind == "ReturnStmt" and len(children) == 1 and self.return_type in SCALARS:
                value, input_id = self.expression(children[0])
                # Observe the same builtin conversion the original return
                # performs, including short/unsigned scalar return values.
                converted = f"(({self.return_type})({value}))"
                record, _ = self.call("RETURN", node, converted, inputs=(input_id, -1))
                begin, end = self.statement_span(node)
                left, right = span(children[0])
                return apply(self.source, begin, end, [(left, right, record)])
            if kind == "IfStmt" and not node.get("hasInit") and not node.get("hasVar") and len(children) in {2, 3}:
                condition, _ = self.expression(children[0])
                begin, end = self.statement_span(node)
                left, right = span(children[0])
                changes = [(left, right, condition)]
                for branch in children[1:]:
                    left, right = self.statement_span(branch)
                    changes.append((left, right, "{" + self.statement(branch) + "}"))
                return apply(self.source, begin, end, changes)
            if kind == "NullStmt":
                return self.original_statement(node)
            if kind in {"CallExpr", "CXXMemberCallExpr"} and scalar(node):
                expression, _ = self.expression(node)
                return expression + ";"
        except ValueError as error:
            detail = str(error)
        else:
            detail = "Statement control, aliasing or object lifetime is outside scalar probe coverage"
        self.gaps.append(detail)
        # Both sides matter: original code may execute an instrumented nested
        # region or an opaque call before continuing in this frame.
        return self.gap(node, detail) + self.original_statement(node) + self.gap(node, detail)

    def body(self, body):
        if len(self.slots) > 128:
            raise ValueError("Function binding budget exceeded")
        parameters = [child for child in self.function.get("inner", []) if child.get("kind") == "ParmVarDecl"]
        dangerous = any(not scalar(parameter) for parameter in parameters)
        def inspect(node):
            nonlocal dangerous
            if "volatile" in node.get("type", {}).get("qualType", ""):
                dangerous = True
            if node.get("kind") in {"LambdaExpr", "CXXThisExpr", "GCCAsmStmt", "MSAsmStmt"}:
                dangerous = True
            if node.get("kind") == "UnaryOperator" and node.get("opcode") in {"&", "*"}:
                dangerous = True
            for child in node.get("inner", []):
                inspect(child)
        inspect(body)
        original = self.raw(body)
        entry = (f'{self.prefix}_frame_t {self.frame};{self.prefix}_enter(&{self.frame},'
                 f'{json.dumps(self.path)},{json.dumps(self.digest)},{json.dumps(self.symbol)},{self.line(body)});')
        entry += self.gap(body, "Native caller/thread context is uncorrelated; cross-invocation transport is not claimed")
        if dangerous or self.return_type not in SCALARS | {"void"}:
            entry += self.gap(body, "Pointer/reference/volatile, floating point or non-scalar function executes unchanged")
            self.gaps.append("Unsupported function storage/signature")
            return original[:1] + entry + original[1:]
        for parameter in parameters:
            slot = self.slots.get(parameter.get("id"))
            if slot is None or not parameter.get("name"):
                continue
            record, _ = self.call("PARAM", parameter, parameter["name"], slot, name=parameter["name"])
            entry += record + ";"
        rewritten = self.statement(body, function_body=True)
        return rewritten[:1] + entry + rewritten[1:]


def generate(root, sources, output, compiler="clang++", flags=()):
    root, output = Path(root).resolve(strict=True), Path(output).resolve()
    if output == root or root in output.parents:
        raise ValueError("Overlay output must be outside the project")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Overlay output must be empty")
    if not sources or len(sources) > 16:
        raise ValueError("Select one to sixteen explicit translation units")
    takes_value = {"-I", "-D", "-U", "-isystem", "-iquote", "-isysroot", "--sysroot", "-target"}
    allowed = {"-fno-exceptions", "-fexceptions", "-fno-rtti", "-frtti", "-pthread"}
    awaiting = False
    for flag in flags:
        if awaiting:
            if flag.startswith("-") or flag.startswith("@"):
                raise ValueError("Expected a semantic compiler flag value")
            awaiting = False
        elif flag in takes_value:
            awaiting = True
        elif (flag in allowed or flag.startswith(("-std=", "--sysroot=", "--target="))
              or (len(flag) > 2 and flag[:2] in {"-I", "-D", "-U"})):
            pass
        else:
            raise ValueError("Only explicit include/define/standard/target flags are accepted")
    if awaiting:
        raise ValueError("Missing semantic compiler flag value")
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    prefix = "_cbm_" + hashlib.sha256(str(root).encode()).hexdigest()[:12]
    replacements, coverage, selected_sources, compile_sources = [], [], [], []
    total = 0
    for index, requested in enumerate(sources):
        path = Path(requested)
        if not path.is_absolute():
            path = root / path
        canonical = path.resolve(strict=True)
        if root not in canonical.parents or path.is_symlink() or canonical.suffix not in {".c", ".cc", ".cpp", ".cxx"}:
            raise ValueError("Select a regular C/C++ source inside the project root")
        if str(canonical) in selected_sources:
            raise ValueError("Each translation unit may be selected once")
        selected_sources.append(str(canonical))
        compile_sources.append(str(requested))
        source, source_version = read_source(canonical)
        total += len(source)
        if len(source) > 4 * 1024 * 1024 or total > 32 * 1024 * 1024 or b"\0" in source:
            raise ValueError("Native source byte budget exceeded")
        if prefix.encode() in source:
            raise ValueError("Generated helper identity conflicts with source text")
        source.decode("utf-8")  # Never silently change source byte encoding.
        digest = hashlib.sha256(source).hexdigest()
        # The compiler only parses original source. No target application or
        # compiler plugin is executed. AST output is private and bounded.
        with tempfile.TemporaryFile() as ast_output:
            def analysis_limits():
                resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
            result = subprocess.run([compiler, *flags, "-fsyntax-only", "-Xclang", "-ast-dump=json", str(canonical)],
                                    cwd=root, stdout=ast_output, stderr=subprocess.PIPE, timeout=20,
                                    preexec_fn=analysis_limits)
            if result.returncode:
                raise ValueError("Clang could not analyze this translation unit: " + result.stderr.decode(errors="replace")[-2000:])
            ast_output.seek(0)
            ast_bytes = ast_output.read(64 * 1024 * 1024 + 1)
        if len(ast_bytes) > 64 * 1024 * 1024:
            raise ValueError("Clang AST exceeded the 64 MiB analysis budget")
        current_source, current_version = read_source(canonical)
        if current_source != source or current_version != source_version:
            raise ValueError("Source changed during Clang analysis; regenerate the overlay")
        tree = json.loads(ast_bytes)
        escaped_functions = set()
        def find_escaped(node, ancestors=()):
            declaration = node.get("referencedDecl", {})
            if node.get("kind") == "DeclRefExpr" and declaration.get("kind") == "FunctionDecl":
                direct = False
                for parent, child_index in reversed(ancestors):
                    if parent.get("kind") in {"ImplicitCastExpr", "ParenExpr"}:
                        continue
                    direct = parent.get("kind") == "CallExpr" and child_index == 0
                    break
                if not direct:
                    escaped_functions.add(declaration.get("id"))
            for child_index, child in enumerate(node.get("inner", [])):
                find_escaped(child, ancestors + ((node, child_index),))
        find_escaped(tree)
        edits = []
        visited = set()
        def walk(node, in_template=False):
            kind = node.get("kind", "")
            if kind == "FunctionTemplateDecl":
                in_template = True
            if kind == "FunctionDecl":
                location = node.get("loc", {})
                body = next((child for child in node.get("inner", []) if child.get("kind") == "CompoundStmt"), None)
                file_name = location.get("file")
                if body is not None and not location.get("includedFrom") and (not file_name or Path(file_name).resolve() == canonical):
                    try:
                        begin, end = span(body)
                        if end > len(source) or begin < 0 or source[begin:begin+1] != b"{" or source[end-1:end] != b"}":
                            return
                        position = location.get("offset", -1)
                        name = node.get("name", "")
                        if position < 0 or source[position:position+len(name.encode())] != name.encode():
                            return
                        if (begin, end) in visited:
                            return
                        visited.add((begin, end))
                        if (in_template or node.get("constexpr") or node.get("consteval")
                                or node.get("id") in escaped_functions
                                or any(child.get("kind", "").endswith("Attr") for child in node.get("inner", []))):
                            coverage.append({"file": str(canonical.relative_to(root)), "symbol": name,
                                             "gap": "Template/constexpr/attribute or address-taken callback remains unmodified"})
                            return
                        rewrite = Rewrite(source, canonical.relative_to(root).as_posix(), digest, prefix, canonical.suffix != ".c", node)
                        text = rewrite.body(body)
                        edits.append((begin, end, text))
                        coverage.extend({"file": str(canonical.relative_to(root)), "symbol": name, "gap": gap} for gap in rewrite.gaps)
                    except ValueError as error:
                        coverage.append({"file": str(canonical.relative_to(root)), "gap": str(error)})
                return
            for child in node.get("inner", []):
                walk(child, in_template)
        walk(tree)
        transformed = apply(source, 0, len(source), edits)
        backing = output / f"source-{index}{canonical.suffix}"
        with backing.open("x") as generated:
            generated.write(transformed)
        replacements.append({"type": "file", "name": str(canonical), "external-contents": str(backing)})
        alias = path.absolute()
        if alias != canonical:
            replacements.append({"type": "file", "name": str(alias), "external-contents": str(backing)})
    here = Path(__file__).parent
    for name in ("runtime.h", "runtime.c"):
        contents = (here / (name + ".txt")).read_text().replace("PREFIX", prefix)
        with (output / name).open("x") as generated:
            generated.write(contents)
    overlay = output / "overlay.json"
    overlay.write_text(json.dumps({"version": 0, "use-external-names": False, "roots": replacements}, indent=2))
    manifest = output / "capture.json"
    manifest.write_text(json.dumps({"schema_version": 1, "root": str(root), "compiler": compiler,
                                    "semantic_flags": list(flags), "sources": compile_sources,
                                    "compile_arguments": ["-ivfsoverlay", str(overlay), "-include", str(output / "runtime.h"), "-pthread"],
                                    "runtime_source": str(output / "runtime.c"), "gaps": coverage}, indent=2))
    return str(manifest)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--source", action="append", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--compiler", default="clang++")
    options, flags = parser.parse_known_args()
    print(generate(options.root, options.source, options.out, options.compiler,
                   flags[1:] if flags[:1] == ["--"] else flags))


if __name__ == "__main__":
    main()
