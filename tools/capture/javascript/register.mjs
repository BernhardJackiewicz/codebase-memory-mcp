/** Run manually: CBM_CAPTURE_ROOT=/app node --import ./register.mjs /app/main.mjs */
import { register } from 'node:module';
import { realpath } from 'node:fs/promises';
import { configure, transportOptions, flush } from './runtime.mjs';
const root = await realpath(process.env.CBM_CAPTURE_ROOT || process.cwd());
let fields;
try { fields = JSON.parse(process.env.CBM_CAPTURE_FIELDS || '[]'); }
catch { throw Error('CBM_CAPTURE_FIELDS must be a JSON array of exact field paths.'); }
if (!Array.isArray(fields)) throw Error('CBM_CAPTURE_FIELDS must be a JSON array of exact field paths.');
configure(transportOptions({ endpoint: process.env.CBM_CAPTURE_ENDPOINT, token: process.env.CBM_CAPTURE_TOKEN,
    valuesEnabled: process.env.CBM_CAPTURE_VALUES === '1', allowedFields: fields, language: 'javascript' }));
register('./loader.mjs', import.meta.url, { data: { root } });
const timer = setInterval(() => { void flush(); }, 200);
timer.unref();
process.on('beforeExit', () => { void flush(); });
