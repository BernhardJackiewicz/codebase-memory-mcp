export interface SourceEvidenceRequest {
    project: string; generation: string; file_path: string; source_hash: string; start_line: number; end_line?: number;
}
export interface SourceEvidence extends SourceEvidenceRequest { schema_version: 1; content: string; end_line: number; complete: boolean }
export type SourceEvidenceLoader = (request: SourceEvidenceRequest, signal: AbortSignal) => Promise<SourceEvidence>;
export const loadSourceEvidence: SourceEvidenceLoader = async (request, signal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) if (value !== undefined) query.set(key, String(value));
    const response = await fetch(`/api/source-evidence?${query}`, { signal, cache: 'no-store', credentials: 'same-origin' });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error : `Source evidence unavailable (${response.status}).`);
    if (!body || typeof body !== 'object' || !('schema_version' in body) || body.schema_version !== 1
        || !('content' in body) || typeof body.content !== 'string' || !('complete' in body) || typeof body.complete !== 'boolean')
        throw new Error('Source evidence has an invalid shape.');
    const source = body as SourceEvidence;
    if (source.project !== request.project || source.generation !== request.generation
        || source.file_path !== request.file_path || source.source_hash !== request.source_hash
        || source.start_line !== request.start_line || !Number.isSafeInteger(source.end_line)
        || source.end_line < source.start_line || source.end_line > (request.end_line ?? request.start_line + 199)
        || source.end_line - source.start_line >= 200)
        throw new Error('Source evidence identity does not match the requested snapshot.');
    return source;
};
