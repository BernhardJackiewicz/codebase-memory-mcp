// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SystemGraph, { type SystemGraphProps } from './system-graph';
import { systemGraphResponse } from './system-graph-fixture';
import type { SystemGraphLoader } from './system-graph-source';
import type { SystemSceneModel } from './system-architecture-model';

vi.mock('./SystemArchitectureScene', () => ({ default: ({ model, planar, selectedNode, onSelectNode, onSelectEdge }: {
    model: SystemSceneModel; planar: boolean; selectedNode?: string;
    onSelectNode: (id: string) => void; onSelectEdge: (id: string) => void;
}) => <div data-testid="graph-scene" data-planar={String(planar)} data-selected={selectedNode} data-ids={JSON.stringify(model.nodes.map(node => node.id))}
    data-positions={JSON.stringify(model.nodes.map(node => node.position))}>
    {model.nodes.map(node => <button key={node.id} data-node={node.id} onClick={() => onSelectNode(node.id)}>{node.label}</button>)}
    {model.edges.map(edge => <button key={edge.id} data-edge={edge.id} onClick={() => onSelectEdge(edge.id)}>{edge.type}</button>)}
</div> }));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function render(props: Partial<SystemGraphProps> = {}) {
    await act(async () => root.render(<SystemGraph project="sample" active onNavigate={vi.fn()}
        loader={vi.fn<SystemGraphLoader>().mockResolvedValue(systemGraphResponse())} {...props} />));
    await act(async () => { await vi.dynamicImportSettled(); });
}
async function click(selector: string) {
    const button = container.querySelector<HTMLElement>(selector); expect(button).not.toBeNull();
    await act(async () => button!.click());
}

describe('system graph workspace', () => {
    it('opens field selection from an explicit source file without substituting the graph node ID', async () => {
        await render(); await click('[data-node="api"]'); await click('[data-system-trace-field]');
        await act(async () => { await vi.dynamicImportSettled(); });
        expect(container.querySelector<HTMLInputElement>('[data-field-file]')?.value).toBe('src/api.ts');
        expect(container.querySelector('[data-testid="field-flow"]')).not.toBeNull();
        expect(container.querySelector('[data-field-path]')).toBeNull();
    });
    it('defaults to 3D and retains identity, selection, filters and positions in 2D without fetching', async () => {
        const loader = vi.fn<SystemGraphLoader>().mockResolvedValue(systemGraphResponse());
        await render({ loader });
        await click('[data-node="api"]');
        await click('[data-layer="documentation"]');
        const scene = () => container.querySelector('[data-testid="graph-scene"]')!;
        const ids = scene().getAttribute('data-ids'), positions = scene().getAttribute('data-positions');
        expect(scene().getAttribute('data-planar')).toBe('false');
        await click('[data-camera="2d"]');
        expect(scene().getAttribute('data-planar')).toBe('true');
        expect(scene().getAttribute('data-selected')).toBe('api');
        expect(scene().getAttribute('data-ids')).toBe(ids);
        expect(scene().getAttribute('data-positions')).toBe(positions);
        expect(container.querySelector('[data-layer="documentation"]')?.getAttribute('aria-pressed')).toBe('false');
        expect(loader).toHaveBeenCalledTimes(1);
    });
    it('opens exact source evidence of a selected relationship, keeping its indexed provenance', async () => {
        const onNavigate = vi.fn(); await render({ onNavigate });
        await click('[data-node="api"]');
        expect(container.querySelector('[data-inspect-relation="write"]')?.textContent).toContain('/users → users');
        await click('[data-edge="write"]');
        expect(container.querySelector('[aria-label="System graph evidence"]')?.textContent).toContain('Indexed evidence');
        await click('[data-witness="102"]');
        expect(onNavigate).toHaveBeenCalledWith('src/callsite.ts', 46, 'WRITES');
        expect(container.textContent).toContain('Field-level value flow is not available');
        expect(container.textContent).toContain('Live capture is not available');
    });
    it('routes PDF entities and page witnesses to generation-pinned extracted documentation', async () => {
        const response = systemGraphResponse(), onNavigate = vi.fn(), onOpenDocument = vi.fn();
        const entity = response.result!.entities.find(item => item.id === 'doc')!;
        Object.assign(entity, { file_path: 'docs/guide.pdf', properties: { page: 2 } });
        response.result!.relations.find(item => item.id === 'mentions')!.witnesses[0].location = { file_path: 'docs/guide.pdf', page: 2 };
        await render({ loader: vi.fn().mockResolvedValue(response), onNavigate, onOpenDocument });
        await click('[data-node="doc"]');
        await click(`[data-source-node="${entity.ref.node_id}"]`);
        expect(onOpenDocument).toHaveBeenLastCalledWith({ filePath: 'docs/guide.pdf', generation: 'g1', page: 2 });
        await click('[data-edge="mentions"]');
        await click('[data-witness="104"]');
        expect(onOpenDocument).toHaveBeenLastCalledWith({ filePath: 'docs/guide.pdf', generation: 'g1', page: 2 });
        expect(onNavigate).not.toHaveBeenCalled();
    });
    it('labels file-only relationship context without inventing an exact source position', async () => {
        const response = systemGraphResponse(), onNavigate = vi.fn();
        response.result!.relations.find(item => item.id === 'write')!.witnesses[0].location = { file_path: 'src/callsite.ts' };
        await render({ loader: vi.fn().mockResolvedValue(response), onNavigate });
        await click('[data-edge="write"]');
        expect(container.querySelector('[data-evidence-edge="102"]')?.textContent).toContain('Relationship location was not recorded.');
        await click('[data-witness="102"]');
        expect(onNavigate).toHaveBeenCalledWith('src/callsite.ts', undefined, 'WRITES source file');
    });
    it('labels a PDF page inferred from its source section as context', async () => {
        const response = systemGraphResponse();
        Object.assign(response.result!.relations.find(item => item.id === 'mentions')!.witnesses[0],
            { location: { file_path: 'guide.pdf', page: 2, position_kind: 'source_context' } });
        await render({ loader: vi.fn().mockResolvedValue(response), onOpenDocument: vi.fn() });
        await click('[data-edge="mentions"]');
        expect(container.querySelector('[data-evidence-edge="104"]')?.textContent)
            .toContain('Showing the source section; the relationship position was not recorded.');
    });
    it('opens a PDF with no recorded page as a document without interpreting a node line as its page', async () => {
        const response = systemGraphResponse(), onOpenDocument = vi.fn(), onNavigate = vi.fn();
        const entity = response.result!.entities.find(item => item.id === 'doc')!;
        Object.assign(entity, { file_path: 'docs/guide.pdf', start_line: 77, properties: {} });
        await render({ loader: vi.fn().mockResolvedValue(response), onNavigate, onOpenDocument });
        await click('[data-node="doc"]');
        await click(`[data-source-node="${entity.ref.node_id}"]`);
        expect(onOpenDocument).toHaveBeenCalledWith({ filePath: 'docs/guide.pdf', generation: 'g1' });
        expect(container.querySelector(`[data-source-node="${entity.ref.node_id}"]`)?.textContent).toBe('docs/guide.pdf');
        expect(onNavigate).not.toHaveBeenCalled();
    });
    it('drills an honest display group and can inspect all original members', async () => {
        const value = systemGraphResponse(); value.result!.entities[1].kind = 'code';
        await render({ loader: vi.fn().mockResolvedValue(value) });
        await click('[data-aggregate-kind="code"]');
        await click('[data-action="drill-group"]');
        expect(container.querySelector('[data-testid="graph-scene"]')?.getAttribute('data-ids')).toContain('"api"');
        expect(container.querySelector('[data-testid="graph-scene"]')?.getAttribute('data-ids')).toContain('"ui"');
        expect(container.querySelector('[aria-label="System graph location"]')?.textContent).toContain('Code');
    });
    it('does not render the previous project while the next request is pending', async () => {
        await render();
        expect(container.querySelector('[data-node="api"]')).not.toBeNull();
        await render({ project: 'other', loader: () => new Promise(() => {}) });
        expect(container.querySelector('[data-node="api"]')).toBeNull();
        expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading system graph');
    });
    it('polls pending work with the same snapshot request and cancels when inactive', async () => {
        vi.useFakeTimers();
        const loader = vi.fn<SystemGraphLoader>()
            .mockResolvedValueOnce({ status: 'pending', generation: 'g1', retry_after_ms: 500 })
            .mockResolvedValue(systemGraphResponse());
        await render({ loader, generation: 'g1' });
        expect(container.querySelector('[data-testid="graph-scene"]')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
        expect(loader).toHaveBeenCalledTimes(2);
        expect(loader.mock.calls.map(call => call[0])).toEqual([
            { project: 'sample', expectedGeneration: 'g1' }, { project: 'sample', expectedGeneration: 'g1' },
        ]);
        const signal = loader.mock.calls[0][1];
        await render({ loader, generation: 'g1', active: false });
        expect(signal.aborted).toBe(true);
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(loader).toHaveBeenCalledTimes(2);
    });
    it('clears stale identity on refresh when an unpinned graph changes generation', async () => {
        const next = systemGraphResponse(); next.generation = 'g2'; next.result!.generation = 'g2';
        next.result!.entities.forEach(entity => { entity.ref.generation = 'g2'; });
        next.result!.relations.forEach(relation => relation.witnesses.forEach(proof => {
            proof.ref.generation = 'g2'; proof.source.generation = 'g2'; proof.target.generation = 'g2';
        }));
        const loader = vi.fn<SystemGraphLoader>().mockResolvedValueOnce(systemGraphResponse()).mockResolvedValue(next);
        await render({ loader });
        await click('[data-node="api"]');
        expect(container.querySelector('[data-testid="graph-scene"]')?.getAttribute('data-selected')).toBe('api');
        const refresh = [...container.querySelectorAll('button')].find(button => button.textContent === 'Refresh graph')!;
        await act(async () => refresh.click());
        expect(container.querySelector('[data-testid="graph-scene"]')?.getAttribute('data-selected')).toBeNull();
    });
    it('reports empty, incomplete graphs without inventing a successful architecture', async () => {
        const value = systemGraphResponse();
        value.result!.entities = []; value.result!.relations = []; value.result!.complete = false;
        value.result!.gaps = [{ code: 'index_empty', message: 'No indexed system entities.' }];
        await render({ loader: vi.fn().mockResolvedValue(value) });
        expect(container.textContent).toContain('No indexed system entities.');
        expect(container.querySelector('[data-testid="graph-scene"]')).toBeNull();
    });
});
