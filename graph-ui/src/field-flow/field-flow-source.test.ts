import { afterEach, describe, expect, it, vi } from 'vitest';
import { callToolJson } from '../provider/rpc-transport';
import { fieldFlowFixture, fieldFlowPackageResolutionFixture, fieldFlowProvenanceFixture } from './field-flow-fixture';
import { loadFieldFlow, readFieldFlow } from './field-flow-source';
import { loadSourceEvidence } from './source-evidence';

vi.mock('../provider/rpc-transport', () => ({ callToolJson: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('field flow identity and transport', () => {
    it('preserves optional native package and resolver evidence while rejecting malformed proofs', () => {
        const fixture = fieldFlowProvenanceFixture();
        expect(readFieldFlow(fixture)).toEqual(fixture);
        expect(() => readFieldFlow(fieldFlowFixture())).not.toThrow();
        const invalidPackage = structuredClone(fixture);
        Object.assign(invalidPackage.values[1], { package: { id: 'npm:example', version: 123, manifest_hash: 'hash' } });
        expect(() => readFieldFlow(invalidPackage)).toThrow(/shape/i);
        const invalidProof = structuredClone(fixture);
        Object.assign(invalidProof.links[0].resolution, { caller_node_id: 0 });
        expect(() => readFieldFlow(invalidProof)).toThrow(/shape/i);
    });
    it('rejects resolver evidence bound to a foreign generation, different source bytes or a different callsite', () => {
        for (const patch of [
            { generation: 'g0' }, { project: 'another-project' }, { source_hash: 'other-caller-hash' },
            { callee_hash: 'other-dependency-hash' }, { start_byte: 21 }, { callee_file: 'other.ts' },
        ]) {
            const fixture = fieldFlowProvenanceFixture();
            Object.assign(fixture.links[0].resolution, patch);
            expect(() => readFieldFlow(fixture), JSON.stringify(patch)).toThrow(/identity/i);
        }
    });
    it('accepts a package import/export witness without graph IDs and rejects contradictory or malformed package proofs', () => {
        const fixture = fieldFlowPackageResolutionFixture();
        expect(readFieldFlow(fixture)).toEqual(fixture);
        const wrongManifest = structuredClone(fixture);
        wrongManifest.links[0].resolution.package.manifest_hash = 'another-manifest';
        expect(() => readFieldFlow(wrongManifest)).toThrow(/identity/i);
        const invalidImport = structuredClone(fixture);
        invalidImport.links[0].resolution.import.end_byte = 0;
        expect(() => readFieldFlow(invalidImport)).toThrow(/shape/i);
        const unknownKind = structuredClone(fixture);
        Object.assign(unknownKind.links[0].resolution, { proof_kind: 'guessed_by_name' });
        expect(() => readFieldFlow(unknownKind)).toThrow(/shape/i);
        const missingPackage = structuredClone(fixture);
        Object.assign(missingPackage.values[1], { package: undefined });
        expect(() => readFieldFlow(missingPackage)).toThrow(/identity/i);
        const returned = structuredClone(fixture);
        Object.assign(returned.links[0], { kind: 'return', source: 'v:new', target: 'v:old' });
        returned.paths[0].values.reverse();
        expect(() => readFieldFlow(returned)).not.toThrow();
    });
    it('sends a selected occurrence and exact generation without treating value IDs as graph IDs', async () => {
        vi.mocked(callToolJson).mockResolvedValue(fieldFlowFixture());
        const signal = new AbortController().signal;
        await loadFieldFlow({ project: 'sample', generation: 'g1', source: { value_id: 'v:old' }, direction: 'forward' }, signal);
        expect(callToolJson).toHaveBeenCalledWith('trace_field', {
            project: 'sample', expected_generation: 'g1', source: { value_id: 'v:old' }, direction: 'forward',
        }, { signal });
    });
    it('preserves ambiguous candidates without manufacturing paths', () => {
        const result = readFieldFlow(fieldFlowFixture(true));
        expect(result.status).toBe('selection_required'); expect(result.paths).toEqual([]);
        expect(result.values.map(value => value.ref.value_id)).toEqual(['v:old', 'v:new']);
    });
    it('rejects foreign generations, dangling operation refs and false path adjacency', async () => {
        const wrong = fieldFlowFixture(); wrong.values[0].ref.generation = 'g0';
        expect(() => readFieldFlow(wrong)).toThrow(/identity/i);
        const missing = fieldFlowFixture(); missing.operations = [];
        expect(() => readFieldFlow(missing)).toThrow(/identity/i);
        const reversed = fieldFlowFixture(); reversed.paths[0].values.reverse();
        expect(() => readFieldFlow(reversed)).toThrow(/path/i);
        vi.mocked(callToolJson).mockResolvedValue(fieldFlowFixture());
        await expect(loadFieldFlow({ project: 'other', generation: 'g1', source: { value_id: 'v:old' }, direction: 'forward' }, new AbortController().signal)).rejects.toThrow(/project/i);
    });
    it('does not quietly accept stale or contradictory source identity', () => {
        const wrong = fieldFlowFixture(); wrong.values[0].source.file_path = 'other.ts';
        expect(() => readFieldFlow(wrong)).toThrow(/identity/i);
        const stale = fieldFlowFixture(); stale.values[0].analysis_status = 'stale';
        expect(readFieldFlow(stale).values[0].analysis_status).toBe('stale');
    });
    it('preserves whole-file adapter gaps with no source line instead of discarding the limited result', () => {
        const limited = fieldFlowFixture();
        limited.gaps.push({ code: 'unsupported_file', message: 'No semantic adapter.', file_path: 'src/users.ts',
            source: { file_path: 'src/users.ts', source_hash: 'abc123', start_byte: 0, end_byte: 0, start_line: 0 } });
        expect(readFieldFlow(limited).gaps.at(-1)?.source?.start_line).toBe(0);
    });
});
describe('verified source evidence', () => {
    const request = { project: 'sample', generation: 'g1', file_path: 'src/users.ts', source_hash: 'abc123', start_line: 1, end_line: 3 };
    it('requests the exact hash and only returns text bound to that snapshot', async () => {
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ schema_version: 1, ...request, content: 'const email = input.email;', complete: true })));
        vi.stubGlobal('fetch', fetcher);
        const signal = new AbortController().signal;
        expect((await loadSourceEvidence(request, signal)).content).toContain('input.email');
        const url = new URL(fetcher.mock.calls[0][0], 'http://localhost');
        expect(url.pathname).toBe('/api/source-evidence'); expect(url.searchParams.get('source_hash')).toBe('abc123');
        expect(fetcher.mock.calls[0][1]).toMatchObject({ signal, cache: 'no-store' });
    });
    it('rejects stale HTTP responses and a successful body with a substituted hash', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Source changed; reindex.' }), { status: 409 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: 1, ...request, source_hash: 'other', content: 'unverified', complete: true }))));
        await expect(loadSourceEvidence(request, new AbortController().signal)).rejects.toThrow(/Source changed/);
        await expect(loadSourceEvidence(request, new AbortController().signal)).rejects.toThrow(/identity/i);
    });
});
