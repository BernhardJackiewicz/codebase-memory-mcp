import { describe, expect, it } from 'vitest';
import { adapterCommands, readAdapterManifest } from './capture-adapters';
import { captureSession } from './capture-fixture';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
describe('local adapter downloads and manual launch instructions', () => {
    it('accepts only explicit local archive paths with a bounded size and checksum', () => {
        const entry = { profile: 'node', archive: '/capture-adapters/javascript.zip', sha256: 'a'.repeat(64), size: 42 };
        expect(readAdapterManifest({ schema_version: 1, adapters: [entry] })).toEqual([entry]);
        for (const archive of ['https://example.com/adapter.zip', '//other/adapter.zip', '/capture-adapters/../secret.zip'])
            expect(() => readAdapterManifest({ schema_version: 1, adapters: [{ ...entry, archive }] })).toThrow();
    });
    it('keeps actual tokens out of copied commands and quotes exact opt-in paths as shell data', () => {
        const session = captureSession({ values_enabled: true, allowed_fields: ["test.'email"] });
        const commands = adapterCommands(session, 'http://127.0.0.1:8000/v1/cbm/lineage?session=a');
        expect(commands).toContain('read -r -s CBM_CAPTURE_TOKEN');
        expect(commands).toContain('CBM_CAPTURE_VALUES=1');
        expect(commands).toContain(`'["test.'"'"'email"]'`);
        expect(commands).toContain('node --import');
        expect(adapterCommands(captureSession(), 'http://127.0.0.1:8000/v1/cbm/lineage?session=a')).toContain('CBM_CAPTURE_VALUES=0');
    });
    it('does not invent a launch command for an unbundled runtime family', () => {
        expect(adapterCommands(captureSession({ profile: 'unknown' }), 'http://127.0.0.1:8000/v1/cbm/lineage?session=a')).toBeUndefined();
    });
    it.each([
        ['go', 'go run -overlay', 'GOPROXY=off'],
        ['dotnet', 'CaptureTool.dll', '--no-restore'],
        ['jvm', '-javaagent:', 'sources.cbm'],
        ['rust', 'cbm_capture_rust.py', '--manifest Cargo.toml'],
        ['php', 'auto_prepend_file=', 'overlay.php'],
        ['native', 'launch.py', '--manifest "$CBM_CAPTURE_OVERLAY/capture.json"'],
    ])('provides a quoted manual %s build and launch without starting anything', (profile, launch, boundary) => {
        const commands = adapterCommands(captureSession({ profile, values_enabled: true, allowed_fields: [`test.'";$(never-run-this)`] }),
            'http://127.0.0.1:8000/v1/cbm/lineage?session=a');
        expect(commands).toContain(launch); expect(commands).toContain(boundary);
        expect(commands).toContain('read -r -s CBM_CAPTURE_TOKEN');
        expect(commands).toContain('"$CBM_CAPTURE_ROOT"');
        expect(spawnSync('/bin/sh', ['-n'], { input: commands, encoding: 'utf8' }).status).toBe(0);
    });
    it('requires the exact bundled browser overlay origin before showing a runnable command', () => {
        const session = captureSession({ profile: 'browser' });
        expect(adapterCommands(session, 'http://127.0.0.1:8000/v1/cbm/lineage?session=a', 'http://localhost:4319')).toBeUndefined();
        expect(adapterCommands(session, 'http://127.0.0.1:8000/v1/cbm/lineage?session=a', 'http://127.0.0.1:4319')).toContain('browser.mjs');
    });
    it('passes quoted paths and exact field strings to each manual launcher in Bash and Zsh', () => {
        const work = mkdtempSync(join(tmpdir(), 'cbm-command-'));
        const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
        try {
            const adapter = join(work, "adapter's files"), project = join(work, "project's files"), bin = join(work, 'commands');
            [adapter, project, bin].forEach(path => mkdirSync(path));
            // Controlled executables record argv only; no compiler or application starts.
            const stub = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.CBM_TEST_CALLS, JSON.stringify({args:process.argv.slice(2),root:process.env.CBM_CAPTURE_ROOT,fields:process.env.CBM_CAPTURE_FIELDS})+'\\n');
if(process.argv[2]==='-c') process.stdout.write(process.env.CBM_TEST_CLASSPATH);
`;
            for (const name of ['node', 'python3', 'go', 'dotnet', 'java', 'php']) {
                const path = join(bin, name); writeFileSync(path, stub); chmodSync(path, 0o700);
            }
            for (const profile of ['node', 'browser', 'python', 'go', 'dotnet', 'jvm', 'rust', 'php', 'native']) {
                const fields = ["test.'\";$(must-stay-data)"];
                const text = adapterCommands(captureSession({ profile, values_enabled: true, allowed_fields: fields }),
                    'http://127.0.0.1:8000/v1/cbm/lineage?session=a', 'http://127.0.0.1:4319')!
                    .replace("'/absolute/path/to/project'", shellQuote(project))
                    .replace("'/absolute/path/to/adapter'", shellQuote(adapter))
                    .replace("'/absolute/path/to/new-temporary-overlay'", shellQuote(join(work, "overlay's files")));
                for (const shell of ['/bin/bash', '/bin/zsh']) {
                    const calls = join(work, 'calls.jsonl'); writeFileSync(calls, '');
                    const result = spawnSync(shell, ['-c', text], { input: 'test-token-not-for-logs\n', encoding: 'utf8',
                        env: { ...process.env, PATH: bin, CBM_TEST_CALLS: calls, CBM_TEST_CLASSPATH: join(work, 'classes with spaces') } });
                    expect(result.status, `${profile} ${shell}: ${result.stderr}`).toBe(0);
                    const records = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
                    expect(records.length).toBeGreaterThan(0);
                    for (const record of records) {
                        expect(record.root).toBe(project); expect(JSON.parse(record.fields)).toEqual(fields);
                        expect(record.args.some((arg: string) => arg.includes('test-token-not-for-logs'))).toBe(false);
                    }
                    expect(result.stdout + result.stderr).not.toContain('test-token-not-for-logs');
                    if (profile === 'jvm') expect(records.at(-1).args).toContain(join(work, 'classes with spaces'));
                }
            }
        } finally { rmSync(work, { recursive: true, force: true }); }
    });
});
