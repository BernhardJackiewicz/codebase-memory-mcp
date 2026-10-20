"""Shared real-receiver acceptance for development adapters.

Every run owns its sources, index, cache, daemon and receiver. No installed CBM
state is used. This helper is test tooling and is not included in adapter ZIPs.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def verify(*, binary, output, profile, files, prepare, launch, expected_stdout,
           field, preview, source_file, source_text, minimum_events=5, check_events=None):
    binary = str(Path(binary).resolve())
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="cbm-ad-", dir="/private/tmp" if Path("/private/tmp").is_dir() else None))
    project = root / "project"
    project.mkdir()
    for name, content in files.items():
        destination = project / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)
    original = {name: (project / name).read_bytes() for name in files}
    env = {**os.environ, "CBM_CACHE_DIR": str(root / "cache"), "CBM_RUNTIME_DIR": str(root / "run"), "CBM_ALLOWED_ROOT": str(root)}
    Path(env["CBM_CACHE_DIR"]).mkdir(mode=0o700)
    Path(env["CBM_RUNTIME_DIR"]).mkdir(mode=0o700)
    server = None
    report = {"profile": profile, "cases": []}
    log = open(output / "native.log", "w")
    try:
        prepared = prepare(root, project, env)
        indexed = subprocess.run([binary, "cli", "index_repository"], input=json.dumps({"repo_path": str(project), "name": "adapter-capture", "mode": "full"}) + "\n",
                                 text=True, env=env, capture_output=True, timeout=120)
        assert indexed.returncode == 0, indexed.stderr
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        base = "http://127.0.0.1:%d" % port
        def request(path, body=None, method=None):
            encoded = json.dumps(body).encode() if body is not None else None
            req = Request(base + path, data=encoded, method=method, headers={"Content-Type": "application/json"})
            with urlopen(req, timeout=5) as response:
                return json.load(response)
        server = subprocess.Popen([binary, "--ui=true", "--port=%d" % port], stdin=subprocess.PIPE, stdout=log, stderr=log, text=True, env=env)
        server.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "adapter-acceptance", "version": "1"}}}) + "\n")
        server.stdin.flush()
        deadline = time.monotonic() + 30
        while True:
            try:
                documents = request("/api/documents?project=adapter-capture")
                break
            except Exception:
                assert server.poll() is None, "Native process exited"
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.1)
        for values in (False, True):
            created = request("/api/capture/sessions", {"project": "adapter-capture", "generation": documents["generation"], "profile": profile,
                              "values_enabled": values, "allowed_fields": [field] if values else []})
            identifier = created["session"]["id"]
            runtime_env = {**env, "CBM_CAPTURE_ENDPOINT": base + created["lineage_url"], "CBM_CAPTURE_TOKEN": created["token"],
                           "CBM_CAPTURE_VALUES": "1" if values else "0", "CBM_CAPTURE_FIELDS": json.dumps([field] if values else [])}
            command, run_env, cwd = launch(prepared, project, runtime_env)
            ran = subprocess.run(command, env=run_env, cwd=cwd, capture_output=True, text=True, timeout=90)
            assert ran.returncode == 0, ran.stdout + ran.stderr
            assert ran.stdout == expected_stdout, ran.stdout
            events = request("/api/capture/events?id=" + identifier)["events"]
            assert len(events) >= minimum_events, "Too few automatic runtime observations"
            assert all(e["source_status"] == "matched" for e in events), "Original source/generation mismatch"
            assert any(e["inputs"] for e in events), "No explicit value-transport observations"
            raw = [e for e in events if "preview" in e]
            assert bool(raw) == values, "Preview mode mismatch"
            assert all(e["access_path"] == field and e["preview"] == preview for e in raw), "Preview escaped the exact allowlist"
            if check_events is not None:
                check_events(events, values)
            digest = hashlib.sha256(original[source_file]).hexdigest()
            evidence = request("/api/source-evidence?" + urlencode({"project": "adapter-capture", "generation": documents["generation"],
                "file_path": source_file, "source_hash": digest, "start_line": 1, "end_line": 30}))
            assert source_text in evidence["content"], "Verified source does not show original code"
            assert all((project / name).read_bytes() == content for name, content in original.items()), "Original source changed"
            request("/api/capture/stop", {"id": identifier})
            assert request("/api/capture/events?id=" + identifier)["session"]["status"] == "stopped"
            request("/api/capture/session?id=" + identifier, method="DELETE")
            report["cases"].append({"name": "exact previews" if values else "metadata only", "passed": True, "events": len(events),
                                    "explicit_input_links": sum(len(e["inputs"]) for e in events), "source_hash": digest})
        print(json.dumps(report))
        return report
    finally:
        if server is not None:
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
