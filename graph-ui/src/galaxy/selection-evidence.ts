import { useEffect } from 'react';
import type { BrowserChatContext } from '../browser-ai/chat-model';
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
    /** Edges into a selected root from outside the selection. */
    incoming: RelationshipGroup[];
    incomingSymbols: number;
    /** Edges from a selected root to outside the selection. */
    outgoing: RelationshipGroup[];
    outgoingSymbols: number;
    /** Edge counts between selected roots and between symbols further out. */
    internal: { type: string; count: number }[];
    beyond: { type: string; count: number }[];
}
export const RELATED_NAMES_PER_GROUP = 24;

/** Classify every scope edge by its direction relative to the roots before any
 * bound applies, so counts stay complete and callers never mix with callees. */
export function scopeRelationships(nodes: readonly GraphNode[], edges: readonly GraphEdge[], roots: ReadonlySet<number>): ScopeRelationships {
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
    const groups = (side: Map<string, Set<number>>): RelationshipGroup[] => [...side].map(([type, members]) => {
        const symbols = [...members].map(id => {
            const node = byId.get(id);
            return { name: node?.name ?? `#${id}`, kind: node?.label || undefined, path: node?.file_path ?? '' };
        });
        const perFile = new Map<string, number>();
        symbols.forEach(symbol => perFile.set(symbol.path, (perFile.get(symbol.path) ?? 0) + 1));
        // Files with the most related symbols first, so a bounded list keeps the densest evidence.
        symbols.sort((left, right) => perFile.get(right.path)! - perFile.get(left.path)!
            || left.path.localeCompare(right.path) || left.name.localeCompare(right.name));
        const files = new Map<string, { name: string; kind?: string }[]>();
        for (const { path, ...symbol } of symbols.slice(0, RELATED_NAMES_PER_GROUP)) files.set(path, [...files.get(path) ?? [], symbol]);
        return { type, count: members.size, files: [...files].map(([path, listed]) => ({ path, symbols: listed })) };
    }).sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
    const distinct = (side: Map<string, Set<number>>) => new Set([...side.values()].flatMap(members => [...members])).size;
    const totals = (side: Map<string, number>) => [...side].map(([type, count]) => ({ type, count }))
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
    return { incoming: groups(related.incoming), incomingSymbols: distinct(related.incoming),
        outgoing: groups(related.outgoing), outgoingSymbols: distinct(related.outgoing),
        internal: totals(counted.internal), beyond: totals(counted.beyond) };
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
