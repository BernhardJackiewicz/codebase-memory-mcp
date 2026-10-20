import type { SystemSceneEdge, SystemSceneModel, SystemSceneNode } from './system-architecture-model';
import type { SystemEntityRef, SystemGraphProjection } from './system-graph-source';
import { SCENE_PALETTE } from './scene-palette';

export const SYSTEM_GRAPH_LAYERS = [
    { id: 'communication', label: 'Code & communication' },
    { id: 'data', label: 'Data' },
    { id: 'deployment', label: 'Deployment & configuration' },
    { id: 'documentation', label: 'Docs' },
    { id: 'dependency', label: 'Dependencies' },
    { id: 'other', label: 'Other' },
] as const;
export type SystemGraphLayer = typeof SYSTEM_GRAPH_LAYERS[number]['id'];
export const allSystemGraphLayers = SYSTEM_GRAPH_LAYERS.map(layer => layer.id);
const nativeLayer: Record<string, SystemGraphLayer> = { code: 'communication', data: 'data', deployment: 'deployment',
    configuration: 'deployment', documentation: 'documentation', dependency: 'dependency' };
const kindLayer: Record<string, SystemGraphLayer> = { code: 'communication', service: 'communication', api: 'communication', queue: 'communication',
    database: 'data', data_structure: 'data', deployment: 'deployment', container: 'deployment', configuration: 'deployment',
    document: 'documentation', diagram: 'documentation', dependency: 'dependency' };
export const relationLayer = (layer: string): SystemGraphLayer => nativeLayer[layer] ?? 'other';
export const entityKindLabel = (kind: string): string => ({
    code: 'Code', service: 'Services', api: 'APIs', database: 'Databases', data_structure: 'Data structures',
    deployment: 'Deployments', container: 'Containers', configuration: 'Configuration', document: 'Documents',
    diagram: 'Diagrams', dependency: 'Dependencies', queue: 'Queues', structural: 'Source structure', other: 'Other entities',
}[kind] ?? kind.replaceAll('_', ' '));
const kindOrder = ['service', 'api', 'code', 'queue', 'database', 'data_structure', 'container', 'deployment', 'configuration', 'document', 'diagram', 'dependency', 'structural', 'other'];
const colorOfKind = (kind: string) => ['document', 'diagram'].includes(kind) ? SCENE_PALETTE.serviceImage
    : ['database', 'data_structure'].includes(kind) ? SCENE_PALETTE.fillLight
        : ['deployment', 'container', 'configuration'].includes(kind) ? SCENE_PALETTE.serviceSource : SCENE_PALETTE.node;

export interface SystemGraphSceneNode extends SystemSceneNode { entityIds: string[]; aggregateKind?: string; ref?: SystemEntityRef }
export interface SystemGraphSceneEdge extends SystemSceneEdge { relationIds: string[]; layer: SystemGraphLayer }
/** Geometry only is shared with the older scene. No legacy inferred component is manufactured. */
export interface SystemGraphSceneModel extends SystemSceneModel {
    nodes: SystemGraphSceneNode[]; edges: SystemGraphSceneEdge[];
    matchingEntities: number; matchingRelations: number;
}
export interface SystemGraphSceneOptions {
    layers?: readonly SystemGraphLayer[]; query?: string; focusKind?: string; maxNodes?: number;
}
const labelSize = (label: string): [number, number] => {
    const width = Math.max(136, Math.min(200, label.length * 6 + 20));
    return [width, Math.max(34, 14 * Math.ceil(label.length * 6 / (width - 16)) + 14)];
};
const kindRow = (kind: string) => ['document', 'diagram', 'dependency', 'structural'].includes(kind) ? 0
    : ['deployment', 'container', 'configuration'].includes(kind) ? 2 : 1;

export function indexedCurveOffset(source: SystemSceneNode, target: SystemSceneNode, nodes: readonly SystemSceneNode[]): number {
    const dx = target.position[0] - source.position[0], dy = target.position[1] - source.position[1];
    const distanceSquared = dx * dx + dy * dy;
    if (!distanceSquared) return 0;
    const distance = Math.sqrt(distanceSquared);
    const obstructed = nodes.some(node => {
        if (node.id === source.id || node.id === target.id) return false;
        const x = node.position[0] - source.position[0], y = node.position[1] - source.position[1];
        const along = (x * dx + y * dy) / distanceSquared;
        return along > 0.08 && along < 0.92 && Math.abs(x * dy - y * dx) / distance < 36;
    });
    return obstructed ? Math.max(72, Math.min(140, distance * 0.35)) : 0;
}

/** Rows describe indexed layers; ordering within them follows actual connectivity.
 * These display regions never claim a service or deployment boundary. */
function placeVisibleNodes(nodes: SystemGraphSceneNode[], edges: SystemGraphSceneEdge[], entityKinds: Map<string, string>): SystemSceneModel['lanes'] {
    const blocks = new Map<string, { kind: string; nodes: SystemGraphSceneNode[]; columns: number; width: number; height: number; x: number; y: number }>();
    for (const node of nodes) {
        const kind = node.aggregateKind ?? entityKinds.get(node.entityIds[0]) ?? 'other';
        const block = blocks.get(kind);
        if (block) block.nodes.push(node);
        else blocks.set(kind, { kind, nodes: [node], columns: 1, width: 118, height: 68, x: 0, y: 0 });
    }
    for (const block of blocks.values()) {
        block.columns = Math.min(4, Math.ceil(Math.sqrt(block.nodes.length)));
        block.width = Math.max(118, block.columns * 74);
        block.height = Math.max(68, Math.ceil(block.nodes.length / block.columns) * 48);
    }
    const rows = [0, 1, 2].map(row => [...blocks.values()].filter(block => kindRow(block.kind) === row));
    const arrange = () => {
        let top = rows.reduce((height, row) => height + (row.length ? Math.max(...row.map(block => block.height)) + 80 : 0), -80) / 2;
        for (const row of rows) {
            if (!row.length) continue;
            const height = Math.max(...row.map(block => block.height));
            let left = -row.reduce((width, block) => width + block.width + 48, -48) / 2;
            for (const block of row) { block.x = left + block.width / 2; block.y = top - height / 2; left += block.width + 48; }
            top -= height + 80;
        }
    };
    arrange();
    const nodeKinds = new Map([...blocks.values()].flatMap(block => block.nodes.map(node => [node.id, block.kind] as const)));
    // Barycentric ordering reduces crossings without a random/animated force layout.
    for (let pass = 0; pass < 2; pass++) {
        const scores = new Map<string, { total: number; weight: number }>();
        for (const edge of edges) {
            const source = nodeKinds.get(edge.source)!, target = nodeKinds.get(edge.target)!;
            if (source === target) continue;
            for (const [from, to] of [[source, target], [target, source]]) {
                const score = scores.get(from) ?? { total: 0, weight: 0 };
                score.total += blocks.get(to)!.x * edge.count; score.weight += edge.count; scores.set(from, score);
            }
        }
        for (const row of rows) row.sort((a, b) => {
            const score = (kind: string, x: number) => { const item = scores.get(kind); return item?.weight ? item.total / item.weight : x; };
            return score(a.kind, a.x) - score(b.kind, b.x) || a.kind.localeCompare(b.kind);
        });
        arrange();
    }
    const lanes: SystemSceneModel['lanes'] = [];
    for (const block of blocks.values()) {
        const countRows = Math.ceil(block.nodes.length / block.columns);
        block.nodes.forEach((node, index) => {
            node.position = [block.x + (index % block.columns - (block.columns - 1) / 2) * 74,
                block.y - (Math.floor(index / block.columns) - (countRows - 1) / 2) * 48, 0];
        });
        if (block.nodes.length > 1) lanes.push({ id: `lane:${block.kind}`, label: `${entityKindLabel(block.kind)} · indexed entities`,
            position: [block.x, block.y, -2], width: block.width, height: block.height, depth: 1,
            memberIds: block.nodes.map(node => node.id) });
    }
    return lanes;
}

export function buildSystemGraphScene(graph: SystemGraphProjection, options: SystemGraphSceneOptions): SystemGraphSceneModel {
    const enabled = new Set(options.layers ?? allSystemGraphLayers), query = options.query?.trim().toLocaleLowerCase() ?? '';
    const enabledRelations = graph.relations.filter(relation => enabled.has(relationLayer(relation.layer)));
    const related = new Set(enabledRelations.flatMap(relation => [relation.source, relation.target]));
    const matches = graph.entities.filter(entity => (related.has(entity.id) || enabled.has(kindLayer[entity.kind] ?? 'other'))
        && (!query || `${entity.name} ${entity.label} ${entity.qualified_name} ${entity.file_path ?? ''}`.toLocaleLowerCase().includes(query)));
    const byKind = new Map<string, typeof matches>();
    for (const entity of matches) {
        const members = byKind.get(entity.kind);
        if (members) members.push(entity); else byKind.set(entity.kind, [entity]);
    }
    const kinds = [...byKind.keys()].sort((a, b) => {
        const rank = (kind: string) => kindOrder.includes(kind) ? kindOrder.indexOf(kind) : kindOrder.length;
        return rank(a) - rank(b) || a.localeCompare(b);
    });
    const allIds = new Set(graph.entities.map(entity => entity.id)), nodes: SystemGraphSceneNode[] = [];
    const entityToScene = new Map<string, string>();
    for (const kind of kinds) {
        const members = byKind.get(kind)!.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const aggregate = members.length > 1 && options.focusKind !== kind;
        let id = `view:kind:${kind}`;
        while (allIds.has(id)) id = `view:${id}`;
        if (aggregate) {
            nodes.push({ id, label: entityKindLabel(kind), detail: `${members.length} indexed entities`,
                entityIds: members.map(entity => entity.id), aggregateKind: kind, position: [0, 0, 0], size: [26, 18, 4],
                labelSize: labelSize(entityKindLabel(kind)),
                visual: { color: colorOfKind(kind), label: 'Display group', basis: 'Grouped by indexed kind; not a deployment boundary' } });
            members.forEach(entity => entityToScene.set(entity.id, id));
        } else {
            members.forEach(entity => {
                const label = entity.name || entity.label || entity.qualified_name;
                nodes.push({ id: entity.id, label,
                    detail: entity.file_path ?? entity.label, entityIds: [entity.id], ref: entity.ref,
                    position: [0, 0, 0], size: [20, 14, 3], labelSize: labelSize(label),
                    visual: { color: colorOfKind(kind), label: entityKindLabel(kind) } });
                entityToScene.set(entity.id, entity.id);
            });
        }
    }
    const sceneNodes = nodes.slice(0, options.maxNodes ?? 180), visible = new Set(sceneNodes.map(node => node.id));
    const groupedEdges = new Map<string, SystemGraphSceneEdge>();
    let matchingRelations = 0, omittedEdges = 0;
    for (const relation of enabledRelations) {
        const source = entityToScene.get(relation.source), target = entityToScene.get(relation.target);
        if (!source || !target) continue;
        matchingRelations++;
        if (!visible.has(source) || !visible.has(target)) { omittedEdges++; continue; }
        const aggregate = source !== relation.source || target !== relation.target;
        const id = aggregate ? `view:relation:${JSON.stringify([source, target, relation.layer, relation.type])}` : relation.id;
        const edge = groupedEdges.get(id);
        if (edge) { edge.relationIds.push(relation.id); edge.count++; }
        else groupedEdges.set(id, { id, source, target, type: relation.type, count: 1, layer: relationLayer(relation.layer), relationIds: [relation.id],
            directed: !['SIMILAR_TO', 'SEMANTICALLY_RELATED', 'FILE_CHANGES_WITH'].includes(relation.type.toUpperCase()) });
    }
    const edges = [...groupedEdges.values()];
    const lanes = placeVisibleNodes(sceneNodes, edges, new Map(graph.entities.map(entity => [entity.id, entity.kind])));
    const byId = new Map(sceneNodes.map(node => [node.id, node]));
    for (const edge of edges) edge.curveOffset = indexedCurveOffset(byId.get(edge.source)!, byId.get(edge.target)!, sceneNodes);
    return { nodes: sceneNodes, edges, lanes,
        omittedNodes: nodes.length - sceneNodes.length, omittedEdges, matchingEntities: matches.length, matchingRelations,
        scopeKey: `system-graph:${graph.project}:${graph.generation}:${options.focusKind ?? 'overview'}` };
}
