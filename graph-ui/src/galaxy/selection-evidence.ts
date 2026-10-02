import { useEffect } from 'react';
import type { BrowserChatContext } from '../browser-ai/chat-model';
import { fairShares } from '../browser-ai/galaxy-evidence';
import type { GraphScope } from './graph-scope';
import type { GraphEdge, GraphNode } from './types';

export type SelectionEvidenceListener = (context: BrowserChatContext | undefined) => void;
export interface SelectionEvidence {
    project: string;
    view: string;
    label: string;
    source: string;
    generation?: string;
    selected: unknown;
    relationships?: unknown;
    scope?: unknown;
    limitations: unknown;
}

/** Source identity only. Camera coordinates and visual weights are not code facts. */
export function graphNodeEvidence(node: GraphNode) {
    return { id: node.id, name: node.name, kind: node.label, qualifiedName: node.qualified_name,
        filePath: node.file_path, startLine: node.start_line, endLine: node.end_line,
        status: node.status, incomingCalls: node.in_calls, outgoingCalls: node.out_calls,
        documentation: node.documentation, packageName: node.package_name };
}

/** Related symbols of one edge type and direction, grouped by file. `count` is
 * complete; `files` lists at most `RELATED_NAMES_PER_GROUP` symbols. */
export interface RelationshipGroup { type: string; count: number; files: { path: string; symbols: { name: string; kind?: string }[] }[] }
export interface ScopeRelationships {
    incomingSymbols: number;
    outgoingSymbols: number;
    /** Edge counts between selected roots and between symbols further out. */
    internal: { type: string; count: number }[];
    beyond: { type: string; count: number }[];
    /** Edges into a selected root from outside the selection. */
    incoming: RelationshipGroup[];
    /** Edges from a selected root to outside the selection. */
    outgoing: RelationshipGroup[];
}
export const RELATED_NAMES_PER_GROUP = 24;
/** Characters of names and paths across every group of both sides. With the bounded
 * roots this keeps a scope inside the snapshot budget, so no count or type is cut. */
export const RELATED_NAME_CHARACTERS = 6000;
/** Readers of the evidence use no more of a root's documentation than this. */
export const ROOT_DOCUMENTATION_CHARACTERS = 300;
const ROOTS_LISTED = 8;

type RelatedSymbol = { name: string; kind?: string; path: string };
/** Roughly what a listed symbol, and the first symbol of each file, add to the snapshot. */
function namesCost(symbols: readonly RelatedSymbol[]): number {
    return symbols.reduce((sum, symbol, index) => sum + symbol.name.length + (symbol.kind?.length ?? 0) + 24
        + (index === 0 || symbols[index - 1].path !== symbol.path ? symbol.path.length + 24 : 0), 0);
}

/** Classify every scope edge by its direction relative to the roots before any
 * bound applies, so counts stay complete and callers never mix with callees.
 * Counts come first; names share an explicit budget fairly between the groups. */
export function scopeRelationships(nodes: readonly GraphNode[], edges: readonly GraphEdge[], roots: ReadonlySet<number>,
    nameCharacters = RELATED_NAME_CHARACTERS): ScopeRelationships {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const related = { incoming: new Map<string, Set<number>>(), outgoing: new Map<string, Set<number>>() };
    const counted = { internal: new Map<string, number>(), beyond: new Map<string, number>() };
    for (const edge of edges) {
        const from = roots.has(edge.source), to = roots.has(edge.target);
        if (from !== to) {
            const side = to ? related.incoming : related.outgoing;
            const members = side.get(edge.type) ?? new Set<number>();
            members.add(to ? edge.source : edge.target); side.set(edge.type, members);
        } else {
            const side = from ? counted.internal : counted.beyond;
            side.set(edge.type, (side.get(edge.type) ?? 0) + 1);
        }
    }
    const ranked = (members: ReadonlySet<number>): RelatedSymbol[] => {
        const symbols = [...members].map(id => {
            const node = byId.get(id);
            return { name: node?.name ?? `#${id}`, kind: node?.label || undefined, path: node?.file_path ?? '' };
        });
        const perFile = new Map<string, number>();
        symbols.forEach(symbol => perFile.set(symbol.path, (perFile.get(symbol.path) ?? 0) + 1));
        // Files with the most related symbols first, so a bounded list keeps the densest evidence.
        return symbols.sort((left, right) => perFile.get(right.path)! - perFile.get(left.path)!
            || left.path.localeCompare(right.path) || left.name.localeCompare(right.name)).slice(0, RELATED_NAMES_PER_GROUP);
    };
    const ordered = (side: Map<string, Set<number>>) => [...side].sort(([leftType, left], [rightType, right]) =>
        right.size - left.size || leftType.localeCompare(rightType));
    const sides = [ordered(related.incoming), ordered(related.outgoing)];
    const candidates = sides.flat().map(([, members]) => ranked(members));
    const shares = fairShares(candidates.map(namesCost), nameCharacters);
    let next = 0;
    const [incoming, outgoing] = sides.map(side => side.map(([type, members]): RelationshipGroup => {
        const index = next++;
        let symbols = candidates[index];
        while (symbols.length && namesCost(symbols) > shares[index]) symbols = symbols.slice(0, -1);
        const files = new Map<string, { name: string; kind?: string }[]>();
        for (const { path, ...symbol } of symbols) files.set(path, [...files.get(path) ?? [], symbol]);
        return { type, count: members.size, files: [...files].map(([path, listed]) => ({ path, symbols: listed })) };
    }));
    const distinct = (side: Map<string, Set<number>>) => new Set([...side.values()].flatMap(members => [...members])).size;
    const totals = (side: Map<string, number>) => [...side].map(([type, count]) => ({ type, count }))
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
    return { incomingSymbols: distinct(related.incoming), outgoingSymbols: distinct(related.outgoing),
        internal: totals(counted.internal), beyond: totals(counted.beyond), incoming, outgoing };
}

/** A traced Galaxy scope as the local agent reads it. */
export interface GalaxyScope {
    project: string;
    identity: GraphScope;
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
    roots: ReadonlySet<number>;
    depth: number;
    direction: string;
    edgeTypes: readonly string[] | 'all';
    state: 'complete-indexed-scope' | 'loading-partial-preview' | 'partial';
    error?: string;
    exhausted?: boolean;
}

/** Every scope edge is classified against the roots first; only the names are
 * bounded afterwards. Render budgets are a drawing concern and stay out of it. */
export function galaxyScopeEvidence(scope: GalaxyScope): SelectionEvidence {
    const roots = scope.nodes.filter(node => scope.roots.has(node.id));
    return { project: scope.project, view: 'galaxy', source: 'query_graph scoped indexed relationships', label: scope.identity.name,
        selected: { scope: scope.identity, rootCount: roots.length, roots: roots.slice(0, ROOTS_LISTED).map(root => ({ ...graphNodeEvidence(root),
            documentation: root.documentation?.slice(0, ROOT_DOCUMENTATION_CHARACTERS) })), omittedRoots: Math.max(0, roots.length - ROOTS_LISTED) },
        scope: { depth: scope.depth, direction: scope.direction, edgeTypes: scope.edgeTypes, nodes: scope.nodes.length, edges: scope.edges.length },
        relationships: scopeRelationships(scope.nodes, scope.edges, scope.roots),
        limitations: { state: scope.state, error: scope.error, exhausted: scope.exhausted, indexCoverage: 'unavailable',
            interpretation: 'Static indexed relationships, not runtime activity. Scope completeness is relative to the indexed graph and selected depth/types.' } };
}

/** Bound every collection/string and the total snapshot; report each omission.
 * Stable content identity prevents camera changes from triggering explanations. */
export function selectionEvidenceContext(evidence: SelectionEvidence): BrowserChatContext {
    const omissions: { path: string; kind: string; count: number }[] = [];
    let budget = 16_000;
    const copy = (value: unknown, path: string, depth: number): unknown => {
        if (value === undefined) return undefined;
        if (budget <= 0 || depth > 10) {
            omissions.push({ path, kind: 'value', count: 1 }); return null;
        }
        if (typeof value === 'string') {
            const limit = Math.max(0, Math.min(1200, budget));
            budget -= Math.min(value.length, limit);
            if (value.length > limit) omissions.push({ path, kind: 'characters', count: value.length - limit });
            return value.slice(0, limit);
        }
        if (value === null || typeof value !== 'object') { budget -= 16; return value; }
        if (Array.isArray(value)) {
            const result: unknown[] = [];
            for (let i = 0; i < Math.min(value.length, 24) && budget > 0; i++) result.push(copy(value[i], `${path}[${i}]`, depth + 1));
            if (result.length < value.length) omissions.push({ path, kind: 'items', count: value.length - result.length });
            return result;
        }
        const entries = Object.entries(value), result: Record<string, unknown> = {};
        let processed = 0;
        for (const [key, item] of entries) {
            if (processed >= 48 || budget <= 0) break;
            budget -= key.length + 6; processed++;
            result[key] = copy(item, `${path}.${key}`, depth + 1);
        }
        if (processed < entries.length) omissions.push({ path, kind: 'fields', count: entries.length - processed });
        return result;
    };
    // Keep provenance and limits ahead of potentially large member collections.
    const snapshot = copy({ kind: 'current-selection-evidence', project: evidence.project, view: evidence.view,
        source: evidence.source, generation: evidence.generation ?? 'unavailable',
        limitations: evidence.limitations, scope: evidence.scope, selected: evidence.selected,
        relationships: evidence.relationships }, '$', 0);
    const text = JSON.stringify({ evidence: snapshot, omissions });
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return { id: `selection:${evidence.project}:${evidence.view}:${(hash >>> 0).toString(16)}:${text.length}`,
        label: evidence.label.slice(0, 120), text };
}

/** Hidden workspaces must never overwrite evidence from the active workspace. */
export function useSelectionEvidence(listener: SelectionEvidenceListener | undefined, evidence: SelectionEvidence | undefined, active: boolean) {
    const context = evidence ? selectionEvidenceContext(evidence) : undefined;
    const text = context?.text, label = context?.label, id = context?.id;
    useEffect(() => {
        if (active) listener?.(text && id && label ? { id, label, text } : undefined);
    }, [listener, active, text, label, id]);
}
