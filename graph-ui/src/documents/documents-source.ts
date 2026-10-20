/** Read-only documentation projection. IDs are scoped to the returned index generation. */
export type DocumentKind = 'markdown' | 'pdf' | 'diagram' | 'adr' | 'other';
export interface DocumentNode {
    id: number; project: string; label: string; name: string; qualified_name: string; file_path: string;
    start_line: number; end_line: number;
    kind?: DocumentKind; location_kind?: 'lines' | 'pages' | 'diagram';
}
export interface DocumentsPage {
    schema_version: 1; generation: string; documents: DocumentNode[];
    complete: boolean; next_cursor?: string; warnings: string[];
}
export interface DocumentRelationship {
    id: number; type: string; direction: 'incoming' | 'outgoing'; target: DocumentNode;
    evidence?: { file_path: string; line?: number; page?: number; position_kind?: 'relationship' | 'source_context' };
    properties?: Record<string, unknown>;
}
export interface DocumentDetail {
    schema_version: 1; generation: string; document: DocumentNode; content: string;
    pages?: { page: number; text: string }[];
    source_mode: 'full' | 'extracted' | 'unavailable'; source_stale: boolean; source_truncated: boolean;
    sections: DocumentNode[]; relationships: DocumentRelationship[]; warnings: string[];
}
export interface DocumentsRequest { project: string; kind?: DocumentKind | 'all'; query?: string; cursor?: string }
export interface DocumentRequest { project: string; nodeId?: number; filePath?: string; generation: string }
export interface DocumentNavigationTarget { filePath: string; generation: string; line?: number; page?: number }
export interface DocumentsSource {
    list(request: DocumentsRequest, signal: AbortSignal): Promise<DocumentsPage>;
    detail(request: DocumentRequest, signal: AbortSignal): Promise<DocumentDetail>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const node = (value: unknown): value is DocumentNode => record(value) && integer(value.id)
    && ['project', 'label', 'name', 'qualified_name', 'file_path'].every(key => typeof value[key] === 'string')
    && integer(value.start_line) && integer(value.end_line)
    && (value.kind === undefined || ['markdown', 'pdf', 'diagram', 'adr', 'other'].includes(String(value.kind)))
    && (value.location_kind === undefined || ['lines', 'pages', 'diagram'].includes(String(value.location_kind)));
const nodes = (value: unknown): value is DocumentNode[] => Array.isArray(value) && value.every(node);
const envelope = (value: unknown): value is Record<string, unknown> => record(value) && value.schema_version === 1
    && typeof value.generation === 'string' && value.generation.length > 0 && strings(value.warnings);

export function readDocumentsPage(value: unknown): DocumentsPage {
    if (!envelope(value) || !nodes(value.documents) || typeof value.complete !== 'boolean'
        || (value.next_cursor !== undefined && typeof value.next_cursor !== 'string')) throw new Error('The document catalog has an unsupported shape.');
    return value as unknown as DocumentsPage;
}
export function readDocumentDetail(value: unknown): DocumentDetail {
    if (!envelope(value) || !node(value.document) || typeof value.content !== 'string'
        || !['full', 'extracted', 'unavailable'].includes(String(value.source_mode))
        || typeof value.source_stale !== 'boolean' || typeof value.source_truncated !== 'boolean'
        || (value.pages !== undefined && (!Array.isArray(value.pages)
            || !value.pages.every(page => record(page) && integer(page.page) && page.page > 0 && typeof page.text === 'string')
            || new Set(value.pages.map(page => page.page)).size !== value.pages.length))
        || !nodes(value.sections) || !Array.isArray(value.relationships)
        || !value.relationships.every(item => record(item) && integer(item.id) && typeof item.type === 'string'
            && ['incoming', 'outgoing'].includes(String(item.direction)) && node(item.target)
            && (item.properties === undefined || record(item.properties))
            && (item.evidence === undefined || (record(item.evidence) && typeof item.evidence.file_path === 'string'
                && (item.evidence.line === undefined || integer(item.evidence.line))
                && (item.evidence.position_kind === undefined || item.evidence.position_kind === 'relationship'
                    || (item.evidence.position_kind === 'source_context' && integer(item.evidence.page) && item.evidence.page > 0))
                && (item.evidence.page === undefined || integer(item.evidence.page)))))) throw new Error('The document evidence has an unsupported shape.');
    return value as unknown as DocumentDetail;
}

export function createDocumentsSource(options: { fetch?: typeof globalThis.fetch; base?: string } = {}): DocumentsSource {
    async function get(path: string, query: URLSearchParams, signal: AbortSignal) {
        const response = await (options.fetch ?? globalThis.fetch)(`${options.base ?? ''}${path}?${query}`, {
            method: 'GET', signal, headers: { Accept: 'application/json' },
        });
        if (response.status === 409) throw new Error('The index changed. Refresh the catalog before opening this document.');
        if (!response.ok) throw new Error(response.status === 404 ? 'This document is not available in the selected project index.'
            : `Documentation could not be read (HTTP ${response.status}). Try again.`);
        return response.json();
    }
    return {
        async list(request, signal) {
            const query = new URLSearchParams({ project: request.project, kind: request.kind ?? 'all' });
            if (request.query) query.set('query', request.query);
            if (request.cursor) query.set('cursor', request.cursor);
            return readDocumentsPage(await get('/api/documents', query, signal));
        },
        async detail(request, signal) {
            const query = new URLSearchParams({ project: request.project, generation: request.generation });
            if (request.nodeId !== undefined) query.set('node_id', String(request.nodeId));
            else if (request.filePath) query.set('file_path', request.filePath);
            else throw new Error('Choose an indexed document first.');
            const detail = readDocumentDetail(await get('/api/document', query, signal));
            if (detail.generation !== request.generation || detail.document.project !== request.project
                || (request.nodeId !== undefined && detail.document.id !== request.nodeId)) throw new Error('The document identity changed. Refresh the catalog.');
            return detail;
        },
    };
}

export type DocumentLink = { kind: 'local'; path: string; anchor: string } | { kind: 'external'; url: string };
export function resolveDocumentLink(href: string, currentPath: string): DocumentLink | undefined {
    if (/[\u0000-\u001f\u007f\\]/.test(href) || href.startsWith('//')) return;
    try {
        if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
            const url = new URL(href);
            if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return;
            return { kind: 'external', url: url.href };
        }
        // URL would silently clamp excessive ".." to its origin. Preserve an unresolved link instead.
        const path = decodeURIComponent(href.split(/[?#]/, 1)[0]);
        const segments = path.startsWith('/') ? [] : currentPath.split('/').filter(Boolean).slice(0, -1);
        for (const part of path.split('/')) {
            if (!part || part === '.') continue;
            if (part === '..') { if (!segments.length) return; segments.pop(); }
            else segments.push(part);
        }
        const absolute = currentPath.startsWith('/');
        const url = new URL(href, `https://repository.invalid/${currentPath.replace(/^\/+/, '')}`);
        if (url.origin !== 'https://repository.invalid') return;
        return { kind: 'local', path: `${absolute ? '/' : ''}${decodeURIComponent(url.pathname).replace(/^\/+/, '')}`, anchor: decodeURIComponent(url.hash.slice(1)) };
    } catch { return; }
}

export const documentKindLabel = (kind: DocumentKind | undefined) => ({ markdown: 'Markdown', pdf: 'PDF', diagram: 'Diagram', adr: 'ADR', other: 'Document' })[kind ?? 'other'];
export const isDocumentPath = (path: string) => /\.(?:md|mdx|markdown|rst|adoc|asciidoc|pdf|drawio|mmd|mermaid|puml|plantuml|dot|d2|excalidraw)$/i.test(path);
export const isDocumentNode = (value: DocumentNode) => ['Document', 'Section', 'ADR', 'Diagram', 'DiagramElement', 'DocumentSection'].includes(value.label)
    || (value.label === 'File' && isDocumentPath(value.file_path));
export const documentLocation = (value: DocumentNode) => value.location_kind === 'pages'
    ? `${value.file_path}${value.start_line > 0 ? ` · page ${value.start_line}` : ''}`
    : `${value.file_path}${value.start_line > 0 ? `:${value.start_line}` : ''}`;
