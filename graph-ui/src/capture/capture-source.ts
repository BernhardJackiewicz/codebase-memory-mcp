export const CAPTURE_PROFILES = [
    { id: 'node', label: 'JavaScript / TypeScript · Node' }, { id: 'browser', label: 'JavaScript / TypeScript · Browser' },
    { id: 'python', label: 'Python' }, { id: 'jvm', label: 'Java / Kotlin · JVM' }, { id: 'dotnet', label: 'C# · .NET' },
    { id: 'go', label: 'Go' }, { id: 'rust', label: 'Rust' }, { id: 'php', label: 'PHP' }, { id: 'native', label: 'C / C++' },
] as const;
export type CaptureProfile = typeof CAPTURE_PROFILES[number]['id'];
export interface CaptureSession {
    id: string; project: string; generation: string; profile: string; status: 'recording' | 'stopped' | 'limited';
    created_at: number; expires_at: number; accepted_events: number; dropped_events: number; max_events: number;
    values_enabled: boolean; allowed_fields: string[]; capabilities: string[]; gaps: string[];
}
export interface CaptureEvent {
    id: number; producer_id: string; language: string; sequence: number; operation: string; invocation_id: string;
    value_id?: string; inputs: string[]; input_refs?: { producer_id: string; value_id: string }[];
    access_path?: string; source?: { file_path: string; line: number; source_hash: string; symbol?: string };
    source_status: 'matched' | 'stale' | 'unmatched'; trace_id?: string; span_id?: string; preview?: string; detail?: string;
}
export interface CaptureStartRequest {
    project: string; generation: string; profile: CaptureProfile; values_enabled: boolean; allowed_fields: string[]; allowed_origin?: string;
}
export interface CaptureStarted {
    schema_version: 1; session: CaptureSession; token: string; lineage_url: string; traces_url: string; instructions: string[];
}
export interface CaptureEvents {
    schema_version: 1; session: CaptureSession; events: CaptureEvent[]; next_after: number; complete: boolean;
}
export interface CaptureApi {
    list(project: string, signal: AbortSignal): Promise<CaptureSession[]>;
    start(request: CaptureStartRequest, signal: AbortSignal): Promise<CaptureStarted>;
    stop(id: string, signal: AbortSignal): Promise<CaptureSession>;
    remove(id: string, signal: AbortSignal): Promise<void>;
    events(id: string, after: number, signal: AbortSignal): Promise<CaptureEvents>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';
const envelope = (value: unknown): value is Record<string, unknown> => record(value) && value.schema_version === 1;

export function readCaptureSession(value: unknown): CaptureSession {
    if (!record(value) || !['id', 'project', 'generation', 'profile'].every(key => text(value[key]))
        || !['recording', 'stopped', 'limited'].includes(String(value.status))
        || !['created_at', 'expires_at', 'accepted_events', 'dropped_events', 'max_events'].every(key => integer(value[key]))
        || typeof value.values_enabled !== 'boolean' || !strings(value.allowed_fields) || !strings(value.capabilities) || !strings(value.gaps)) {
        throw new Error('Invalid local capture session response.');
    }
    return value as unknown as CaptureSession;
}
function isEvent(value: unknown): value is CaptureEvent {
    return record(value) && integer(value.id) && value.id > 0 && integer(value.sequence)
        && ['producer_id', 'language', 'operation', 'invocation_id'].every(key => text(value[key]))
        && strings(value.inputs) && value.inputs.every(text) && ['matched', 'stale', 'unmatched'].includes(String(value.source_status))
        && ['value_id', 'access_path', 'trace_id', 'span_id', 'preview', 'detail'].every(key => optionalText(value[key]))
        && (value.input_refs === undefined || (Array.isArray(value.input_refs) && value.input_refs.every(ref => record(ref) && text(ref.producer_id) && text(ref.value_id))))
        && (value.source === undefined || (record(value.source) && text(value.source.file_path)
            && integer(value.source.line) && value.source.line > 0 && text(value.source.source_hash) && optionalText(value.source.symbol)));
}
export function readCaptureEvents(value: unknown): CaptureEvents {
    if (!envelope(value) || !Array.isArray(value.events) || !value.events.every(isEvent)
        || !integer(value.next_after) || typeof value.complete !== 'boolean'
        || value.events.some(event => event.id > Number(value.next_after))
        || new Set(value.events.map(event => event.id)).size !== value.events.length) {
        throw new Error('Invalid local capture events response.');
    }
    readCaptureSession(value.session);
    return value as unknown as CaptureEvents;
}
export function readCaptureStarted(value: unknown): CaptureStarted {
    if (!envelope(value) || !text(value.token) || !text(value.lineage_url) || !text(value.traces_url) || !strings(value.instructions)) {
        throw new Error('Invalid local capture start response.');
    }
    readCaptureSession(value.session);
    return value as unknown as CaptureStarted;
}
export function captureFields(value: string): string[] {
    return [...new Set(value.split(/\r?\n/).map(field => field.trim()).filter(Boolean))];
}
export function validCaptureFields(fields: readonly string[]): boolean {
    return fields.length > 0 && fields.every(field => field.length <= 200 && !/[*\r\n]/.test(field) && field.trim() === field && field.length > 0);
}
export function validCaptureOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && Boolean(url.port) && url.origin === origin;
    } catch { return false; }
}
async function request(path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(path, {
        method, signal, credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let result: unknown;
    try { result = await response.json(); } catch { throw new Error(`Local capture returned an unreadable response (HTTP ${response.status}).`); }
    if (!response.ok) throw new Error(record(result) && typeof result.error === 'string' ? result.error : `Local capture request failed (HTTP ${response.status}).`);
    return result;
}
function sameSession(session: CaptureSession, id: string): CaptureSession {
    if (session.id !== id) throw new Error('Local capture returned a different session.');
    return session;
}
export const captureApi: CaptureApi = {
    async list(project, signal) {
        const result = await request(`/api/capture/sessions?project=${encodeURIComponent(project)}`, signal);
        if (!envelope(result) || !Array.isArray(result.sessions)) throw new Error('Invalid local capture sessions response.');
        const sessions = result.sessions.map(readCaptureSession);
        if (sessions.some(session => session.project !== project) || new Set(sessions.map(session => session.id)).size !== sessions.length) throw new Error('Capture session belongs to another project.');
        return sessions;
    },
    async start(args, signal) {
        if (!args.project || !args.generation) throw new Error('A project and current index generation are required.');
        if (args.values_enabled && !validCaptureFields(args.allowed_fields)) throw new Error('Choose explicit test fields before enabling raw values. Wildcards are not allowed.');
        if (!args.values_enabled && args.allowed_fields.length) throw new Error('Raw value fields require an explicit opt-in.');
        if (args.allowed_origin && !validCaptureOrigin(args.allowed_origin)) throw new Error('Choose one local HTTP application origin including its port.');
        const result = readCaptureStarted(await request('/api/capture/sessions', signal, 'POST', args));
        if (result.session.project !== args.project || result.session.generation !== args.generation) throw new Error('Capture started against a different project or generation.');
        return result;
    },
    async stop(id, signal) {
        const result = await request('/api/capture/stop', signal, 'POST', { id });
        if (!envelope(result)) throw new Error('Invalid local capture stop response.');
        return sameSession(readCaptureSession(result.session), id);
    },
    async remove(id, signal) {
        const result = await request(`/api/capture/session?id=${encodeURIComponent(id)}`, signal, 'DELETE');
        if (!record(result) || result.deleted !== true) throw new Error('Local capture was not deleted.');
    },
    async events(id, after, signal) {
        const result = readCaptureEvents(await request(`/api/capture/events?id=${encodeURIComponent(id)}&after=${after}`, signal));
        sameSession(result.session, id);
        if (result.next_after < after) throw new Error('Local capture event cursor moved backwards.');
        return result;
    },
};
