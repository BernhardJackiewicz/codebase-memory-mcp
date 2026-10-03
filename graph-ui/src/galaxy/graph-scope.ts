import { RpcIntelligenceClient } from '../provider/rpc-client';
import { escapeLiteral } from '../provider/cypher';
import type { QueryGraphResult } from '../provider/rpc-schemas';
import { readerGraphFocus, type SourceFocusRange } from './reader-graph-focus';
import type { GraphData, GraphEdge, GraphNode } from './types';
import type { GraphNeighborhoodTransaction } from './graph-neighborhood-cache';

export type TraceDirection = 'both' | 'inbound' | 'outbound';
export type GraphScope = { kind: 'node'; id: number; name: string; qualifiedName?: string } | { kind: 'symbol'; qualifiedName: string; name: string } | { kind: 'file' | 'folder'; path: string; name: string; range?: SourceFocusRange };
/** A layer that stopped at the render limit (hand test K8): what was loaded, and which limit stopped it. */
export interface ScopePartial { layer: number; nodes: number; edges: number; limit: 'nodes' | 'edges' }
export interface ScopedGraph { data: GraphData; roots: Set<number>; depth: number; exhausted: boolean; frontier?: number[]; levels?: Map<number, number>; traversalKey?: string; partial?: ScopePartial }
/** How large one query_graph page may be. */
export interface QueryBudget { maxRows?: number; maxOutputTokens?: number }
export interface GraphQueryClient { queryGraph(project: string, query: string, cursor?: string, budget?: QueryBudget): Promise<QueryGraphResult> }
/** What a running load has gathered so far, for the toolbar instead of an endless "Loading". */
export interface ScopeProgress { layer: number; nodes: number; edges: number; requests: number }
/*
 * Grosse Seiten, und das ist die eigentliche Antwort auf K8. Der Server rechnet
 * eine Abfrage fuer JEDE Fortsetzungsseite vollstaendig neu und schickt davon
 * nur ein Fenster (Vorgabe 200 Zeilen und rund 3.200 Tokens, also bei dieser
 * Spaltenbreite etwa 30 Zeilen). Die dritte Ebene um JSONBAgg brauchte so ueber
 * 500 Aufrufe nacheinander, je rund 0,6 s. Mit diesem Fenster ist eine Ebene
 * eine Handvoll Aufrufe; die Ergebnisse selbst aendern sich nicht.
 */
export const SCOPE_PAGE_BUDGET: QueryBudget = { maxRows: 5000, maxOutputTokens: 600_000 };
/** Undefined includes every relationship type; an explicit empty list includes none. */
export function graphEdgeTypesKey(edgeTypes?: readonly string[]): string {
    return JSON.stringify(edgeTypes === undefined ? null : [...new Set(edgeTypes)].sort());
}
const BATCH_SIZE = 64;
const number = (value: string | undefined): number | undefined => value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
const id = (value: string | undefined): number => {
    const parsed = number(value);
    if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Graph response contains an invalid identity.');
    return parsed;
};
const nodeColumns = (alias: string, prefix: string) => [`id(${alias}) AS ${prefix}id`, `${alias}.label AS ${prefix}label`, `${alias}.name AS ${prefix}name`, `${alias}.qualified_name AS ${prefix}qn`, `${alias}.file_path AS ${prefix}file`, `${alias}.start_line AS ${prefix}start_line`, `${alias}.end_line AS ${prefix}end_line`].join(', ');

/** The cursor binds a complete query result to one graph generation. Every
 * continuation is consumed; a daemon cap or missing cursor is never silently
 * accepted as the selected file's complete neighborhood. */
export async function readGraphPages(client: GraphQueryClient, project: string, query: string, key: string, signal?: AbortSignal,
    onRequest?: () => void): Promise<Record<string, string>[]> {
    signal?.throwIfAborted();
    onRequest?.();
    let page = await client.queryGraph(project, query, undefined, SCOPE_PAGE_BUDGET);
    const columns = page.columns, total = page.total, records: Record<string, string>[] = [];
    const cursors = new Set<string>(), identities = new Set<number>();
    for (;;) {
        signal?.throwIfAborted();
        if (JSON.stringify(columns) !== JSON.stringify(page.columns) || page.total !== total
            || (page.offset !== undefined && page.offset !== records.length)) throw new Error('Graph pagination changed its result snapshot.');
        for (const row of page.rows) {
            const record = Object.fromEntries(columns.map((column, index) => [column, row[index] ?? '']));
            const identity = id(record[key]);
            if (identities.has(identity)) throw new Error('Graph pagination repeated a row.');
            identities.add(identity); records.push(record);
        }
        if (!page.nextCursor) {
            if (page.hasMore || page.truncated || page.totalRelation === 'gte' || (total !== undefined && records.length < total))
                throw new Error(`Incomplete graph response (${records.length} relationships read); ${page.truncationReason ?? 'the server did not provide a continuation'}.`);
            return records;
        }
        if (!page.rows.length || cursors.has(page.nextCursor)) throw new Error('Graph pagination did not advance.');
        if (page.nextOffset !== undefined && page.nextOffset !== records.length) throw new Error('Graph pagination skipped rows.');
        cursors.add(page.nextCursor); signal?.throwIfAborted();
        onRequest?.();
        page = await client.queryGraph(project, query, page.nextCursor, SCOPE_PAGE_BUDGET);
    }
}

const languageColors: Record<string, string> = { ts: '#6ea6be', tsx: '#6ea6be', js: '#c3b775', jsx: '#c3b775', c: '#92a8b4', h: '#92a8b4', cpp: '#b28da6', py: '#8daf88', go: '#77b2b4', rs: '#bd947c', java: '#bd9281', cs: '#a392bb', rb: '#b78288', swift: '#bf9b85', kt: '#af97ba' };
function readNode(row: Record<string, string>, prefix: string, layout: Map<number, GraphNode>): GraphNode {
    const identity = id(row[`${prefix}id`]), known = layout.get(identity);
    const path = row[`${prefix}file`] || undefined;
    return { ...known, id: identity, name: row[`${prefix}name`] || String(identity), label: row[`${prefix}label`] || known?.label || '',
        qualified_name: row[`${prefix}qn`] || undefined, file_path: path,
        start_line: number(row[`${prefix}start_line`]), end_line: number(row[`${prefix}end_line`]),
        x: known?.x ?? 0, y: known?.y ?? 0, z: known?.z ?? 0,
        size: known?.size ?? 2.8, color: known?.color ?? languageColors[path?.split('.').pop() ?? ''] ?? '#97a6ad' };
}
const anyNames = (alias: string, names: readonly string[]) => `(${names.map(value => `${alias}.qualified_name = "${escapeLiteral(value)}"`).join(' OR ')})`;

/** Deterministic concentric hop rings. Names within a folder stay adjacent;
 * distances encode relationship depth, never runtime or architectural certainty. */
export function arrangeScopedGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[], roots: ReadonlySet<number>, discoveredLevels?: ReadonlyMap<number, number>): GraphData {
    const levels = new Map<number, number>(discoveredLevels);
    roots.forEach(value => levels.set(value, 0));
    const adjacency = new Map<number, number[]>();
    for (const edge of edges) {
        const from = adjacency.get(edge.source) ?? [], to = adjacency.get(edge.target) ?? [];
        from.push(edge.target); to.push(edge.source); adjacency.set(edge.source, from); adjacency.set(edge.target, to);
    }
    const queue = [...roots];
    for (let at = 0; !discoveredLevels && at < queue.length; at++) for (const next of adjacency.get(queue[at]!) ?? []) {
        if (levels.has(next)) continue;
        levels.set(next, levels.get(queue[at]!)! + 1); queue.push(next);
    }
    const rings = new Map<number, GraphNode[]>();
    for (const node of nodes) {
        const level = levels.get(node.id) ?? 0;
        const ring = rings.get(level) ?? []; ring.push(node); rings.set(level, ring);
    }
    const arranged: GraphNode[] = [];
    let radius = 0;
    for (const [level, ring] of [...rings].sort(([a], [b]) => a - b)) {
        ring.sort((a, b) => (a.file_path ?? '').localeCompare(b.file_path ?? '') || a.name.localeCompare(b.name) || a.id - b.id);
        radius = level === 0 && ring.length === 1 ? 0 : Math.max(radius + 70, ring.length * 8 / Math.PI);
        ring.forEach((node, index) => {
            const angle = index / ring.length * Math.PI * 2;
            arranged.push({ ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z: level * -18,
                size: Math.min(5, Math.max(2, node.size)) });
        });
    }
    return { nodes: arranged, edges: [...edges], total_nodes: arranged.length };
}

export async function loadGraphScope(project: string, scope: GraphScope, depth: number, direction: TraceDirection,
    layout: GraphData | undefined, options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; client?: GraphQueryClient; previous?: ScopedGraph; edgeTypes?: readonly string[]; cache?: GraphNeighborhoodTransaction;
        /** Called after every relationship request with what is loaded so far. */
        onProgress?: (progress: ScopeProgress) => void;
        /** The render limits: a layer that grows past them stops and is marked partial. */
        limits?: { nodes: number; edges: number } } = {}): Promise<ScopedGraph> {
    options.signal?.throwIfAborted();
    const client = options.client ?? new RpcIntelligenceClient({ fetch: options.fetch, signal: options.signal });
    const edgeTypes = options.edgeTypes === undefined ? undefined : [...new Set(options.edgeTypes)].sort();
    if (edgeTypes?.some(type => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(type))) throw new Error('Invalid graph relationship type.');
    const allowedTypes = edgeTypes === undefined ? undefined : new Set(edgeTypes);
    const traversalKey = JSON.stringify([project, scope, direction, graphEdgeTypesKey(edgeTypes)]);
    const relationship = edgeTypes?.length ? `[r:${edgeTypes.join('|')}]` : '[r]';
    const known = new Map(layout?.nodes.map(node => [node.id, node]) ?? []);
    if (scope.kind === 'node') {
        const cachedNode = options.cache?.node(scope.id);
        if (cachedNode && (!scope.qualifiedName || cachedNode.qualified_name === scope.qualifiedName)) known.set(scope.id, cachedNode);
    }
    if (scope.kind === 'node' && !(scope.qualifiedName ?? known.get(scope.id)?.qualified_name))
        throw new Error('This node has no indexed qualified identity; its relationships cannot be retrieved reliably.');
    const predicate = scope.kind === 'node' ? `n.qualified_name = "${escapeLiteral(scope.qualifiedName ?? known.get(scope.id)?.qualified_name ?? '')}"` : scope.kind === 'symbol' ? `n.qualified_name = "${escapeLiteral(scope.qualifiedName)}"` : scope.kind === 'file' ? `n.file_path = "${escapeLiteral(scope.path)}"`
        : `n.file_path STARTS WITH "${escapeLiteral(scope.path.replace(/\/$/, '') + '/')}"`;
    // A partial layer misses part of its frontier, so it is never the base of the next one.
    const previous = options.previous?.traversalKey === traversalKey && options.previous.depth <= depth && !options.previous.partial ? options.previous : undefined;
    let requests = 0;
    const counted = () => { requests += 1; };
    const cachedNode = scope.kind === 'node' ? options.cache?.node(scope.id) : undefined;
    let rootNodes = cachedNode && cachedNode.qualified_name === (scope.kind === 'node' ? scope.qualifiedName ?? known.get(scope.id)?.qualified_name : '')
        ? [cachedNode] : options.cache?.roots(predicate);
    if (!previous && !rootNodes) {
        const rootRows = await readGraphPages(client, project, `MATCH (n) WHERE ${predicate} RETURN ${nodeColumns('n', '')}`, 'id', options.signal, counted);
        rootNodes = rootRows.map(row => readNode(row, '', known));
        options.cache?.rememberRoots(predicate, rootNodes);
    }
    const candidates = previous ? previous.data.nodes.filter(node => previous.roots.has(node.id))
        : rootNodes!.filter(node => scope.kind !== 'node' || node.id === scope.id);
    const roots = scope.kind === 'file' && scope.range ? readerGraphFocus(candidates, scope.path, scope.range).ids : new Set(candidates.map(node => node.id));
    const nodes = new Map((previous?.data.nodes ?? candidates.filter(node => roots.has(node.id))).map(node => [node.id, node]));
    const levels = new Map<number, number>(previous?.levels ?? [...roots].map(identity => [identity, 0] as const));
    const edges = new Map<number, GraphEdge>(previous?.data.edges.filter(edge => edge.id !== undefined).map(edge => [edge.id!, edge]) ?? []);
    let frontier = edgeTypes?.length === 0 ? [] : previous?.frontier ?? [...roots], reachedDepth = previous?.depth ?? 0;
    let partial: ScopePartial | undefined;
    const overLimit = (layer: number): ScopePartial | undefined => !options.limits ? undefined
        : nodes.size > options.limits.nodes ? { layer, nodes: nodes.size, edges: edges.size, limit: 'nodes' }
            : edges.size > options.limits.edges ? { layer, nodes: nodes.size, edges: edges.size, limit: 'edges' } : undefined;
    for (let hop = reachedDepth; hop < Math.max(depth, roots.size > 1 ? 1 : 0) && frontier.length && !partial; hop++) {
        const next = new Set<number>();
        const fileBoundary = hop === 0 && (scope.kind === 'folder' || (scope.kind === 'file' && !scope.range));
        const accept = (evidenceNodes: readonly GraphNode[], evidenceEdges: readonly GraphEdge[]) => {
            const byId = new Map(evidenceNodes.map(node => [node.id, node]));
            for (const edge of evidenceEdges) {
                for (const identity of [edge.source, edge.target]) {
                    const node = byId.get(identity)!;
                    if (!nodes.has(identity)) { next.add(identity); levels.set(identity, hop + 1); }
                    nodes.set(identity, node);
                }
                edges.set(edge.id!, edge);
            }
        };
        const legs = direction === 'both' ? ['outbound', 'inbound'] as const : [direction];
        for (const leg of legs) {
            if (partial) break;
            const missing: number[] = [];
            for (const identity of frontier) {
                const cached = options.cache?.neighborhood(identity, leg, edgeTypes);
                if (cached) accept(cached.nodes, cached.edges); else missing.push(identity);
            }
            const useBoundary = fileBoundary && missing.length === frontier.length;
            const batchSize = useBoundary ? Math.max(1, missing.length) : BATCH_SIZE;
            for (let at = 0; at < missing.length && !partial; at += batchSize) {
                const batch = missing.slice(at, at + batchSize), batchIds = new Set(batch);
                const names = batch.map(value => nodes.get(value)?.qualified_name);
                if (!useBoundary && names.some(name => !name)) throw new Error('A selected graph node has no qualified identity; its dependencies cannot be loaded completely.');
                const alias = leg === 'inbound' ? 'b' : 'a';
                const relation = useBoundary ? scope.kind === 'folder'
                    ? `${alias}.file_path STARTS WITH "${escapeLiteral(scope.path.replace(/\/$/, '') + '/')}"`
                    : `${alias}.file_path = "${escapeLiteral(scope.kind === 'file' ? scope.path : '')}"`
                    : anyNames(alias, names as string[]);
                // Keep each predicate on the left seed, so early WHERE prunes before
                // adjacency expansion. An OR spanning a and b materializes the repo.
                const pattern = leg === 'inbound' ? `(b)<-${relationship}-(a)` : `(a)-${relationship}->(b)`;
                const rows = await readGraphPages(client, project, `MATCH ${pattern} WHERE ${relation} RETURN id(r) AS edge_id, type(r) AS edge_type, r.line AS edge_line, ${nodeColumns('a', 'a_')}, ${nodeColumns('b', 'b_')}`, 'edge_id', options.signal, counted);
                const evidenceNodes = new Map(batch.map(identity => [identity, nodes.get(identity)!]));
                const evidenceEdges: GraphEdge[] = [];
                for (const row of rows) {
                    // Filter before discovering a frontier, including on older servers
                    // whose typed-pattern implementation may return extra rows.
                    if (allowedTypes && !allowedTypes.has(row.edge_type ?? '')) continue;
                    const source = readNode(row, 'a_', known), target = readNode(row, 'b_', known);
                    const incident = leg === 'inbound' ? batchIds.has(target.id) : batchIds.has(source.id);
                    if (!incident) continue; // Qualified names are not assumed unique.
                    evidenceNodes.set(source.id, source); evidenceNodes.set(target.id, target);
                    const identity = id(row.edge_id);
                    evidenceEdges.push({ id: identity, source: source.id, target: target.id, type: row.edge_type ?? '', line: number(row.edge_line) });
                }
                const verifiedNodes = [...evidenceNodes.values()];
                options.cache?.rememberNeighborhood(batch, leg, edgeTypes, verifiedNodes, evidenceEdges);
                accept(verifiedNodes, evidenceEdges);
                options.onProgress?.({ layer: hop + 1, nodes: nodes.size, edges: edges.size, requests });
                partial = overLimit(hop + 1);
            }
        }
        reachedDepth = hop + 1;
        frontier = [...next];
    }
    // A cluster starts with all of its members and their internal edges.
    if (depth === 0 && roots.size > 1) {
        const initial = [...edges.values()].filter(edge => roots.has(edge.source) && roots.has(edge.target));
        return { data: arrangeScopedGraph([...nodes.values()].filter(node => roots.has(node.id)), initial, roots, levels), roots, depth: 0, exhausted: edgeTypes?.length === 0, frontier: edgeTypes?.length === 0 ? [] : [...roots], levels, traversalKey };
    }
    return { data: arrangeScopedGraph([...nodes.values()], [...edges.values()], roots, levels), roots, depth: reachedDepth,
        exhausted: !partial && (edgeTypes?.length === 0 || (depth > 0 && frontier.length === 0)), frontier, levels, traversalKey, ...(partial ? { partial } : {}) };
}

/** Eine Schaetzung der naechsten Ebene, bevor sie geladen wird (K8): so viele
 * Knoten stehen an ihrem Rand, und so viele neue brachte jeder Knoten der
 * letzten Ebene. Eine Schaetzung und keine Zusage; die Grenze beim Laden
 * selbst haelt die Ebene trotzdem am Render-Limit an. */
export function nextLayerEstimate(scope: ScopedGraph | undefined): { layer: number; frontier: number; perNode: number; estimate: number } | undefined {
    if (!scope?.levels || scope.exhausted || scope.partial) return undefined;
    const at = (level: number) => scope.data.nodes.filter(node => (scope.roots.has(node.id) ? 0 : scope.levels!.get(node.id)) === level).length;
    const frontier = at(scope.depth);
    if (frontier === 0) return undefined;
    const perNode = scope.depth > 0 ? frontier / Math.max(1, at(scope.depth - 1)) : 1;
    return { layer: scope.depth + 1, frontier, perNode, estimate: Math.round(frontier * perNode) };
}

/** Was die Galaxie zeigt, waehrend ein Scope angeordnet wird: das aktuelle
 * Bild, sonst die letzte Anordnung, sonst den ganzen Graphen. Eine Anordnung
 * ohne Knoten ist kein Bild. Liegt das gewaehlte Symbol ausserhalb des
 * geladenen Layouts, ist die erste Vorschau leer, und als Platzhalter stand
 * dann eine leere Flaeche statt des Graphen, der gerade noch zu sehen war. */
export function scenePictureFor(current: GraphData | undefined, stale: GraphData | undefined, layout: GraphData | undefined): GraphData | undefined {
    if (current && current.nodes.length > 0) return current;
    if (stale && stale.nodes.length > 0) return stale;
    return layout;
}

export function limitGraphRender(data: GraphData, nodeLimit: number, edgeLimit: number, required: ReadonlySet<number> = new Set()): GraphData {
    const nodes = [...data.nodes.filter(node => required.has(node.id)), ...data.nodes.filter(node => !required.has(node.id))]
        .slice(0, Math.max(0, Math.floor(nodeLimit)));
    const ids = new Set(nodes.map(node => node.id));
    const edges = data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).slice(0, edgeLimit);
    return { ...data, nodes, edges };
}

/** Hierarchy constants for a Galaxy scope (hand test K5). Labels are NodeLabels sprites at font 12. */
export const SCOPED_HIERARCHY_LEVEL_GAP = 160;
export const SCOPED_HIERARCHY_ROW_GAP = 32;
/** Texture width of a hierarchy name in a scope: about forty characters before an ellipsis. */
export const SCOPED_HIERARCHY_LABEL_MAX_TEXT_WIDTH = 1600;
/** Up to this many nodes every name is drawn, and columns stay single columns; above it they wrap into grids. */
export const SCOPED_HIERARCHY_LABEL_BUDGET = 60;
const SCOPED_HIERARCHY_WRAP_AT = 12;
const LABEL_UNITS_PER_CHAR = 7.1, LABEL_UNITS_PADDING = 12, LABEL_GUTTER = 40;
const LABEL_MAX_CHARS = Math.floor((SCOPED_HIERARCHY_LABEL_MAX_TEXT_WIDTH - 64) / 38);

/** The world width of a name in the scoped hierarchy, as NodeLabels draws it (about 38 texture pixels per character at 64 px). */
export function hierarchyLabelWidth(name: string): number {
    return Math.min(name.length, LABEL_MAX_CHARS) * LABEL_UNITS_PER_CHAR + LABEL_UNITS_PADDING;
}

/*
 * Der Ausschnitt als Hierarchie (Handtest K5).
 *
 * Bis hierher stand alles einer Ebene in EINER Spalte rechts der Wurzel,
 * Eingehendes und Ausgehendes aller Arten gemischt und alphabetisch, und der
 * Hinweis behauptete "one column per call depth". Jetzt:
 *
 *  - Eingehendes links, die Wurzel in der Mitte, Ausgehendes rechts. Ein
 *    Knoten der ersten Ebene steht dort, wohin seine Kante zur Wurzel zeigt;
 *    jeder tiefere Knoten auf der Seite seines Elternknotens, also des
 *    Nachbarn eine Ebene naeher an der Wurzel, ueber den er gefunden wurde.
 *  - In einer Spalte stehen die Knoten nach ihrem Elternknoten, dann CALLS vor
 *    den anderen Arten, CALLS nach Aufrufzeile (`edge.line`), dann nach Name.
 *  - Die Spalten stehen so weit auseinander, wie ihre Namen breit sind: kein
 *    Name wird gekuerzt, solange Platz ist.
 *
 * Die Ebene kommt aus den gefundenen `levels`; nur eine Ringanordnung legt sie
 * in z ab, eine Vorschau aus dem ganzen Layout behaelt globale Koordinaten.
 * Sehr grosse Ebenen (ohne Namen) brechen weiter in kompakte Raster um.
 */
export function scopedHierarchy(scope: ScopedGraph, name: string): import('./hierarchy-layout').HierarchyProjection {
    const levelOf = (node: GraphNode) => scope.roots.has(node.id) ? 0 : scope.levels?.get(node.id) ?? Math.max(0, Math.round(-node.z / 18));
    const level = new Map(scope.data.nodes.map(node => [node.id, levelOf(node)] as const));
    const incident = new Map<number, GraphEdge[]>();
    for (const edge of scope.data.edges) {
        for (const end of [edge.source, edge.target]) { const list = incident.get(end) ?? []; list.push(edge); incident.set(end, list); }
    }
    const typeRank = (edge: GraphEdge | undefined) => edge?.type === 'CALLS' ? 0 : 1;
    const side = new Map<number, -1 | 0 | 1>(), parent = new Map<number, { id: number; edge: GraphEdge }>();
    const ordered = [...scope.data.nodes].sort((a, b) => level.get(a.id)! - level.get(b.id)! || a.id - b.id);
    for (const node of ordered) {
        const hop = level.get(node.id)!;
        if (hop === 0) { side.set(node.id, 0); continue; }
        // The neighbour one layer closer to the root decides the side; a consistently directed edge wins, then CALLS.
        const candidates = (incident.get(node.id) ?? []).flatMap(edge => {
            const other = edge.source === node.id ? edge.target : edge.source;
            const otherSide = side.get(other);
            if (other === node.id || otherSide === undefined || level.get(other) !== hop - 1) return [];
            const towards = otherSide !== 0 ? otherSide : edge.source === other ? 1 : -1;
            const consistent = towards === 1 ? edge.source === other : edge.target === other;
            return [{ other, edge, towards: towards as -1 | 1, consistent }];
        }).sort((a, b) => Number(b.consistent) - Number(a.consistent) || typeRank(a.edge) - typeRank(b.edge)
            || (a.edge.line ?? Number.MAX_SAFE_INTEGER) - (b.edge.line ?? Number.MAX_SAFE_INTEGER) || a.other - b.other);
        const chosen = candidates[0];
        side.set(node.id, chosen?.towards ?? 1);
        if (chosen) parent.set(node.id, { id: chosen.other, edge: chosen.edge });
    }
    const columns = new Map<number, GraphNode[]>();
    for (const node of scope.data.nodes) {
        const column = side.get(node.id)! * level.get(node.id)!;
        const entries = columns.get(column) ?? []; entries.push(node); columns.set(column, entries);
    }
    const labelled = scope.data.nodes.length <= SCOPED_HIERARCHY_LABEL_BUDGET;
    const row = new Map<number, number>();
    const byText = (a: GraphNode, b: GraphNode) => (a.file_path ?? '').localeCompare(b.file_path ?? '') || a.name.localeCompare(b.name) || a.id - b.id;
    const keys = [...columns.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    for (const key of keys) {
        const entries = columns.get(key)!;
        entries.sort((a, b) => {
            const pa = parent.get(a.id), pb = parent.get(b.id);
            return (row.get(pa?.id ?? -1) ?? -1) - (row.get(pb?.id ?? -1) ?? -1) || typeRank(pa?.edge) - typeRank(pb?.edge)
                || (pa?.edge.type ?? '').localeCompare(pb?.edge.type ?? '')
                // Calls in source order; one line with two calls keeps the order of the call list (by identity).
                || (pa?.edge.type === 'CALLS' ? (pa.edge.line ?? Number.MAX_SAFE_INTEGER) - (pb?.edge.line ?? Number.MAX_SAFE_INTEGER) || a.id - b.id : 0)
                || byText(a, b);
        });
        entries.forEach((node, index) => row.set(node.id, index));
    }
    // Column blocks: width from wrapping and from the widest name in them.
    const block = new Map(keys.map(key => {
        const entries = columns.get(key)!;
        const cols = !labelled && entries.length > SCOPED_HIERARCHY_WRAP_AT ? Math.ceil(Math.sqrt(entries.length)) : 1;
        const label = labelled ? Math.max(...entries.map(node => hierarchyLabelWidth(node.name))) : 0;
        const gapX = labelled ? label + LABEL_GUTTER : SCOPED_HIERARCHY_ROW_GAP * 1.25;
        return [key, { entries, cols, rows: Math.ceil(entries.length / cols), gapX, width: (cols - 1) * gapX, label }] as const;
    }));
    const left = new Map<number, number>();
    const centre = block.get(0);
    if (centre) left.set(0, -centre.width / 2);
    for (const direction of [1, -1] as const) {
        let previous = centre ? 0 : undefined;
        for (const key of keys.filter(value => Math.sign(value) === direction).sort((a, b) => Math.abs(a) - Math.abs(b))) {
            const current = block.get(key)!, before = previous === undefined ? undefined : block.get(previous)!;
            const gap = Math.max(SCOPED_HIERARCHY_LEVEL_GAP, before ? (before.label + current.label) / 2 + LABEL_GUTTER : 0);
            if (direction === 1) {
                const edge = before ? left.get(previous!)! + before.width : 0;
                left.set(key, edge + gap);
            } else {
                const edge = before ? left.get(previous!)! : 0;
                left.set(key, edge - gap - current.width);
            }
            previous = key;
        }
    }
    const nodes: GraphNode[] = [], remap = new Map<number, number>(), sourceIds: number[] = [];
    const placements: import('./hierarchy-layout').HierarchyPlacement[] = [];
    for (const key of keys) {
        const { entries, cols, rows, gapX } = block.get(key)!;
        // Outgoing blocks grow away from the root to the right, incoming ones to the left.
        const start = left.get(key)!, width = (cols - 1) * gapX;
        entries.forEach((node, index) => {
            const column = index % cols;
            const x = key < 0 ? start + width - column * gapX : start + column * gapX;
            const y = ((rows - 1) / 2 - Math.floor(index / cols)) * SCOPED_HIERARCHY_ROW_GAP;
            const id = nodes.length;
            remap.set(node.id, id); sourceIds.push(node.id); nodes.push({ ...node, id, x, y, z: 0 });
            placements.push({ id, key: node.qualified_name ?? `node:${node.id}`, name: node.name, hop: level.get(node.id)!, side: side.get(node.id)!, x, y });
        });
    }
    return { data: { nodes, edges: scope.data.edges.map(edge => ({ ...edge, source: remap.get(edge.source)!, target: remap.get(edge.target)! })), total_nodes: nodes.length },
        rootId: scope.roots.size === 1 ? remap.get([...scope.roots][0]!) ?? -1 : -1, rootKey: name, rootName: name,
        symbols: nodes.length, depth: new Set(level.values()).size, truncated: false, cap: nodes.length, walkDepth: scope.depth,
        missing: 0, placements, sourceIds };
}
