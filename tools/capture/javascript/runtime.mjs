/** Browser-compatible, bounded development probes. Never compare application values. */
export function createRuntime(options = {}) {
    const encoder = new TextEncoder(), allowed = new Set(options.allowedFields ?? []);
    if (allowed.size > 64 || [...allowed].some(field => typeof field !== 'string' || !field || field.includes('*')
        || encoder.encode(field).length > 200 || /[\x00-\x1f]/.test(field))) throw Error('Use at most 64 exact field paths.');
    const producerId = options.producerId ?? `js-${globalThis.crypto.randomUUID()}`;
    const maximum = Math.min(10000, Math.max(1, options.maxEvents ?? 10000));
    const functions = new WeakMap();
    let sequence = 0, invocation = 0, pending, buffer = [], disabled = false, sending = Promise.resolve();
    function preview(value) {
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
        if (typeof value === 'string') return new TextDecoder().decode(encoder.encode(value).slice(0, 256)).replace(/\uFFFD$/, '');
        return undefined; // No getters, custom serializers, iteration or object coercion.
    }
    function emit(frame, operation, line, value, inputs = [], accessPath, detail) {
        if (disabled || sequence >= maximum) return undefined;
        const id = ++sequence;
        const event = { sequence: id, operation, invocation_id: frame.id, value_id: `v${id}`,
            inputs: [...new Set(inputs.filter(Boolean))].slice(0, 64),
            source: { file_path: frame.meta.file_path, source_hash: frame.meta.source_hash,
                symbol: frame.meta.symbol, line: Math.max(1, line) } };
        if (accessPath) event.access_path = accessPath.slice(0, 200);
        if (detail) event.detail = detail.slice(0, 512);
        if (id === maximum) Object.assign(event, { operation: 'gap', inputs: [], detail: 'Producer event budget reached; subsequent execution is unobserved.' });
        else if (options.valuesEnabled && allowed.has(accessPath)) {
            const safe = preview(value);
            if (safe !== undefined) event.preview = safe;
        }
        buffer.push(event);
        if (buffer.length >= 128) void runtime.flush();
        return event.operation === 'gap' ? undefined : event.value_id;
    }
    const runtime = {
        producerId,
        track(fn, id) { if (typeof fn === 'function') functions.set(fn, id); return fn; },
        flush() {
            const batch = buffer; buffer = [];
            if (batch.length && !disabled) sending = sending.then(() => {
                if (!disabled) return options.sink?.(batch, producerId);
            }).catch(() => { disabled = true; });
            return sending;
        },
        frame(meta, parameters = []) {
            const bindings = new Map(), sites = new Map(), frame = { meta, id: `i${++invocation}` };
            const call = pending && !pending.consumed && pending.functionId === meta.function_id ? pending : undefined;
            if (call) call.consumed = true;
            parameters.forEach(([key, name, value], index) => {
                bindings.set(key, emit(frame, 'value', meta.line, value, call ? [call.arguments[index]] : [], name));
            });
            return Object.assign(frame, {
                observe(site, line, value, inputSites = [], operation = 'value', accessPath) {
                    if (value !== null && (typeof value === 'object' || typeof value === 'function'))
                        this.gap(line, 'Nonprimitive value may invoke coercion/accessor code; scalar binding versions are invalidated.');
                    sites.set(site, emit(frame, operation, line, value, inputSites.map(key => sites.get(key)), accessPath));
                    return value;
                },
                read(site, line, key, value, name) {
                    if (value !== null && (typeof value === 'object' || typeof value === 'function'))
                        this.gap(line, 'Nonprimitive read may invoke coercion/accessor code; scalar binding versions are invalidated.');
                    sites.set(site, emit(frame, 'copy', line, value, [bindings.get(key)], name)); return value;
                },
                assign(site, line, key, inputSite, value, name) {
                    if (value !== null && (typeof value === 'object' || typeof value === 'function'))
                        this.gap(line, 'Nonprimitive assignment has no proven scalar transport.');
                    const id = emit(frame, 'copy', line, value, [sites.get(inputSite)], name);
                    bindings.set(key, id); sites.set(site, id); return value;
                },
                returning(site, line, value, inputSite) {
                    const id = emit(frame, 'return', line, undefined, [sites.get(inputSite)]);
                    sites.set(site, id); if (call) call.returned = id; return value;
                },
                gap(line, detail) {
                    bindings.clear(); sites.clear(); emit(frame, 'gap', line, undefined, [], undefined, detail);
                },
                opaque(site, line, value, detail, accessPath, operation = 'value') {
                    this.gap(line, detail);
                    sites.set(site, emit(frame, operation, line, value, [], accessPath)); return value;
                },
                invoke(site, line, fn, args, argumentSites) {
                    const previous = pending;
                    const current = { functionId: functions.get(fn), arguments: argumentSites.map(key => sites.get(key)), consumed: false };
                    pending = current.functionId ? current : undefined;
                    let value;
                    try { value = Reflect.apply(fn, undefined, args); }
                    catch (error) { this.gap(line, 'Call raised; no result value was produced.'); throw error; }
                    finally { pending = previous; }
                    // A callback can mutate a captured binding even when its own body
                    // is opaque. Keep the proven return, but never reuse caller versions.
                    bindings.clear();
                    if (!current.consumed || !current.returned) this.gap(line, 'Opaque, async or generator call: no argument/return lineage proof.');
                    sites.set(site, emit(frame, 'call', line, undefined, current.returned ? [current.returned] : []));
                    return value;
                },
            });
        },
    };
    return runtime;
}

export function transportOptions({ endpoint, token, valuesEnabled = false, allowedFields = [], language = 'javascript' }) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.pathname !== '/v1/cbm/lineage' || !url.searchParams.get('session') || url.username || url.password || url.hash
        || typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw Error('Capture requires a loopback lineage URL and a session token.');
    return { valuesEnabled, allowedFields, sink: async (events, producerId) => {
        const response = await fetch(url, { method: 'POST', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(3000),
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ schema_version: 1, producer: { id: producerId, language }, events }) });
        if (!response.ok) throw Error(`Local capture receiver rejected events (${response.status}).`);
    } };
}
let current = createRuntime();
export function configure(options) { current = createRuntime(options); return current; }
export function getRuntime() { return current; }
export function flush() { return current.flush(); }
