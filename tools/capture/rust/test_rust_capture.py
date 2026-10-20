"""Real rustc/cargo semantic tests; only disposable projects and loopback receivers."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import cbm_capture_rust as capture

LAUNCHER = Path(__file__).with_name("cbm_capture_rust.py")

DROP_SUPPORT = """struct Boxed(*mut i32);
impl Drop for Boxed { fn drop(&mut self) { unsafe { *self.0 = 0; } } }
impl Boxed { fn number(&self) -> i32 { 42 } }
fn number(_: &Boxed) -> i32 { 42 }
"""
LIFETIME_CASES = {
    "scope": "{ let obj = Boxed(&mut value); value = 42; }",
    "nested_scope": "{ { let obj = Boxed(&mut value); value = 42; } }",
    "extended_temporary": "{ let obj = &Boxed(&mut value); value = 42; }",
    "destructured_owner": "{ let (obj,) = (Boxed(&mut value),); value = 42; }",
    "replacement": "let mut obj = Boxed(&mut value); value = 42; obj = Boxed(&mut value);",
    "temporary_call": "value = number(&Boxed(&mut value));",
    "temporary_method": "value = Boxed(&mut value).number();",
}


def lifetime_source(body):
    return DROP_SUPPORT + "\nfn flow() -> i32 {\n let mut value = 0;\n " + body + "\n return value;\n}\nfn main() { println!(\"{}\", flow()); }\n"


def ancestors(events, target):
    links = {event["value_id"]: event["inputs"] for event in events}
    pending = list(links.get(target, []))
    visited = set()
    while pending:
        value = pending.pop()
        if value not in visited:
            visited.add(value)
            pending.extend(links.get(value, []))
    return visited


class CaptureTests(unittest.TestCase):
    def test_build_only_standalone_never_launches_the_application(self):
        with tempfile.TemporaryDirectory(prefix="cbm-rust-build-only-") as directory:
            root = Path(directory)
            source = root / "app.rs"
            source.write_text('fn main() { std::fs::write("application-ran", "unexpected").unwrap(); }\n')
            env = {**os.environ, "CBM_CAPTURE_ENDPOINT": "http://127.0.0.1:1/v1/cbm/lineage?session=test",
                   "CBM_CAPTURE_TOKEN": "test", "CBM_CAPTURE_VALUES": "0", "CBM_CAPTURE_FIELDS": "[]"}
            result = subprocess.run([sys.executable, str(LAUNCHER), "--root", str(root),
                                     "--source", str(source), "--action", "build"],
                                    env=env, text=True, capture_output=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((root / "application-ran").exists(),
                             "A build-only request executed the application")

    def test_concurrent_original_edit_cannot_change_the_hashed_parser_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="cbm-rust-snapshot-") as directory:
            root = Path(directory)
            source = root / "app.rs"
            before = 'fn main() { let value: i32 = 41; }\n'
            source.write_text(before)
            actual_command = capture.command
            parsed = []
            def edit_before_parser(args, **kwargs):
                if Path(args[0]).name == "cbm-rust-overlay":
                    source.write_text(before.replace("41", "99"))
                    result = actual_command(args, **kwargs)
                    parsed.append((args[2], result))
                    return result
                return actual_command(args, **kwargs)
            env = {"CBM_CAPTURE_ENDPOINT": "http://127.0.0.1:1/v1/cbm/lineage?session=test",
                   "CBM_CAPTURE_TOKEN": "test", "CBM_CAPTURE_VALUES": "0", "CBM_CAPTURE_FIELDS": "[]"}
            args = SimpleNamespace(root=str(root), source=str(source), manifest=None,
                                   edition="2021", action="build", arguments=[])
            with patch.dict(os.environ, env), patch.object(capture, "command", edit_before_parser):
                self.assertEqual(capture.launch(args), 0)
            self.assertEqual(len(parsed), 1)
            digest, transformed = parsed[0]
            self.assertEqual(digest, hashlib.sha256(before.encode()).hexdigest())
            self.assertRegex(transformed, r"\b41\b", "Parser observed changed original bytes under the old source hash")
            self.assertNotRegex(transformed, r"\b99\b")

    def launch(self, source, previews=False, modules=None, empty_cache=False, expected_stdout=None):
        batches = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.assert_token = self.headers.get("Authorization")
                body = self.rfile.read(int(self.headers["Content-Length"]))
                batches.append(json.loads(body))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="cbm-rust-test-") as tmp:
                root = Path(tmp)
                if modules is None:
                    entry = root / "app.rs"
                    entry.write_text(source)
                    build = ["rustc", "--edition=2021", str(entry), "-o", str(root / "original")]
                    args = ["--root", str(root), "--source", str(entry)]
                else:
                    (root / "src").mkdir()
                    entry = root / "src/main.rs"
                    entry.write_text(source)
                    for name, contents in modules.items():
                        (root / "src" / name).write_text(contents)
                    (root / "Cargo.toml").write_text('[package]\nname="capture_test"\nversion="0.1.0"\nedition="2021"\n')
                    build = ["cargo", "build", "--offline", "--quiet", "--manifest-path", str(root / "Cargo.toml")]
                    args = ["--root", str(root), "--manifest", "Cargo.toml"]
                original = subprocess.run(build, text=True, capture_output=True, timeout=90)
                self.assertEqual(original.returncode, 0, original.stderr)
                binary = root / "target/debug/capture_test" if modules else root / "original"
                expected = subprocess.run([str(binary)], text=True, capture_output=True, timeout=5)
                if expected_stdout is not None:
                    self.assertEqual(expected.stdout, expected_stdout)
                original_files = {str(file.relative_to(root)): hashlib.sha256(file.read_bytes()).hexdigest()
                                  for file in root.rglob("*") if file.is_file() and "target" not in file.parts and file.name != "original"}
                endpoint = "http://127.0.0.1:%d/v1/cbm/lineage?session=local-test" % server.server_port
                env = {**os.environ, "CBM_CAPTURE_ENDPOINT": endpoint, "CBM_CAPTURE_TOKEN": "local-test-token",
                       "CBM_CAPTURE_VALUES": "1" if previews else "0", "CBM_CAPTURE_FIELDS": '["value"]' if previews else "[]"}
                if empty_cache:
                    (root / "empty-cargo-home").mkdir()
                    env["CARGO_HOME"] = str(root / "empty-cargo-home")
                result = subprocess.run([sys.executable, str(LAUNCHER), *args], env=env, text=True, capture_output=True, timeout=120)
                self.assertEqual(result.returncode, expected.returncode, result.stderr)
                self.assertEqual(result.stdout, expected.stdout)
                self.assertNotIn("local-test-token", result.stderr)
                for name, digest in original_files.items():
                    self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), digest, name)
                events = [event for batch in batches for event in batch["events"]]
                self.assertTrue(events, "No actual Rust probes were received")
                self.assertTrue(all(batch["producer"]["language"] == "rust" for batch in batches))
                self.assertTrue(all(e["source"]["source_hash"] == original_files[e["source"]["file_path"]] for e in events))
                return events
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_shadow_overwrite_and_shortcircuit_preserve_original_semantics(self):
        source = """fn flow(input: i32) -> i32 {
 let mut value = input;
 { let value = 77; let unused = value + 1; }
 value = value + 2;
 let mut changed = false;
 let result = false && { changed = true; true };
 if changed { return 999; }
 return value;
}
fn main() { println!("{}", flow(5)); }
"""
        events = self.launch(source)
        self.assertTrue(any(e["operation"] == "transform" and e["inputs"] for e in events))
        self.assertTrue(any(e["operation"] == "return" for e in events))
        self.assertTrue(any(e["operation"] == "gap" for e in events))
        self.assertTrue(all("preview" not in e for e in events))

    def test_drop_lifetimes_do_not_connect_pre_drop_values_to_post_drop_reads_or_returns(self):
        for name, body in LIFETIME_CASES.items():
            with self.subTest(lifetime=name):
                events = self.launch(lifetime_source(body), previews=True, expected_stdout="0\n")
                selected = [event for event in events if event["source"]["symbol"] == "flow"]
                old = [event for event in selected if event.get("access_path") == "value" and event.get("preview") == 42]
                self.assertTrue(old, "The pre-drop scalar assignment must still be observed")
                after = [event for event in selected if event["sequence"] > old[-1]["sequence"]
                         and event.get("access_path") == "value" and event.get("preview") == 0]
                returned = [event for event in selected if event["operation"] == "return"]
                self.assertTrue(after, "The post-drop scalar read must still be observed")
                self.assertTrue(returned)
                for target in after + returned:
                    self.assertTrue({event["value_id"] for event in old}.isdisjoint(ancestors(selected, target["value_id"])),
                                    f"Destructor mutation has fabricated provenance: {name}: {target}")
                self.assertTrue(any(event["operation"] == "gap" for event in selected))

    def test_primitive_nested_scope_keeps_copy_transform_and_return_provenance(self):
        events = self.launch("""fn flow(input: i32) -> i32 {
 let mut value = input;
 { let copied = value; value = copied + 2; }
 return value;
}
fn main() { println!("{}", flow(40)); }
""", previews=True, expected_stdout="42\n")
        selected = [event for event in events if event["source"]["symbol"] == "flow"]
        parameter = next(event for event in selected if event.get("access_path") == "input")
        returned = next(event for event in selected if event["operation"] == "return")
        self.assertIn(parameter["value_id"], ancestors(selected, returned["value_id"]))
        self.assertTrue(any(event["operation"] == "transform" and event["inputs"] for event in selected))
        self.assertTrue(any(event["operation"] == "copy" and event["inputs"] for event in selected))

    def test_temporary_borrow_in_typed_scalar_binding_keeps_its_original_lifetime(self):
        events = self.launch("""fn flow() -> usize {
 let value: &str = &String::from("four");
 return value.len();
}
fn main() { println!("{}", flow()); }
""", previews=True, expected_stdout="4\n")
        selected = [event for event in events if event["source"]["symbol"] == "flow"]
        self.assertTrue(any(event.get("preview") == "four" for event in selected))
        self.assertTrue(any(event["operation"] == "gap" for event in selected))
        self.assertTrue(all(not event["inputs"] for event in selected))

    def test_exact_test_field_previews_do_not_serialize_other_bindings(self):
        events = self.launch("""fn flow(input: i32) -> i32 { let value = input + 2; let private = 9901; return value; }
fn main() { println!("{}", flow(5)); }
""", previews=True)
        raw = [e for e in events if "preview" in e]
        self.assertTrue(raw)
        self.assertTrue(all(e["access_path"] == "value" and e["preview"] == 7 for e in raw))
        self.assertTrue(all(e.get("preview") != 9901 for e in events))

    def test_multiple_local_cargo_modules_are_instrumented_in_a_temporary_overlay(self):
        events = self.launch("mod domain;\nfn main() { println!(\"{}\", domain::flow(9)); }\n", modules={
            "domain.rs": "pub fn flow(input: i32) -> i32 { let value=input+1; return value; }\n",
        })
        self.assertTrue(any(e["source"]["file_path"] == "src/domain.rs" and e["operation"] == "transform" for e in events))
        self.assertTrue(any(e["source"]["file_path"] == "src/main.rs" for e in events))

    def test_known_primitive_struct_field_is_observed_without_inventing_heap_lineage(self):
        events = self.launch("""struct Data { value: i32 }
fn flow(data: Data) -> i32 { let value=data.value; return value; }
fn main() { println!("{}", flow(Data { value: 7 })); }
""", empty_cache=True)
        field = next(e for e in events if e["operation"] == "field")
        self.assertEqual(field["access_path"], "data.value")
        self.assertEqual(field["inputs"], [])
        self.assertTrue(any(e["operation"] == "gap" for e in events))

    def test_shadowed_callable_and_owned_string_are_left_unproven(self):
        events = self.launch("""fn source() -> i32 { 1 }
fn main() { let source=||String::from("owned"); let value=source(); println!("{}",value); }
""", previews=True)
        self.assertTrue(any(e["operation"] == "gap" for e in events))
        self.assertTrue(all("preview" not in e for e in events))

    def test_cargo_build_script_is_unmodified_and_never_receives_capture_credentials(self):
        events = self.launch("mod domain;\nfn main() { println!(\"{}\",domain::flow(3)); }\n", modules={
            "domain.rs": "pub fn flow(input:i32)->i32 { let value=input+1; value }\n",
            "../build.rs": 'fn main() { assert!(std::env::var("CBM_CAPTURE_TOKEN").is_err()); println!("cargo:rerun-if-changed=build.rs"); }\n',
        })
        self.assertTrue(all(e["source"]["file_path"] != "build.rs" for e in events))


if __name__ == "__main__":
    unittest.main()
