import { classifyQuestion, identifierNamesIn, mentionsIn, quotedNamesIn } from '../compiler/question-classifier';
import type { BrowserChatContext } from './chat-model';
import { readGalaxyEvidence, relationshipLine, scopeSentence, sideLoaded, type GalaxyEvidence } from './galaxy-evidence';
import { relationshipWords } from './strings';

export interface RelationshipQuestion { sides: ('incoming' | 'outgoing')[]; language: 'en' | 'de' }

/** "What does X call" asks for callees; the shared classifier does not have that class. */
const CALLEE_PATTERNS = [/\bwhat\s+(?:does|do|did|will)\s+.+?\s+call\b/i, /\bwhich\s+\w+\s+(?:does|do|did)\s+.+?\s+call\b/i,
    /\bcallees?\b/i, /\bwas\s+ruft\b/i, /\bwelche\s+\w+\s+ruft\b/i, /\bwas\s+wird\s+von\b.+\baufgerufen\b/i];
const CALLER_PATTERNS = [/\bwhat\s+calls\b/i, /\bcallers?\b/i, /\bwer\s+ruft\b/i, /\bvon\s+wem\b/i];
const GERMAN = /\b(?:wer|welche\w*|ruft|rufen|aufrufer|aufgerufen|wem|wird)\b/i;

/** Caller and callee questions, in English or German. Anything else goes to the model. */
export function relationshipQuestion(prompt: string): RelationshipQuestion | undefined {
    const callees = CALLEE_PATTERNS.some(pattern => pattern.test(prompt));
    const callers = CALLER_PATTERNS.some(pattern => pattern.test(prompt)) || classifyQuestion(prompt).klass === 'who-calls';
    if (!callers && !callees) return undefined;
    return { sides: [...callers ? ['incoming' as const] : [], ...callees ? ['outgoing' as const] : []], language: GERMAN.test(prompt) ? 'de' : 'en' };
}

/** A question that names another symbol is not about this selection. */
function aboutSelection(prompt: string, evidence: GalaxyEvidence): boolean {
    const named = [...mentionsIn(prompt), ...quotedNamesIn(prompt), ...identifierNamesIn(prompt)];
    const selected = new Set([evidence.label, ...evidence.roots.map(root => root.name)].map(name => name.toLowerCase()));
    return !named.length || named.some(name => selected.has(name.toLowerCase()) || selected.has(name.split('.').pop()!.toLowerCase()));
}

const quote = (value: string) => `\`${value.replace(/`/g, "'")}\``;

function listed(question: RelationshipQuestion, evidence: GalaxyEvidence): string {
    const words = relationshipWords[question.language];
    const name = quote(evidence.label);
    const sections: string[] = [];
    for (const side of question.sides) {
        const heading = side === 'incoming' ? words.callersOf(name) : words.calleesOf(name);
        if (evidence.depth === 0) { sections.push(`${heading}. ${words.notExpanded}`); continue; }
        if (!sideLoaded(evidence, side)) { sections.push(`${heading}. ${words.notLoaded(side)}`); continue; }
        const groups = evidence.relationships[side];
        if (!groups.length) { sections.push(`${heading}. ${evidence.truncated ? words.cut(side) : words.noRelationships}`); continue; }
        const symbols = side === 'incoming' ? evidence.relationships.incomingSymbols : evidence.relationships.outgoingSymbols;
        const total = groups.reduce((sum, group) => sum + group.count, 0);
        const calls = groups.find(group => group.type === 'CALLS');
        // A caller question is answered with CALLS first; other edge types follow, never hidden.
        const ordered = calls ? [calls, ...groups.filter(group => group !== calls)] : groups;
        sections.push(`${heading}. ${side === 'incoming' ? words.incoming(total, symbols) : words.outgoing(total, symbols)}`
            + (calls ? '' : ` ${words.noCalls(name, side)} ${words.otherRelationships}`),
        ordered.map(group => relationshipLine(group, side, Infinity, words, true).text).join('\n'));
    }
    sections.push(scopeSentence(evidence, words));
    if (evidence.state === 'loading') sections.push(words.stillLoading);
    sections.push(`_${words.listedFromGraph}_`);
    return sections.join('\n\n');
}

/** A complete, deterministic answer from the current Galaxy evidence, or undefined
 * when the question is not about callers or callees of the selection. */
export function relationshipAnswer(prompt: string, contexts: readonly BrowserChatContext[]): { markdown: string; context: BrowserChatContext } | undefined {
    const question = relationshipQuestion(prompt);
    if (!question) return undefined;
    for (const context of contexts) {
        const evidence = readGalaxyEvidence(context.text);
        if (evidence && aboutSelection(prompt, evidence)) return { markdown: listed(question, evidence), context };
    }
    return undefined;
}
