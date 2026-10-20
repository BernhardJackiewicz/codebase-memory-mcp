/** Node asynchronous module hooks. Native ESM only; all overlays stay in memory. */
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { instrument } from './instrument.mjs';
let root;
const adapter = path.dirname(fileURLToPath(import.meta.url));
const excluded = new Set(['node_modules', '.git', '.venv', 'vendor']);
export async function initialize(data) { root = await realpath(data.root); }
export async function eligible(url) {
    if (!root || !url.startsWith('file:')) return undefined;
    try {
        const file = await realpath(fileURLToPath(url)), relative = path.relative(root, file);
        if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
            || file === adapter || file.startsWith(adapter + path.sep)
            || relative.split(path.sep).some(part => excluded.has(part))
            || !/\.(mjs|js|mts|ts|tsx|jsx)$/.test(file) || (await stat(file)).size > 4 * 1024 * 1024) return undefined;
        return { file, relative: relative.split(path.sep).join('/') };
    } catch { return undefined; }
}
export async function load(url, context, nextLoad) {
    const target = await eligible(url);
    if (!target) return nextLoad(url, context);
    const typescript = /\.(mts|ts|tsx|jsx)$/.test(target.file);
    const loaded = typescript ? { format: 'module', source: await readFile(target.file, 'utf8') } : await nextLoad(url, context);
    // A CommonJS loader has different resolution/require semantics; leave it untouched.
    if (loaded.format !== 'module') return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    const output = instrument(source, { filePath: target.relative, runtimeUrl: new URL('./runtime.mjs', import.meta.url).href });
    return { ...loaded, format: 'module', source: output.code, shortCircuit: true };
}
