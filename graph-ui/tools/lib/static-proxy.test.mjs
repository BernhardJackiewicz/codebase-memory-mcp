import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStaticProxy } from './static-proxy.mjs';

const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });
describe('local capture receiver forwarding', () => {
    it('forwards only the exact capture paths with origin, token, query and binary body intact', async () => {
        const received = [];
        const upstream = http.createServer(async (request, response) => {
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            received.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
            response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}');
        });
        await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
        cleanup.push(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
        const distDir = await mkdtemp(join(tmpdir(), 'cbm-proxy-test-'));
        cleanup.push(() => rm(distDir, { recursive: true, force: true }));
        await writeFile(join(distDir, 'index.html'), 'local fixture');
        const proxy = await startStaticProxy({ distDir, upstreamPort: upstream.address().port, port: 0 });
        cleanup.push(() => proxy.close());
        const base = `http://127.0.0.1:${proxy.port}`, body = Buffer.from([0, 255, 7, 0]);
        for (const route of ['/v1/traces?session=opaque', '/v1/cbm/lineage?session=opaque']) {
            const response = await fetch(base + route, { method: 'POST', headers: {
                Origin: 'http://localhost:3000', Authorization: 'Bearer test-only', 'Content-Type': 'application/x-protobuf',
            }, body });
            expect(response.status).toBe(200);
            expect(received.at(-1)).toMatchObject({ url: route, headers: { origin: 'http://localhost:3000', authorization: 'Bearer test-only' } });
            expect(received.at(-1).body).toEqual(body);
        }
        expect((await fetch(base + '/v1/traces/other', { method: 'POST', body })).status).toBe(404);
        expect(received).toHaveLength(2);
        await fetch(base + '/api/capture/sessions', { headers: { Origin: 'http://localhost:3000' } });
        expect(received.at(-1).headers.origin).toBeUndefined();
    });
});
