import type { RelationshipGroup, ScopeRelationships } from '../galaxy/selection-evidence';
import type { RelationshipWords } from './strings';

/** The Galaxy selection snapshot as readable data. Every field was bounded by its
 * producer and is validated again here; names and paths stay untrusted text. */
export interface GalaxyEvidence {
    project: string;
    label: string;
    /** The selected scope itself (node id, qualified name or path): stable while it loads. */
    identity: unknown;
    selectionKind: string;
    roots: { name: string; kind?: string; qualifiedName?: string; filePath?: string; startLine?: number; endLine?: number; documentation?: string }[];
    rootCount: number;
    depth: number;
    direction: 'both' | 'inbound' | 'outbound';
    edgeTypes: 'all' | string[];
    nodes: number;
    edges: number;
    /** `limited`: loaded, but a layer stopped at the render limit (C1). */
    state: 'complete' | 'loading' | 'partial' | 'limited';
    /** Where a `limited` scope stopped. */
    renderLimit?: { layer: number; kind: 'nodes' | 'edges'; limit: number };
    error?: string;
    exhausted: boolean;
    /** Distinct related symbols per side; undefined when the snapshot lost the total. */
    relationships: Omit<ScopeRelationships, 'incomingSymbols' | 'outgoingSymbols'> & { incomingSymbols?: number; outgoingSymbols?: number };
    /** The snapshot budget cut relationship data, so counts and names can be incomplete. */
    truncated: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record).filter(item => item !== undefined) : [];
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const line = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
function text(value: unknown, limit: number): string | undefined {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function groups(value: unknown): RelationshipGroup[] {
    return records(value).flatMap(group => {
        const type = text(group.type, 60);
        if (!type) return [];
        const files = records(group.files).map(file => ({ path: text(file.path, 240) ?? '', symbols: records(file.symbols)
            .flatMap(symbol => { const name = text(symbol.name, 120); return name ? [{ name, kind: text(symbol.kind, 40) }] : []; }) }))
            .filter(file => file.symbols.length);
        const listed = files.reduce((sum, file) => sum + file.symbols.length, 0);
        return [{ type, count: Math.max(count(group.count), listed), files }];
    });
}
const totals = (value: unknown) => records(value).flatMap(item => { const type = text(item.type, 60); return type ? [{ type, count: count(item.count) }] : []; });

export function readGalaxyEvidence(snapshot: string): GalaxyEvidence | undefined {
    if (snapshot.length > 128_000) return undefined;
    let parsed: Record<string, unknown> | undefined;
    try { parsed = record(JSON.parse(snapshot)); } catch { return undefined; }
    const evidence = record(parsed?.evidence);
    const selected = record(evidence?.selected), scope = record(evidence?.scope), limits = record(evidence?.limitations);
    const identity = record(selected?.scope);
    // A traced Galaxy scope, recognised by its identity and depth even when its relationships were cut.
    if (evidence?.kind !== 'current-selection-evidence' || evidence.view !== 'galaxy' || typeof identity?.kind !== 'string'
        || typeof scope?.depth !== 'number') return undefined;
    const relationships = record(evidence.relationships);
    const truncated = !relationships || !Array.isArray(relationships.incoming) || !Array.isArray(relationships.outgoing)
        || records(parsed?.omissions).some(item => typeof item.path === 'string' && item.path.startsWith('$.relationships'));
    const total = (value: unknown) => typeof value === 'number' ? count(value) : undefined;
    const direction = scope.direction === 'inbound' || scope.direction === 'outbound' ? scope.direction : 'both';
    const edgeTypes = Array.isArray(scope.edgeTypes) ? scope.edgeTypes.flatMap(type => text(type, 60) ?? []) : 'all';
    const stopped = record(limits?.renderLimit);
    const renderLimit = stopped && line(stopped.layer) && line(stopped.limit) && (stopped.kind === 'nodes' || stopped.kind === 'edges')
        ? { layer: stopped.layer as number, kind: stopped.kind as 'nodes' | 'edges', limit: stopped.limit as number } : undefined;
    const state = limits?.state === 'complete-indexed-scope' ? 'complete' : limits?.state === 'loading-partial-preview' ? 'loading'
        : limits?.state === 'render-limit-partial' && renderLimit ? 'limited' : 'partial';
    const roots = records(selected?.roots).flatMap(root => {
        const name = text(root.name, 120);
        return name ? [{ name, kind: text(root.kind, 40), qualifiedName: text(root.qualifiedName, 400), filePath: text(root.filePath, 240), startLine: line(root.startLine),
            endLine: line(root.endLine), documentation: text(root.documentation, 300) }] : [];
    });
    return {
        project: text(evidence.project, 120) ?? '', label: text(identity.name, 120) ?? roots[0]?.name ?? 'selection',
        identity, selectionKind: text(identity.kind, 20) ?? 'node',
        roots, rootCount: Math.max(count(selected?.rootCount), roots.length),
        depth: count(scope.depth), direction, edgeTypes, nodes: count(scope.nodes), edges: count(scope.edges),
        state, ...state === 'limited' ? { renderLimit } : {}, error: text(limits?.error, 200), exhausted: limits?.exhausted === true,
        relationships: { incoming: groups(relationships?.incoming), incomingSymbols: total(relationships?.incomingSymbols),
            outgoing: groups(relationships?.outgoing), outgoingSymbols: total(relationships?.outgoingSymbols),
            internal: totals(relationships?.internal), beyond: totals(relationships?.beyond) },
        truncated,
    };
}

/** Water-filling: parts that fit their fair share stay whole; larger parts split the rest. */
export function fairShares(natural: readonly number[], budget: number): number[] {
    const shares = natural.map(() => 0);
    let pool = Math.max(0, Math.floor(budget));
    const order = natural.map((_, index) => index).sort((left, right) => natural[left] - natural[right]);
    order.forEach((index, position) => {
        shares[index] = Math.min(natural[index], Math.floor(pool / (order.length - position)));
        pool -= shares[index];
    });
    return shares;
}

/** One edge type: complete count, then names until the budget, then an explicit "+N more". */
export function relationshipLine(group: RelationshipGroup, side: 'incoming' | 'outgoing', budget: number,
    words: RelationshipWords, markdown = false): { text: string; listed: number } {
    const quote = (value: string) => markdown ? `\`${value.replace(/`/g, "'")}\`` : value;
    const head = `- ${markdown ? `**${group.type}**` : group.type} ${side === 'incoming' ? words.from : words.to} ${group.count}: `;
    let body = '', listed = 0;
    const more = (shown: number) => group.count > shown ? `${body ? '; ' : ''}${words.more(group.count - shown)}` : '';
    if (head.length + more(0).length > budget) return { text: '', listed: 0 };
    for (const file of group.files) {
        const kinds = new Set(file.symbols.map(symbol => symbol.kind));
        const where = [kinds.size === 1 ? file.symbols[0].kind : undefined, file.path ? quote(file.path) : undefined].filter(Boolean).join(', ');
        const suffix = where ? ` (${where})` : '';
        let chunk = '';
        for (const symbol of file.symbols) {
            const next = `${chunk ? `${chunk}, ` : body ? '; ' : ''}${quote(symbol.name)}`;
            const shown = listed + 1;
            const after = group.count > shown ? `; ${words.more(group.count - shown)}` : '';
            if (head.length + body.length + next.length + suffix.length + after.length > budget) {
                if (chunk) body += chunk + suffix;
                return { text: head + body + more(listed), listed };
            }
            chunk = next; listed = shown;
        }
        if (chunk) body += chunk + suffix;
    }
    return { text: head + body + more(listed), listed };
}

/** "1 hop in both directions, all relationship types; complete." in words, never as fields. */
export function scopeSentence(evidence: GalaxyEvidence, words: RelationshipWords): string {
    const direction = evidence.direction === 'inbound' ? words.inbound : evidence.direction === 'outbound' ? words.outbound : words.both;
    const types = evidence.edgeTypes === 'all' ? words.allTypes : words.onlyTypes(evidence.edgeTypes);
    const state = evidence.state === 'complete' ? words.complete : evidence.state === 'loading' ? words.loading
        : evidence.state === 'limited' && evidence.renderLimit ? words.renderLimited(evidence.renderLimit.layer, evidence.renderLimit.limit, evidence.renderLimit.kind)
            : words.partial(evidence.error);
    const notes = [state, ...evidence.state === 'complete' && evidence.exhausted ? [words.exhausted] : [], ...evidence.truncated ? [words.truncated] : []];
    return words.scope(`${words.hops(evidence.depth)} ${direction}, ${types}`, words.size(evidence.nodes, evidence.edges), notes.join('; '));
}

/** Whether the loaded scope followed this side at all; otherwise "none" would be a guess. */
export function sideLoaded(evidence: GalaxyEvidence, side: 'incoming' | 'outgoing'): boolean {
    return evidence.depth > 0 && evidence.direction !== (side === 'incoming' ? 'outbound' : 'inbound');
}

export function selectionSentence(evidence: GalaxyEvidence): string[] {
    const [first] = evidence.roots;
    const range = (root: GalaxyEvidence['roots'][number]) => root.filePath
        ? ` in ${root.filePath}${root.startLine ? `:${root.startLine}${root.endLine && root.endLine !== root.startLine ? `-${root.endLine}` : ''}` : ''}` : '';
    if (evidence.rootCount <= 1 && first) {
        return [`Selected: ${first.name}${first.kind ? ` (${first.kind})` : ''}${range(first)}.`,
            ...first.documentation ? [`Documentation: ${first.documentation}`] : []];
    }
    if (!first) return [`Selected: ${evidence.label} (${evidence.selectionKind}); its symbols are not in the loaded scope yet.`];
    const listed = evidence.roots.map(root => `${root.name}${root.kind ? ` (${root.kind})` : ''}`).join(', ');
    const omitted = evidence.rootCount - evidence.roots.length;
    return [`Selected ${evidence.selectionKind}: ${evidence.label} with ${evidence.rootCount} symbols: ${listed}${omitted > 0 ? `; +${omitted} more` : ''}.`];
}
