// @vitest-environment jsdom
/*
 * Review-Befund G1: der Canvas wurde bei jedem Scope-Schritt neu aufgebaut und
 * die Kamera bei jedem Bild neu eingepasst. Hier steht die Szene als Attrappe,
 * die mitzaehlt, wie oft sie auf- und abgebaut wird; die Beziehungen kommen
 * ueber dieselbe RPC-Strecke wie im Betrieb.
 */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GalaxyPanel from './GalaxyPanel';
import type { GraphData, GraphEdge, GraphNode } from './types';

const scene = vi.hoisted(() => ({ mounts: 0, unmounts: 0, renders: 0 }));
vi.mock('./GraphScene', async importOriginal => ({
    ...await importOriginal<typeof import('./GraphScene')>(),
    GraphScene: ({ data }: { data: GraphData }) => {
        scene.renders += 1;
        useEffect(() => { scene.mounts += 1; return () => { scene.unmounts += 1; }; }, []);
        return <output data-testid="scene-nodes">{data.nodes.length}</output>;
    },
}));

const node = (id: number): GraphNode => ({ id, name: `n${id}`, qualified_name: `sample.n${id}`, label: 'Function',
    file_path: `src/n${id}.ts`, start_line: 1, end_line: 5, x: id * 10, y: 0, z: 0, size: 2, color: '#999999' });
const nodes = [1, 2, 3, 4, 5].map(node);
const edges: GraphEdge[] = [
    { source: 1, target: 2, type: 'CALLS', line: 3 }, { source: 3, target: 1, type: 'CALLS', line: 4 },
    { source: 2, target: 4, type: 'CALLS', line: 2 }, { source: 4, target: 5, type: 'IMPORTS' },
];

/** /api/layout plus the two query_graph shapes the scope loader sends. */
function graphFetch() {
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes('/api/layout')) return new Response(JSON.stringify({ nodes, edges, total_nodes: nodes.length }));
        const request = JSON.parse(String(init?.body)) as { params: { name: string; arguments: { query: string } } };
        if (request.params.name === 'index_status') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ indexed_at: 'generation-1' }) }] } }));
        const query = request.params.arguments.query;
        const columns = (prefix: string) => ['id', 'label', 'name', 'qn', 'file', 'start_line', 'end_line'].map(key => prefix + key);
        const values = (entry: GraphNode) => [entry.id, entry.label, entry.name, entry.qualified_name ?? '', entry.file_path ?? '', entry.start_line ?? '', entry.end_line ?? ''].map(String);
        const names = [...query.matchAll(/qualified_name = "([^"]+)"/g)].map(match => match[1]);
        let cols: string[], rows: string[][];
        if (query.startsWith('MATCH (n)')) {
            cols = columns(''); rows = nodes.filter(entry => names.includes(entry.qualified_name ?? '')).map(values);
        } else {
            cols = ['edge_id', 'edge_type', 'edge_line', ...columns('a_'), ...columns('b_')];
            rows = edges.flatMap((edge, i) => {
                const a = nodes.find(entry => entry.id === edge.source)!, b = nodes.find(entry => entry.id === edge.target)!;
                return names.includes(a.qualified_name ?? '') || names.includes(b.qualified_name ?? '')
                    ? [[String(i + 1), edge.type, String(edge.line ?? ''), ...values(a), ...values(b)]] : [];
            });
        }
        const text = `rows: ${rows.length} (cols: ${cols.join(' ')})\n${rows.map(row => '  ' + row.map(value => JSON.stringify(value || '-')).join(' ')).join('\n')}\ntotal: ${rows.length}\nhas_more: false\ntruncated: false`;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }));
    });
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    scene.mounts = 0; scene.unmounts = 0; scene.renders = 0;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.__atlasGalaxy = undefined; });

const seam = () => globalThis.__atlasGalaxy!;
const settle = (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    check();
});

it('keeps one scene mounted through selection and expansion and fits once per selected root', async () => {
    await act(async () => root.render(<GalaxyPanel project="sample" visible workspaceExpanded onOpenNode={vi.fn()} fetch={graphFetch()} />));
    await settle(() => expect(seam().nodes).toBe(5));
    expect(scene.mounts).toBe(1);
    const fitsBefore = seam().fits;

    await act(async () => { seam().clickNode('sample.n1'); });
    await settle(() => {
        expect(seam().nodes).toBe(3);
        expect(host.querySelector('.atlas-graph-scope-count')?.textContent).toBe('3 nodes · 2 edges');
    });
    expect(scene.mounts).toBe(1); expect(scene.unmounts).toBe(0);
    expect(seam().fits).toBe(fitsBefore + 1);

    const expand = [...host.querySelectorAll('button')].find(button => button.textContent === 'Expand +1')!;
    await act(async () => expand.click());
    await settle(() => expect(seam().nodes).toBe(4));
    expect(scene.mounts).toBe(1); expect(scene.unmounts).toBe(0);
    // An expansion is the same scope: no new fit, the scene keeps the reader's camera.
    expect(seam().fits).toBe(fitsBefore + 1);

    await act(async () => { seam().clickNode('sample.n4'); });
    await settle(() => expect(seam().lastFit?.nodes).toBe(3));
    expect(scene.mounts).toBe(1);
    expect(seam().fits).toBe(fitsBefore + 2);
});
