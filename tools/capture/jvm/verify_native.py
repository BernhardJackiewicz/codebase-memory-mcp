#!/usr/bin/env python3
"""Actual Java/Kotlin agent -> isolated native CBM -> source evidence acceptance."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen

import build

SOURCES = {
    "java": ("JavaFixture.java", "JavaFixture", """public class JavaFixture {
 static int flow(int input) {
  int copied=input;
  int transformed=copied+1;
  return transformed;
 }
 public static void main(String[] args) { System.out.println(flow(41)); }
}
"""),
    "kotlin": ("KotlinFixture.kt", "KotlinFixtureKt", """fun flow(input: Int): Int {
 val copied=input
 val transformed=copied+1
 return transformed
}
fun main() { println(flow(41)) }
"""),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True)
    parser.add_argument("--out", required=True)
    options = parser.parse_args()
    binary = str(Path(options.binary).resolve(strict=True))
    output = Path(options.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="cbm-jvm-native-", dir="/private/tmp" if Path("/private/tmp").is_dir() else None))
    project = root / "project"
    project.mkdir()
    for filename, _, source in SOURCES.values():
        (project / filename).write_bytes(source.encode())
    environment = {**os.environ, "CBM_CACHE_DIR": str(root / "cache"), "CBM_RUNTIME_DIR": str(root / "run"),
                   "CBM_ALLOWED_ROOT": str(root)}
    Path(environment["CBM_CACHE_DIR"]).mkdir(mode=0o700)
    Path(environment["CBM_RUNTIME_DIR"]).mkdir(mode=0o700)
    server = None
    report = {"cases": []}
    log = open(output / "native.log", "w")
    try:
        agent = build.build_agent(root / "agent")
        overlays = {language: build.build_overlay(project, root / language, language) for language in SOURCES}
        indexed = subprocess.run([binary, "cli", "index_repository"],
                                 input=json.dumps({"repo_path": str(project), "name": "jvm-capture", "mode": "full"}) + "\n",
                                 env=environment, capture_output=True, text=True, timeout=90)
        (output / "index.stdout.log").write_text(indexed.stdout)
        (output / "index.stderr.log").write_text(indexed.stderr)
        assert indexed.returncode == 0, indexed.stderr
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        base = "http://127.0.0.1:%d" % port

        def request(path, body=None, method=None):
            encoded = json.dumps(body).encode() if body is not None else None
            req = Request(base + path, data=encoded, method=method, headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=3) as response:
                return json.load(response)

        server = subprocess.Popen([binary, "--ui=true", "--port=%d" % port], stdin=subprocess.PIPE,
                                  stdout=log, stderr=log, text=True, env=environment)
        server.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                      "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                                 "clientInfo": {"name": "jvm-capture-acceptance", "version": "1"}}}) + "\n")
        server.stdin.flush()
        deadline = time.monotonic() + 20
        while True:
            try:
                documents = request("/api/documents?project=jvm-capture")
                break
            except Exception:
                assert server.poll() is None, "Native process exited"
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.1)
        for language, (filename, entry, source) in SOURCES.items():
            overlay = overlays[language]
            for previews in (False, True):
                created = request("/api/capture/sessions", {"project": "jvm-capture", "generation": documents["generation"],
                                  "profile": "jvm", "values_enabled": previews, "allowed_fields": ["input"] if previews else []})
                identifier = created["session"]["id"]
                runtime = {**environment, "CBM_CAPTURE_ENDPOINT": base + created["lineage_url"], "CBM_CAPTURE_TOKEN": created["token"],
                           "CBM_CAPTURE_VALUES": "1" if previews else "0", "CBM_CAPTURE_FIELDS": '["input"]' if previews else "[]"}
                launched = subprocess.run([build.tool("java"), "-javaagent:%s=%s" % (agent, overlay["manifest"]),
                                           "-cp", overlay["classpath"], entry], env=runtime, capture_output=True, text=True, timeout=15)
                assert launched.returncode == 0, launched.stderr
                assert launched.stdout == "42\n", launched.stdout
                assert "unavailable" not in launched.stderr and "queue full" not in launched.stderr, launched.stderr
                events = request("/api/capture/events?id=" + identifier)["events"]
                assert len(events) >= 8, "No actual instrumented JVM events received"
                assert all(event["source_status"] == "matched" for event in events), "Source evidence is not matched"
                assert all(event["source"]["source_hash"] == hashlib.sha256(source.encode()).hexdigest() for event in events)
                assert all(event["source"]["file_path"] == filename for event in events)
                assert any(event["operation"] == "transform" and event["inputs"] for event in events)
                assert any(event["operation"] == "return" and event["inputs"] for event in events)
                raw = [event for event in events if "preview" in event]
                assert bool(raw) == previews
                assert all(event["access_path"] == "input" and event["preview"] == "41" for event in raw)
                evidence = request("/api/source-evidence?project=jvm-capture&generation=" + documents["generation"]
                                   + "&file_path=" + filename + "&source_hash=" + hashlib.sha256(source.encode()).hexdigest()
                                   + "&start_line=1&end_line=6")
                assert "return transformed" in evidence["content"]
                assert (project / filename).read_bytes() == source.encode()
                request("/api/capture/stop", {"id": identifier})
                assert request("/api/capture/events?id=" + identifier)["session"]["status"] == "stopped"
                request("/api/capture/session?id=" + identifier, method="DELETE")
                report["cases"].append({"name": language + " actual JVM / native receiver / " + ("exact previews" if previews else "metadata only"),
                                        "passed": True, "events": len(events), "explicit_input_links": sum(len(event["inputs"]) for event in events),
                                        "source_hash": hashlib.sha256(source.encode()).hexdigest()})
        print(json.dumps(report))
    finally:
        if server is not None:
            server.stdin.close()
            try:
                server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                server.terminate()
                server.wait(timeout=4)
        subprocess.run([binary, "daemon", "stop"], env=environment, stdout=log, stderr=log, timeout=15)
        log.close()
        if (root / "cache/logs").exists():
            shutil.copytree(root / "cache/logs", output / "worker-logs", dirs_exist_ok=True)
        shutil.rmtree(root)
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
