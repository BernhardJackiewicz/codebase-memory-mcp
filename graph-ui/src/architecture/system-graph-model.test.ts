import { describe, expect, it } from 'vitest';
import { buildSystemGraphScene, indexedCurveOffset, SYSTEM_GRAPH_LAYERS } from './system-graph-model';
import { systemGraphFixture } from './system-graph-fixture';

describe('system graph scene projection', () => {
    it('keeps native entity and relationship identities and locations in the shared scene', () => {
        const graph = systemGraphFixture();
        const model = buildSystemGraphScene(graph, {});
        expect(model.nodes.map(node => node.id).sort()).toEqual(graph.entities.map(entity => entity.id).sort());
        expect(model.edges.map(edge => edge.id).sort()).toEqual(graph.relations.map(relation => relation.id).sort());
        expect(model.edges.find(edge => edge.id === 'write')?.relationIds).toEqual(['write']);
        expect(model.scopeKey).toContain('g1');
    });
    it('filters actual relationship layers without manufacturing a data path', () => {
        const model = buildSystemGraphScene(systemGraphFixture(), { layers: ['data'] });
        expect(model.edges.map(edge => edge.id)).toEqual(['write']);
        expect(model.nodes.map(node => node.id).sort()).toEqual(['api', 'store']);
        expect(SYSTEM_GRAPH_LAYERS.map(layer => layer.id)).toEqual(['communication', 'data', 'deployment', 'documentation', 'dependency', 'other']);
    });
    it('groups only for presentation, retaining every witness when drilling to original entities', () => {
        const graph = systemGraphFixture();
        graph.entities[1].kind = 'code';
        const grouped = buildSystemGraphScene(graph, {});
        const group = grouped.nodes.find(node => node.aggregateKind === 'code')!;
        expect(group.entityIds.sort()).toEqual(['api', 'ui']);
        expect(group.ref).toBeUndefined();
        const drilled = buildSystemGraphScene(graph, { focusKind: 'code' });
        expect(drilled.nodes.filter(node => node.entityIds.some(id => ['api', 'ui'].includes(id))).map(node => node.id).sort()).toEqual(['api', 'ui']);
        expect(drilled.edges.find(edge => edge.id === 'http')?.relationIds).toEqual(['http']);
        expect(grouped.edges.flatMap(edge => edge.relationIds).sort()).toEqual(graph.relations.map(edge => edge.id).sort());
    });
    it('reports a drawing limit without throwing away the underlying entity catalog', () => {
        const graph = systemGraphFixture();
        graph.entities = Array.from({ length: 40 }, (_, index) => ({ ...graph.entities[0], id: `code-${index}`,
            name: `function${index}`, ref: { ...graph.entities[0].ref, node_id: index + 1 } }));
        graph.relations = [];
        const model = buildSystemGraphScene(graph, { focusKind: 'code', maxNodes: 12 });
        expect(model.nodes).toHaveLength(12);
        expect(model.omittedNodes).toBe(28);
        expect(graph.entities).toHaveLength(40);
        expect(model.lanes[0].height).toBeLessThan(250);
    });
    it('places documentation, communication/data and deployment in distinct rows instead of a chain', () => {
        const graph = systemGraphFixture(), model = buildSystemGraphScene(graph, {});
        const node = (id: string) => model.nodes.find(item => item.id === id)!;
        expect(node('doc').position[1]).toBeGreaterThan(node('api').position[1]);
        expect(node('api').position[1]).toBeGreaterThan(node('deploy').position[1]);
        expect(new Set(model.nodes.map(item => item.position[1])).size).toBeGreaterThanOrEqual(3);
        const reordered = buildSystemGraphScene({ ...graph, entities: [...graph.entities].reverse(), relations: [...graph.relations].reverse() }, {});
        expect(Object.fromEntries(model.nodes.map(item => [item.id, item.position])))
            .toEqual(Object.fromEntries(reordered.nodes.map(item => [item.id, item.position])));
    });
    it('reserves label room and retains explicit indexed direction for types outside the old legend', () => {
        const graph = systemGraphFixture(); graph.entities[0].kind = 'data_structure'; graph.entities[1].kind = 'data_structure';
        const model = buildSystemGraphScene(graph, {});
        expect(model.nodes.find(item => item.aggregateKind === 'data_structure')?.labelSize?.[0]).toBeGreaterThanOrEqual(130);
        expect(model.edges.find(edge => edge.relationIds.includes('runs'))?.directed).toBe(true);
    });
    it('routes a direct relationship around intervening nodes without inventing intermediate hops', () => {
        const model = buildSystemGraphScene(systemGraphFixture(), {});
        const [source, target, unrelated] = model.nodes;
        source.position = [0, 0, 0]; target.position = [200, 0, 0]; unrelated.position = [100, 0, 0];
        expect(indexedCurveOffset(source, target, [source, target, unrelated])).toBeGreaterThan(60);
        unrelated.position = [100, 150, 0];
        expect(indexedCurveOffset(source, target, [source, target, unrelated])).toBe(0);
    });
});
