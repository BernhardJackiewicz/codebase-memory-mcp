"""Execute original and instrumented Python; compare behavior and actual lineage."""
import ast
import asyncio
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

import cbm_capture_python as capture


class PythonCaptureTest(unittest.TestCase):
    def run_source(self, source, *, fields=(), preview=False):
        events = []
        runtime = capture.Runtime(events.extend, values_enabled=preview, allowed_fields=fields)
        module = types.ModuleType("fixture")
        namespace = module.__dict__
        with patch.object(capture, "runtime", runtime), patch.dict(sys.modules, {"fixture": module}):
            exec(compile(capture.instrument(source, "fixture.py"), "fixture.py", "exec"), namespace)
            runtime.flush()
        return namespace, events

    def reaches(self, events, start, end):
        links = {event.get("value_id"): event["inputs"] for event in events}
        todo, seen = [end], set()
        while todo:
            value = todo.pop()
            if value == start:
                return True
            if value in seen:
                continue
            seen.add(value)
            todo.extend(links.get(value, []))
        return False

    def test_assignment_transform_return_and_overwrite_versions(self):
        source = '''
def flow(email):
    copied = email
    normalized = copied + "!"
    discarded = email
    discarded = "constant"
    return normalized, discarded
answer = flow("test@example.test")
'''
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["answer"], ("test@example.test!", "constant"))
        writes = [event for event in events if event.get("access_path") == "discarded" and event["operation"] == "copy"]
        params = [event for event in events if event.get("access_path") == "email" and event["operation"] == "value"]
        self.assertEqual(len(writes), 2)
        self.assertEqual(len(params), 1)
        self.assertTrue(self.reaches(events, params[0]["value_id"], writes[0]["value_id"]))
        self.assertFalse(self.reaches(events, params[0]["value_id"], writes[1]["value_id"]))
        self.assertTrue(any(event["operation"] == "transform" and event["inputs"] for event in events))
        self.assertTrue(all(event["source"]["source_hash"] == hashlib.sha256(source.encode()).hexdigest() for event in events))
        self.assertNotIn("test@example.test", repr(events))

    def test_store_finalizers_cannot_publish_stale_destination_or_other_bindings(self):
        fixtures = (
            ("x = C()\nx = 42\ny = x\n", "x = 0", 0),
            ("obj = C()\nx = 42\nobj = None\ny = x\n", "x = 0", 0),
            ("x = C()\nx: int = 42\ny = x\n", "x = 0", 0),
            ("x = C()\nz = x = 42\ny = x\n", "x = 0", 0),
            ("x = C()\nx = 42\ny = x\n", "x = 42", 42),
        )
        for statements, destructor, expected in fixtures:
            with self.subTest(statements=statements):
                source = ("class C:\n    def __del__(self):\n        global x\n        " +
                          destructor + "\n" + statements + "observed = y\n")
                original = {}
                exec(compile(source, "original.py", "exec"), original)
                namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
                self.assertEqual((namespace["x"], namespace["y"]),
                                 (original["x"], original["y"]))
                self.assertEqual(namespace["y"], expected)
                assigned_line = max(i for i, line in enumerate(source.splitlines(), 1)
                                    if "42" in line)
                candidates = [event for event in events
                              if event["source"]["line"] == assigned_line
                              and event["operation"] in ("value", "copy")]
                self.assertTrue(candidates, "The evaluated RHS remains observed")
                later_y = [event for event in events if event.get("access_path") == "y"]
                # Read y explicitly to observe the post-store value even if a
                # potentially destructive STORE cannot itself publish lineage.
                self.assertTrue(later_y)
                for event in candidates:
                    self.assertFalse(self.reaches(events, event["value_id"],
                                                  later_y[-1]["value_id"]))
                self.assertTrue(any(event["operation"] == "gap" for event in events))

    def test_store_probe_does_not_reload_a_destination_deleted_by_its_finalizer(self):
        source = """
class C:
    def __del__(self):
        global x
        del x
x = C()
x = 42
try:
    result = x
except NameError:
    result = "deleted"
"""
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["result"], "deleted")
        self.assertNotIn("x", namespace)
        self.assertTrue(any(event["operation"] == "gap" for event in events))

    def test_store_checks_old_binding_after_rhs_and_bounds_annotation_effects(self):
        sources = (
            """
class C:
    def __del__(self):
        global x
        x = 0
def replacement():
    global x
    x = C()
    return 42
x = 1
x = replacement()
y = x
""",
            """
def annotation():
    global x
    x = 0
    return int
x = 1
x: annotation() = 42
y = x
""")
        for source in sources:
            with self.subTest(source=source):
                namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
                self.assertEqual(namespace["y"], 0)
                candidates = [event for event in events if event.get("preview") == 42]
                self.assertTrue(candidates)
                y = next(event for event in events if event.get("access_path") == "y")
                self.assertTrue(all(not self.reaches(events, event["value_id"], y["value_id"])
                                    for event in candidates))

    def test_store_keeps_safe_primitive_and_local_annotation_lineage(self):
        source = """
def annotation():
    raise AssertionError("Local annotation must not execute")
def flow(value):
    copied: annotation() = value
    copied = copied + 1
    left = right = copied
    return right
answer = flow(41)
"""
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["answer"], 42)
        parameter = next(event for event in events
                         if event["operation"] == "value" and event.get("access_path") == "value")
        returned = next(event for event in events
                        if event["operation"] == "return" and event["source"]["symbol"] == "flow")
        self.assertTrue(self.reaches(events, parameter["value_id"], returned["value_id"]))
        self.assertTrue(any(event["operation"] == "transform" and event["inputs"] for event in events))

    def test_recursive_and_keyword_calls_have_distinct_invocations_and_real_returns(self):
        source = '''
def identity(value="default"):
    return value
def outer(value):
    first = identity(value=value)
    second = identity("other")
    return first
answer = outer("test")
'''
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["answer"], "test")
        params = [e for e in events if e["operation"] == "value" and e.get("access_path") == "value"]
        self.assertEqual(len({e["invocation_id"] for e in params}), 3)
        returned = [e for e in events if e["operation"] == "return"]
        outer_return = returned[-1]
        first_call = next(e for e in events if e["operation"] == "call" and e["source"]["symbol"] == "outer")
        self.assertTrue(self.reaches(events, params[1]["value_id"], first_call["value_id"]))
        # A later call can mutate caller-visible state. Its side effects are
        # not proven absent merely because both callees have return probes.
        self.assertFalse(self.reaches(events, params[1]["value_id"], outer_return["value_id"]))
        self.assertFalse(self.reaches(events, params[2]["value_id"], outer_return["value_id"]))
        self.assertTrue(any(e["operation"] == "call" and e["inputs"] for e in events))

    def test_getters_evaluated_once_and_exceptions_and_short_circuit_unchanged(self):
        source = '''
calls = []
class Box:
    @property
    def item(self):
        calls.append("get")
        return 4
def fail():
    calls.append("fail")
    raise ValueError("same exception")
def calculate(box):
    value = box.item
    short = False and fail()
    try:
        fail()
    except ValueError as error:
        calls.append(str(error))
    return value, short
answer = calculate(Box())
'''
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["answer"], (4, False))
        self.assertEqual(namespace["calls"], ["get", "fail", "same exception"])
        self.assertTrue(any(e["operation"] == "gap" for e in events))

    def test_previews_require_exact_allowlist_and_do_not_call_user_conversions(self):
        source = '''
class Trap:
    def __str__(self):
        raise AssertionError("not allowed")
    def __repr__(self):
        raise AssertionError("not allowed")
def flow(email, other, object_value):
    saved = email
    return saved
answer = flow("test@example.test", "private", Trap())
'''
        _, events = self.run_source(source, fields=("email", "object_value"), preview=True)
        self.assertTrue(any(e.get("preview") == "test@example.test" for e in events))
        self.assertTrue(all(e.get("access_path") == "email" for e in events if "preview" in e))
        self.assertNotIn("private", repr(events))
        _, disabled = self.run_source(source, fields=("email",), preview=False)
        self.assertFalse(any("preview" in e for e in disabled))

    def test_overlong_unicode_paths_are_omitted_without_aliasing_a_short_allowlist(self):
        events = []
        runtime = capture.Runtime(events.extend, values_enabled=True, allowed_fields=("短",))
        frame = capture.Frame(runtime, "fixture.py", "a" * 64, "関" * 600, "i1")
        runtime.emit(frame, "field", 1, access_path="短" * 400, value="private")
        runtime.flush()
        self.assertNotIn("access_path", events[0])
        self.assertNotIn("preview", events[0])
        self.assertLessEqual(len(events[0]["source"].get("symbol", "").encode()), 1024)

    def test_user_defined_operator_result_does_not_assert_builtin_scalar_transport(self):
        source = '''
calls = []
class Box:
    def __add__(self, other):
        calls.append("add")
        return "unrelated"
def flow(box):
    output = box + 1
    return output
answer = flow(Box())
'''
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["answer"], "unrelated")
        self.assertEqual(namespace["calls"], ["add"])
        self.assertFalse(any(e["operation"] == "transform" and e["source"]["symbol"] == "flow" for e in events))
        self.assertTrue(any(e["operation"] == "gap" and e["source"]["symbol"] == "flow" for e in events))

    def test_exact_field_reads_feed_copies_without_replaying_accessors(self):
        source = '''
calls = []
class Profile:
    @property
    def email(self):
        calls.append("read")
        return "test@example.test"
def flow(profile):
    copied = profile.email
    return copied
answer = flow(Profile())
'''
        namespace, events = self.run_source(source, fields=("profile.email",), preview=True)
        self.assertEqual(namespace["calls"], ["read"])
        fields = [e for e in events if e["operation"] == "field"]
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["access_path"], "profile.email")
        self.assertEqual(fields[0]["preview"], "test@example.test")
        returned = [e for e in events if e["operation"] == "return"][-1]
        self.assertTrue(self.reaches(events, fields[0]["value_id"], returned["value_id"]))
        self.assertEqual(fields[0]["inputs"], [], "A getter does not prove transport from a prior object state")

    def test_async_and_generator_execution_preserves_suspension_and_results(self):
        source = '''
import asyncio
async def flow(value):
    await asyncio.sleep(0)
    copied = value
    return copied
def generate(value):
    copied = value
    yield copied
    yield "end"
answer = asyncio.run(flow("async")), list(generate("generator"))
'''
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["answer"], ("async", ["generator", "end"]))
        self.assertTrue(any(e["operation"] == "gap" for e in events))
        self.assertTrue(all(e["sequence"] == index + 1 for index, e in enumerate(events)))

    def test_dynamic_mutation_breaks_stale_bindings_without_changing_output(self):
        source = '''
def flow(value):
    local = value
    eval("0")
    return local
answer = flow("input")
'''
        namespace, events = self.run_source(source)
        self.assertEqual(namespace["answer"], "input")
        parameters = [e for e in events if e["operation"] == "value" and e.get("access_path") == "value"]
        returned = [e for e in events if e["operation"] == "return"]
        self.assertFalse(any(self.reaches(events, p["value_id"], r["value_id"]) for p in parameters for r in returned))
        self.assertTrue(any(e["operation"] == "gap" for e in events))

    def test_reflective_module_execution_keeps_original_scope_and_namespace(self):
        for source in (
            'x = 41\nanswer = eval("x + 1")\n',
            'x = 41\nexec("answer = x + 1")\n',
            'x = 41\nanswer = sorted(locals().keys())\n',
            'evaluate = eval\nx = 41\nanswer = evaluate("x + 1")\n',
        ):
            with self.subTest(source=source):
                original = types.ModuleType("fixture").__dict__
                exec(compile(source, "fixture.py", "exec"), original)
                namespace, events = self.run_source(source)
                self.assertEqual(namespace["answer"], original["answer"])
                self.assertTrue(any(event["operation"] == "gap" for event in events))

    def test_qualified_and_imported_reflection_keeps_the_whole_namespace_unchanged(self):
        for source in (
            'import builtins\nanswer = sorted(builtins.locals().keys())\n',
            'import builtins as bi\nanswer = sorted(bi.globals().keys())\n',
            'from builtins import locals as names\nanswer = sorted(names().keys())\n',
            'import builtins as bi\nanswer = sorted(getattr(bi, "locals")().keys())\n',
            'import builtins as bi\nx = 41\nanswer = bi.eval("x + 1")\n',
            'from builtins import exec as execute\nx = 41\nexecute("answer = x + 1")\n',
        ):
            with self.subTest(source=source):
                original = types.ModuleType("fixture").__dict__
                exec(compile(source, "fixture.py", "exec"), original)
                namespace, events = self.run_source(source)
                self.assertEqual(namespace["answer"], original["answer"])
                self.assertEqual(set(namespace), set(original))
                self.assertTrue(events)
                self.assertTrue(all(event["operation"] == "gap" for event in events))

    def test_instrumented_callee_side_effect_cannot_reuse_callers_previous_write(self):
        source = '''import sys
def mutate():
    setattr(sys.modules[__name__], "x", 2)
    return 0
x = 1
mutate()
y = x
'''
        namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
        self.assertEqual(namespace["y"], 2)
        old = next(event for event in events if event.get("access_path") == "x" and event.get("preview") == 1)
        copied = next(event for event in events if event.get("access_path") == "y")
        self.assertFalse(self.reaches(events, old["value_id"], copied["value_id"]),
                         "A callee mutation was incorrectly linked to the caller's old write")

    def test_iterator_lifecycle_invalidates_bindings_even_without_a_body_iteration(self):
        for iterator in (
            'def iterate():\n    global x\n    x = 99\n    return []\n',
            'def iterate():\n    global x\n    yield 0\n    x = 99\n',
        ):
            with self.subTest(iterator=iterator):
                source = iterator + 'x = 1\nfor item in iterate():\n    x = 1\ny = x\n'
                namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
                self.assertEqual(namespace["y"], 99)
                copied = next(event for event in events if event.get("access_path") == "y")
                old = [event for event in events if event.get("access_path") == "x" and event.get("preview") == 1]
                self.assertTrue(old)
                self.assertFalse(any(self.reaches(events, event["value_id"], copied["value_id"]) for event in old))

    def test_context_exit_invalidates_bindings_after_body_and_suppressed_exception(self):
        for body in ('x = 1', 'x = 1\n    raise ValueError("suppressed")'):
            with self.subTest(body=body):
                source = '''class Context:
    def __enter__(self): return self
    def __exit__(self, *error):
        global x
        x = 99
        return True
x = 1
with Context():
    ''' + body + '\ny = x\n'
                namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
                self.assertEqual(namespace["y"], 99)
                copied = next(event for event in events if event.get("access_path") == "y")
                old = [event for event in events if event.get("access_path") == "x" and event.get("preview") == 1]
                self.assertTrue(old)
                self.assertFalse(any(self.reaches(events, event["value_id"], copied["value_id"]) for event in old))

    def test_finally_invalidates_after_a_getter_mutates_and_raises_before_its_probe(self):
        source = '''class Box:
    @property
    def item(self):
        global x
        x = 99
        raise ValueError("unchanged")
box = Box()
x = 1
try:
    try:
        box.item
    finally:
        y = x
except ValueError as error:
    message = str(error)
'''
        namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
        self.assertEqual(namespace["y"], 99)
        self.assertEqual(namespace["message"], "unchanged")
        copied = next(event for event in events if event.get("access_path") == "y")
        old = [event for event in events if event.get("access_path") == "x" and event.get("preview") == 1]
        self.assertTrue(old)
        self.assertFalse(any(self.reaches(events, event["value_id"], copied["value_id"]) for event in old))

    def test_loop_else_starts_after_exhaustion_effects_and_exception_paths_stay_unchanged(self):
        source = '''def iterate():
    global x
    yield 0
    x = 99
x = 1
for item in iterate():
    x = 1
else:
    y = x
'''
        namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
        self.assertEqual(namespace["y"], 99)
        copied = next(event for event in events if event.get("access_path") == "y")
        old = [event for event in events if event.get("access_path") == "x" and event.get("preview") == 1]
        self.assertTrue(old)
        self.assertFalse(any(self.reaches(events, event["value_id"], copied["value_id"]) for event in old))
        for statement in (
            "for item in iterate():\n            x = 1",
            "with Context():\n            x = 1",
        ):
            with self.subTest(statement=statement):
                source = '''calls = []
class Context:
    def __enter__(self):
        calls.append("enter")
        return self
    def __exit__(self, *error):
        global x
        calls.append("exit")
        x = 99
        raise ValueError("lifecycle")
def iterate():
    global x
    yield 0
    x = 99
    raise ValueError("lifecycle")
x = 1
try:
    try:
        ''' + statement + '''
    finally:
        y = x
except ValueError as error:
    message = str(error)
'''
                original = {}
                exec(source, original)
                namespace, events = self.run_source(source, fields=("x", "y"), preview=True)
                self.assertEqual((namespace["y"], namespace["message"], namespace["calls"]),
                                 (original["y"], original["message"], original["calls"]))
                copied = next(event for event in events if event.get("access_path") == "y")
                old = [event for event in events if event.get("access_path") == "x" and event.get("preview") == 1]
                self.assertTrue(old)
                self.assertFalse(any(self.reaches(events, event["value_id"], copied["value_id"]) for event in old))

    def test_declarations_replace_existing_binding_and_recursive_returns_stay_scoped(self):
        source = '''
def changed(input):
    target = input
    def target():
        return "new"
    return target
def countdown(value):
    if value == 0:
        return value
    next_value = value - 1
    return countdown(next_value)
answer = changed("old"), countdown(3)
'''
        namespace, events = self.run_source(source)
        self.assertTrue(callable(namespace["answer"][0]))
        self.assertEqual(namespace["answer"][1], 0)
        parameter = next(e for e in events if e["operation"] == "value" and e.get("access_path") == "input")
        returned = next(e for e in events if e["operation"] == "return")
        self.assertFalse(self.reaches(events, parameter["value_id"], returned["value_id"]))
        countdown = [e for e in events if e["operation"] == "value" and e.get("access_path") == "value"]
        self.assertEqual(len({e["invocation_id"] for e in countdown}), 4)

    def test_real_launcher_imports_scoped_sources_without_rewriting_them(self):
        batches = []
        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                batches.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as root:
                root = Path(root)
                helper = root / "helper.py"
                helper.write_text("def flow(email):\n    copied = email\n    return copied\n")
                main = root / "main.py"
                main.write_text("from helper import flow\nmarker = 'main'\nimport __main__\nassert __main__.marker == marker\nprint(flow('test'))\n")
                originals = {path: path.read_bytes() for path in (main, helper)}
                env = {**os.environ, "CBM_CAPTURE_ENDPOINT": "http://127.0.0.1:%d/v1/cbm/lineage?session=test" % server.server_port,
                       "CBM_CAPTURE_TOKEN": "test-token", "CBM_CAPTURE_FIELDS": "[]", "CBM_CAPTURE_VALUES": "0"}
                result = subprocess.run([sys.executable, str(Path(capture.__file__).resolve()), "--root", str(root), "--script", str(main)], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "test\n")
                self.assertEqual(originals, {path: path.read_bytes() for path in originals})
                self.assertFalse((root / "__pycache__").exists())
                events = [event for batch in batches for event in batch["events"]]
                self.assertTrue(any(event["source"]["file_path"] == "helper.py" and event["operation"] == "return" for event in events))
                self.assertFalse(any("preview" in event for event in events))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_source_policy_and_event_budget_are_bounded(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            source = Path(root, "module.py")
            source.write_text("value = 1\n")
            link = Path(root, "linked.py")
            link.symlink_to(Path(outside, "hidden.py"))
            Path(outside, "hidden.py").write_text("value = 2\n")
            self.assertTrue(capture.eligible_source(source, root))
            self.assertFalse(capture.eligible_source(link, root))
            self.assertFalse(capture.eligible_source(Path(root, ".venv/lib/pkg.py"), root))
        events = []
        runtime = capture.Runtime(events.extend, max_events=8)
        with patch.object(capture, "runtime", runtime):
            exec(compile(capture.instrument("def f(x):\n return x\nfor i in range(100):\n f(i)\n", "many.py"), "many.py", "exec"), {})
            runtime.flush()
        self.assertLessEqual(len(events), 8)
        self.assertEqual(events[-1]["operation"], "gap")


if __name__ == "__main__":
    unittest.main()
