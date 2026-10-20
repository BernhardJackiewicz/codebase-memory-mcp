#!/usr/bin/env python3
"""Actual C/C++ overlays -> native receiver -> hash-bound source evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="cbm-native-acceptance-",
                                dir="/private/tmp" if Path("/private/tmp").is_dir() else None))
    env = {**os.environ, "CBM_CACHE_DIR": str(root / "cache"), "CBM_RUNTIME_DIR": str(root / "run"),
           "CBM_ALLOWED_ROOT": str(root)}
    Path(env["CBM_CACHE_DIR"]).mkdir(mode=0o700)
    Path(env["CBM_RUNTIME_DIR"]).mkdir(mode=0o700)
    source = """#include <stdio.h>
int flow(int input) {
    int copied=input;
    unsigned char normalized=copied+3;
    return normalized;
}
int main(void) { printf("%d\\n",flow(4)); return 0; }
"""
    lifetime_source = """#include <stdio.h>
struct Box { int &target; Box(int &value):target(value){} ~Box(){target=0;} };
int flow() {
    int x=0;
    {
        Box box(x);
        x=42;
    }
    return x;
}
int main() { printf("%d\\n",flow()); }
"""
    adapter = Path(__file__).parent
    report, projects, server = {"cases": []}, [], None
    log = open(output / "native.log", "w")
    try:
        for case, language, compiler, standard, project_source, expected, field in (
                ("c", "c", "clang", "-std=c11", source, "7\n", "input"),
                ("cpp", "cpp", "clang++", "-std=c++17", source, "7\n", "input"),
                ("cpp-lifetime", "cpp", "clang++", "-std=c++17", lifetime_source, "0\n", "x")):
            project = root / ("project-" + case)
            project.mkdir()
            path = project / ("main." + language)
            path.write_text(project_source)
            overlay = root / ("overlay-" + case)
            overlay.mkdir()
            generated = subprocess.run([sys.executable, str(adapter / "instrument.py"), "--root", str(project),
                                        "--source", str(path), "--out", str(overlay), "--compiler", compiler,
                                        "--", standard], capture_output=True, text=True, timeout=30)
            assert generated.returncode == 0, generated.stderr
            target = overlay / "application"
            built = subprocess.run([sys.executable, str(adapter / "build.py"), "--manifest",
                                    str(overlay / "capture.json"), "--output", str(target)],
                                   capture_output=True, text=True, timeout=30)
            assert built.returncode == 0, built.stderr
            name = "native-" + case
            indexed = subprocess.run([binary, "cli", "index_repository"],
                                     input=json.dumps({"repo_path": str(project), "name": name, "mode": "full"}) + "\n",
                                     text=True, env=env, capture_output=True, timeout=90)
            assert indexed.returncode == 0, indexed.stderr
            projects.append((name, path, target, project_source, expected, field))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        base = "http://127.0.0.1:%d" % port

        def request(path, body=None, method=None):
            encoded = json.dumps(body).encode() if body is not None else None
            with urlopen(Request(base + path, data=encoded, method=method,
                                 headers={"Content-Type": "application/json"}), timeout=3) as response:
                return json.load(response)

        server = subprocess.Popen([binary, "--ui=true", "--port=%d" % port], stdin=subprocess.PIPE,
                                  stdout=log, stderr=log, text=True, env=env)
        server.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "native-capture-acceptance", "version": "1"}}}) + "\n")
        server.stdin.flush()
        deadline = time.monotonic() + 20
        while True:
            try:
                request("/api/documents?project=native-c")
                break
            except Exception:
                assert server.poll() is None, "Native process exited"
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.1)
        for name, path, target, project_source, expected, field in projects:
            generation = request("/api/documents?project=" + name)["generation"]
            for previews in (False, True):
                created = request("/api/capture/sessions", {
                    "project": name, "generation": generation, "profile": "native",
                    "values_enabled": previews, "allowed_fields": [field] if previews else []})
                identifier = created["session"]["id"]
                runtime_env = {**env, "CBM_CAPTURE_ENDPOINT": base + created["lineage_url"],
                               "CBM_CAPTURE_TOKEN": created["token"], "CBM_CAPTURE_VALUES": "1" if previews else "0",
                               "CBM_CAPTURE_FIELDS": json.dumps([field]) if previews else "[]"}
                launched = subprocess.run([sys.executable, str(adapter / "launch.py"), "--", str(target)],
                                          env=runtime_env, capture_output=True, text=True, timeout=10)
                assert launched.returncode == 0 and launched.stdout == expected, launched.stderr
                assert "incomplete" not in launched.stderr, launched.stderr
                events = request("/api/capture/events?id=" + identifier)["events"]
                assert len(events) >= 8, "No actual scalar events"
                assert all(event["source_status"] == "matched" for event in events)
                if field == "x":
                    selected = [event for event in events if event["source"].get("symbol") == "flow"]
                    reached = {event["value_id"] for event in selected
                               if event["operation"] == "copy" and event["source"]["line"] == 7}
                    assert reached, "No actual pre-destruction assignment"
                    for event in selected:
                        if any(value in reached for value in event["inputs"]):
                            reached.add(event["value_id"])
                    returned = [event for event in selected if event["operation"] == "return"]
                    assert returned and all(event["value_id"] not in reached for event in returned)
                    assert any(event["operation"] == "gap" for event in selected)
                else:
                    assert any(event["operation"] == "transform" and event["inputs"] for event in events)
                    assert any(event["operation"] == "return" and event["inputs"] for event in events)
                raw = [event for event in events if "preview" in event]
                assert bool(raw) == previews
                # The receiver intentionally normalizes primitive previews to
                # bounded display text, independent of producer JSON type.
                assert all(event["access_path"] == field for event in raw)
                if field == "x":
                    if previews:
                        assert {"0", "42"}.issubset({event["preview"] for event in raw})
                else:
                    assert all(event["preview"] == "4" for event in raw)
                digest = hashlib.sha256(project_source.encode()).hexdigest()
                evidence = request("/api/source-evidence?project=" + name + "&generation=" + generation
                                   + "&file_path=" + path.name + "&source_hash=" + digest
                                   + "&start_line=1&end_line=" + str(len(project_source.splitlines())))
                assert ("return x" if field == "x" else "return normalized") in evidence["content"]
                assert path.read_text() == project_source
                assert list(path.parent.iterdir()) == [path]
                request("/api/capture/stop", {"id": identifier})
                request("/api/capture/session?id=" + identifier, method="DELETE")
                report["cases"].append({
                    "name": name + (" exact previews" if previews else " metadata only"), "passed": True,
                    "events": len(events), "explicit_input_links": sum(len(event["inputs"]) for event in events),
                    "source_hash": digest})
        print(json.dumps(report))
    finally:
        if server:
            server.stdin.close()
            try:
                server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                server.terminate()
                server.wait(timeout=4)
        subprocess.run([binary, "daemon", "stop"], env=env, stdout=log, stderr=log, timeout=15)
        log.close()
        shutil.rmtree(root)
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
