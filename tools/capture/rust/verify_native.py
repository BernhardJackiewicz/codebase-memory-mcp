#!/usr/bin/env python3
"""Isolated real-native acceptance for Rust probes; never uses installed indexes."""
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

from test_rust_capture import DROP_SUPPORT, LIFETIME_CASES, ancestors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    binary = str(Path(args.binary).resolve())
    output = Path(args.out).resolve()
    output.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='cbm-rust-', dir='/private/tmp' if Path('/private/tmp').is_dir() else None))
    project = root / 'project'
    project.mkdir()
    source = """fn flow(input: i32) -> i32 {
    let value = input + 2;
    return value;
}
"""
    source += DROP_SUPPORT + "\n"
    for name, body in LIFETIME_CASES.items():
        source += "fn lifetime_" + name + "() -> i32 {\n let mut value = 0;\n " + body + "\n return value;\n}\n"
    source += 'fn lifetime_borrow() -> usize { let value: &str = &String::from("four"); return value.len(); }\n'
    source += 'fn main() { println!("{}", flow(5));\n'
    source += "".join('println!("{}", lifetime_' + name + '());\n' for name in LIFETIME_CASES)
    source += 'println!("{}", lifetime_borrow()); }\n'
    (project / 'app.rs').write_text(source)
    env = {**os.environ, 'CBM_CACHE_DIR': str(root / 'cache'), 'CBM_RUNTIME_DIR': str(root / 'run'), 'CBM_ALLOWED_ROOT': str(root)}
    Path(env['CBM_CACHE_DIR']).mkdir(mode=0o700)
    Path(env['CBM_RUNTIME_DIR']).mkdir(mode=0o700)
    server = None
    report = {'cases': []}
    native_log = open(output / 'native.log', 'w')
    try:
        original_build = subprocess.run(['rustc', '--edition=2021', str(project / 'app.rs'), '-o', str(root / 'original')],
                                        text=True, capture_output=True, timeout=90)
        assert original_build.returncode == 0, original_build.stderr
        original_run = subprocess.run([str(root / 'original')], text=True, capture_output=True, timeout=5)
        assert original_run.returncode == 0, original_run.stderr
        assert original_run.stdout == '7\n' + '0\n' * len(LIFETIME_CASES) + '4\n'
        indexed = subprocess.run([binary, 'cli', 'index_repository'], input=json.dumps({'repo_path': str(project), 'name': 'rust-capture', 'mode': 'full'}) + '\n', text=True, env=env, capture_output=True, timeout=90)
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
        server.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'rust-capture-acceptance', 'version': '1'}}}) + '\n')
        server.stdin.flush()
        deadline = time.monotonic() + 20
        while True:
            try:
                documents = request('/api/documents?project=rust-capture')
                break
            except Exception:
                assert server.poll() is None, 'Native process exited'
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.1)
        for previews in (False, True):
            created = request('/api/capture/sessions', {'project': 'rust-capture', 'generation': documents['generation'], 'profile': 'rust', 'values_enabled': previews, 'allowed_fields': ['value'] if previews else []})
            identifier = created['session']['id']
            runtime_env = {**env, 'CBM_CAPTURE_ENDPOINT': base + created['lineage_url'], 'CBM_CAPTURE_TOKEN': created['token'], 'CBM_CAPTURE_VALUES': '1' if previews else '0', 'CBM_CAPTURE_FIELDS': '["value"]' if previews else '[]'}
            launched = subprocess.run([sys.executable, str(Path(__file__).with_name('cbm_capture_rust.py')), '--root', str(project), '--source', str(project / 'app.rs')], env=runtime_env, capture_output=True, text=True, timeout=120)
            assert launched.returncode == 0, launched.stderr
            assert launched.stdout == original_run.stdout
            assert 'not delivered' not in launched.stderr, launched.stderr
            events = request('/api/capture/events?id=' + identifier)['events']
            assert len(events) >= 8, 'No real instrumented events received'
            assert all(e['source_status'] == 'matched' for e in events), 'Source hash/generation did not match real index'
            assert any(e['operation'] == 'transform' and e['inputs'] for e in events), 'No actual transform lineage'
            assert any(e['operation'] == 'return' and e['inputs'] for e in events), 'No actual return lineage'
            raw = [e for e in events if 'preview' in e]
            assert bool(raw) == previews
            assert all(e['access_path'] == 'value' for e in raw)
            primitive = [e for e in events if e['source']['symbol'] == 'flow']
            assert all(e['preview'] == '7' for e in primitive if 'preview' in e)
            parameter = next(e for e in primitive if e.get('access_path') == 'input')
            source_event = next(e for e in primitive if e['operation'] == 'return')
            assert parameter['value_id'] in ancestors(primitive, source_event['value_id']), 'Primitive parameter-to-return path was lost'
            lifetime_results = []
            for name in LIFETIME_CASES:
                selected = [e for e in events if e['source']['symbol'] == 'lifetime_' + name]
                assert selected and any(e['operation'] == 'return' for e in selected), name
                assert any(e['operation'] == 'gap' and 'lifetime' in e.get('detail', '').lower() for e in selected), name
                assert all(not e['inputs'] for e in selected), 'Unknown Drop lifetime asserted an input: ' + name
                old = [e for e in selected if e.get('preview') == '42']
                if previews:
                    assert old, 'Pre-drop value not observed: ' + name
                    later = [e for e in selected if e['sequence'] > old[-1]['sequence']
                             and (e.get('preview') == '0' or e['operation'] == 'return')]
                    assert any(e.get('preview') == '0' for e in later), name
                    assert all({e['value_id'] for e in old}.isdisjoint(ancestors(selected, target['value_id'])) for target in later), name
                lifetime_results.append({'name': name, 'events': len(selected), 'passed': True})
            borrowed = [e for e in events if e['source']['symbol'] == 'lifetime_borrow']
            assert borrowed and all(not e['inputs'] for e in borrowed)
            assert any(e.get('preview') == 'four' for e in borrowed) == previews
            location = source_event['source']
            evidence = request('/api/source-evidence?project=rust-capture&generation=' + documents['generation'] + '&file_path=app.rs&source_hash=' + location['source_hash'] + '&start_line=1&end_line=6')
            assert 'return value' in evidence['content']
            assert (project / 'app.rs').read_text() == source
            assert not (project / '__pycache__').exists()
            request('/api/capture/stop', {'id': identifier})
            assert request('/api/capture/events?id=' + identifier)['session']['status'] == 'stopped'
            request('/api/capture/session?id=' + identifier, method='DELETE')
            report['cases'].append({'name': 'rust real native ' + ('exact previews' if previews else 'metadata only'), 'passed': True, 'events': len(events), 'explicit_input_links': sum(len(e['inputs']) for e in events), 'lifetime_cases': lifetime_results, 'temporary_borrow_preserved': True, 'source_hash': hashlib.sha256(source.encode()).hexdigest()})
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
