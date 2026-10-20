import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GraphData, GraphNode } from '../galaxy/types';
import { useSelectionEvidence, type SelectionEvidenceListener } from '../galaxy/selection-evidence';
import { loadSystemGraph, type SystemGraphEntity, type SystemGraphLoader, type SystemGraphProjection,
    type SystemGraphResponse, type SystemGraphWitness } from './system-graph-source';
import { allSystemGraphLayers, buildSystemGraphScene, entityKindLabel, SYSTEM_GRAPH_LAYERS, type SystemGraphLayer } from './system-graph-model';
import type { PlaceChange, SystemPlace } from './architecture-history';
import { useLiftedPlace, useOnIdentityChange } from './lifted-place';
import './system-architecture.css';
import './system-graph.css';
import type { DocumentNavigationTarget } from '../documents/documents-source';

const Scene = lazy(() => import('./SystemArchitectureScene'));
const CapturePanel = lazy(() => import('../capture/CapturePanel'));
const FieldFlowPanel = lazy(() => import('../field-flow/FieldFlowPanel'));
export interface SystemGraphProps {
    project: string; generation?: string; active: boolean; loader?: SystemGraphLoader;
    graph?: GraphData; onSelect?: (node: GraphNode) => void; onClearSelection?: () => void;
    onSelectionEvidence?: SelectionEvidenceListener;
    onNavigate: (path: string, line?: number, name?: string) => void;
    onOpenDocument?: (target: DocumentNavigationTarget) => void;
    place?: SystemPlace; onPlace?: PlaceChange<SystemPlace>; navigation?: ReactNode;
}
const PAGE_SIZE = 24;
const emptyPlace = (): SystemPlace => ({ expanded: [] });
function Source({ entity, onNavigate, onOpenDocument }: { entity: SystemGraphEntity; onNavigate: SystemGraphProps['onNavigate']; onOpenDocument: SystemGraphProps['onOpenDocument'] }) {
    const pdf = /\.pdf$/i.test(entity.file_path ?? '');
    const page = Number.isSafeInteger(entity.properties.page) && Number(entity.properties.page) > 0 ? Number(entity.properties.page) : undefined;
    return entity.file_path ? <button className="atlas-arch-source" data-source-node={entity.ref.node_id}
        disabled={pdf && !onOpenDocument} onClick={() => {
            if (pdf && onOpenDocument) onOpenDocument({ filePath: entity.file_path!, generation: entity.ref.generation,
                ...(page ? { page } : {}) });
            else if (!pdf) onNavigate(entity.file_path!, entity.start_line || undefined, entity.name);
        }}>
        {entity.file_path}{pdf ? page ? ` · page ${page}` : '' : entity.start_line ? `:${entity.start_line}` : ''}</button> : <p className="atlas-arch-muted">No indexed source location.</p>;
}
function Witness({ proof, type, onNavigate, onOpenDocument }: { proof: SystemGraphWitness; type: string; onNavigate: SystemGraphProps['onNavigate']; onOpenDocument: SystemGraphProps['onOpenDocument'] }) {
    const pdf = /\.pdf$/i.test(proof.location?.file_path ?? '');
    return <li data-evidence-edge={proof.ref.edge_id}>
        <span>Indexed evidence · edge {proof.ref.edge_id}</span>
        {proof.location ? <button className="atlas-arch-source" data-witness={proof.ref.edge_id}
            disabled={pdf && !onOpenDocument} onClick={() => {
                const location = proof.location!;
                if (pdf && onOpenDocument) onOpenDocument({ filePath: location.file_path, generation: proof.ref.generation,
                    ...(location.page ? { page: location.page } : {}) });
                else if (!pdf) onNavigate(location.file_path, location.line, location.line ? type : `${type} source file`);
            }}>
            {proof.location.file_path}{proof.location.line ? `:${proof.location.line}` : ''}
            {proof.location.page ? ` · page ${proof.location.page}` : ''}</button> : <span className="atlas-arch-muted">Source location not recorded.</span>}
        {proof.location && !proof.location.line && !proof.location.page && <span className="atlas-arch-muted">Relationship location was not recorded.</span>}
        {proof.location?.position_kind === 'source_context' && <span className="atlas-arch-muted">Showing the source section; the relationship position was not recorded.</span>}
    </li>;
}
function GraphLimits({ data }: { data: SystemGraphProjection }) {
    return <details className="system-graph-coverage" open={!data.complete || data.gaps.length > 0}>
        <summary>{data.complete ? 'Indexed coverage and capabilities' : 'Partial indexed graph'}</summary>
        <p>Indexed relationships describe source evidence. They do not establish observed execution or field-level value flow.</p>
        {!data.capabilities.field_value_flow && <p>Field-level value flow is not available in this graph response. Use Trace a field to query indexed flow evidence separately.</p>}
        {!data.capabilities.live_capture && <p>Live capture is not available in this response.</p>}
        {(data.limits.omitted_entities > 0 || data.limits.omitted_relations > 0) && <p>
            {data.limits.omitted_entities.toLocaleString()} entities and {data.limits.omitted_relations.toLocaleString()} relationships omitted by the server limit.</p>}
        {data.gaps.length > 0 && <ul>{data.gaps.map((gap, index) => <li key={`${gap.code}:${index}`}>{gap.message}{gap.count === undefined ? '' : ` (${gap.count.toLocaleString()})`}</li>)}</ul>}
    </details>;
}

export default function SystemGraph({ project, generation, active, loader = loadSystemGraph, graph, onSelect, onClearSelection,
    onSelectionEvidence, onNavigate, onOpenDocument, place: lifted, onPlace, navigation }: SystemGraphProps) {
    const [place, changePlace] = useLiftedPlace(lifted, onPlace, emptyPlace);
    const [captureOpen, setCaptureOpen] = useState(false);
    const [fieldTarget, setFieldTarget] = useState<{ project: string; generation: string; file: string }>();
    const fieldHost = useRef<HTMLDivElement>(null);
    useEffect(() => { fieldHost.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }, [fieldTarget]);
    const [revision, setRevision] = useState(0), [resetKey, setResetKey] = useState(0), [listLimit, setListLimit] = useState(PAGE_SIZE);
    const [reading, setReading] = useState<{ key: string; response?: SystemGraphResponse; error?: string }>();
    const requestKey = JSON.stringify([project, generation, revision]);
    useEffect(() => {
        if (!active || !project) return;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        setReading({ key: requestKey });
        const read = async () => {
            try {
                const response = await loader({ project, ...(generation ? { expectedGeneration: generation } : {}) }, controller.signal);
                if (controller.signal.aborted) return;
                if (response.result && (response.result.project !== project || response.result.generation !== response.generation))
                    throw new Error('System graph evidence belongs to a different project or generation.');
                setReading({ key: requestKey, response });
                if (response.status === 'pending') timer = setTimeout(() => void read(), Math.max(100, Math.min(5000, response.retry_after_ms ?? 500)));
            } catch (error) {
                if (!controller.signal.aborted) setReading({ key: requestKey, error: error instanceof Error ? error.message : 'System graph could not be loaded.' });
            }
        };
        void read();
        return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
    }, [active, generation, loader, project, requestKey]);
    const current = reading?.key === requestKey ? reading : undefined;
    const data = current?.response?.status === 'ready' ? current.response.result : undefined;
    const error = current?.error ?? (current?.response?.status === 'failed' ? current.response.error ?? 'System graph analysis failed.' : undefined);
    useOnIdentityChange(`${project}:${generation ?? ''}`, () => changePlace({ graphSelection: undefined, graphFocusKind: undefined,
        focus: undefined, expanded: [] }, true));
    const resolvedIdentity = data ? JSON.stringify([data.project, data.generation]) : undefined;
    const lastResolvedIdentity = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!resolvedIdentity) return;
        if (lastResolvedIdentity.current && lastResolvedIdentity.current !== resolvedIdentity) {
            changePlace({ graphSelection: undefined, graphFocusKind: undefined, focus: undefined, expanded: [] }, true);
            onClearSelection?.();
        }
        lastResolvedIdentity.current = resolvedIdentity;
    }, [resolvedIdentity, changePlace, onClearSelection]);
    const layers = useMemo(() => place.graphLayers ? allSystemGraphLayers.filter(layer => place.graphLayers!.includes(layer)) : allSystemGraphLayers, [place.graphLayers]);
    const model = useMemo(() => data ? buildSystemGraphScene(data, { layers, query: place.graphQuery, focusKind: place.graphFocusKind }) : undefined,
        [data, layers, place.graphQuery, place.graphFocusKind]);
    const selection = place.graphSelection;
    const selectedNode = selection?.type !== 'relation' ? model?.nodes.find(node => node.id === selection?.id) : undefined;
    const selectedEntity = selection?.type === 'entity' ? data?.entities.find(entity => entity.id === selection.id) : undefined;
    const selectedEdge = selection?.type === 'relation' ? model?.edges.find(edge => edge.id === selection.id) : undefined;
    const selectedRelations = data?.relations.filter(relation => selectedEdge?.relationIds.includes(relation.id)
        || (!selectedEdge && selection?.type === 'relation' && relation.id === selection.id)) ?? [];
    const members = selectedNode?.aggregateKind ? data?.entities.filter(entity => selectedNode.entityIds.includes(entity.id)) ?? [] : [];
    const adjacent = model?.edges.filter(edge => edge.source === selection?.id || edge.target === selection?.id) ?? [];
    const selectedLabel = selectedEntity?.name ?? selectedNode?.label ?? (selectedRelations.length ? selectedRelations[0].type : undefined);
    useSelectionEvidence(onSelectionEvidence, data && selectedLabel ? {
        project, generation: data.generation, view: 'architecture-system-graph', label: selectedLabel,
        source: 'get_architecture system_graph indexed projection',
        selected: selectedEntity ?? (members.length ? { kind: selectedNode!.aggregateKind, label: selectedLabel, members } : selectedRelations),
        relationships: { items: selectedRelations.length ? selectedRelations : data.relations.filter(relation => selectedNode?.entityIds.includes(relation.source) || selectedNode?.entityIds.includes(relation.target)) },
        limitations: { complete: data.complete, limits: data.limits, capabilities: data.capabilities, gaps: data.gaps,
            interpretation: 'Indexed source relationships. Display groups are not inferred services. No observed execution or field lineage is implied.' },
    } : undefined, active);
    useEffect(() => { setListLimit(PAGE_SIZE); }, [selection?.id, place.graphFocusKind, place.graphQuery]);
    const clearSelection = () => { changePlace({ graphSelection: undefined }, true); onClearSelection?.(); };
    const chooseNode = (id: string) => {
        const node = model?.nodes.find(item => item.id === id);
        if (!node) return;
        changePlace({ graphSelection: { type: node.aggregateKind ? 'group' : 'entity', id } }, true);
        if (node.ref && data?.generation === generation) {
            const known = graph?.nodes.find(item => item.id === node.ref!.node_id);
            if (known) onSelect?.(known);
        }
    };
    const chooseEntity = (entity: SystemGraphEntity) => {
        changePlace({ graphSelection: { type: 'entity', id: entity.id }, graphFocusKind: entity.kind,
            focus: { id: `kind:${entity.kind}`, label: entityKindLabel(entity.kind) }, expanded: [entity.kind] });
    };
    const drill = (kind: string) => changePlace({ graphFocusKind: kind, graphSelection: undefined,
        focus: { id: `kind:${kind}`, label: entityKindLabel(kind) }, expanded: [kind] });
    const overview = () => { changePlace({ graphFocusKind: undefined, graphSelection: undefined, focus: undefined, expanded: [] }); onClearSelection?.(); };
    const toggleLayer = (layer: SystemGraphLayer) => changePlace({ graphLayers: layers.includes(layer) ? layers.filter(item => item !== layer) : [...layers, layer] }, true);
    const catalog = data?.entities.filter(entity => (!place.graphFocusKind || entity.kind === place.graphFocusKind)
        && (!place.graphQuery?.trim() || `${entity.name} ${entity.qualified_name} ${entity.file_path ?? ''}`.toLocaleLowerCase().includes(place.graphQuery.trim().toLocaleLowerCase()))) ?? [];

    return <section className="system-architecture system-graph" data-testid="system-graph" data-focus-kind={place.graphFocusKind ?? ''} aria-label="System graph" aria-busy={!data && !error}>
        <div className="atlas-arch-context">{navigation}<nav aria-label="System graph location">
            <button type="button" onClick={overview} disabled={!place.graphFocusKind}>System graph</button>
            {place.graphFocusKind && <span>{entityKindLabel(place.graphFocusKind)}</span>}
        </nav><button type="button" className="atlas-arch-action" onClick={() => setRevision(value => value + 1)} disabled={!active}>Refresh graph</button></div>
        {error ? <div role="alert" className="system-analysis-state"><strong>System graph unavailable</strong><p>{error}</p>
            <button className="atlas-arch-action" onClick={() => setRevision(value => value + 1)}>Retry</button></div>
            : !data ? <div className="system-analysis-state" role="status">Loading system graph…</div> : <>
                <div className="system-graph-toolbar">
                    <label className="atlas-arch-filter"><span className="system-graph-search-label">Find an entity</span>
                        <input type="search" aria-label="Filter system graph" placeholder="Name, source file or qualified name"
                            value={place.graphQuery ?? ''} onChange={event => changePlace({ graphQuery: event.target.value }, true)} /></label>
                    <div className="system-view-switch" role="group" aria-label="System graph camera">
                        <button type="button" data-camera="3d" aria-pressed={!place.structurePlanar} onClick={() => changePlace({ structurePlanar: false }, true)}>3D</button>
                        <button type="button" data-camera="2d" aria-pressed={Boolean(place.structurePlanar)} onClick={() => changePlace({ structurePlanar: true }, true)}>2D</button>
                    </div>
                    <button type="button" className="atlas-arch-action" onClick={() => setResetKey(value => value + 1)}>Fit graph</button>
                </div>
                <div className="system-graph-layers" role="group" aria-label="System graph layers">
                    {SYSTEM_GRAPH_LAYERS.map(layer => <button type="button" key={layer.id} data-layer={layer.id}
                        aria-pressed={layers.includes(layer.id)} onClick={() => toggleLayer(layer.id)}>{layer.label}</button>)}
                </div>
                <p className="system-filter-count">{model!.matchingEntities.toLocaleString()} of {data.entities.length.toLocaleString()} returned entities · {model!.matchingRelations.toLocaleString()} indexed relationships</p>
                {model!.nodes.length ? <div className="system-workspace">
                    <div className="system-map"><Suspense fallback={<div role="status" className="system-analysis-state">Preparing graph…</div>}>
                        <Scene model={model!} selectedNode={selectedNode?.id} selectedEdge={selectedEdge?.id} resetKey={resetKey}
                            planar={Boolean(place.structurePlanar)} active={active} showConnectionLoad={false}
                            onSelectNode={chooseNode} onSelectEdge={id => changePlace({ graphSelection: { type: 'relation', id } }, true)}
                            onClearSelection={clearSelection} />
                    </Suspense>
                        <div className="system-map-caption"><span>{place.structurePlanar ? 'Drag to pan' : 'Drag to orbit'} · Scroll to zoom</span><span>Arrows show indexed direction</span></div>
                    </div>
                    <aside className="system-inspector" aria-label="System graph evidence">
                        {!selectedLabel ? <><h3>Explore the system</h3><p>Select an entity or relationship to inspect its indexed evidence.</p>
                            <p>Groups collect entities of the same indexed kind. Open a group to see its members.</p></>
                            : <><button type="button" className="atlas-arch-action" onClick={clearSelection}>Clear selection</button><h3>{selectedLabel}</h3>
                                {selectedEntity && <><p>{entityKindLabel(selectedEntity.kind)} · {selectedEntity.label}</p><Source entity={selectedEntity} onNavigate={onNavigate} onOpenDocument={onOpenDocument} />
                                    <p className="system-graph-identity">{selectedEntity.qualified_name}</p>
                                    {selectedEntity.file_path && <button type="button" className="atlas-arch-action" data-system-trace-field
                                        onClick={() => setFieldTarget({ project, generation: data.generation, file: selectedEntity.file_path! })}>Trace a field…</button>}</>}
                                {selectedNode?.aggregateKind && <><p>Display group · {members.length} indexed entities. This grouping does not establish a service or deployment boundary.</p>
                                    <button type="button" className="atlas-arch-action" data-action="drill-group" onClick={() => drill(selectedNode.aggregateKind!)}>Show members</button>
                                    <ul className="system-graph-entity-list">{members.slice(0, listLimit).map(entity => <li key={entity.id}><button type="button" onClick={() => chooseEntity(entity)}>{entity.name}</button></li>)}</ul>
                                    {members.length > listLimit && <button type="button" className="atlas-arch-action" onClick={() => setListLimit(value => value + PAGE_SIZE)}>More members</button>}</>}
                                {selectedRelations.slice(0, listLimit).map(relation => <div key={relation.id} className="system-graph-relation-proof">
                                    <p>{data.entities.find(entity => entity.id === relation.source)?.name} → {data.entities.find(entity => entity.id === relation.target)?.name}</p>
                                    <strong>{relation.type}</strong>
                                    {relation.witnesses.length ? <ul className="system-graph-witnesses">{relation.witnesses.slice(0, listLimit).map((proof, index) =>
                                        <Witness key={`${proof.ref.edge_id}:${index}`} proof={proof} type={relation.type} onNavigate={onNavigate} onOpenDocument={onOpenDocument} />)}</ul>
                                        : <p>No source witness was returned.</p>}
                                    {relation.witnesses.length > listLimit && <button type="button" className="atlas-arch-action" onClick={() => setListLimit(value => value + PAGE_SIZE)}>More source witnesses ({relation.witnesses.length - listLimit} remaining)</button>}
                                </div>)}
                                {selectedRelations.length > listLimit && <button type="button" className="atlas-arch-action" onClick={() => setListLimit(value => value + PAGE_SIZE)}>More evidence relationships ({selectedRelations.length - listLimit} remaining)</button>}
                                {adjacent.length > 0 && <><h4>Relationships</h4><ul className="system-graph-entity-list">{adjacent.slice(0, listLimit).map(edge => <li key={edge.id}>
                                    <button type="button" data-inspect-relation={edge.id} onClick={() => changePlace({ graphSelection: { type: 'relation', id: edge.id } }, true)}>
                                        <span>{model!.nodes.find(node => node.id === edge.source)?.label} {edge.directed ? '→' : '—'} {model!.nodes.find(node => node.id === edge.target)?.label}</span>
                                        <small>{edge.type} · {edge.count} {edge.count === 1 ? 'relationship' : 'relationships'}</small></button></li>)}</ul>
                                    {adjacent.length > listLimit && <button type="button" className="atlas-arch-action" onClick={() => setListLimit(value => value + PAGE_SIZE)}>More relationships</button>}</>}
                            </>}
                    </aside>
                </div> : <div className="system-analysis-state" role="status"><strong>{data.entities.length ? 'No entities match these filters.' : 'No indexed system entities.'}</strong>
                    {data.entities.length > 0 && <button className="atlas-arch-action" onClick={() => changePlace({ graphQuery: '', graphLayers: undefined }, true)}>Clear filters</button>}</div>}
                {(model!.omittedNodes > 0 || model!.omittedEdges > 0) && <p className="system-graph-limit" role="status">
                    Drawing limit: {model!.omittedNodes} nodes and {model!.omittedEdges} relationships are outside this view. Find their names below or filter the graph.</p>}
                {fieldTarget?.project === project && fieldTarget.generation === data.generation && <div ref={fieldHost}>
                    <button type="button" className="atlas-arch-action" data-field-close onClick={() => setFieldTarget(undefined)}>Close field trace</button>
                    <Suspense fallback={<p role="status">Preparing field flow…</p>}><FieldFlowPanel project={project} generation={data.generation}
                        initialFile={fieldTarget.file} entities={data.entities} active={active} onSelectEntity={chooseEntity} /></Suspense>
                </div>}
                <details className="system-graph-catalog"><summary>Entities and groups ({catalog.length.toLocaleString()} entities)</summary>
                    <ul className="system-graph-entity-list system-graph-groups">{model!.nodes.filter(node => node.aggregateKind).map(node => <li key={node.id}>
                        <button type="button" data-aggregate-kind={node.aggregateKind} onClick={() => chooseNode(node.id)}>{node.label} ({node.entityIds.length})</button></li>)}</ul>
                    <ul className="system-graph-entity-list">{catalog.slice(0, listLimit).map(entity => <li key={entity.id}>
                        <button type="button" data-catalog-entity={entity.id} onClick={() => chooseEntity(entity)}>{entity.name}<small>{entity.file_path ?? entity.kind}</small></button></li>)}</ul>
                    {catalog.length > listLimit && <button type="button" className="atlas-arch-action" onClick={() => setListLimit(value => value + PAGE_SIZE)}>More entities</button>}
                </details>
                <GraphLimits data={data} />
                <details className="system-graph-capture" onToggle={event => setCaptureOpen(event.currentTarget.open)}>
                    <summary>Local live capture</summary>
                    {captureOpen && <Suspense fallback={<p role="status">Preparing local capture…</p>}>
                        <CapturePanel project={project} generation={data.generation} active={active} onNavigate={onNavigate} />
                    </Suspense>}
                </details>
            </>}
    </section>;
}
