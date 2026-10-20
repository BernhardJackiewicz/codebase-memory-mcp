// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DocumentsWorkspace from './DocumentsWorkspace';
import type { DocumentsSource, DocumentNode, DocumentDetail } from './documents-source';

let host: HTMLDivElement, root: Root;
const guide: DocumentNode = { id: 1, label: 'File', project: 'p', kind: 'markdown', location_kind: 'lines', name: 'Guide', qualified_name: 'docs/guide.md', file_path: 'docs/guide.md', start_line: 1, end_line: 10 };
const readme: DocumentNode = { ...guide, id: 2, name: 'README', file_path: 'README.md', qualified_name: 'README.md' };
const detail = (document = guide): DocumentDetail => ({ schema_version: 1, generation: 'g1', document, content: '# Guide\n\n[Read README](../README.md#setup)\n\n## Setup\n\nUse the indexed API.',
    source_mode: 'full', source_stale: false, source_truncated: false, sections: [], warnings: [], relationships: [
        { id: 8, type: 'REFERENCES', direction: 'outgoing', target: readme, evidence: { file_path: guide.file_path, line: 3 } },
        { id: 9, type: 'DOCUMENTS', direction: 'outgoing', target: { ...guide, id: 3, label: 'Function', name: 'createUser', file_path: 'src/users.ts', start_line: 24 } },
    ] });
const adr = { adr: vi.fn(async () => ({ hasAdr: true, content: '# Keep these decisions', updatedAt: '' })), saveAdr: vi.fn(async () => {}) };
function source(): DocumentsSource {
    return { list: vi.fn(async () => ({ schema_version: 1 as const, generation: 'g1', documents: [guide, readme], complete: true, warnings: [] })),
        detail: vi.fn(async request => detail(request.nodeId === 2 || request.filePath === 'README.md' ? readme : guide)) };
}
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    vi.clearAllMocks();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function button(name: string) {
    const found = [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === name || node.getAttribute('aria-label') === name);
    if (!found) throw new Error(`Button missing: ${name}`);
    return found;
}
async function click(name: string) { await act(async () => button(name).click()); }

it('loads only active documentation, opens actual content and follows indexed document links', async () => {
    const api = source();
    await act(async () => root.render(<DocumentsWorkspace project="p" active={false} source={api} adrSource={adr} onNavigate={vi.fn()} />));
    expect(api.list).not.toHaveBeenCalled();
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Open Guide');
    expect(host.querySelector('.docs-reader')?.textContent).toContain('Use the indexed API.');
    await act(async () => (host.querySelector('.docs-reader a') as HTMLAnchorElement).click());
    expect(api.detail).toHaveBeenLastCalledWith({ project: 'p', filePath: 'README.md', generation: 'g1' }, expect.any(AbortSignal));
    await click('Back');
    expect(host.querySelector('.docs-document-heading')?.textContent).toContain('Guide');
});

it('opens graph evidence at its real source location and keeps the ADR editor intact', async () => {
    const onNavigate = vi.fn(), api = source();
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={onNavigate} />));
    await click('Open Guide');
    await click('Open source for createUser');
    expect(onNavigate).toHaveBeenCalledWith('src/users.ts', 24, 'createUser');
    await click('Architecture decisions');
    expect(adr.adr).toHaveBeenCalledWith('p');
    expect(host.textContent).toContain('Keep these decisions');
    await click('Edit');
    const editor = host.querySelector('textarea');
    await click('Documents');
    await click('Architecture decisions');
    expect(host.querySelector('textarea')).toBe(editor);
    expect(adr.saveAdr).not.toHaveBeenCalled();
});

it('selects the exact indexed heading line when section titles repeat and retains section history', async () => {
    const api = source();
    const sections: DocumentNode[] = [3, 7].map((line, index) => ({
        ...guide, id: 20 + index, label: 'Section', name: 'Repeated', start_line: line, end_line: line + 2,
    }));
    vi.mocked(api.detail).mockImplementation(async request => ({
        ...detail(sections.find(section => section.id === request.nodeId) ?? guide), sections,
        content: '# Guide\n\n## Repeated\n\nFirst section.\n\n## Repeated\n\nSecond section.',
    }));
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Open Guide');
    const sectionButtons = () => [...host.querySelectorAll<HTMLButtonElement>('.docs-connections section button')]
        .filter(node => node.textContent?.startsWith('Repeated'));
    await act(async () => sectionButtons()[1].click());
    expect(document.activeElement).toBe(host.querySelector('[data-document-anchor="repeated-1"]'));
    await act(async () => sectionButtons()[0].click());
    expect(document.activeElement).toBe(host.querySelector('[data-document-anchor="repeated"]'));
    await click('Back');
    expect(document.activeElement).toBe(host.querySelector('[data-document-anchor="repeated-1"]'));
});

it('preserves a selected heading and user focus through unrelated parent renders', async () => {
    const api = source(), onNavigate = vi.fn();
    vi.mocked(api.detail).mockResolvedValue({ ...detail(), content: `${detail().content}\n\n[Code](../src/users.ts#L24)` });
    const target = { filePath: guide.file_path, generation: 'g1', line: 5 };
    const render = (navigate = onNavigate) => root.render(<DocumentsWorkspace project="p" active
        source={api} adrSource={adr} onNavigate={navigate} openDocument={target} />);
    await act(async () => render());
    const heading = host.querySelector('[data-document-anchor="setup"]');
    expect(document.activeElement).toBe(heading);
    for (const navigate of [onNavigate, vi.fn()]) {
        await act(async () => render(navigate));
        expect(host.querySelector('[data-document-anchor="setup"]')).toBe(heading);
        expect(document.activeElement).toBe(heading);
    }
    const code = [...host.querySelectorAll<HTMLAnchorElement>('.docs-reader a')].find(link => link.textContent === 'Code')!;
    code.focus();
    const latestNavigate = vi.fn();
    await act(async () => render(latestNavigate));
    expect(document.activeElement).toBe(code);
    await act(async () => code.click());
    expect(latestNavigate).toHaveBeenCalledWith('src/users.ts', 24, 'users.ts');
    const search = host.querySelector('input');
    search?.focus();
    await act(async () => render(vi.fn()));
    expect(document.activeElement).toBe(search);
});

it('opens a generation-pinned PDF page through extracted documentation and keeps page selection separate from lines', async () => {
    const api = source(), onNavigate = vi.fn();
    const pdf: DocumentNode = { ...guide, file_path: 'docs/guide.pdf', kind: 'pdf', location_kind: 'pages', name: 'PDF guide' };
    const section: DocumentNode = { ...pdf, id: 21, label: 'Section', name: 'Page 2', start_line: 2, end_line: 2 };
    vi.mocked(api.detail).mockResolvedValue({
        ...detail(pdf), source_mode: 'extracted', sections: [section], relationships: [],
        content: '## Page 1\n\nFirst page.\n\n## Page 2\n\nSecond page.',
        pages: [{ page: 1, text: 'First page.' }, { page: 2, text: 'Second page.' }],
    });
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={onNavigate}
        openDocument={{ filePath: pdf.file_path, generation: 'g1', page: 2 }} />));
    expect(api.detail).toHaveBeenLastCalledWith({ project: 'p', filePath: pdf.file_path, generation: 'g1' }, expect.any(AbortSignal));
    expect(document.activeElement).toBe(host.querySelector('[data-document-anchor="page-2"]'));
    expect(onNavigate).not.toHaveBeenCalled();
    await click('Page 2Page 2');
    expect(document.activeElement).toBe(host.querySelector('[data-document-anchor="page-2"]'));
});

it('labels a relationship without a recorded position as file context instead of a precise witness', async () => {
    const api = source(), onNavigate = vi.fn();
    vi.mocked(api.detail).mockResolvedValue({ ...detail(), relationships: [{
        id: 8, type: 'REFERENCES_FILE', direction: 'outgoing', target: readme,
        evidence: { file_path: guide.file_path },
    }] });
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={onNavigate} />));
    await click('Open Guide');
    expect(host.textContent).toContain('Relationship location was not recorded.');
    await click('Open source file');
    expect(onNavigate).toHaveBeenLastCalledWith('docs/guide.md', undefined, 'REFERENCES_FILE source file');
    expect(host.querySelector('.docs-evidence-link')?.textContent).not.toContain('View relationship source');
});

it('focuses the actual PDF page even when extracted text contains a matching Markdown heading', async () => {
    const api = source();
    const pdf = { ...guide, kind: 'pdf' as const, location_kind: 'pages' as const, file_path: 'guide.pdf' };
    const response = { ...detail(pdf), source_mode: 'extracted' as const,
        content: '## Page 1\n\n## Page 2\n\nStill page 1 text\n\n## Page 2\n\nActual second page',
        pages: [{ page: 1, text: '## Page 2\n\nStill page 1 text' }, { page: 2, text: 'Actual second page' }],
        sections: [], relationships: [] };
    vi.mocked(api.detail).mockResolvedValue(response);
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr}
        openDocument={{ filePath: 'guide.pdf', generation: 'g1', page: 2 }} onNavigate={vi.fn()} />));
    const page = host.querySelector('[data-document-page="2"]');
    expect(page).not.toBeNull();
    expect(page?.textContent).toContain('Actual second page');
    expect(page?.contains(document.activeElement)).toBe(true);
    expect(host.querySelectorAll('.docs-reader h2')).toHaveLength(2);
    expect(host.querySelector('[data-document-page="1"]')?.textContent).toContain('## Page 2');
});

it('keeps Markdown anchors deterministic in StrictMode and unique when suffixes collide', async () => {
    const api = source();
    vi.mocked(api.detail).mockResolvedValue({ ...detail(), content: '# Guide\n\n[Go to setup](#setup)\n\n## Setup\n\nFirst\n\n## Setup\n\nSecond\n\n## Setup-1\n\nThird' });
    await act(async () => root.render(<StrictMode><DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} /></StrictMode>));
    await click('Open Guide');
    const headings = [...host.querySelectorAll<HTMLElement>('[data-document-anchor]')];
    expect(headings.map(node => node.id)).toEqual(['guide', 'setup', 'setup-1', 'setup-1-1']);
    await act(async () => (host.querySelector('.docs-reader a') as HTMLAnchorElement).click());
    expect(document.activeElement?.id).toBe('setup');
    expect(host.querySelectorAll('#setup-1')).toHaveLength(1);
});

it('distinguishes a PDF source section from a recorded relationship coordinate', async () => {
    const api = source();
    const response = { ...detail(), relationships: [{
        id: 8, type: 'MENTIONS', direction: 'incoming' as const, target: readme,
        evidence: { file_path: 'guide.pdf', page: 2, position_kind: 'source_context' as const },
    }] };
    vi.mocked(api.detail).mockResolvedValue(response);
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Open Guide');
    expect(host.querySelector('.docs-evidence-link')?.textContent).toBe('Open source section · page 2');
    expect(host.textContent).toContain('Showing the source section; the relationship position was not recorded.');
});

it.each(['relationship', 'source_context'] as const)('opens an incoming PDF %s witness at its page and preserves it in history', async positionKind => {
    const api = source(), onNavigate = vi.fn();
    const pdf: DocumentNode = { ...guide, id: 30, file_path: 'source.pdf', kind: 'pdf', location_kind: 'pages', name: 'PDF source' };
    vi.mocked(api.detail).mockImplementation(async request => request.filePath === pdf.file_path ? {
        ...detail(pdf), source_mode: 'extracted', sections: [], relationships: [],
        content: 'First page.\nSecond page.',
        pages: [{ page: 1, text: 'First page.' }, { page: 2, text: 'Second page.' }],
    } : {
        ...detail(), sections: [], relationships: [{
            id: 8, type: 'MENTIONS', direction: 'incoming', target: pdf,
            evidence: { file_path: pdf.file_path, page: 2, position_kind: positionKind },
        }],
    });
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={onNavigate} />));
    await click('Open Guide');
    await click(`${positionKind === 'source_context' ? 'Open source section' : 'View relationship source'} · page 2`);
    expect(api.detail).toHaveBeenLastCalledWith({ project: 'p', filePath: 'source.pdf', generation: 'g1' }, expect.any(AbortSignal));
    expect(document.activeElement).toBe(host.querySelector('[data-document-page="2"] h2'));
    await click('Back');
    expect(host.querySelector('.docs-document-heading')?.textContent).toContain('Guide');
    await click('Forward');
    expect(document.activeElement).toBe(host.querySelector('[data-document-page="2"] h2'));
    expect(onNavigate).not.toHaveBeenCalled();
});

it('opens relative code and configuration links in indexed source without replacing the document', async () => {
    const api = source(), onNavigate = vi.fn();
    vi.mocked(api.detail).mockResolvedValue({ ...detail(), content: '# Guide\n\n[Users](../src/users.ts#L24-L30)\n\n[Compose](../compose.yaml)\n\n[Docker](../Dockerfile)' });
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={onNavigate} />));
    await click('Open Guide');
    const links = [...host.querySelectorAll<HTMLAnchorElement>('.docs-reader a')];
    await act(async () => links[0].click());
    expect(onNavigate).toHaveBeenLastCalledWith('src/users.ts', 24, 'users.ts');
    await act(async () => links[1].click());
    expect(onNavigate).toHaveBeenLastCalledWith('compose.yaml', undefined, 'compose.yaml');
    await act(async () => links[2].click());
    expect(onNavigate).toHaveBeenLastCalledWith('Dockerfile', undefined, 'Dockerfile');
    expect(api.detail).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.docs-document-heading')?.textContent).toContain('Guide');
});

it('keeps a prior project response out of the current project and reports errors without fabricated content', async () => {
    let resolve!: (value: DocumentDetail) => void;
    const api = source();
    api.detail = vi.fn(() => new Promise<DocumentDetail>(done => { resolve = done; }));
    await act(async () => root.render(<DocumentsWorkspace project="old" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Open Guide');
    await act(async () => root.render(<DocumentsWorkspace project="new" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await act(async () => resolve(detail()));
    expect(host.querySelector('.docs-reader')).toBeNull();
    expect(host.textContent).not.toContain('Use the indexed API.');
});

it('opens the retained ADR for old workspace links without querying the documents API', async () => {
    const api = source();
    await act(async () => root.render(<DocumentsWorkspace project="p" active initialTab="adr" source={api} adrSource={adr} onNavigate={vi.fn()} />));
    expect(api.list).not.toHaveBeenCalled();
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe('Architecture decisions');
});

it('draws only recorded document neighbors and opens a selected graph node', async () => {
    const api = source(), onNavigate = vi.fn();
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={onNavigate} />));
    await click('Open Guide');
    const graph = host.querySelector('[aria-label="Documentation graph"]')!;
    expect(graph).not.toBeNull();
    expect(graph.querySelectorAll('[data-document-edge]')).toHaveLength(2);
    expect(graph.textContent).toContain('DOCUMENTS');
    const code = graph.querySelector('[aria-label="Open graph node createUser"]')!;
    await act(async () => code.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onNavigate).toHaveBeenCalledWith('src/users.ts', 24, 'createUser');
    const camera = graph.querySelector('svg > g')!;
    const before = camera.getAttribute('transform');
    await act(async () => graph.querySelector('svg')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })));
    expect(camera.getAttribute('transform')).not.toBe(before);
    await click('Fit');
    expect(camera.getAttribute('transform')).toBe(before);
});

it('routes every document connection outside unrelated nodes and exposes a readable focused edge label', async () => {
    const api = source();
    vi.mocked(api.detail).mockResolvedValue({ ...detail(), relationships: Array.from({ length: 6 }, (_, index) => ({
        id: index + 20, type: index % 2 ? 'REFERENCES' : 'DOCUMENTS', direction: 'outgoing' as const,
        target: { ...readme, id: index + 10, name: `Connected document ${index}`, file_path: `docs/linked-${index}.md` },
    })) });
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Open Guide');
    const graph = host.querySelector('[aria-label="Documentation graph"]')!;
    const boxes = [...graph.querySelectorAll('[data-graph-node]')].map(node => {
        const [x, y] = node.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        const rect = node.querySelector('rect')!;
        return { x: x + Number(rect.getAttribute('x')), y: y + Number(rect.getAttribute('y')),
            width: Number(rect.getAttribute('width')), height: Number(rect.getAttribute('height')) };
    });
    for (const edge of graph.querySelectorAll('.docs-graph-edge')) {
        const path = edge.getAttribute('d')!, p = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        for (let step = 1; step < 20; step += 1) {
            const t = step / 20, u = 1 - t;
            const point = path.includes('Q')
                ? [u * u * p[0] + 2 * u * t * p[2] + t * t * p[4], u * u * p[1] + 2 * u * t * p[3] + t * t * p[5]]
                : [u ** 3 * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t ** 3 * p[6],
                    u ** 3 * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t ** 3 * p[7]];
            expect(boxes.some(box => point[0] > box.x && point[0] < box.x + box.width
                && point[1] > box.y && point[1] < box.y + box.height)).toBe(false);
        }
    }
    await act(async () => (graph.querySelector('[data-document-edge]') as SVGGElement).focus());
    expect(graph.querySelector('.docs-graph-edge-caption')?.textContent).toContain('DOCUMENTS');
    expect(graph.querySelectorAll('.docs-graph-edge-label')).toHaveLength(0);
});

it('reports missing documents without preserving the previous document under a failed link', async () => {
    const api = source();
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Open Guide');
    api.detail = vi.fn().mockRejectedValue(new Error('This document is not available in the selected project index.'));
    await act(async () => (host.querySelector('.docs-reader a') as HTMLAnchorElement).click());
    expect(host.querySelector('.docs-reader')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not available');
});

it('paginates actual documents and rejects a continuation from another generation', async () => {
    const api = source();
    vi.mocked(api.list).mockResolvedValueOnce({ schema_version: 1, generation: 'g1', documents: [guide], complete: false, next_cursor: 'page-2', warnings: [] })
        .mockResolvedValueOnce({ schema_version: 1, generation: 'g1', documents: [readme], complete: false, next_cursor: 'page-3', warnings: [] })
        .mockResolvedValueOnce({ schema_version: 1, generation: 'g2', documents: [{ ...readme, id: 99, name: 'Wrong generation' }], complete: true, warnings: [] });
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Load more documents');
    expect(host.querySelectorAll('.docs-document-list li')).toHaveLength(2);
    expect(api.list).toHaveBeenLastCalledWith({ project: 'p', kind: 'all', query: '', cursor: 'page-2' }, expect.any(AbortSignal));
    await click('Load more documents');
    expect(host.textContent).toContain('The index changed.');
    expect(host.textContent).not.toContain('Wrong generation');
    expect(host.querySelectorAll('.docs-document-list li')).toHaveLength(2);
});

it('labels extracted and stale content and does not issue network requests for Markdown images', async () => {
    const api = source();
    vi.mocked(api.detail).mockResolvedValue({ ...detail(), source_mode: 'extracted', source_stale: true, source_truncated: true,
        content: '# Extracted page\n\n![remote](https://example.org/pixel.png)' });
    await act(async () => root.render(<DocumentsWorkspace project="p" active source={api} adrSource={adr} onNavigate={vi.fn()} />));
    await click('Open Guide');
    expect(host.textContent).toContain('Text extracted by the index');
    expect(host.textContent).toContain('changed after indexing');
    expect(host.textContent).toContain('Only part of this document');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.docs-reader a')?.getAttribute('href')).toBe('https://example.org/pixel.png');
});
