import { describe, expect, it } from 'vitest';
import { prepareExplanationContext, selectionSummary } from './explanation-context';
import { formatExplanationEvidence } from './explanation-response';
import { jsonbAggEvidence, jsonbAggRenderLimited } from './galaxy-evidence.fixture';
import { relationshipAnswer } from './relationship-answer';

/* Wording of the chat texts after the third review of the hand test (2026-10-04, W1 to W10). */

describe('the render limit in the scope sentence (W1)', () => {
    const english = 'Scope: 3 hops in both directions, all relationship types; 5,548 symbols and 15,673 relationships; partial. '
        + 'Layer 3 stopped loading after the request that took it past the render limit of 5,000 nodes; the scene draws at most 5,000 nodes, '
        + 'so counts and names further out can be incomplete.';
    const german = 'Ausschnitt: 3 Schritte in beide Richtungen, alle Beziehungstypen; 5.548 Symbole und 15.673 Beziehungen; unvollständig. '
        + 'Ebene 3 hörte nach der Anfrage auf zu laden, die sie über das Darstellungslimit von 5.000 Knoten brachte; die Szene zeichnet höchstens 5.000 Knoten, '
        + 'daher können Anzahlen und Namen weiter außen fehlen.';

    it('says what the Galaxy tooltip says, in the card, the prompt and the listed answers', () => {
        expect(selectionSummary(jsonbAggRenderLimited()).at(-1)).toBe(english);
        expect(formatExplanationEvidence(prepareExplanationContext(undefined, jsonbAggRenderLimited(), 3200))).toContain(english);
        expect(relationshipAnswer('Who calls JSONBAgg?', [jsonbAggRenderLimited()])!.markdown).toContain(english);
        expect(selectionSummary(jsonbAggRenderLimited(), 'de').at(-1)).toBe(german);
        expect(relationshipAnswer('Wer ruft JSONBAgg auf?', [jsonbAggRenderLimited()])!.markdown).toContain(german);
    });

    it('keeps one unit in each sentence: symbols with the scope size, nodes with the render limit', () => {
        for (const text of [english, german]) {
            const sentences = text.split(/(?<=\.) (?=[A-ZÄÖÜ])/);
            expect(sentences).toHaveLength(2);
            expect(sentences[0]).not.toMatch(/nodes|Knoten/);
            expect(sentences[1]).not.toMatch(/symbols|Symbole/);
        }
        expect(english).not.toContain('stopped at the render limit');
        expect(german).not.toContain('hielt am Darstellungslimit');
    });

    it('names the direct relationships when the first layer stopped', () => {
        const first = jsonbAggEvidence({ state: 'render-limit-partial', renderLimit: { layer: 1, kind: 'edges', limit: 15_000 } });
        expect(selectionSummary(first).at(-1)).toContain('Layer 1 stopped loading after the request that took it past the render limit of 15,000 edges; '
            + 'the scene draws at most 15,000 edges, so counts and names can be incomplete, the direct relationships included.');
        expect(selectionSummary(first, 'de').at(-1)).toContain('über das Darstellungslimit von 15.000 Kanten brachte; die Szene zeichnet höchstens 15.000 Kanten, '
            + 'daher können Anzahlen und Namen fehlen, auch bei den direkten Beziehungen.');
    });
});
