import { describe, expect, it } from 'vitest';
import { citedInterpretation, explanationMessages } from './explanation-response';
const packet = { label: 'file.c', evidence: [{ id: 'E1', text: 'u.i = (uintptr_t)CBM_NOT_FOUND;', source: 'code' as const, location: { path: 'file.c', startLine: 103, startColumn: 5, endLine: 103, endColumn: 36, sourceVersion: 'v1' } }], limitations: [], fallback: 'Source excerpt', characterCount: 50 };
describe('explanation attribution', () => {
    it('keeps evidence in the user request and requires a current exact citation', () => {
        const messages = explanationMessages(packet);
        expect(messages[1].content).toContain(packet.evidence[0].text);
        expect(messages[0].content).not.toContain(packet.evidence[0].text);
        expect(citedInterpretation(JSON.stringify({ claim: 'Assigns a cast value.', evidence_id: 'E1', quote: packet.evidence[0].text }), packet)?.evidenceId).toBe('E1');
    });
    it('rejects uncited prose, made-up sources, altered quotes and unsupported quoted code', () => {
        expect(citedInterpretation('Creates a new destructor.', packet)).toBeUndefined();
        for (const change of [{ evidence_id: 'E2' }, { quote: 'u.i = 0;' }, { claim: 'Calls `sqlite3_destructor_create`.' }]) {
            expect(citedInterpretation(JSON.stringify({ claim: 'Assignment.', evidence_id: 'E1', quote: packet.evidence[0].text, ...change }), packet)).toBeUndefined();
        }
    });
    it('does not misrepresent attribution as semantic verification', () => {
        // A real quote cannot prove that a free-form interpretation is true.
        expect(citedInterpretation(JSON.stringify({ claim: 'A possibly wrong interpretation.', evidence_id: 'E1', quote: packet.evidence[0].text }), packet)).toBeDefined();
    });
});
