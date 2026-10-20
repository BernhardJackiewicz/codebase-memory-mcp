"""Run real Java/Kotlin bytecode with and without the scoped JVM agent."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

import build


class JvmPreviewBoundaryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="cbm-jvm-preview-")
        cls.classes = Path(cls.temporary.name)
        harness = cls.classes / "PreviewHarness.java"
        harness.write_text(r'''import java.lang.reflect.Method;
public class PreviewHarness {
 public static void main(String[] args) throws Exception {
  Method preview=Class.forName("cbm.capture.Probe").getDeclaredMethod("preview",Object.class);
  preview.setAccessible(true);
  if(args[0].equals("large")) {
   System.out.println(preview.invoke(null,"x".repeat(500000)));
   return;
  }
  String emoji=new String(Character.toChars(0x1f600));
  String[] values={"", "x".repeat(256), "x".repeat(257),
   "\u00e9".repeat(128), "\u00e9".repeat(129),
   "\u4e2d".repeat(85)+"a", "\u4e2d".repeat(86),
   "x".repeat(252)+emoji, "x".repeat(255)+emoji,
   String.valueOf((char)0xd800)+"a", String.valueOf((char)0xdc00)+"b",
   "x".repeat(255)+String.valueOf((char)0xd800), "line\n\"quoted\"\\end"};
  for(String value:values) System.out.println(preview.invoke(null,value));
  System.out.println(preview.invoke(null,Character.valueOf((char)0xd800)));
  System.out.println(preview.invoke(null,new Object(){public String toString(){throw new AssertionError("no user serialization");}}));
 }
}''')
        subprocess.run([build.tool("javac"), "--release", "17", "-d", str(cls.classes),
                        str(Path(__file__).parent / "src/cbm/capture/Probe.java"), str(harness)],
                       capture_output=True, text=True, check=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def preview(self, mode):
        return subprocess.run([build.tool("java"), "-Xmx32m", "-cp", str(self.classes),
                               "PreviewHarness", mode], capture_output=True, text=True,
                              check=True, timeout=5)

    def test_large_string_preview_has_bounded_work_and_allocation(self):
        result = self.preview("large")
        self.assertEqual(json.loads(result.stdout), "x" * 256)

    def test_unicode_prefix_respects_utf8_boundary_without_split_or_invalid_surrogates(self):
        result = self.preview("unicode")
        actual = [json.loads(line) for line in result.stdout.splitlines()]
        expected = ["", "x" * 256, "x" * 256, "é" * 128, "é" * 128,
                    "中" * 85 + "a", "中" * 85, "x" * 252 + "😀", "x" * 255,
                    "\ufffda", "\ufffdb", "x" * 255, 'line\n"quoted"\\end', "\ufffd", None]
        self.assertEqual(actual, expected)
        for value in actual:
            if value is not None:
                self.assertLessEqual(len(value.encode("utf-8")), 256)


class JvmCaptureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agent_temp = tempfile.TemporaryDirectory(prefix="cbm-jvm-agent-test-")
        cls.agent = build.build_agent(cls.agent_temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.agent_temp.cleanup()

    def execute(self, source, *, language="java", main="Fixture", previews=False, fields=(), live=False, mutate_source=False):
        events, requests = [], []

        class Receiver(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((dict(self.headers), body))
                events.extend(body["events"])
                self.send_response(202)
                self.end_headers()

            def log_message(self, *_):
                pass

        receiver = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        thread = threading.Thread(target=receiver.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="cbm-jvm-source-") as root, tempfile.TemporaryDirectory(prefix="cbm-jvm-overlay-") as overlay:
                filename = "Fixture.kt" if language == "kotlin" else "Fixture.java"
                path = Path(root, filename)
                path.write_bytes(source.encode())
                artifact = build.build_overlay(root, overlay, language)
                class_hashes = {p.relative_to(artifact["classes"]).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in Path(artifact["classes"]).rglob("*.class")}
                if mutate_source:
                    path.write_text(source + "\n// changed after compilation\n")
                command = [build.tool("java"), "-cp", artifact["classpath"], main]
                original = subprocess.run(command, text=True, capture_output=True, timeout=30)
                environment = {key: value for key, value in os.environ.items() if not key.startswith("CBM_CAPTURE_")}
                environment.update(CBM_CAPTURE_ENDPOINT="http://127.0.0.1:%d/v1/cbm/lineage?session=%s" % (receiver.server_port, "a" * 32),
                                   CBM_CAPTURE_TOKEN="local-test-token", CBM_CAPTURE_VALUES="1" if previews else "0",
                                   CBM_CAPTURE_FIELDS=json.dumps(list(fields)))
                launch = [command[0], "-javaagent:%s=%s" % (self.agent, artifact["manifest"]), *command[1:]]
                if live:
                    child = subprocess.Popen(launch, env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                    try:
                        deadline = time.monotonic() + .8
                        while not events and time.monotonic() < deadline:
                            time.sleep(.01)
                        self.assertTrue(events, "A running development app must flush before shutdown or a full batch")
                        self.assertIsNone(child.poll(), "This assertion must occur while the real JVM is still running")
                        stdout, stderr = child.communicate(timeout=30)
                        instrumented = subprocess.CompletedProcess(launch, child.returncode, stdout, stderr)
                    finally:
                        if child.poll() is None:
                            child.terminate()
                            child.communicate(timeout=5)
                else:
                    instrumented = subprocess.run(launch, env=environment, text=True, capture_output=True, timeout=30)
                self.assertEqual(instrumented.returncode, original.returncode, instrumented.stderr)
                self.assertEqual(instrumented.stdout, original.stdout)
                self.assertEqual(path.read_bytes(), (source + ("\n// changed after compilation\n" if mutate_source else "")).encode())
                self.assertEqual(class_hashes, {p.relative_to(artifact["classes"]).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                                               for p in Path(artifact["classes"]).rglob("*.class")})
                self.assertNotIn("local-test-token", instrumented.stderr)
                self.assertTrue(events, "The real JVM agent must produce events from executed bytecode")
                self.assertTrue(all(e["source"]["source_hash"] == hashlib.sha256(source.encode()).hexdigest() for e in events))
                self.assertTrue(all(e["source"]["file_path"] == filename and e["source"]["line"] >= 1 for e in events))
                self.assertEqual([e["sequence"] for e in events], list(range(1, len(events) + 1)))
                self.assertTrue(all(body["schema_version"] == 1 for _, body in requests))
                return events, instrumented.stdout
        finally:
            receiver.shutdown()
            receiver.server_close()
            thread.join(timeout=2)

    def reaches(self, events, source, target):
        links = {event.get("value_id"): event.get("inputs", []) for event in events}
        todo, seen = [target], set()
        while todo:
            current = todo.pop()
            if current == source:
                return True
            if current not in seen:
                seen.add(current)
                todo.extend(links.get(current, []))
        return False

    def test_actual_scalar_copy_transform_and_overwrite(self):
        events, output = self.execute('''public class Fixture {
 static int flow(int input) {
  int copied = input;
  int computed = copied + 1;
  int discarded = input;
  discarded = 9;
  return computed;
 }
 public static void main(String[] args) { System.out.println(flow(41)); }
}''')
        self.assertEqual(output, "42\n")
        parameter = next(e for e in events if e["operation"] == "value" and e.get("access_path") == "input")
        returned = next(e for e in events if e["operation"] == "return" and ".flow(" in e["source"]["symbol"])
        writes = [e for e in events if e["operation"] == "copy" and e.get("access_path") == "discarded"]
        self.assertEqual(len(writes), 2)
        self.assertTrue(self.reaches(events, parameter["value_id"], returned["value_id"]))
        self.assertTrue(self.reaches(events, parameter["value_id"], writes[0]["value_id"]))
        self.assertFalse(self.reaches(events, parameter["value_id"], writes[1]["value_id"]))
        self.assertTrue(any(e["operation"] == "transform" and e["inputs"] for e in events))
        self.assertFalse(any("preview" in e for e in events))

    def test_kotlin_real_compiler_and_invocation_ports(self):
        events, output = self.execute('''fun identity(value: Int): Int { val copied = value; return copied }
fun flow(input: Int): Int {
 val first = identity(input)
 val second = identity(9)
 return first + 1
}
fun main() { println(flow(41)) }
''', language="kotlin", main="FixtureKt")
        self.assertEqual(output, "42\n")
        parameters = [e for e in events if e["operation"] == "value" and e.get("access_path") == "value"]
        self.assertEqual(len(parameters), 2)
        returned = next(e for e in events if e["operation"] == "return" and ".flow(" in e["source"]["symbol"])
        self.assertNotEqual(parameters[0]["invocation_id"], parameters[1]["invocation_id"])
        self.assertTrue(self.reaches(events, parameters[0]["value_id"], returned["value_id"]))
        self.assertFalse(self.reaches(events, parameters[1]["value_id"], returned["value_id"]))

    def test_live_delivery_does_not_wait_for_exit_or_full_batch(self):
        self.execute('''public class Fixture {
 static int flow(int input) { int copied=input; return copied; }
 public static void main(String[] args) throws Exception {
  System.out.println(flow(42));
  Thread.sleep(1800);
 }
}''', live=True)

    def test_identical_values_recursive_calls_and_threads_do_not_merge(self):
        events, output = self.execute('''public class Fixture {
 static int left, right;
 static int identity(int value) { int copied=value; return copied; }
 static int flow(int input) { int first=identity(input); int second=identity(input); return first; }
 static int recurse(int input,int depth) { if(depth==0)return input; return recurse(input,depth-1); }
 public static void main(String[] args) throws Exception {
  Thread a=new Thread(()->{left=flow(7);});
  Thread b=new Thread(()->{right=flow(7);});
  a.start(); b.start(); a.join(); b.join();
  System.out.println(left+right+recurse(3,2));
 }
}''')
        self.assertEqual(output, "17\n")
        identities = [e for e in events if e["operation"] == "value" and e.get("access_path") == "value"]
        self.assertEqual(len(identities), 4)
        returns = [e for e in events if e["operation"] == "return" and ".flow(" in e["source"]["symbol"]]
        self.assertEqual(len(returns), 2)
        for returned in returns:
            connected = [p for p in identities if self.reaches(events, p["value_id"], returned["value_id"])]
            self.assertEqual(len(connected), 1, "Neither equal values nor another invocation may join this return")
        recursive = [e for e in events if e["operation"] == "value" and e.get("access_path") == "input" and ".recurse(" in e["source"]["symbol"]]
        self.assertEqual(len({e["invocation_id"] for e in recursive}), 3)

    def test_actual_field_reads_do_not_replay_getters_or_custom_conversions(self):
        events, output = self.execute('''public class Fixture {
 static class Trap {
  public String toString(){throw new AssertionError("conversion");}
  public boolean equals(Object other){throw new AssertionError("equality");}
 }
 static class Box {
  int reads; String email="sample@example";
  String get(){ reads++; return email; }
 }
 static String flow(Box box,Trap secret) { String first=box.get(); String second=box.get(); return first; }
 public static void main(String[] args) {
  Box box=new Box(); System.out.println(flow(box,new Trap())); System.out.println(box.reads);
 }
}''', previews=True, fields=("Fixture$Box.email", "secret"))
        self.assertEqual(output, "sample@example\n2\n")
        reads = [e for e in events if e["operation"] == "field" and e.get("access_path") == "Fixture$Box.email"]
        self.assertEqual(len(reads), 2)
        self.assertTrue(all(e["inputs"] == [] and e["preview"] == "sample@example" for e in reads))
        self.assertTrue(all(e.get("access_path") == "Fixture$Box.email" for e in events if "preview" in e))
        self.assertTrue(any(e["operation"] == "gap" and "heap" in e.get("detail", "") for e in events))

    def test_exceptions_short_circuit_and_wide_stack_values_preserve_behavior(self):
        events, output = self.execute('''public class Fixture {
 static int calls;
 static int fail(int value) { calls++; throw new IllegalArgumentException("same"); }
 static long flow(long input) {
  long copied=input; long[] array={0}; array[0]=copied++;
  boolean skipped=false && fail(99)>0;
  try { fail(4); } catch(IllegalArgumentException error) { copied+=2; }
  return copied+array[0];
 }
 public static void main(String[] args) { System.out.println(flow(5));System.out.println(calls); }
}''')
        self.assertEqual(output, "13\n1\n")
        failing = [e for e in events if e["operation"] == "value" and e.get("access_path") == "value"]
        self.assertEqual(len(failing), 1)
        self.assertTrue(any(e["operation"] == "gap" and "exception" in e.get("detail", "").lower() for e in events))

    def test_stale_source_is_not_attached_to_compiled_execution(self):
        events, output = self.execute('''public class Fixture {
 static int flow(int input) { return input; }
 public static void main(String[] args) { System.out.println(flow(42)); }
}''', mutate_source=True)
        self.assertEqual(output, "42\n")
        self.assertTrue(all(e["operation"] == "gap" for e in events))
        self.assertTrue(any("Source hash changed" in e.get("detail", "") for e in events))

    def test_exact_final_string_transformations_retain_receiver_provenance(self):
        events, output = self.execute('''public class Fixture {
 static String flow(String email) {
  String copied=email;
  String normalized=copied.trim().toLowerCase();
  return normalized;
 }
 public static void main(String[] args) { System.out.println(flow("  SAMPLE@EXAMPLE  ")); }
}''')
        self.assertEqual(output, "sample@example\n")
        parameter = next(e for e in events if e["operation"] == "value" and e.get("access_path") == "email")
        returned = next(e for e in events if e["operation"] == "return" and ".flow(" in e["source"]["symbol"])
        self.assertTrue(self.reaches(events, parameter["value_id"], returned["value_id"]))
        self.assertEqual(len([e for e in events if e["operation"] == "transform"]), 2)

    def test_overlay_reuse_cannot_bind_old_classes_to_new_source_bytes(self):
        with tempfile.TemporaryDirectory(prefix="cbm-jvm-source-") as root, tempfile.TemporaryDirectory(prefix="cbm-jvm-overlay-") as overlay:
            source = Path(root, "Fixture.java")
            source.write_text("public class Fixture { static class Removed {} }")
            build.build_overlay(root, overlay)
            source.write_text("public class Fixture {}")
            with self.assertRaisesRegex(ValueError, "new|empty|existing"):
                build.build_overlay(root, overlay)


if __name__ == "__main__":
    unittest.main()
