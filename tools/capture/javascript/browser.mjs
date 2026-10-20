/** Local native-ESM dev overlay. Explicitly not a general bundler or production server. */
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { instrument } from './instrument.mjs';
import { transportOptions } from './runtime.mjs';
const prefix = '/__cbm_capture/';

function bootstrapHtml(html) {
    // Preserve the original declaration and explicit head. Prepending a script
    // puts the HTML parser into quirks mode and makes a later <head> ineffective.
    // Only inspect the document prefix: apparent tags inside scripts, titles or
    // body text are not insertion points, and the document is never reserialized.
    let offset = html.startsWith('\uFEFF') ? 1 : 0;
    const tagEnd = start => {
        let quote = '';
        for (let i = start; i < html.length; i++) {
            const c = html[i];
            if (quote) { if (c === quote) quote = ''; }
            else if (c === '"' || c === "'") quote = c;
            else if (c === '>') return i + 1;
        }
        return -1;
    };
    while (offset < html.length) {
        while (/[\t\n\f\r ]/.test(html[offset] || '\0')) offset++;
        const tail = html.slice(offset);
        if (tail.startsWith('<!--')) {
            const end = /--!?>/.exec(tail.slice(4));
            if (!end) return html; // An unfinished comment cannot safely host a script.
            offset += 4 + end.index + end[0].length;
        } else if (/^<!doctype(?:[\t\n\f\r >])/i.test(tail)) {
            const end = tagEnd(offset + 2);
            if (end < 0) return html;
            offset = end;
        } else if (/^<[!?]/.test(tail)) {
            // Other declarations and processing instructions are bogus comments
            // in HTML; their first '>' terminates them, irrespective of quotes.
            const end = html.indexOf('>', offset + 2);
            if (end < 0) return html;
            offset = end + 1;
        } else {
            const tag = /^<(html|head)(?=[\t\n\f\r />])/i.exec(tail);
            if (!tag) break;
            const end = tagEnd(offset + tag[0].length);
            if (end < 0) return html;
            offset = end;
            if (tag[1].toLowerCase() === 'head') break;
        }
    }
    return html.slice(0, offset)
        + `<script type="module" src="${prefix}bootstrap.mjs"></script>\n`
        + html.slice(offset);
}

export async function startBrowserOverlay({ root, endpoint, token, valuesEnabled = false, allowedFields = [], port = 4319 }) {
    root = await realpath(root);
    transportOptions({ endpoint, token, valuesEnabled, allowedFields }); // Validate before any listener opens.
    const runtime = await readFile(new URL('./runtime.mjs', import.meta.url), 'utf8');
    const bootstrap = `import {configure,transportOptions,flush} from '${prefix}runtime.mjs';
configure(transportOptions(${JSON.stringify({ endpoint, token, valuesEnabled, allowedFields, language: 'javascript' })}));
setInterval(()=>void flush(),200);
addEventListener('pagehide',()=>void flush());`;
    const server = createServer(async (request, response) => {
        try {
            const host = request.headers.host;
            const ownOrigin = `http://127.0.0.1:${server.address().port}`;
            if (host !== `127.0.0.1:${server.address().port}`
                || (request.headers.origin && request.headers.origin !== ownOrigin)
                || request.headers['sec-fetch-site'] === 'cross-site') { response.writeHead(403).end(); return; }
            if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
            const pathname = decodeURIComponent(new URL(request.url, ownOrigin).pathname);
            let content, type = 'text/plain; charset=utf-8';
            if (pathname === `${prefix}runtime.mjs`) { content = runtime; type = 'text/javascript; charset=utf-8'; }
            else if (pathname === `${prefix}bootstrap.mjs`) { content = bootstrap; type = 'text/javascript; charset=utf-8'; }
            else {
                const candidate = path.resolve(root, '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname));
                const file = await realpath(candidate), relative = path.relative(root, file);
                if (!relative || path.isAbsolute(relative) || relative.startsWith('..' + path.sep)
                    || relative.split(path.sep).some(part => part.startsWith('.') || ['node_modules', 'vendor'].includes(part))
                    || !(await stat(file)).isFile() || (await stat(file)).size > 4 * 1024 * 1024) {
                    response.writeHead(403).end(); return;
                }
                content = await readFile(file);
                if (/\.(m?js|mts|ts|tsx|jsx)$/.test(file)) {
                    const transformed = instrument(content.toString('utf8'), { filePath: relative.split(path.sep).join('/'),
                        runtimeUrl: `${prefix}runtime.mjs` });
                    // Each transformed module explicitly depends on configuration, including direct module navigation.
                    content = `import '${prefix}bootstrap.mjs';\n` + transformed.code;
                    type = 'text/javascript; charset=utf-8';
                } else if (/\.html?$/.test(file)) {
                    content = bootstrapHtml(content.toString('utf8'));
                    type = 'text/html; charset=utf-8';
                } else if (/\.css$/.test(file)) type = 'text/css; charset=utf-8';
                else if (/\.json$/.test(file)) type = 'application/json';
                else if (/\.svg$/.test(file)) type = 'image/svg+xml';
                else if (/\.png$/.test(file)) type = 'image/png';
            }
            response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
            response.end(request.method === 'HEAD' ? undefined : content);
        } catch { response.writeHead(404).end('Local source is unavailable.'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    return { server, origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    let fields;
    try { fields = JSON.parse(process.env.CBM_CAPTURE_FIELDS || '[]'); } catch { throw Error('CBM_CAPTURE_FIELDS must be a JSON array.'); }
    if (!Array.isArray(fields)) throw Error('CBM_CAPTURE_FIELDS must be a JSON array.');
    const overlay = await startBrowserOverlay({ root: process.env.CBM_CAPTURE_ROOT || process.cwd(),
        endpoint: process.env.CBM_CAPTURE_ENDPOINT, token: process.env.CBM_CAPTURE_TOKEN,
        valuesEnabled: process.env.CBM_CAPTURE_VALUES === '1', allowedFields: fields,
        port: Number(process.env.CBM_CAPTURE_BROWSER_PORT || 4319) });
    process.stdout.write(`Local ESM capture overlay: ${overlay.origin}\n`);
    const stop = () => void overlay.close().then(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
