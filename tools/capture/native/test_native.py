import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import instrument


class NativeOverlayTests(unittest.TestCase):
    def fixture(self, source, language="cpp", fields=()):
        with tempfile.TemporaryDirectory(prefix="cbm-native-fixture-") as temporary:
            base = Path(temporary)
            root, out = base / "project", base / "overlay"
            root.mkdir()
            out.mkdir()
            path = root / ("main." + language)
            path.write_text(source)
            compiler = "clang++" if language == "cpp" else "clang"
            flags = ["-std=c++17"] if language == "cpp" else ["-std=c11"]
            plain = base / "plain"
            compiled = subprocess.run([compiler, *flags, str(path), "-o", str(plain)],
                                      text=True, capture_output=True, timeout=30)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            original = subprocess.run([str(plain)], text=True, capture_output=True, timeout=5)
            manifest = Path(instrument.generate(str(root), [str(path)], str(out), compiler, flags))
            config = json.loads(manifest.read_text())
            binary = base / "observed"
            compiled = subprocess.run([os.sys.executable, str(Path(__file__).with_name("build.py")),
                                       "--manifest", str(manifest), "--output", str(binary)],
                                      text=True, capture_output=True, timeout=30)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            events = base / "events.json"
            environment = {key: value for key, value in os.environ.items()
                           if not key.startswith("CBM_CAPTURE_")}
            launched = subprocess.run(
                [os.sys.executable, str(Path(__file__).with_name("launch.py")), "--events", str(events),
                 "--", str(binary)], text=True, capture_output=True, timeout=10,
                env={**environment, "CBM_CAPTURE_VALUES": "1" if fields else "0",
                     "CBM_CAPTURE_FIELDS": json.dumps(list(fields))})
            self.assertEqual((launched.returncode, launched.stdout), (original.returncode, original.stdout),
                             launched.stderr)
            self.assertEqual(path.read_text(), source)
            records = json.loads(events.read_text())
            digest = hashlib.sha256(source.encode()).hexdigest()
            self.assertTrue(records)
            for record in records:
                self.assertEqual(record["source"]["source_hash"], digest)
                self.assertEqual(record["source"]["file_path"], path.name)
                self.assertGreater(record["source"]["line"], 0)
                if "preview" in record:
                    self.assertIn(record["access_path"], fields)
            return records, launched.stdout

    def test_cpp_actual_scalar_parameter_transform_return(self):
        records, output = self.fixture("""#include <stdio.h>
int flow(int input) { int copied=input; int transformed=copied+3; return transformed; }
int main() { printf("%d\\n",flow(4)); }
""")
        self.assertEqual(output, "7\n")
        selected = [event for event in records if event["source"]["symbol"] == "flow"]
        self.assertTrue(any(event["operation"] == "transform" and event["inputs"] for event in selected))
        self.assertTrue(any(event["operation"] == "return" and event["inputs"] for event in selected))

    def test_c_overwrite_kills_parameter_and_preserves_actual_output(self):
        records, output = self.fixture("""#include <stdio.h>
int flow(int input) { int output=input; output=9; return output; }
int main(void) { printf("%d\\n",flow(4)); return 0; }
""", "c")
        self.assertEqual(output, "9\n")
        selected = [event for event in records if event["source"]["symbol"] == "flow"]
        parameter = next(event["value_id"] for event in selected if event["operation"] == "value")
        seen = {parameter}
        for event in records:
            if any(value in seen for value in event["inputs"]):
                seen.add(event["value_id"])
        returned = next(event for event in selected if event["operation"] == "return")
        self.assertNotIn(returned["value_id"], seen)

    def test_pointer_reference_volatile_shapes_execute_unchanged_with_gap(self):
        records, output = self.fixture("""#include <stdio.h>
void mutate(int &value) { value+=2; }
int flow(volatile int *value) { return *value; }
int main() { int x=3; mutate(x); printf("%d\\n",flow(&x)); }
""")
        self.assertEqual(output, "5\n")
        self.assertTrue(any(event["operation"] == "gap" for event in records))
        self.assertFalse(any(event["inputs"] for event in records
                             if event["source"]["symbol"] in {"mutate", "flow"}))

    def test_cpp_scope_destructors_invalidate_values_after_actual_scope_exit(self):
        scopes = [
            "{ Box box(x); x=42; }",
            "if (true) { Box box(x); x=42; }",
            "{ Box box(x); { x=42; } }",
        ]
        for scope in scopes:
            with self.subTest(scope=scope):
                records, output = self.fixture("""#include <stdio.h>
struct Box { int &target; Box(int &value):target(value){} ~Box(){target=0;} };
int flow() { int x=0; """ + scope + """ return x; }
int main() { printf("%d\\n",flow()); }
""", fields=("x",))
                self.assertEqual(output, "0\n")
                selected = [event for event in records if event["source"]["symbol"] == "flow"]
                seeds = {event["value_id"] for event in selected
                         if event.get("preview") == 42 and event.get("access_path") == "x"}
                self.assertTrue(seeds, "The pre-destruction scalar assignment must remain observable")
                reached = set(seeds)
                for event in selected:
                    if any(value in reached for value in event["inputs"]):
                        reached.add(event["value_id"])
                returned = next(event for event in selected if event["operation"] == "return")
                self.assertNotIn(returned["value_id"], reached,
                                 "Scope destruction must not preserve the previous scalar provenance")
                for event in selected:
                    if event.get("preview") == 0 and event.get("access_path") == "x":
                        self.assertNotIn(event["value_id"], reached)
                self.assertTrue(any(event["operation"] == "gap" for event in selected))

    def test_cpp_primitive_scopes_and_return_evaluation_keep_valid_transport(self):
        scopes = [
            "int x=42; { int y=1; y=2; } return x;",
            "int x=0; { Box box(x); x=42; return x; }",
        ]
        for body in scopes:
            with self.subTest(body=body):
                records, output = self.fixture("""#include <stdio.h>
struct Box { int &target; Box(int &value):target(value){} ~Box(){target=0;} };
int flow() { """ + body + """ }
int main() { printf("%d\\n",flow()); }
""", fields=("x",))
                self.assertEqual(output, "42\n")
                selected = [event for event in records if event["source"]["symbol"] == "flow"]
                reached = {event["value_id"] for event in selected
                           if event.get("preview") == 42 and event.get("access_path") == "x"}
                self.assertTrue(reached)
                for event in selected:
                    if any(value in reached for value in event["inputs"]):
                        reached.add(event["value_id"])
                returned = next(event for event in selected if event["operation"] == "return")
                self.assertIn(returned["value_id"], reached)

    def test_named_scalar_conversion_and_cpp_exception_semantics_preserved(self):
        records, output = self.fixture("""#include <stdio.h>
short narrow(short input) { return input+2; }
int failing() { throw 7; }
int main() { try { failing(); } catch(int value) { printf("%d %d\\n",narrow(3),value); } }
""")
        self.assertEqual(output, "5 7\n")
        self.assertTrue(any(event["source"]["symbol"] == "narrow" for event in records))

    def test_shadowing_loop_writes_and_struct_field_are_distinct_occurrences(self):
        records, output = self.fixture("""#include <stdio.h>
struct User { int points; };
int shadow(int input) { int output=input; {int output=8; output=9;} return output; }
int changed(int input) { int output=input; for(int i=0;i<2;i++) output=8; return output; }
int field(int input) { struct User user={6}; return user.points; }
int main() { printf("%d %d %d\\n",shadow(3),changed(3),field(3)); }
""")
        self.assertEqual(output, "3 8 6\n")
        for symbol, reaches in (("shadow", True), ("changed", False)):
            selected = [event for event in records if event["source"]["symbol"] == symbol]
            parameter = next(event["value_id"] for event in selected if event["operation"] == "value")
            seen = {parameter}
            for event in selected:
                if any(value in seen for value in event["inputs"]):
                    seen.add(event["value_id"])
            returned = next(event for event in selected if event["operation"] == "return")
            self.assertEqual(returned["value_id"] in seen, reaches)
        self.assertTrue(any(event["operation"] == "field" and event["access_path"] == "points"
                            and not event["inputs"] for event in records))

    def test_preview_requires_explicit_exact_integral_field_allowlist(self):
        source = """#include <stdio.h>
int flow(int allowed, int private_value) { int output=allowed+private_value; return output; }
int main() { printf("%d\\n",flow(3,11)); }
"""
        records, _ = self.fixture(source, fields=("allowed",))
        self.assertTrue(any(event.get("preview") == 3 and event["access_path"] == "allowed" for event in records))
        metadata, _ = self.fixture(source)
        self.assertFalse(any("preview" in event for event in metadata))

    def test_fork_never_reuses_parent_producer_sequence_or_invocation(self):
        records, output = self.fixture("""#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>
int flow(int input) { return input+1; }
int main(void) { int first=flow(1); int pid=fork(); if(pid==0) {_exit(flow(3)-4);}
waitpid(pid,0,0); printf("%d\\n",first); return 0; }
""", "c")
        self.assertEqual(output, "2\n")
        sequences = [event["sequence"] for event in records]
        self.assertEqual(len(sequences), len(set(sequences)), "fork child duplicated producer sequence")
        observed_parameters = [event for event in records
                               if event["source"]["symbol"] == "flow" and event["operation"] == "value"]
        self.assertEqual(len(observed_parameters), 1, "fork child requires a separately launched producer")

    def test_float_environment_sensitive_functions_are_explicitly_unobserved(self):
        records, output = self.fixture("""#include <stdio.h>
double flow(double input) { return input+0.5; }
int main(void) { printf("%.1f\\n",flow(2)); return 0; }
""", "c")
        self.assertEqual(output, "2.5\n")
        selected = [event for event in records if event["source"]["symbol"] == "flow"]
        self.assertTrue(selected)
        self.assertTrue(all(event["operation"] == "gap" for event in selected))

    def test_implicit_integral_conversion_has_its_own_transformation(self):
        records, output = self.fixture("""#include <stdio.h>
unsigned char flow(int input) { unsigned char output=input; return output; }
int main(void) { printf("%d\\n",flow(259)); return 0; }
""", "c", fields=("output",))
        self.assertEqual(output, "3\n")
        selected = [event for event in records if event["source"]["symbol"] == "flow"]
        self.assertTrue(any(event["operation"] == "transform" and event["inputs"] for event in selected))
        self.assertTrue(any(event.get("preview") == 3 for event in selected))

    def test_address_taken_callbacks_are_not_instrumented_as_synchronous_functions(self):
        records, output = self.fixture("""#include <stdio.h>
int callback(int input) { return input+1; }
int apply(int (*function)(int)) { return function(4); }
int main(void) { printf("%d\\n",apply(callback)); return 0; }
""", "c")
        self.assertEqual(output, "5\n")
        self.assertFalse(any(event["source"]["symbol"] == "callback" for event in records))

    def test_file_and_line_macros_keep_original_compiler_source_spelling(self):
        self.fixture("""#include <stdio.h>
int flow(int input) {
    if (
        input
    ) {
        input=3;
    }
    printf("%s:%d\\n", __FILE__, __LINE__);
    return input;
}
int main(void) { return flow(0); }
""", "c")

    def test_source_edit_during_ast_analysis_cannot_publish_mismatched_probe_evidence(self):
        with tempfile.TemporaryDirectory(prefix="cbm-native-changing-") as temporary:
            root = Path(temporary) / "project"
            root.mkdir()
            path = root / "main.c"
            path.write_text("int flow(int input) { return input; }\n")
            original_run = subprocess.run

            def concurrent_edit(*args, **kwargs):
                path.write_text("int flow(int input) { return 9; }\n")
                return original_run(*args, **kwargs)

            with patch.object(instrument.subprocess, "run", side_effect=concurrent_edit):
                with self.assertRaisesRegex(ValueError, "changed during"):
                    instrument.generate(root, [path], Path(temporary) / "overlay", "clang", ["-std=c11"])


if __name__ == "__main__":
    unittest.main()
