#!/usr/bin/env python3
import argparse
import importlib.util
from pathlib import Path
import shutil
import subprocess
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_acceptance", HERE.parent / "verify_native.py")
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    php = shutil.which("php")
    if not php: parser.error("An existing PHP 8.1+ runtime is required")
    source = '''<?php
function flow(string $email): string {
    $copied = $email;
    $output = $copied . ".test";
    return $output;
}
class Box {
    private $target;
    function __construct(&$target) { $this->target =& $target; }
    function __destruct() { $this->target = 0; }
}
function other_target() {
    $x = 0;
    $obj = new Box($x);
    $x = 42; // other target
    $obj = null;
    return $x;
}
function own_target() {
    $x = 0;
    $x = new Box($x);
    $x = 42; // own target
    return $x;
}
function array_release() {
    $x = 0;
    $items = [new Box($x)];
    $x = 42; // array release
    $items = null;
    return $x;
}
class TypedReference {
    public int $number;
    function __construct(&$number) { $this->number =& $number; }
}
function coerced_store() {
    $x = 0;
    $reference = new TypedReference($x);
    $x = 3.0; // coerced store
    return $x;
}
echo flow("sample@example"), "\\n", other_target(), "\\n", own_target(), "\\n", array_release(), "\\n", coerced_store(), "\\n";
'''
    def prepare(root, project, env):
        overlay = root / "overlay"
        ran = subprocess.run([php, str(HERE / "overlay.php"), "--root", str(project), "--out", str(overlay)],
                             env=env, text=True, capture_output=True, timeout=30)
        assert ran.returncode == 0, ran.stdout + ran.stderr
        return overlay
    def launch(overlay, project, env):
        return [php, "-d", "auto_prepend_file=" + str(overlay / ".cbm/Runtime.php"), str(overlay / "app.php")], env, str(overlay)
    def check_events(events, values):
        for symbol, marker, detail in (
            ("other_target", "// other target", "lifetime"),
            ("own_target", "// own target", "lifetime"),
            ("array_release", "// array release", "lifetime"),
            ("coerced_store", "// coerced store", "coercion"),
        ):
            line = next(index for index, text in enumerate(source.splitlines(), 1) if marker in text)
            local = [event for event in events if event["source"].get("symbol") == symbol]
            origins = {event["value_id"] for event in local
                       if event["source"]["line"] == line and event["operation"] == "value"}
            assert origins, "No actual RHS observation for " + symbol
            reachable = set(origins)
            for event in events:
                if any(value in reachable for value in event["inputs"]):
                    reachable.add(event["value_id"])
            returned = next(event for event in local if event["operation"] == "return")
            assert returned["value_id"] not in reachable, "False post-STORE value transport: " + symbol
            assert any(detail in event.get("detail", "").lower() for event in local), "Missing STORE gap: " + symbol
        positive = [event for event in events if event["source"].get("symbol") == "flow"]
        parameter = next(event for event in positive if event["operation"] == "value" and event.get("access_path") == "email")
        reachable = {parameter["value_id"]}
        for event in positive:
            if any(value in reachable for value in event["inputs"]):
                reachable.add(event["value_id"])
        returned = next(event for event in positive if event["operation"] == "return")
        assert returned["value_id"] in reachable, "Primitive copy/transform/return transport regressed"
    native.verify(binary=args.binary, output=args.out, profile="php", files={"app.php": source}, prepare=prepare, launch=launch,
        expected_stdout="sample@example.test\n0\n0\n0\n3\n", field="email", preview="sample@example", source_file="app.php",
        source_text="return $output", check_events=check_events)

if __name__ == "__main__":
    main()
