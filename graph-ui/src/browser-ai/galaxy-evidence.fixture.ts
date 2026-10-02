import { graphNodeEvidence, scopeRelationships, selectionEvidenceContext } from '../galaxy/selection-evidence';
import type { GraphEdge, GraphNode } from '../galaxy/types';
import type { BrowserChatContext } from './chat-model';

/** JSONBAgg in django-demo at one layer, as the call reproduction measured it:
 * 11 tests with CALLS and TESTS, DEFINES from general.py, two outgoing INHERITS. */
export const JSONB_AGG_CALLERS = ['test_default_argument', 'test_empty_result_set', 'test_jsonb_agg', 'test_jsonb_agg_booleanfield_order_by',
    'test_jsonb_agg_charfield_order_by', 'test_jsonb_agg_distinct_false', 'test_jsonb_agg_distinct_true', 'test_jsonb_agg_integerfield_order_by',
    'test_jsonb_agg_jsonfield_order_by', 'test_jsonb_agg_key_index_transforms', 'test_values_list'];

const node = (id: number, name: string, label: string, file_path: string, start_line?: number, end_line?: number): GraphNode =>
    ({ id, name, label, file_path, start_line, end_line, qualified_name: `django-demo.${name}`, x: 0, y: 0, z: 0, size: 1, color: '#999' });

export function jsonbAggScope(): { nodes: GraphNode[]; edges: GraphEdge[]; roots: Set<number> } {
    const root = node(32360, 'JSONBAgg', 'Class', 'django/contrib/postgres/aggregates/general.py', 50, 54);
    const tests = JSONB_AGG_CALLERS.map((name, index) => node(100 + index, name, 'Method', 'tests/postgres_tests/test_aggregates.py', 200 + index * 10));
    const module = node(9, 'general.py', 'File', 'django/contrib/postgres/aggregates/general.py');
    const parents = [node(7, 'OrderableAggMixin', 'Class', 'django/contrib/postgres/aggregates/mixins.py'), node(8, 'Aggregate', 'Class', 'django/db/models/aggregates.py')];
    const edges: GraphEdge[] = [
        ...tests.flatMap(test => [{ source: test.id, target: root.id, type: 'CALLS' }, { source: test.id, target: root.id, type: 'TESTS' }]),
        { source: module.id, target: root.id, type: 'DEFINES' },
        ...parents.map(parent => ({ source: root.id, target: parent.id, type: 'INHERITS' })),
    ];
    return { nodes: [root, ...tests, module, ...parents], edges, roots: new Set([root.id]) };
}

/** The context GalaxyPanel publishes for that scope, with optional scope overrides. */
export function jsonbAggEvidence(overrides: { depth?: number; direction?: string; state?: string; edges?: GraphEdge[] } = {}): BrowserChatContext {
    const scope = jsonbAggScope();
    const edges = overrides.edges ?? scope.edges;
    const [root] = scope.nodes;
    return selectionEvidenceContext({ project: 'django-demo', view: 'galaxy', source: 'query_graph scoped indexed relationships', label: 'JSONBAgg',
        selected: { scope: { kind: 'symbol', qualifiedName: root.qualified_name, name: 'JSONBAgg' }, rootCount: 1, roots: [graphNodeEvidence(root)], omittedRoots: 0 },
        scope: { depth: overrides.depth ?? 1, direction: overrides.direction ?? 'both', edgeTypes: 'all', nodes: scope.nodes.length, edges: edges.length },
        relationships: scopeRelationships(scope.nodes, edges, scope.roots),
        limitations: { state: overrides.state ?? 'complete-indexed-scope', exhausted: false, indexCoverage: 'unavailable',
            interpretation: 'Static indexed relationships, not runtime activity.' } });
}
