import type { SystemGraphProjection, SystemGraphResponse } from './system-graph-source';

/** Small indexed cross-layer graph shared by the boundary and interaction tests. */
export function systemGraphFixture(): SystemGraphProjection {
    const ref = (node_id: number) => ({ project: 'sample', generation: 'g1', node_id });
    const entities = [
        { id: 'ui', kind: 'code', name: 'renderUsers', file_path: 'src/users.tsx', start_line: 12 },
        { id: 'api', kind: 'api', name: '/users', file_path: 'src/api.ts', start_line: 24 },
        { id: 'store', kind: 'database', name: 'users', file_path: 'schema.sql', start_line: 3 },
        { id: 'deploy', kind: 'deployment', name: 'users deployment', file_path: 'deploy.yaml', start_line: 8 },
        { id: 'doc', kind: 'document', name: 'User data', file_path: 'docs/users.md', start_line: 1 },
    ].map((entity, index) => ({ ...entity, label: entity.name, qualified_name: `sample.${entity.name}`, properties: {}, ref: ref(index + 1) }));
    const relations = [
        { id: 'http', source: 'ui', target: 'api', type: 'CALLS_HTTP', layer: 'code' },
        { id: 'write', source: 'api', target: 'store', type: 'WRITES', layer: 'data' },
        { id: 'runs', source: 'deploy', target: 'api', type: 'DEPLOYS', layer: 'deployment' },
        { id: 'mentions', source: 'doc', target: 'api', type: 'MENTIONS', layer: 'documentation' },
    ].map((relation, index) => ({ ...relation, evidence: 'indexed' as const, witnesses: [{
        ref: { project: 'sample', generation: 'g1', edge_id: 101 + index },
        source: entities.find(entity => entity.id === relation.source)!.ref,
        target: entities.find(entity => entity.id === relation.target)!.ref,
        location: { file_path: 'src/callsite.ts', line: 45 + index }, properties: {},
    }] }));
    return { schema_version: 1, project: 'sample', generation: 'g1', status: 'ready', complete: true,
        entities, relations, totals: { nodes: 5, edges: 4, entities: 5, relations: 4 },
        limits: { max_entities: 1000, max_relations: 3000, omitted_entities: 0, omitted_relations: 0 },
        capabilities: { static_system_graph: true, field_value_flow: false, live_capture: false }, gaps: [],
        groups: entities.map(entity => ({ kind: entity.kind, count: 1 })) };
}
export const systemGraphResponse = (result = systemGraphFixture()): SystemGraphResponse =>
    ({ status: 'ready', generation: result.generation, result });
