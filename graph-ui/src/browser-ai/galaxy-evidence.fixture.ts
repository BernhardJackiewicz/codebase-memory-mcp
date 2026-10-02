import { galaxyScopeEvidence, selectionEvidenceContext, type GalaxyScope, type SelectionEvidence } from '../galaxy/selection-evidence';
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
export function jsonbAggEvidence(overrides: { depth?: number; direction?: string; state?: GalaxyScope['state']; edges?: GraphEdge[]; nodes?: GraphNode[] } = {}): BrowserChatContext {
    const scope = jsonbAggScope();
    const [root] = scope.nodes;
    return selectionEvidenceContext(galaxyScopeEvidence({ project: 'django-demo', identity: { kind: 'symbol', qualifiedName: root.qualified_name!, name: 'JSONBAgg' },
        nodes: [...scope.nodes, ...overrides.nodes ?? []], edges: overrides.edges ?? scope.edges, roots: scope.roots,
        depth: overrides.depth ?? 1, direction: overrides.direction ?? 'both', edgeTypes: 'all',
        state: overrides.state ?? 'complete-indexed-scope', exhausted: false }));
}

/** A folder of 40 documented symbols with five incoming and five outgoing edge types of 30 symbols each. */
export function largeFolderScope(): SelectionEvidence {
    const node = (id: number, name: string, file: string, documentation?: string): GraphNode => ({ id, name, label: 'Function', qualified_name: `pkg.${file}.${name}`,
        file_path: `django/contrib/postgres/aggregates/${file}.py`, start_line: 10, end_line: 20, documentation, x: 0, y: 0, z: 0, size: 1, color: '#999' });
    const roots = Array.from({ length: 40 }, (_, index) => node(index + 1, `postgres_member_${index}`, 'members', 'd'.repeat(1500)));
    const types = ['CALLS', 'TESTS', 'USAGE', 'IMPORTS', 'DEFINES_METHOD'];
    const nodes: GraphNode[] = [...roots], edges: GraphEdge[] = [];
    types.forEach((type, typeIndex) => (['incoming', 'outgoing'] as const).forEach(side => {
        for (let index = 0; index < 30; index++) {
            const id = 1000 + typeIndex * 100 + (side === 'incoming' ? 0 : 50) + index;
            nodes.push(node(id, `${side}_${type.toLowerCase()}_relationship_${index}`, `${side}_module_${Math.floor(index / 3)}`));
            edges.push(side === 'incoming' ? { source: id, target: 1 + index, type } : { source: 1 + index, target: id, type });
        }
    }));
    return galaxyScopeEvidence({ project: 'django-demo', identity: { kind: 'folder', path: 'django/contrib/postgres', name: 'postgres' }, nodes, edges,
        roots: new Set(roots.map(root => root.id)), depth: 1, direction: 'both', edgeTypes: 'all', state: 'complete-indexed-scope', exhausted: false });
}
