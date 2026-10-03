// @vitest-environment jsdom
/*
 * Handtest K5: die Hierarchie eines Ausschnitts. Eingehendes links, Wurzel in
 * der Mitte, Ausgehendes rechts, ein ehrlicher Hinweis, und Pfad und
 * Aufrufreihe gibt es auch hier, mit Hervorhebung im Bild der Hierarchie.
 */
import { act, isValidElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GalaxyPanel from './GalaxyPanel';
import type { GraphData } from './types';
import type { ScenePath } from './PathLayer';
import { scopeFetch, scopeNode } from './test-scope-fetch';
import { GALAXY_LEGEND_KEY } from './galaxy-legend';
import { HierarchyEdgeLabels } from './HierarchyEdgeLabels';

const scene = vi.hoisted(() => ({ data: undefined as GraphData | undefined, path: undefined as ScenePath | undefined, highlighted: null as Set<number> | null,
    labelMaxTextWidth: undefined as number | undefined, overlay: false, overlayNode: undefined as unknown, showLabels: false, labelBudget: undefined as number | undefined }));
vi.mock('./GraphScene', async importOriginal => ({
    ...await importOriginal<typeof import('./GraphScene')>(),
    GraphScene: ({ data, path, highlightedIds, labelMaxTextWidth, overlay, showLabels, labelBudget }: { data: GraphData; path?: ScenePath; highlightedIds: Set<number> | null;
        labelMaxTextWidth?: number; overlay?: unknown; showLabels: boolean; labelBudget?: number }) => {
        scene.data = data; scene.path = path; scene.highlighted = highlightedIds; scene.labelMaxTextWidth = labelMaxTextWidth; scene.overlay = Boolean(overlay);
        scene.overlayNode = overlay; scene.showLabels = showLabels; scene.labelBudget = labelBudget;
        return <output data-testid="scene" />;
    },
}));
/** Die Kantenschilder der Hierarchie im Baum der Ueberlagerung, ohne sie zu zeichnen. */
function edgeLabelProps(node: unknown): { edges: unknown[] } | undefined {
    if (!isValidElement(node)) return Array.isArray(node) ? node.map(edgeLabelProps).find(Boolean) : undefined;
    if (node.type === HierarchyEdgeLabels) return node.props as { edges: unknown[] };
    return edgeLabelProps((node.props as { children?: unknown }).children);
}

let host: HTMLDivElement, root: Root;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.__atlasGalaxy = undefined; });

const seam = () => globalThis.__atlasGalaxy!;
const settle = (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    check();
});
const button = (label: string) => [...host.querySelectorAll('button')].find(entry => entry.textContent === label);

it('K5: the hierarchy of a scope puts callers left and callees right, says so, and keeps Path to and Call order', async () => {
    const nodes = [1, 2, 3, 4, 5].map(id => scopeNode(id));
    const edges = [{ id: 1, source: 1, target: 2, type: 'CALLS', line: 30 }, { id: 2, source: 1, target: 3, type: 'CALLS', line: 12 },
        { id: 3, source: 4, target: 1, type: 'CALLS', line: 2 }, { id: 4, source: 5, target: 1, type: 'TESTS' }];
    await act(async () => root.render(<GalaxyPanel project="sample" visible workspaceExpanded onOpenNode={vi.fn()} fetch={scopeFetch({ nodes, edges }).fetch}
        legendStore={{ getItem: (key: string) => (key === GALAXY_LEGEND_KEY ? 'open' : null), setItem: vi.fn() } as unknown as Storage} />));
    await settle(() => expect(seam().nodes).toBe(5));
    await act(async () => { seam().clickNode('sample.n1'); });
    await settle(() => expect(host.querySelector('.atlas-graph-scope-count')?.textContent).toBe('5 nodes · 4 edges'));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="atlas-graph-mode-chip"][data-mode="hierarchy"]')!.click());
    expect(seam().mode).toBe('hierarchy');

    const placed = Object.fromEntries(seam().hierarchy!.placements.map(placement => [placement.name, placement]));
    expect(placed.n1).toMatchObject({ x: 0, y: 0 });
    expect(placed.n4!.x).toBeLessThan(0); expect(placed.n5!.x).toBeLessThan(0);
    expect(placed.n2!.x).toBeGreaterThan(0); expect(placed.n3!.y).toBeGreaterThan(placed.n2!.y); // line 12 above line 30
    // Full names, the edge types at the lines, and an honest description.
    expect(scene.labelMaxTextWidth).toBeGreaterThanOrEqual(1600);
    expect(scene.overlay).toBe(true);
    const chip = host.querySelector('[data-testid="atlas-graph-mode-chip"][data-mode="hierarchy"]')!.closest('[data-hint-name], span, div')!;
    expect(host.innerHTML).toContain('incoming relationships on the left, the root in the middle, outgoing on the right');
    expect(chip).toBeTruthy();
    expect(host.querySelector('[data-entry="positions"]')?.textContent).toContain('Incoming relationships on the left');
    expect(host.querySelector('[data-entry="positions"]')?.textContent).not.toContain('ordered by name');

    // Call order and Path to work in this picture and highlight its own nodes.
    await act(async () => button('Call order')!.click());
    const sceneId = (name: string) => scene.data!.nodes.find(node => node.name === name)!.id;
    expect(scene.path?.steps.map(step => [step.from, step.to])).toEqual([[sceneId('n1'), sceneId('n3')], [sceneId('n1'), sceneId('n2')]]);
    expect([...scene.highlighted ?? []].sort()).toEqual([sceneId('n1'), sceneId('n2'), sceneId('n3')].sort());
    await act(async () => button('Call order')!.click());
    host.querySelector<HTMLDetailsElement>('.atlas-graph-path-picker')!.open = true;
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.atlas-graph-path-menu li button')]
        .find(entry => entry.querySelector('strong')?.textContent === 'n5')!.click());
    expect(host.querySelector('[data-testid="atlas-galaxy-path-panel"] strong')?.textContent).toBe('Path to n5 · 1 hop');
    expect(scene.path?.steps.map(step => [step.edge.source, step.edge.target])).toEqual([[sceneId('n5'), sceneId('n1')]]);
});

it('K5: the hint follows the trace direction', async () => {
    const nodes = [1, 2].map(id => scopeNode(id));
    await act(async () => root.render(<GalaxyPanel project="sample" visible workspaceExpanded onOpenNode={vi.fn()}
        fetch={scopeFetch({ nodes, edges: [{ id: 1, source: 1, target: 2, type: 'CALLS' }] }).fetch} />));
    await settle(() => expect(seam().nodes).toBe(2));
    await act(async () => { seam().clickNode('sample.n1'); });
    await settle(() => expect(host.querySelector('.atlas-graph-scope-count')?.textContent).toBe('2 nodes · 1 edge'));
    await act(async () => {
        const select = host.querySelector<HTMLSelectElement>('select[aria-label="Trace direction"]')!;
        select.value = 'outbound'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.innerHTML).toContain('what the root reaches, one column per layer to the right');
});

/*
 * Review of K5: above sixty nodes the hierarchy of a scope drew no name at all
 * (JSONBAgg at two layers, 90 nodes) but eighty edge-type labels. Names now
 * stand up to 150 nodes, and above that neither names nor edge labels, and the
 * hint says why and how to get them back.
 */
it('K5: a two-layer scope of 90 nodes keeps its names in the hierarchy; above 150 names and edge labels go together, and the hint says so', async () => {
    const fan = (count: number) => Array.from({ length: count }, (_, at) => scopeNode(100 + at));
    const render = async (count: number) => {
        const nodes = [scopeNode(1), ...fan(count)];
        const edges = fan(count).map((node, at) => ({ id: 10 + at, source: node.id, target: 1, type: 'CALLS' }));
        await act(async () => root.render(<GalaxyPanel key={count} project="sample" visible workspaceExpanded onOpenNode={vi.fn()} fetch={scopeFetch({ nodes, edges }).fetch} />));
        await settle(() => expect(seam().nodes).toBe(count + 1));
        await act(async () => { seam().clickNode('sample.n1'); });
        await settle(() => expect(host.querySelector('.atlas-graph-scope-count')?.textContent).toBe(`${count + 1} nodes · ${count} edges`));
        await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="atlas-graph-mode-chip"][data-mode="hierarchy"]')!.click());
    };
    await render(89);
    expect(scene.showLabels).toBe(true);
    expect(scene.labelBudget).toBeGreaterThanOrEqual(90);
    expect(edgeLabelProps(scene.overlayNode)?.edges).toHaveLength(89);
    expect(host.innerHTML).not.toContain('names and edge types show');

    await render(200);
    expect(scene.showLabels).toBe(false);
    expect(edgeLabelProps(scene.overlayNode)).toBeUndefined();
    expect(host.innerHTML).toContain('names and edge types show for up to 150 nodes');
});
