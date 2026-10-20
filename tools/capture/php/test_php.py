"""Execute actual PHP source overlays against a local receiver."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

HERE = Path(__file__).resolve().parent
PHP = shutil.which("php")

@unittest.skipUnless(PHP, "An existing PHP 8 runtime is required")
class PhpCaptureTest(unittest.TestCase):
    @staticmethod
    def reaches(events, origin, target):
        reachable = {origin}
        for event in events:
            if any(value in reachable for value in event["inputs"]):
                reachable.add(event["value_id"])
        return target in reachable

    def assert_lifetime_boundary(self, setup, release, returned="x"):
        source = '''<?php
class Box {
 private $target;
 function __construct(&$target) { $this->target =& $target; }
 function __destruct() { echo "destroyed\\n"; $this->target = 0; }
}
function flow() {
 $x = 0;
''' + setup + "\n" + release + "\n return $" + returned + ''';\n}
echo flow(), "\\n";
'''
        output, events = self.capture(source, fields=["x", "obj", "items"], values=True)
        self.assertEqual(output, "destroyed\n0\n")
        flow = [event for event in events if event["source"]["symbol"] == "flow"]
        old = [event for event in flow if event.get("preview") == 42]
        self.assertTrue(old, "The actual scalar occurrence must remain observable")
        returned_event = next(event for event in reversed(flow) if event["operation"] == "return")
        for event in old:
            self.assertFalse(self.reaches(events, event["value_id"], returned_event["value_id"]),
                             "A release that changes locals must not retain old scalar lineage")
        self.assertTrue(any(event["operation"] == "gap" and "lifetime" in event.get("detail", "").lower()
                            for event in flow), "Unknown object release needs an explicit lifetime gap")

    def test_destructor_rebinding_another_local_does_not_reuse_scalar_lineage(self):
        self.assert_lifetime_boundary(" $obj = new Box($x);\n $x = 42;", " $obj = null;")

    def test_destructor_rebinding_the_assignment_target_does_not_publish_rhs_as_binding(self):
        self.assert_lifetime_boundary(" $x = new Box($x);", " $x = 42;")

    def test_array_release_with_nested_destructor_has_no_old_local_lineage(self):
        self.assert_lifetime_boundary(" $items = [new Box($x)];\n $x = 42;", " $items = null;")

    def test_primitive_assignment_keeps_lineage_and_kills_overwritten_version(self):
        output, events = self.capture('''<?php
function flow($input) {
 $copied = $input;
 $output = $copied + 1;
 $copied = 42;
 return $output;
}
echo flow(7), "\\n";
''', fields=["input", "copied"], values=True)
        self.assertEqual(output, "8\n")
        parameter = next(event for event in events if event["operation"] == "value" and event.get("access_path") == "input")
        overwritten = next(event for event in events if event.get("access_path") == "copied" and event.get("preview") == 42)
        returned = next(event for event in events if event["operation"] == "return")
        self.assertTrue(self.reaches(events, parameter["value_id"], returned["value_id"]))
        self.assertFalse(self.reaches(events, overwritten["value_id"], returned["value_id"]))

    def test_observed_scalar_field_result_can_flow_through_a_safe_store(self):
        output, events = self.capture('''<?php
class Profile { function __get($name) { return 7; } }
function flow($profile) {
 $copied = $profile->value;
 return $copied;
}
echo flow(new Profile()), "\\n";
''')
        self.assertEqual(output, "7\n")
        field = next(event for event in events if event["operation"] == "field")
        returned = next(event for event in events if event["operation"] == "return" and event["source"]["symbol"] == "flow")
        self.assertTrue(self.reaches(events, field["value_id"], returned["value_id"]))

    def test_observed_scalar_call_result_can_flow_through_a_safe_store(self):
        output, events = self.capture('''<?php
function scalar_value() { return 7; }
function flow() {
 $copied = scalar_value();
 return $copied;
}
echo flow(), "\\n";
''')
        self.assertEqual(output, "7\n")
        flow = [event for event in events if event["source"]["symbol"] == "flow"]
        observed = next(event for event in flow if event["operation"] == "value")
        returned = next(event for event in flow if event["operation"] == "return")
        self.assertTrue(self.reaches(events, observed["value_id"], returned["value_id"]))

    def test_old_target_is_classified_after_rhs_side_effects(self):
        output, events = self.capture('''<?php
class Box {
 private $target;
 function __construct(&$target) { $this->target =& $target; }
 function __destruct() { echo "destroyed\\n"; $this->target = 0; }
}
function prepare(&$target) { $target = new Box($target); return 42; }
function flow() {
 $x = 0;
 $x = prepare($x);
 return $x;
}
echo flow(), "\\n";
''', fields=["x"], values=True)
        self.assertEqual(output, "destroyed\n0\n")
        flow = [event for event in events if event["source"]["symbol"] == "flow"]
        assigned = next(event for event in flow if event.get("preview") == 42)
        returned = next(event for event in flow if event["operation"] == "return")
        self.assertFalse(self.reaches(events, assigned["value_id"], returned["value_id"]))
        self.assertTrue(any("lifetime" in event.get("detail", "").lower() for event in flow))

    def test_scalar_store_coercion_is_not_a_copy_of_the_rhs(self):
        source = '''<?php
class TypedReference {
 public int $number;
 function __construct(&$number) { $this->number =& $number; }
}
function flow() {
 $x = 0;
 $reference = new TypedReference($x);
 $x = 3.0;
 return $x;
}
echo flow(), "\\n";
'''
        output, events = self.capture(source, fields=["x"], values=True)
        self.assertEqual(output, "3\n")
        flow = [event for event in events if event["source"]["symbol"] == "flow"]
        literal = next(event for event in flow if event["operation"] == "value" and event["source"]["line"] == 9)
        returned = next(event for event in flow if event["operation"] == "return")
        self.assertFalse(self.reaches(events, literal["value_id"], returned["value_id"]),
                         "A coerced store result is not unchanged RHS value transport")
        self.assertTrue(any("coercion" in event.get("detail", "").lower() for event in flow))

    def test_fresh_scalar_lineage_recovers_after_unknown_release(self):
        output, events = self.capture('''<?php
class Box {
 private $target;
 function __construct(&$target) { $this->target =& $target; }
 function __destruct() { $this->target = 0; }
}
function flow() {
 $x = 0;
 $obj = new Box($x);
 $x = 42;
 $obj = null;
 $fresh = 7;
 return $fresh;
}
echo flow(), "\\n";
''', fields=["fresh"], values=True)
        self.assertEqual(output, "7\n")
        flow = [event for event in events if event["source"]["symbol"] == "flow"]
        fresh = next(event for event in flow if event.get("access_path") == "fresh" and event.get("preview") == 7)
        returned = next(event for event in flow if event["operation"] == "return")
        self.assertTrue(self.reaches(events, fresh["value_id"], returned["value_id"]))

    def capture(self, source, fields=(), values=False, live=False):
        received = []
        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                received.extend(json.loads(self.rfile.read(int(self.headers["Content-Length"])))["events"])
                self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="cbm-php-") as directory:
                root = Path(directory); project = root / "project"; project.mkdir()
                (project / "app.php").write_text(source)
                original = subprocess.run([PHP, str(project / "app.php")], capture_output=True, text=True, timeout=10)
                self.assertEqual(original.returncode, 0, original.stderr)
                output = root / "overlay"
                prepared = subprocess.run([PHP, str(HERE / "overlay.php"), "--root", str(project), "--out", str(output)], capture_output=True, text=True, timeout=20)
                self.assertEqual(prepared.returncode, 0, prepared.stdout + prepared.stderr)
                env = {**os.environ, "CBM_CAPTURE_ENDPOINT": "http://127.0.0.1:%d/v1/cbm/lineage?session=test" % server.server_port,
                       "CBM_CAPTURE_TOKEN": "test-token", "CBM_CAPTURE_VALUES": "1" if values else "0", "CBM_CAPTURE_FIELDS": json.dumps(fields)}
                command = [PHP, "-d", "auto_prepend_file=" + str(output / ".cbm/Runtime.php"), str(output / "app.php")]
                if live:
                    process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    try:
                        first = process.stdout.readline()
                        deadline = time.monotonic() + .5
                        while not received and time.monotonic() < deadline:
                            time.sleep(.01)
                        self.assertTrue(received, "Completed function must be visible before the application exits")
                        self.assertIsNone(process.poll())
                        rest, errors = process.communicate(timeout=10)
                        actual = subprocess.CompletedProcess(command, process.returncode, first + rest, errors)
                    finally:
                        if process.poll() is None:
                            process.terminate(); process.communicate(timeout=2)
                else:
                    actual = subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(actual.returncode, original.returncode, actual.stdout + actual.stderr)
                self.assertEqual(actual.stdout, original.stdout)
                self.assertEqual((project / "app.php").read_text(), source)
                self.assertTrue(received, "No automatic PHP runtime observations")
                self.assertTrue(all(e["source"]["source_hash"] == hashlib.sha256(source.encode()).hexdigest() for e in received))
                self.assertTrue(all(e["sequence"] == index + 1 for index, e in enumerate(received)))
                return actual.stdout, received
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_parameters_assignment_transform_overwrite_and_return(self):
        source = '''<?php
function flow(string $email): string {
    $copied = $email;
    $output = $copied . ".test";
    $copied = "overwritten";
    return $output;
}
echo flow("sample@example"), "\\n";
'''
        output, events = self.capture(source)
        self.assertEqual(output, "sample@example.test\n")
        self.assertTrue(any(e["operation"] == "copy" and e["inputs"] for e in events))
        self.assertTrue(any(e["operation"] == "transform" and len(e["inputs"]) == 2 for e in events))
        self.assertTrue(any(e["operation"] == "return" and e["inputs"] for e in events))
        self.assertFalse(any("preview" in e for e in events))

    def test_getter_once_short_circuit_and_exact_field_preview(self):
        source = '''<?php
class Profile {
 public static int $reads = 0;
 function __get($name) { self::$reads++; return "sample@example.test"; }
}
function fail() { throw new Exception("must not execute"); }
function flow($profile) {
 $email = $profile->email;
 $skip = false && fail();
 return $email;
}
echo flow(new Profile()), "\\n", Profile::$reads, "\\n";
'''
        output, events = self.capture(source, fields=["profile.email"], values=True)
        self.assertEqual(output, "sample@example.test\n1\n")
        previews = [e for e in events if "preview" in e]
        self.assertTrue(previews)
        self.assertTrue(all(e["access_path"] == "profile.email" and e["preview"] == "sample@example.test" for e in previews))

    def test_references_closures_exceptions_and_dynamic_scope_are_preserved(self):
        source = '''<?php
function update(&$number) { $number++; }
function flow($value) {
 $original = $value;
 $callback = function () use (&$value) { $value = "changed"; };
 $callback();
 try { throw new Exception($value); } catch (Exception $e) { echo $e->getMessage(), "\\n"; }
 return $original;
}
$number = 2; update($number);
echo flow("before"), "\\n", $number, "\\n";
'''
        output, events = self.capture(source)
        self.assertEqual(output, "changed\nbefore\n3\n")
        self.assertTrue(any(e["operation"] == "gap" for e in events))

    def test_completed_function_is_delivered_while_process_is_still_running(self):
        self.capture('''<?php
function flow($value) { $copied = $value; return $copied; }
echo flow("ready"), "\\n"; fflush(STDOUT); sleep(2);
''', live=True)

    def test_introspection_body_remains_unchanged_without_added_local_variables(self):
        output, events = self.capture('''<?php
function flow($email) { return count(get_defined_vars()); }
echo flow("sample"), "\\n";
''')
        self.assertEqual(output, "1\n")
        self.assertTrue(any(e["operation"] == "gap" for e in events))

    def test_non_identifier_array_key_cannot_alias_an_allowed_nested_field(self):
        _, events = self.capture('''<?php
function flow($profile) { $value = $profile["private.email"]; return $value; }
echo flow(["private.email" => "private"]), "\\n";
''', fields=["profile.private.email"], values=True)
        self.assertFalse(any("preview" in e for e in events))
        self.assertTrue(any(e.get("access_path") == 'profile["private.email"]' for e in events))

if __name__ == "__main__":
    unittest.main()
