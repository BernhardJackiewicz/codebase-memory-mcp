import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startBrowserOverlay } from './browser.mjs';
import { transportOptions } from './runtime.mjs';
const register = fileURLToPath(new URL('./register.mjs', import.meta.url));
async function receiver() {
    const batches = [];
    const server = createServer((request, response) => {
        let content = ''; request.on('data', chunk => content += chunk);
        request.on('end', () => {
            assert.equal(request.headers.authorization, 'Bearer local-test-only');
            batches.push(JSON.parse(content)); response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { batches, endpoint: `http://127.0.0.1:${server.address().port}/v1/cbm/lineage?session=test`,
        close: () => new Promise(resolve => server.close(resolve)) };
}
function run(args, env) {
    return new Promise((resolve, reject) => {
        const process = spawn(globalThis.process.execPath, args, { env: { ...globalThis.process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        process.stdout.on('data', chunk => stdout += chunk); process.stderr.on('data', chunk => stderr += chunk);
        process.once('error', reject); process.once('close', code => resolve({ code, stdout, stderr }));
    });
}
describe('manual local development overlays', () => {
    it('runs the actual Node loader and sends real probes while keeping original bytes unchanged', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'cbm-node-overlay-')), server = await receiver();
        const source = `export function decorate(input: string) { const output=input+"!"; return output; }
export function run(input: string) { return decorate(input); }
console.log(run("sample"));`;
        const file = path.join(root, 'app.ts');
        await writeFile(file, source);
        try {
            const result = await run(['--import', register, file], {
                CBM_CAPTURE_ROOT: root, CBM_CAPTURE_ENDPOINT: server.endpoint, CBM_CAPTURE_TOKEN: 'local-test-only',
                CBM_CAPTURE_VALUES: '0', CBM_CAPTURE_FIELDS: '[]',
            });
            assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, 'sample!\n');
            assert.equal(await readFile(file, 'utf8'), source);
            const events = server.batches.flatMap(batch => batch.events);
            assert(events.some(event => event.operation === 'call' && event.inputs.length));
            assert(events.every(event => !('preview' in event)));
            assert(events.every(event => event.source.file_path === 'app.ts'));
            assert(!result.stderr.includes('local-test-only'));
        } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
    });
    it('serves a reversible browser ESM overlay and rejects foreign origins, hosts and out-of-root symlinks', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'cbm-browser-overlay-')), server = await receiver();
        const file = path.join(root, 'app.ts'), source = 'export function copy(input: string) { const output=input; return output; }';
        await writeFile(file, source); await writeFile(path.join(root, 'index.html'), '<div>Local test</div><script type="module" src="/app.ts"></script>');
        await symlink(register, path.join(root, 'outside.mjs'));
        const overlay = await startBrowserOverlay({ root, endpoint: server.endpoint, token: 'local-test-only', port: 0 });
        try {
            const response = await fetch(overlay.origin + '/app.ts');
            assert.equal(response.status, 200); const code = await response.text();
            assert(code.includes('/__cbm_capture/bootstrap.mjs')); assert(code.includes('.assign('));
            assert.equal(await readFile(file, 'utf8'), source);
            assert.equal((await fetch(overlay.origin + '/outside.mjs')).status, 403);
            assert.equal((await fetch(overlay.origin + '/__cbm_capture/bootstrap.mjs', { headers: { Origin: 'http://localhost:9999' } })).status, 403);
            const wrongHost = await new Promise((resolve, reject) => {
                get(overlay.origin + '/__cbm_capture/bootstrap.mjs', { headers: { Host: 'attacker.test' } }, response => {
                    response.resume(); resolve(response.statusCode);
                }).once('error', reject);
            });
            assert.equal(wrongHost, 403);
            assert.equal((await fetch(overlay.origin + '/.env')).status, 404);
        } finally { await overlay.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
    });
    it('rejects remote or credential-bearing transport endpoints before making requests', () => {
        for (const endpoint of ['https://example.com/v1/cbm/lineage?session=a', 'http://localhost:1/wrong?session=a',
            'http://name:password@127.0.0.1:1/v1/cbm/lineage?session=a'])
            assert.throws(() => transportOptions({ endpoint, token: 'test' }), /loopback/);
    });
});
