import { describe, expect, it, vi } from 'vitest';
import { createDocumentsSource, isDocumentNode, readDocumentDetail, readDocumentsPage, resolveDocumentLink } from './documents-source';

const node = { id: 10, label: 'File', project: 'p', kind: 'markdown', location_kind: 'lines', name: 'Guide', qualified_name: 'docs/guide.md', file_path: 'docs/guide.md', start_line: 1, end_line: 12 };
const page = { schema_version: 1, generation: 'g1', documents: [node], complete: true, warnings: [] };
const detail = { schema_version: 1, generation: 'g1', document: node, content: '# Guide', source_mode: 'full', source_stale: false, source_truncated: false, sections: [],
    relationships: [{ id: 8, type: 'DOCUMENTS', direction: 'outgoing', target: { ...node, id: 20, label: 'Function', name: 'create', file_path: 'src/users.ts' }, evidence: { file_path: 'docs/guide.md', line: 8 } }], warnings: [] };

describe('documents wire boundary', () => {
    it('preserves exact source and graph identities', () => {
        expect(readDocumentsPage(page)).toEqual(page);
        expect(readDocumentDetail(detail)).toEqual(detail);
    });
    it('rejects malformed identities and misleading source data', () => {
        expect(() => readDocumentsPage({ ...page, documents: [{ ...node, id: -1 }] })).toThrow();
        expect(() => readDocumentDetail({ ...detail, document: { ...node, start_line: -1 } })).toThrow();
        expect(() => readDocumentDetail({ ...detail, relationships: [{ ...detail.relationships[0], direction: 'maybe' }] })).toThrow();
    });
    it('sends the query, cursor, exact generation and cancellation on read-only requests', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page))).mockResolvedValueOnce(new Response(JSON.stringify(detail)));
        const source = createDocumentsSource({ fetch: fetcher });
        const controller = new AbortController();
        await source.list({ project: 'a & b', kind: 'all', query: 'guide', cursor: 'opaque/?' }, controller.signal);
        await source.detail({ project: 'p', nodeId: 10, generation: 'g1' }, controller.signal);
        const first = new URL(fetcher.mock.calls[0][0], 'http://localhost');
        expect(first.pathname).toBe('/api/documents');
        expect(first.searchParams.get('cursor')).toBe('opaque/?');
        expect(first.searchParams.get('project')).toBe('a & b');
        expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
        expect(fetcher.mock.calls[1][0]).toContain('generation=g1');
        expect(fetcher.mock.calls[1][0]).toContain('node_id=10');
        expect(fetcher.mock.calls[1][1].method).toBe('GET');
    });
    it('reports generation changes distinctly and never silently retries a different document', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response('{"error":"index changed"}', { status: 409 }));
        const source = createDocumentsSource({ fetch: fetcher });
        await expect(source.detail({ project: 'p', nodeId: 10, generation: 'old' }, new AbortController().signal)).rejects.toThrow(/index changed/i);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

it('resolves local document links while refusing executable, remote-image and credential URLs', () => {
    expect(resolveDocumentLink('../README.md#install', 'docs/guide.md')).toEqual({ kind: 'local', path: 'README.md', anchor: 'install' });
    expect(resolveDocumentLink('#hello-world', 'docs/guide.md')).toEqual({ kind: 'local', path: 'docs/guide.md', anchor: 'hello-world' });
    expect(resolveDocumentLink('https://example.org/docs', 'README.md')).toEqual({ kind: 'external', url: 'https://example.org/docs' });
    for (const href of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:pw@example.org', '//example.org/img', '../../README.md', '%2e%2e/%2e%2e/README.md']) {
        expect(resolveDocumentLink(href, 'README.md')).toBeUndefined();
    }
});

it('distinguishes documentation files from linked code files', () => {
    const item = { ...node, kind: 'other' as const, location_kind: 'lines' as const };
    expect(isDocumentNode({ ...item, file_path: 'docs/guide.md' })).toBe(true);
    expect(isDocumentNode({ ...item, file_path: 'docs/model.drawio' })).toBe(true);
    expect(isDocumentNode({ ...item, file_path: 'src/users.ts' })).toBe(false);
    expect(isDocumentNode({ ...item, label: 'DiagramElement', file_path: 'docs/model.drawio' })).toBe(true);
});
