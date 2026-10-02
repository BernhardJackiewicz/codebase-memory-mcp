import { identifierNamesIn, mentionsIn, quotedNamesIn } from '../compiler/question-classifier';
import type { BrowserChatContext } from './chat-model';
import { readGalaxyEvidence, relationshipLine, scopeSentence, sideLoaded, type GalaxyEvidence } from './galaxy-evidence';
import { relationshipWords } from './strings';

type Side = 'incoming' | 'outgoing';
export interface RelationshipQuestion {
    sides: Side[];
    language: 'en' | 'de';
    /** The symbol named where the question puts its subject; undefined for "it", "this" or none. */
    subject?: string;
}

const KIND = 'function|method|class|symbol|file|module|funktion|methode|klasse|datei|modul';
/** Where a pattern says {name}: an optional article and kind noun, the name as typed, an optional kind noun. */
const NAME = String.raw`(?:(?:the|a|an|der|die|das|den|dem|des)\s+)?(?:(?:${KIND})\s+)?[@\x60'"]?([A-Za-z_][\w.:/]*)[\x60'"]?(?:\s+(?:${KIND})\b)?`;
const pattern = (source: string) => new RegExp(source.replace('{name}', NAME), 'iu');

/** Phrasings that fix the direction and, where it is written, the subject. */
const PHRASINGS: { side: Side; pattern: RegExp }[] = [
    ...[
        String.raw`\bwho\s+(?:else\s+)?(?:calls|invokes|uses)\s+{name}`,
        String.raw`\bwhat\s+(?:calls|invokes)\s+{name}`,
        String.raw`\b(?:which|what)\s+\w+\s+(?:calls?|invokes?)\s+{name}`,
        String.raw`\bcall(?:ers?|\s+sites?)\s+(?:of|for|to)\s+{name}`,
        String.raw`\bwhere\s+(?:is|are|does|do)\s+{name}\s+(?:\w+\s+)?(?:called|invoked|used)\b`,
        String.raw`\b(?:is|are)\s+{name}\s+(?:called|invoked|used)\s+by\b`,
        String.raw`\bwer\s+(?:ruft|benutzt|verwendet|nutzt)\s+{name}`,
        String.raw`\bwelche\w*\s+[\p{L}\w]+\s+(?:rufen|benutzen|verwenden|nutzen)\s+{name}`,
        String.raw`\b(?:wo|woher|von\s+wo)(?:\s+überall)?\s+wird\s+{name}\s+(?:\w+\s+)?(?:aufgerufen|benutzt|verwendet|genutzt)\b`,
        String.raw`\bvon\s+wem\s+(?:wird|werden)\s+{name}`,
        String.raw`\baufrufer\s+(?:von|für)\s+{name}`,
        String.raw`\bwird\s+{name}\s+(?:\w+\s+)?aufgerufen\b`,
    ].map(source => ({ side: 'incoming' as const, pattern: pattern(source) })),
    ...[
        String.raw`\bwhat\s+(?:does|do|did|will|can)\s+{name}\s+(?:call|invoke|use)\b`,
        String.raw`\b(?:which|what)\s+\w+\s+(?:does|do|did|will|can)\s+{name}\s+(?:call|invoke|use)\b`,
        String.raw`\bcallees?\s+(?:of|for)\s+{name}`,
        String.raw`\bcalled\s+by\s+{name}`,
        String.raw`\bwas\s+ruft\s+{name}`,
        String.raw`\b(?:wird|werden)\s+von\s+{name}\s+(?:\w+\s+)?aufgerufen\b`,
    ].map(source => ({ side: 'outgoing' as const, pattern: pattern(source) })),
];
/** "Welche Funktion ruft X auf" asks for callers; with a plural noun, "ruft" has X as subject. */
const WHICH_CALLS = pattern(String.raw`\b(welche[rsnm]?)\s+([\p{L}\w]+)\s+ruft\s+{name}`);
/** Direction words without a written subject. */
const GENERAL: { side: Side; pattern: RegExp }[] = [
    { side: 'incoming', pattern: /\b(?:callers?|call\s+sites?|who\s+(?:calls|invokes|uses)|what\s+calls|wer\s+ruft|von\s+wem|aufrufer)\b/i },
    { side: 'outgoing', pattern: /\b(?:callees?|was\s+ruft)\b/i },
];
/** Why, how, what-if and explain questions want reasoning, not a list; "how many" still asks for one. */
const REASONING = /\b(?:why|how(?!\s+(?:many|often))|explain\w*|describe\w*|would|could|should|if|when|rename\w*|break\w*|impact\w*|warum|wieso|weshalb|wie(?!\s+(?:viele|oft))|erkl(?:ä|ae)r\w*|beschreib\w*|passiert|wäre|waere|würde|wuerde|könnte|koennte|sollte|wenn|falls|umbenenn\w*|auswirkung\w*)\b/iu;
const GERMAN = /\b(?:wer|welche\w*|ruft|rufen|aufrufer|aufgerufen|wem|wird|werden)\b/i;
/** Subjects that mean the current selection. */
const SELF = new Set(['it', 'this', 'that', 'these', 'those', 'here', 'es', 'dies', 'diese', 'dieser', 'dieses', 'diesen', 'diesem', 'sie', 'ihn',
    'function', 'method', 'class', 'symbol', 'file', 'module', 'selection', 'funktion', 'methode', 'klasse', 'datei', 'modul', 'auswahl']);
/** Words a {name} can land on that are not a subject at all; the match is discarded. */
const NOT_A_NAME = new Set(['in', 'into', 'from', 'at', 'on', 'to', 'for', 'with', 'of', 'and', 'or', 'by', 'anything', 'anyone', 'something', 'someone',
    'what', 'which', 'who', 'whom', 'all', 'every', 'auf', 'von', 'im', 'aus', 'und', 'oder', 'irgendwo', 'überhaupt', 'etwas', 'jemand',
    'was', 'wer', 'wem', 'wen', 'alle', 'jede', 'jeder', 'jedes']);

/** Caller and callee questions that ask for a list, in English or German. Anything else goes to the model. */
export function relationshipQuestion(prompt: string): RelationshipQuestion | undefined {
    if (REASONING.test(prompt)) return undefined;
    const sides = new Set<Side>();
    let subject: string | undefined, named = false;
    const take = (side: Side, name: string | undefined): void => {
        const word = name?.replace(/[.:/]+$/, '');
        if (!word || NOT_A_NAME.has(word.toLowerCase())) return;
        sides.add(side);
        if (!SELF.has(word.toLowerCase()) && !subject) subject = word;
        named = true;
    };
    for (const phrasing of PHRASINGS) take(phrasing.side, phrasing.pattern.exec(prompt)?.[1]);
    const which = WHICH_CALLS.exec(prompt);
    if (which) take(which[1].toLowerCase() === 'welche' && /(?:en|[^s]s)$/iu.test(which[2]) ? 'outgoing' : 'incoming', which[3]);
    if (!named) for (const general of GENERAL) if (general.pattern.test(prompt)) sides.add(general.side);
    if (!sides.size) return undefined;
    return { sides: (['incoming', 'outgoing'] as const).filter(side => sides.has(side)), language: GERMAN.test(prompt) ? 'de' : 'en',
        ...subject ? { subject } : {} };
}

/** A question about another symbol is not about this selection. Without a written
 * subject, any symbol-shaped word in the question still counts as naming one. */
function aboutSelection(prompt: string, question: RelationshipQuestion, evidence: GalaxyEvidence): boolean {
    const selected = new Set([evidence.label, evidence.label.split('/').pop()!, ...evidence.roots.map(root => root.name)].map(name => name.toLowerCase()));
    const matches = (name: string) => selected.has(name.toLowerCase()) || selected.has(name.split(/[.:]/).pop()!.toLowerCase());
    if (question.subject) return matches(question.subject);
    const snake = prompt.match(/\b[A-Za-z]\w*_\w+\b/g) ?? [];
    const named = [...mentionsIn(prompt), ...quotedNamesIn(prompt), ...identifierNamesIn(prompt), ...snake];
    return !named.length || named.some(matches);
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
 * when the question is not a list of callers or callees of the selection. */
export function relationshipAnswer(prompt: string, contexts: readonly BrowserChatContext[]): { markdown: string; context: BrowserChatContext } | undefined {
    const question = relationshipQuestion(prompt);
    if (!question) return undefined;
    for (const context of contexts) {
        const evidence = readGalaxyEvidence(context.text);
        if (evidence && aboutSelection(prompt, question, evidence)) return { markdown: listed(question, evidence), context };
    }
    return undefined;
}
