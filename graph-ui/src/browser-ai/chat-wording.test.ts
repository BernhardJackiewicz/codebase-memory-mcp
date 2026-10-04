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

describe('a scope that finished loading (W4)', () => {
    it('says it is fully loaded, not complete for the whole graph', () => {
        expect(selectionSummary(jsonbAggEvidence()).at(-1)).toBe('Scope: 1 hop in both directions, all relationship types; 15 symbols and 25 relationships; fully loaded.');
        expect(selectionSummary(jsonbAggEvidence(), 'de').at(-1)).toBe('Ausschnitt: 1 Schritt in beide Richtungen, alle Beziehungstypen; 15 Symbole und 25 Beziehungen; vollständig geladen.');
        const listed = relationshipAnswer('Who calls JSONBAgg?', [jsonbAggEvidence()])!.markdown + relationshipAnswer('Wer ruft JSONBAgg auf?', [jsonbAggEvidence()])!.markdown;
        expect(listed).not.toMatch(/complete for the indexed graph|vollständig für den indizierten Graphen/);
        expect(listed).toContain('fully loaded.');
        expect(listed).toContain('vollständig geladen.');
    });
});

describe('relationship counts that read as counts, not as a score (W2)', () => {
    it('names the unit beside each number in the summary, in English and German', () => {
        expect(selectionSummary(jsonbAggEvidence()).slice(1, 3)).toEqual([
            'Incoming: 23 relationships from 12 symbols (CALLS 11, TESTS 11, DEFINES 1).',
            'Outgoing: 2 relationships to 2 symbols (INHERITS 2).',
        ]);
        expect(selectionSummary(jsonbAggEvidence(), 'de').slice(1, 3)).toEqual([
            'Eingehend: 23 Beziehungen von 12 Symbolen (CALLS 11, TESTS 11, DEFINES 1).',
            'Ausgehend: 2 Beziehungen zu 2 Symbolen (INHERITS 2).',
        ]);
    });

    it('heads each edge type of the prompt with its count in parentheses, so the model has no "CALLS from 11" to repeat', () => {
        const prompt = formatExplanationEvidence(prepareExplanationContext(undefined, jsonbAggEvidence(), 3200));
        expect(prompt).toContain('Incoming: 23 relationships from 12 symbols.');
        expect(prompt).toContain('Outgoing: 2 relationships to 2 symbols.');
        expect(prompt).toMatch(/^- CALLS \(11\): test_default_argument/m);
        expect(prompt).toMatch(/^- INHERITS \(2\): OrderableAggMixin/m);
        expect(prompt).not.toMatch(/\b(?:CALLS|TESTS|DEFINES|INHERITS) (?:from|to) \d/);
    });

    it('uses the same words where a side has nothing, was not loaded or was cut', () => {
        expect(selectionSummary(jsonbAggEvidence({ direction: 'outbound' }))[1]).toBe('Incoming: not loaded; the scope does not follow incoming edges.');
        expect(selectionSummary(jsonbAggEvidence({ direction: 'outbound' }), 'de')[1]).toBe('Eingehend: nicht geladen; der Ausschnitt folgt keinen eingehenden Kanten.');
        const lonely = jsonbAggEvidence({ edges: [] });
        expect(selectionSummary(lonely).slice(1, 3)).toEqual(['Incoming: no relationships in this scope.', 'Outgoing: no relationships in this scope.']);
        expect(selectionSummary(lonely, 'de').slice(1, 3)).toEqual(['Eingehend: keine Beziehungen in diesem Ausschnitt.', 'Ausgehend: keine Beziehungen in diesem Ausschnitt.']);
    });
});

describe('the heading of a listed caller or callee answer (W3)', () => {
    const answer = (prompt: string, context = jsonbAggEvidence()) => relationshipAnswer(prompt, [context])!.markdown;
    // Two callers of JSONBAgg with CALLS only, and three calls from it.
    const calling = () => jsonbAggEvidence({ edges: [{ source: 100, target: 32360, type: 'CALLS' }, { source: 101, target: 32360, type: 'CALLS' },
        { source: 32360, target: 7, type: 'CALLS' }, { source: 32360, target: 8, type: 'CALLS' }, { source: 32360, target: 9, type: 'CALLS' }, { source: 32360, target: 7, type: 'INHERITS' }] });

    it('counts the callers it lists and gives all incoming relationships as a sentence of their own', () => {
        expect(answer('Who calls JSONBAgg?').split('\n')[0]).toBe('11 callers (CALLS) of `JSONBAgg` in the loaded graph. All incoming: 23 relationships from 12 symbols.');
        expect(answer('Wer ruft JSONBAgg auf?').split('\n')[0]).toBe('11 Aufrufer (CALLS) von `JSONBAgg` im geladenen Graphen. Alle eingehenden: 23 Beziehungen von 12 Symbolen.');
        // With CALLS as the only type there is nothing more to count.
        expect(answer('Who calls JSONBAgg?', calling()).split('\n')[0]).toBe('2 callers (CALLS) of `JSONBAgg` in the loaded graph.');
    });

    it('says what the selection calls as a full sentence, in English and German', () => {
        expect(answer('What does JSONBAgg call?', calling()).split('\n')[0])
            .toBe('`JSONBAgg` calls 3 symbols (CALLS) in the loaded graph. All outgoing: 4 relationships to 3 symbols.');
        expect(answer('Was ruft JSONBAgg auf?', calling()).split('\n')[0])
            .toBe('`JSONBAgg` ruft im geladenen Graphen 3 Symbole auf (CALLS). Alle ausgehenden: 4 Beziehungen zu 3 Symbolen.');
        expect(answer('Was ruft JSONBAgg auf?').split('\n')[0])
            .toBe('`JSONBAgg` hat in diesem Ausschnitt keine ausgehende CALLS-Kante. Ausgehend: 2 Beziehungen zu 2 Symbolen.');
        expect(answer('What does JSONBAgg call?').split('\n')[0])
            .toBe('`JSONBAgg` has no outgoing CALLS edge in this scope. Outgoing: 2 relationships to 2 symbols.');
        expect(answer('Was ruft JSONBAgg auf?')).not.toContain('Was `JSONBAgg` im geladenen Graphen aufruft.');
    });

    it('heads the other edge types "Andere" in German, also right after "keine ausgehende CALLS-Kante"', () => {
        expect(answer('Was ruft JSONBAgg auf?')).toContain('\n\nAndere ausgehende Beziehungen:\n- **INHERITS (2):**');
        expect(answer('Wer ruft JSONBAgg auf?')).toContain('\n\nAndere eingehende Beziehungen:\n- **TESTS (11):**');
        expect(answer('What does JSONBAgg call?')).toContain('\n\nOther outgoing relationships:\n- **INHERITS (2):**');
        expect(answer('Wer ruft JSONBAgg auf?') + answer('Was ruft JSONBAgg auf?')).not.toContain('Weitere');
    });

    it('says in a full sentence why nothing is listed', () => {
        expect(answer('Who calls JSONBAgg?', jsonbAggEvidence({ direction: 'outbound' })).split('\n')[0]).toMatch(/^The callers of `JSONBAgg` cannot be listed from this scope\. /);
        expect(answer('Was ruft JSONBAgg auf?', jsonbAggEvidence({ direction: 'inbound' })).split('\n')[0]).toMatch(/^Was `JSONBAgg` aufruft, lässt sich aus diesem Ausschnitt nicht auflisten\. /);
        expect(answer('Who calls JSONBAgg?', jsonbAggEvidence({ edges: [] })).split('\n')[0]).toBe('`JSONBAgg` has no callers and no other incoming relationships in this scope.');
        expect(answer('Was ruft JSONBAgg auf?', jsonbAggEvidence({ edges: [] })).split('\n')[0]).toBe('`JSONBAgg` ruft in diesem Ausschnitt nichts auf und hat keine anderen ausgehenden Beziehungen.');
    });
});
