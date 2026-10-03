// @vitest-environment jsdom
/*
 * Handtest K8: eine tiefe Ebene haengt nicht mehr minutenlang. Die Leiste
 * zeigt, was schon geladen ist, "−" bricht das Laden ab und kehrt sofort zur
 * vorigen Ebene zurueck, und eine Ebene ueber dem Render-Limit stoppt dort und
 * sagt, dass sie unvollstaendig ist.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GalaxyPanel from './GalaxyPanel';
import { viewPreferencesKey } from '../settings/view-preferences';
import { scopeFetch, scopeNode } from './test-scope-fetch';
import type { GraphEdge } from './types';

vi.mock('./GraphScene', async importOriginal => ({
    ...await importOriginal<typeof import('./GraphScene')>(),
    GraphScene: () => <output data-testid="scene" />,
}));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); globalThis.__atlasGalaxy = undefined;
    window.localStorage.clear();
});

const seam = () => globalThis.__atlasGalaxy!;
const settle = (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    check();
});
const status = () => host.querySelector('.atlas-graph-scope-count');
const button = (label: string) => [...host.querySelectorAll('button')].find(entry => entry.textContent === label)!;
const minus = () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove graph layer"]')!;
const layers = () => [...host.querySelectorAll('.atlas-graph-exploration span')].map(entry => entry.textContent ?? '').find(text => /^\d+ layers?$/.test(text));

it('K8: shows loaded nodes and edges while a layer loads, and "−" cancels back to the previous layer at once', async () => {
    const nodes = [1, 2, 3, 4, 5, 6].map(id => scopeNode(id));
    const edges: GraphEdge[] = [{ id: 1, source: 1, target: 2, type: 'CALLS' }, { id: 2, source: 2, target: 3, type: 'CALLS' },
        { id: 3, source: 4, target: 2, type: 'CALLS' }, { id: 4, source: 3, target: 5, type: 'CALLS' }, { id: 5, source: 6, target: 1, type: 'TESTS' }];
    let block = false, release: () => void = () => {};
    let edgeQueries = 0;
    const { fetch } = scopeFetch({ nodes, edges, gate: async () => {
        edgeQueries += 1;
        // Layer 2: the outbound batch arrives, the inbound one hangs like the slow server.
        if (block && edgeQueries > 1) await new Promise<void>(resolve => { release = resolve; });
    } });
    await act(async () => root.render(<GalaxyPanel project="sample" visible workspaceExpanded onOpenNode={vi.fn()} fetch={fetch} />));
    await settle(() => expect(seam().nodes).toBe(6));
    await act(async () => { seam().clickNode('sample.n1'); });
    await settle(() => expect(status()?.textContent).toBe('3 nodes · 2 edges'));
    expect(minus().disabled).toBe(true);

    block = true; edgeQueries = 0;
    await act(async () => button('Expand +1').click());
    await settle(() => expect(status()?.textContent).toBe('Loading layer 2: 4 nodes, 3 edges so far'));
    expect(status()?.getAttribute('data-state')).toBe('loading');
    // While loading, "−" is the way out, and it says so.
    expect(minus().disabled).toBe(false);
    expect(minus().title).toBe('Cancel loading layer 2 and return to 1 layer');
    await act(async () => minus().click());
    // At once: the previous layer is complete again, nothing waits for the hanging request.
    expect(layers()).toBe('1 layer');
    expect(status()?.getAttribute('data-state')).not.toBe('loading');
    expect(minus().disabled).toBe(true);
    await settle(() => expect(status()?.textContent).toBe('3 nodes · 2 edges'));
    await act(async () => { release(); });
    await settle(() => expect(status()?.textContent).toBe('3 nodes · 2 edges'));
});

it('K8: a layer past the render limit stops there, says it is partial and cannot be expanded further', async () => {
    window.localStorage.setItem(viewPreferencesKey('sample'), JSON.stringify({ version: 1, preferences: { galaxyNodes: 500, galaxyEdges: 1000 } }));
    const fan = Array.from({ length: 600 }, (_, at) => scopeNode(100 + at));
    const nodes = [scopeNode(1), scopeNode(2), ...fan];
    const edges: GraphEdge[] = [{ id: 1, source: 1, target: 2, type: 'CALLS' },
        ...fan.map((node, at) => ({ id: 10 + at, source: 2, target: node.id, type: 'CALLS' }))];
    await act(async () => root.render(<GalaxyPanel project="sample" visible workspaceExpanded onOpenNode={vi.fn()} fetch={scopeFetch({ nodes, edges }).fetch} />));
    await settle(() => expect(seam().nodes).toBeGreaterThan(0));
    await act(async () => { seam().clickNode('sample.n1'); });
    await settle(() => expect(status()?.textContent).toBe('2 nodes · 1 edge'));
    expect(button('Expand +1').title).toContain('Load layer 2: 1 node to expand');

    await act(async () => button('Expand +1').click());
    await settle(() => expect(status()?.textContent).toBe('602 nodes · 601 edges · partial'));
    expect(status()?.getAttribute('data-state')).toBe('partial');
    expect(status()?.getAttribute('title')).toBe('Layer 2 stopped at the render limit of 500 nodes. Raise the limit under Limits or trace fewer edge types to load all of it.');
    expect(button('Expand +1').disabled).toBe(true);
    expect(button('Expand +1').title).toContain('stopped at the render limit');
    // The partial layer can still be left the normal way.
    await act(async () => minus().click());
    await settle(() => expect(status()?.textContent).toBe('2 nodes · 1 edge'));
});
