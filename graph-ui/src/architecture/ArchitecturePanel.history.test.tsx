// @vitest-environment jsdom
/*
 * Handtest K27: ein Zurueck und ein Vor fuer ganz Architecture, mit demselben
 * Verlaufsmodell wie Galaxy (K2). Die Szenen sind Attrappen mit Knoepfen fuer
 * Auswahl, Doppelklick und leere Flaeche; Analyse und Routen kommen aus
 * festen Antworten.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArchitecturePanel, { type ArchitecturePanelProps } from './ArchitecturePanel';
import type { ArchitectureSceneProps } from './ArchitectureScene';
import type { ArchitectureOverviewDto } from '../core/intelligence-provider';
import type { GraphData, GraphNode } from '../galaxy/types';
import type { SystemSceneModel } from './system-architecture-model';
import type { SystemArchitectureLoader, SystemProjection, SystemSymbol } from './system-architecture-source';

vi.mock('./ArchitectureScene', () => ({ ArchitectureScene: (props: ArchitectureSceneProps) => <div data-testid="scene">
    {props.model.nodes.map(node => <button key={node.id} data-node={node.id} onClick={() => props.onSelect(node.id)} onDoubleClick={() => props.onOpen?.(node.id)}>{node.label}</button>)}
    <button aria-label="Empty background" onClick={props.onClearSelection} /></div> }));
vi.mock('./ContainerMap', () => ({ default: ({ filter }: { filter: string }) => <div data-testid="container-map" data-filter={filter} /> }));
vi.mock('./route-graph-source', () => ({ loadRouteGraph: vi.fn(async () => ({ relationships: [], truncated: false, warnings: [] })) }));
vi.mock('./BehaviorSourceEvidence', () => ({ default: () => <div /> }));
vi.mock('../app/atlas-api', () => ({ AtlasApi: class { flows() { return Promise.resolve([]); } } }));
vi.mock('./SystemArchitectureScene', () => ({ default: ({ model, onSelectNode, onExpandNode, onClearSelection }: {
    model: SystemSceneModel; onSelectNode: (id: string) => void; onExpandNode?: (id: string) => void; onClearSelection?: () => void;
}) => <div data-testid="system-scene" data-focus={model.focusId ?? ''}><button onClick={onClearSelection}>System background</button>
    {model.nodes.map(node => <button key={node.id} data-system-node={node.id} onClick={() => onSelectNode(node.id)} onDoubleClick={() => onExpandNode?.(node.id)}>{node.label}</button>)}</div> }));

const graphNode = (id: number, name: string, file_path: string, label = 'Function'): GraphNode =>
    ({ id, label, name, qualified_name: `sample.${name}`, file_path, start_line: 3, x: 0, y: 0, z: 0, size: 1, color: '' });
const graph: GraphData = { nodes: [graphNode(1, 'render', 'django/shortcuts.py'), graphNode(2, 'options', 'django/contrib/admin/options.py'),
    graphNode(3, 'setup', 'setup.py'), graphNode(10, '/edit/one/', 'app/urls.py', 'Route'), graphNode(11, '/edit/two/', 'app/urls.py', 'Route'),
    graphNode(12, '/home/', 'app/urls.py', 'Route')], edges: [], total_nodes: 6 };
const overview: ArchitectureOverviewDto = { projectName: 'sample', totalSymbols: 6, totalRelations: 0, symbolKinds: [], relationKinds: [], languages: [],
    groups: [], boundaries: [], layers: [], clusters: [], entryPoints: [], routes: [], hotspots: [], files: ['django/shortcuts.py', 'django/contrib/admin/options.py', 'setup.py', 'app/urls.py'] };

const symbol = (id: number, component: string, name: string): SystemSymbol => ({
    id, name, qualified_name: `sample.${name}`, label: 'Function', file_path: `src/${component}.ts`, start_line: id * 10, component_id: component, group_id: `g:${component}`,
});
function projection(): SystemProjection {
    const main = symbol(1, 'api', 'main'), handle = symbol(2, 'service', 'handle'), save = symbol(3, 'store', 'save'), commit = symbol(4, 'store', 'commit');
    const components = [main, handle, save].map(item => ({ id: item.component_id, label: item.component_id, basis: 'interaction_community', member_count: 4, file_count: 1, representatives: [item], group_id: `g:${item.component_id}` }));
    const dependencies = [{ source: 'api', target: 'service', type: 'CALLS', count: 2, witnesses: [{ edge_id: 10, source: main, target: handle }] },
        { source: 'service', target: 'store', type: 'CALLS', count: 1, witnesses: [{ edge_id: 11, source: handle, target: save }] }];
    return {
        schema_version: 1, status: 'ready', kind: 'static_projection', complete: true, components, dependencies, cycles: [], entrypoints: [main, handle],
        paths: [{ entrypoint_id: 1, nodes: [main, handle, save], edges: [{ id: 10, source_id: 1, target_id: 2, type: 'CALLS' }, { id: 11, source_id: 2, target_id: 3, type: 'CALLS' }] },
            { entrypoint_id: 2, nodes: [handle, save], edges: [{ id: 11, source_id: 2, target_id: 3, type: 'CALLS' }] },
            { entrypoint_id: 3, nodes: [save, commit], edges: [{ id: 12, source_id: 3, target_id: 4, type: 'CALLS' }] }],
        totals: { nodes: 12, files: 3, edges: 3, accounted_nodes: 12, structural_nodes: 0 }, limits: {}, warnings: [],
        overview: { complete: true, grouping_basis: 'common_source_directory_aggregate', components,
            groups: components.map(item => ({ id: `g:${item.id}`, label: item.label, component_count: 1, member_count: 4, file_count: 1, component_ids: [item.id], representatives: item.representatives })),
            connections: dependencies.map(edge => ({ ...edge, source: `g:${edge.source}`, target: `g:${edge.target}` })), totals: { groups: 3, components: 3 }, limits: {} },
    };
}

let container: HTMLDivElement;
let root: Root;
let storageDescriptor: PropertyDescriptor | undefined;
let loader: ReturnType<typeof vi.fn<SystemArchitectureLoader>>;

beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const contents = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
        getItem: (key: string) => contents.get(key) ?? null, setItem: (key: string, value: string) => { contents.set(key, value); },
    } });
    loader = vi.fn<SystemArchitectureLoader>().mockImplementation(async () => ({ status: 'ready', generation: 'g1', result: projection() }));
});
afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
    else delete (window as unknown as Record<string, unknown>).localStorage;
});

async function render(changes: Partial<ArchitecturePanelProps> = {}): Promise<void> {
    await act(async () => root.render(<ArchitecturePanel projectName="sample" overview={overview} graph={graph} graphGeneration="g1"
        systemArchitectureLoader={loader} onNavigate={vi.fn()} active {...changes} />));
    await settle();
}
async function settle(): Promise<void> {
    for (let round = 0; round < 4; round++) await act(async () => { await vi.dynamicImportSettled(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
const buttons = (scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
const byText = (text: string, scope?: ParentNode) => buttons(scope).find(button => button.textContent === text);
async function press(target: HTMLElement | null | undefined): Promise<void> {
    expect(target).toBeTruthy();
    await act(async () => target!.click()); await settle();
}
const clickText = (text: string, scope?: ParentNode) => press(byText(text, scope));
async function doubleClick(selector: string): Promise<void> {
    const target = container.querySelector(selector); expect(target).not.toBeNull();
    await act(async () => target!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await settle();
}
async function choose(label: string, value: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`); expect(select).not.toBeNull();
    await act(async () => { select!.value = value; select!.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
}
async function type(value: string): Promise<void> {
    const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
        search.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
const history = () => container.querySelector<HTMLElement>('[role="group"][aria-label="Architecture history"]');
const back = () => history()?.querySelector<HTMLButtonElement>('button[aria-label="Back"]') ?? null;
const forward = () => history()?.querySelector<HTMLButtonElement>('button[aria-label="Forward"]') ?? null;
const goBack = () => press(back());
const goForward = () => press(forward());
const view = () => container.querySelector('.atlas-arch-tab[aria-pressed="true"]')?.getAttribute('data-view');
const trail = () => [...container.querySelectorAll('[aria-label="Architecture location"] button')].map(item => item.textContent);
const planar = () => container.querySelector('[aria-label="Map camera"] button[aria-pressed="true"]')?.textContent;
const perspective = () => container.querySelector('[aria-label="Routes perspective"] button[aria-pressed="true"]')?.textContent;
const filter = () => container.querySelector<HTMLInputElement>('input[type="search"]')?.value;
const focus = () => container.querySelector('[data-testid="system-scene"]')?.getAttribute('data-focus');
const heading = () => container.querySelector('.behavior-heading h2')?.textContent;
const sceneLabels = () => [...container.querySelectorAll('[data-testid="scene"] [data-node]')].map(item => item.textContent);
const key = (init: KeyboardEventInit, target: EventTarget = window) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
};
async function openArea(name: string): Promise<void> {
    await press(container.querySelector<HTMLButtonElement>(`[data-testid="scene"] [data-node="area:${name}"]`) ?? byText(name, container.querySelector('[data-testid="scene"]')!));
    await clickText('Open area →');
}

describe('Architecture back and forward (K27)', () => {
    it('goes back and forward across subtabs, an opened area and Plan, naming each target', async () => {
        await render();
        expect(back()?.disabled).toBe(true);
        expect(back()?.title).toBe('Nothing to go back to yet');
        expect(forward()?.disabled).toBe(true);
        await openArea('django');
        expect(trail()).toEqual(['sample', 'django']);
        expect(back()?.title).toBe('Back to Overview (Alt+Left)');
        await clickText('Plan', container.querySelector('[aria-label="Map camera"]')!);
        expect(back()?.title).toBe('Back to Overview · django (Alt+Left)');
        await press(container.querySelector<HTMLButtonElement>('[data-view="hotspots"]'));
        expect(back()?.title).toBe('Back to Overview · django · Plan (Alt+Left)');

        await goBack();
        expect([view(), trail(), planar()]).toEqual(['overview', ['sample', 'django'], 'Plan']);
        expect(forward()?.title).toBe('Forward to Hotspots · Plan (Alt+Right)');
        await goBack();
        expect([view(), trail(), planar()]).toEqual(['overview', ['sample', 'django'], '3D']);
        await goBack();
        expect(trail()).toEqual(['sample']);
        expect(back()?.disabled).toBe(true);
        await goForward(); await goForward(); await goForward();
        expect(view()).toBe('hotspots');
        expect(forward()?.disabled).toBe(true);
        // The location trail stays: it still leads back to the repository, and that is a step of its own.
        await goBack();
        await press(byText('sample', container.querySelector('[aria-label="Architecture location"]')!));
        expect(trail()).toEqual(['sample']);
        expect(back()?.title).toBe('Back to Overview · django · Plan (Alt+Left)');
    });

    it('restores the Routes perspective and an opened route group', async () => {
        await render();
        await press(container.querySelector<HTMLButtonElement>('[data-view="routes"]'));
        expect(perspective()).toBe('Service map');
        await clickText('Endpoints', container.querySelector('[aria-label="Routes perspective"]')!);
        expect(sceneLabels()).toContain('/edit · 2');
        await press(byText('/edit · 2', container.querySelector('[data-testid="scene"]')!));
        await clickText('Show these 2 routes →');
        expect(filter()).toBe('/edit');
        expect(sceneLabels()).toEqual(['/edit/one/', '/edit/two/']);
        expect(back()?.title).toBe('Back to Routes · Endpoints (Alt+Left)');

        await goBack();
        expect([view(), perspective(), filter()]).toEqual(['routes', 'Endpoints', '']);
        await goBack();
        expect([perspective(), filter()]).toEqual(['Service map', '']);
        expect(container.querySelector('[data-testid="container-map"]')).not.toBeNull();
        await goBack();
        expect(view()).toBe('overview');
        await goForward(); await goForward(); await goForward();
        expect([view(), perspective(), filter()]).toEqual(['routes', 'Endpoints', '/edit']);
        expect(sceneLabels()).toEqual(['/edit/one/', '/edit/two/']);
    });

    it('takes a typed filter as one step once typing pauses, not one per key', async () => {
        await render();
        await press(container.querySelector<HTMLButtonElement>('[data-view="routes"]'));
        await type('/e'); await type('/ed'); await type('/edit');
        expect(filter()).toBe('/edit');
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 900)); });
        expect(back()?.title).toBe('Back to Routes · Service map (Alt+Left)');
        await goBack();
        expect([view(), filter()]).toEqual(['routes', '']);
        await goBack();
        expect(view()).toBe('overview');
        await goForward(); await goForward();
        expect(filter()).toBe('/edit');
    });

    it('makes the System structure focus and expanded groups steps, and its old Back the shared Back', async () => {
        await render();
        await press(container.querySelector<HTMLButtonElement>('[data-view="structure"]'));
        expect(focus()).toBe('');
        const oldBack = () => byText('← Back', container.querySelector('.system-scope-actions')!);
        expect(oldBack()?.disabled).toBe(false);
        expect(oldBack()?.title).toBe('Back to Overview (Alt+Left)');
        await doubleClick('[data-system-node="g:api"]');
        expect(focus()).toBe('g:api');
        expect(container.querySelector('[data-system-node="member:g:api:api"]')).not.toBeNull();
        expect(back()?.title).toBe('Back to System structure (Alt+Left)');
        await press(container.querySelector<HTMLButtonElement>('[data-system-node="g:service"]'));
        await clickText('Focus here');
        expect(focus()).toBe('g:service');
        expect(oldBack()?.title).toBe('Back to System structure · api · 1 group open (Alt+Left)');

        await press(oldBack());
        expect(focus()).toBe('g:api');
        await goBack();
        expect(focus()).toBe('');
        expect(container.querySelector('[data-system-node="member:g:api:api"]')).toBeNull();
        // One meaning of Back: the old button now also leaves System structure.
        await press(oldBack());
        expect(view()).toBe('overview');
        await goForward(); await goForward();
        expect([view(), focus()]).toEqual(['structure', 'g:api']);
        expect(container.querySelector('[data-system-node="member:g:api:api"]')).not.toBeNull();
        // "Whole system" stays the way to the top, as a new step that drops the forward branch.
        await clickText('Whole system');
        expect(focus()).toBe('');
        expect(forward()?.disabled).toBe(true);
        expect(back()?.title).toBe('Back to System structure · api · 1 group open (Alt+Left)');
    });

    it('steps through Behavior starts and followed calls, and an automatic start is no extra step', async () => {
        await render();
        await press(container.querySelector<HTMLButtonElement>('[data-view="structure"]'));
        await press(container.querySelector<HTMLButtonElement>('[data-view="behavior"]'));
        expect(heading()).toBe('What can main call?');
        // The suggested start completes the Behavior step instead of adding one Back would bounce on.
        expect(back()?.title).toBe('Back to System structure (Alt+Left)');
        await choose('Behavior entry point', '2');
        expect(heading()).toBe('What can handle call?');
        expect(back()?.title).toBe('Back to Behavior · main (Alt+Left)');
        await doubleClick('[data-system-node="journey-choice:3"]');
        expect(heading()).toBe('What can save call?');
        const oldBack = () => byText('← Back', container.querySelector('.behavior-navigation')!);
        expect(oldBack()?.title).toBe('Back to Behavior · handle (Alt+Left)');
        expect(forward()?.disabled).toBe(true);

        await press(oldBack());
        expect(heading()).toBe('What can handle call?');
        expect(forward()?.title).toBe('Forward to Behavior · save · followed from handle (Alt+Right)');
        await goBack();
        expect(heading()).toBe('What can main call?');
        await goBack();
        expect(view()).toBe('structure');
        await goForward(); await goForward(); await goForward();
        expect(heading()).toBe('What can save call?');
        expect(container.querySelector<HTMLSelectElement>('select[aria-label="Behavior entry point"]')?.value).toBe('3');
        // Empty background still returns from a followed call to where the hops started, as a step.
        await clickText('System background');
        expect(heading()).toBe('What can handle call?');
        expect(back()?.title).toBe('Back to Behavior · save · followed from handle (Alt+Left)');
    });

    it('names the start a reset Behavior step shows, after the suggested start was rejected for a stale snapshot', async () => {
        // django-demo: the suggested main is rejected once for another analysis generation; the journey then shows main on its own.
        let calls = 0;
        loader.mockImplementation(async request => {
            calls++;
            if (request.entryNodeId !== undefined && request.expectedGeneration === 'g1') return { status: 'failed', generation: 'g2', error: 'Entry snapshot changed.' };
            return { status: 'ready', generation: calls === 1 ? 'g1' : 'g2', result: projection() };
        });
        await render();
        await press(container.querySelector<HTMLButtonElement>('[data-view="behavior"]'));
        expect(heading()).toBe('What can main call?');
        expect(back()?.title).toBe('Back to Overview (Alt+Left)');
        await choose('Behavior entry point', '2');
        expect(heading()).toBe('What can handle call?');
        expect(back()?.title).toBe('Back to Behavior · main (Alt+Left)');
        await goBack();
        expect(heading()).toBe('What can main call?');
        expect(forward()?.title).toBe('Forward to Behavior · handle (Alt+Right)');
        await goBack();
        expect(view()).toBe('overview');
        expect(forward()?.title).toBe('Forward to Behavior · main (Alt+Right)');
    });

    it('drops the forward branch on a new navigation after Back and keeps at most 25 steps', async () => {
        await render();
        for (const tab of ['routes', 'hotspots', 'structure']) await press(container.querySelector<HTMLButtonElement>(`[data-view="${tab}"]`));
        await goBack(); await goBack();
        expect(view()).toBe('routes');
        expect(forward()?.disabled).toBe(false);
        await press(container.querySelector<HTMLButtonElement>('[data-view="behavior"]'));
        expect(forward()?.disabled).toBe(true);
        await goBack();
        expect(view()).toBe('routes');
        expect(forward()?.title).toBe('Forward to Behavior · main (Alt+Right)');

        for (let step = 0; step < 15; step++) for (const tab of ['overview', 'hotspots']) await press(container.querySelector<HTMLButtonElement>(`[data-view="${tab}"]`));
        expect(history()?.getAttribute('data-position')).toBe('25/25');
        let steps = 0;
        while (!back()!.disabled && steps < 100) { await goBack(); steps++; }
        expect(steps).toBe(24);
    });

    it('answers Alt+Left and Alt+Right only in the active workspace and never while typing', async () => {
        await render();
        await press(container.querySelector<HTMLButtonElement>('[data-view="routes"]'));
        let event = key({ key: 'ArrowLeft', altKey: true });
        expect(event.defaultPrevented).toBe(true);
        await settle();
        expect(view()).toBe('overview');
        event = key({ key: 'ArrowRight', altKey: true });
        await settle();
        expect(view()).toBe('routes');
        // Typing in the route filter keeps the arrows for the text field.
        const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
        event = key({ key: 'ArrowLeft', altKey: true }, search);
        expect(event.defaultPrevented).toBe(false);
        expect(view()).toBe('routes');
        // Without Alt, or with another modifier, the arrows are not history keys.
        expect(key({ key: 'ArrowLeft' }).defaultPrevented).toBe(false);
        expect(key({ key: 'ArrowLeft', altKey: true, metaKey: true }).defaultPrevented).toBe(false);
        // Another surface on top (help, settings) keeps its keys.
        await render({ escapeTaken: true });
        expect(key({ key: 'ArrowLeft', altKey: true }).defaultPrevented).toBe(false);
        expect(view()).toBe('routes');
        // A hidden Architecture (Galaxy is active) leaves Alt+arrows to that workspace.
        await render({ active: false });
        expect(key({ key: 'ArrowLeft', altKey: true }).defaultPrevented).toBe(false);
        await settle();
        expect(view()).toBe('routes');
    });

    it('jumps to a recent place as a new navigation and starts a fresh history per project', async () => {
        await render();
        await openArea('django');
        await press(container.querySelector<HTMLButtonElement>('[data-view="routes"]'));
        await press(container.querySelector<HTMLButtonElement>('[data-view="structure"]'));
        await goBack();
        const recent = container.querySelector<HTMLDetailsElement>('details.atlas-arch-recent')!;
        expect(recent).not.toBeNull();
        expect(recent.querySelector('summary')?.getAttribute('aria-label')).toBe('Recent');
        const places = [...recent.querySelectorAll('[aria-label="Recently visited places"] li button')];
        expect(places.map(item => [item.querySelector('strong')?.textContent, item.querySelector('span')?.textContent ?? ''])).toEqual([
            ['Routes', 'Service map'], ['System structure', ''], ['Overview', 'django'], ['Overview', ''],
        ]);
        expect(places[0]?.getAttribute('aria-current')).toBe('true');
        await act(async () => { recent.open = true; });
        await press(places[2] as HTMLButtonElement);
        expect([view(), trail()]).toEqual(['overview', ['sample', 'django']]);
        expect(recent.open).toBe(false);
        expect(forward()?.disabled).toBe(true);
        expect(back()?.title).toBe('Back to Routes · Service map (Alt+Left)');

        await render({ projectName: 'other', overview: { ...overview, projectName: 'other' } });
        expect(back()?.disabled).toBe(true);
        expect(forward()?.disabled).toBe(true);
        expect(container.querySelector('details.atlas-arch-recent')).toBeNull();
    });
});
