import { describe, expect, it, vi } from 'vitest';
import { callToolJson } from '../provider/rpc-transport';
import { loadSystemGraph, readSystemGraph } from './system-graph-source';
import { systemGraphResponse } from './system-graph-fixture';

vi.mock('../provider/rpc-transport', () => ({ callToolJson: vi.fn() }));
describe('system graph wire evidence', () => {
    it('requests the native projection with the exact project, generation and cancellation', async () => {
        vi.mocked(callToolJson).mockResolvedValue(systemGraphResponse());
        const signal = new AbortController().signal;
        expect((await loadSystemGraph({ project: 'sample', expectedGeneration: 'g1' }, signal)).result?.entities).toHaveLength(5);
        expect(callToolJson).toHaveBeenCalledWith('get_architecture', {
            project: 'sample', aspects: ['system_graph'], format: 'json', expected_generation: 'g1',
        }, { signal });
    });
    it('rejects mixed project or generation evidence before source navigation', () => {
        const wrongProject = systemGraphResponse();
        wrongProject.result!.relations[0].witnesses[0].source.project = 'other';
        expect(() => readSystemGraph(wrongProject)).toThrow(/identity/i);
        const wrongGeneration = systemGraphResponse();
        wrongGeneration.result!.entities[0].ref.generation = 'stale';
        expect(() => readSystemGraph(wrongGeneration)).toThrow(/identity/i);
    });
    it('rejects dangling relations, duplicate identities and mismatched witness endpoints', () => {
        const dangling = systemGraphResponse();
        dangling.result!.relations[0].target = 'missing';
        expect(() => readSystemGraph(dangling)).toThrow(/identity/i);
        const duplicate = systemGraphResponse();
        duplicate.result!.entities.push(duplicate.result!.entities[0]);
        expect(() => readSystemGraph(duplicate)).toThrow(/identity/i);
        const wrongWitness = systemGraphResponse();
        wrongWitness.result!.relations[0].witnesses[0].source.node_id = 5;
        expect(() => readSystemGraph(wrongWitness)).toThrow(/identity/i);
    });
    it('preserves limited coverage and unavailable capabilities, rejects invalid locations', () => {
        const limited = systemGraphResponse();
        limited.result!.complete = false; limited.result!.status = 'limited';
        limited.result!.limits.omitted_entities = 80;
        limited.result!.gaps = [{ code: 'budget', message: 'Entity budget reached.', count: 80 }];
        expect(readSystemGraph(limited).result?.limits.omitted_entities).toBe(80);
        expect(readSystemGraph(limited).result?.capabilities.live_capture).toBe(false);
        limited.result!.entities[0].start_line = -3;
        expect(() => readSystemGraph(limited)).toThrow(/shape/i);
    });
    it('rejects a response belonging to another requested project or snapshot', async () => {
        vi.mocked(callToolJson).mockResolvedValue(systemGraphResponse());
        const signal = new AbortController().signal;
        await expect(loadSystemGraph({ project: 'other' }, signal)).rejects.toThrow(/project/i);
        await expect(loadSystemGraph({ project: 'sample', expectedGeneration: 'g2' }, signal)).rejects.toThrow(/generation/i);
    });
    it('preserves a backend failure before a project generation is available', async () => {
        const failure = { status: 'failed', generation: '', error: 'Project is not indexed.' };
        vi.mocked(callToolJson).mockResolvedValue(failure);
        expect(await loadSystemGraph({ project: 'sample', expectedGeneration: 'g1' }, new AbortController().signal)).toEqual(failure);
        expect(() => readSystemGraph({ ...systemGraphResponse(), generation: '' })).toThrow(/shape/i);
    });
});
