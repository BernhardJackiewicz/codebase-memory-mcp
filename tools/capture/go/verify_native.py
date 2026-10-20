#!/usr/bin/env python3
"""Isolated real-native acceptance for Go overlay probes; never uses installed indexes."""
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
    parser.add_argument('--binary', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='cbm-go-', dir='/private/tmp' if Path('/private/tmp').is_dir() else None))
    project = root / 'project'
    project.mkdir()
    source = '''package main
import "fmt"
func flow(email string) string {
    copied := email
    normalized := copied + ".test"
    return normalized
}
func main() { fmt.Println(flow("sample@example")) }
'''
    (project / 'main.go').write_text(source)
    (project / 'go.mod').write_text('module fixture\n\ngo 1.20\n')
    overlay = root / 'overlay'
    overlay.mkdir()
    adapter = Path(__file__).parent
    generated = subprocess.run(['go', 'run', '.', '--root', str(project), '--out', str(overlay)], cwd=adapter, env={**os.environ, 'GOTOOLCHAIN': 'local', 'GOPROXY': 'off'}, capture_output=True, text=True, timeout=30)
    assert generated.returncode == 0, generated.stderr
    env = {**os.environ, 'CBM_CACHE_DIR': str(root / 'cache'), 'CBM_RUNTIME_DIR': str(root / 'run'), 'CBM_ALLOWED_ROOT': str(root)}
    Path(env['CBM_CACHE_DIR']).mkdir(mode=0o700)
    Path(env['CBM_RUNTIME_DIR']).mkdir(mode=0o700)
    server = None
    report = {'cases': []}
    native_log = open(output / 'native.log', 'w')
    try:
        indexed = subprocess.run([binary, 'cli', 'index_repository'], input=json.dumps({'repo_path': str(project), 'name': 'go-capture', 'mode': 'full'}) + '\n', text=True, env=env, capture_output=True, timeout=90)
        assert indexed.returncode == 0, indexed.stderr
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        base = 'http://127.0.0.1:%d' % port
        def request(path, body=None, method=None):
            encoded = json.dumps(body).encode() if body is not None else None
            req = Request(base + path, data=encoded, method=method, headers={'Content-Type': 'application/json'})
            with urlopen(req, timeout=3) as response:
                return json.load(response)
        server = subprocess.Popen([binary, '--ui=true', '--port=%d' % port], stdin=subprocess.PIPE, stdout=native_log, stderr=native_log, text=True, env=env)
        server.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'go-capture-acceptance', 'version': '1'}}}) + '\n')
        server.stdin.flush()
        deadline = time.monotonic() + 20
        while True:
            try:
                documents = request('/api/documents?project=go-capture')
                break
            except Exception:
                assert server.poll() is None, 'Native process exited'
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.1)
        for previews in (False, True):
            created = request('/api/capture/sessions', {'project': 'go-capture', 'generation': documents['generation'], 'profile': 'go', 'values_enabled': previews, 'allowed_fields': ['email'] if previews else []})
            identifier = created['session']['id']
            runtime_env = {**env, 'CBM_CAPTURE_ENDPOINT': base + created['lineage_url'], 'CBM_CAPTURE_TOKEN': created['token'], 'CBM_CAPTURE_VALUES': '1' if previews else '0', 'CBM_CAPTURE_FIELDS': '["email"]' if previews else '[]'}
            runtime_env.update(GOTOOLCHAIN='local', GOPROXY='off')
            launched = subprocess.run(['go', 'run', '-overlay', str(overlay / 'overlay.json'), '.'], cwd=project, env=runtime_env, capture_output=True, text=True, timeout=30)
            assert launched.returncode == 0, launched.stderr
            assert launched.stdout == 'sample@example.test\n'
            assert 'not delivered' not in launched.stderr, launched.stderr
            events = request('/api/capture/events?id=' + identifier)['events']
            assert len(events) >= 8, 'No real instrumented events received'
            assert all(e['source_status'] == 'matched' for e in events), 'Source hash/generation did not match real index'
            assert any(e['operation'] == 'transform' and e['inputs'] for e in events), 'No actual transform lineage'
            assert any(e['operation'] == 'return' and e['inputs'] for e in events), 'No actual return lineage'
            raw = [e for e in events if 'preview' in e]
            assert bool(raw) == previews
            assert all(e['access_path'] == 'email' and e['preview'] == 'sample@example' for e in raw)
            source_event = next(e for e in events if e['operation'] == 'return')
            location = source_event['source']
            evidence = request('/api/source-evidence?project=go-capture&generation=' + documents['generation'] + '&file_path=main.go&source_hash=' + location['source_hash'] + '&start_line=1&end_line=8')
            assert 'return normalized' in evidence['content']
            assert (project / 'main.go').read_text() == source
            assert sorted(p.name for p in project.iterdir()) == ['go.mod', 'main.go']
            request('/api/capture/stop', {'id': identifier})
            assert request('/api/capture/events?id=' + identifier)['session']['status'] == 'stopped'
            request('/api/capture/session?id=' + identifier, method='DELETE')
            report['cases'].append({'name': 'go real native ' + ('exact previews' if previews else 'metadata only'), 'passed': True, 'events': len(events), 'explicit_input_links': sum(len(e['inputs']) for e in events), 'source_hash': hashlib.sha256(source.encode()).hexdigest()})
        print(json.dumps(report))
    finally:
        if server is not None:
            server.stdin.close()
            try:
                server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                server.terminate()
                server.wait(timeout=4)
        subprocess.run([binary, 'daemon', 'stop'], env=env, stdout=native_log, stderr=native_log, timeout=15)
        native_log.close()
        shutil.rmtree(root)
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
