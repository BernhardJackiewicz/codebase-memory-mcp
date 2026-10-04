import type { GalaxyEvidence } from './galaxy-evidence';
import { typoBudget, withinEdits } from './relationship-answer';
import { noQuestionText } from './strings';

/** What a prompt asks of the current selection or open file, before any model sees it.
 *
 * A general question ("was macht diese Klasse?", "what does this do") got a long garbled
 * guess from the small model, while the automatic explanation of the same selection, its
 * listed facts and one checked sentence, was good (C5). Such questions get that shape; those
 * that ask for detail ("line by line", "ausführlich") still go to the model. A prompt with
 * no question at all ("test", "hallo") gets examples instead of an echo (C6). */

/** Words before the name: articles, demonstratives, and what a selection or file is called. */
const DET = 'der|die|das|den|dem|des|diese|dieser|dieses|diesen|diesem|dies|the|this|that|these|those|my|mein|meine';
const ADJ = 'aktuelle|aktuellen|aktuelles|aktueller|ganze|ganzen|ganzes|geöffnete|geöffneten|geöffnetes|ausgewählte|ausgewählten|markierte|markierten|current|whole|entire|open|opened|selected|marked';
const KIND = 'code|klasse|funktion|methode|datei|file|symbol|modul|module|class|function|method|node|knoten|auswahl|selection|teil|part|skript|script|workflow|konfiguration|config|configuration';
const PRONOUN = 'das|dies|es|this|that|it|sie|ihn|hier|here';
/** The selection or file: "diese Klasse", "the JSONBAgg class", "das", "it". */
const OBJECT = `(?:(?:(?:${DET}) )?(?:(?:${ADJ}) )?(?:${KIND}|<name>)(?: (?:${KIND}))?|(?:${PRONOUN}))`;
/** What may follow a general question without making it another one: "sehr kurze Antwort", "briefly". */
const TAIL = 'bitte|please|kurz|kurze|kurzer|kurzen|knapp|knappe|sehr|antwort|einfach|mal|eigentlich|überhaupt|denn|nochmal|so|jetzt|now|again|briefly|brief|short|shortly|quick|quickly|simply|simple|in|a|an|one|sentence|einem|einen|satz|wenigen|worten|few|words|overall|insgesamt|zusammen|for|me|mir|uns|us|du';
const END = `(?: (?:${TAIL}))*$`;

const GENERAL = [
    // German
    String.raw`^(?:was|wass) (?:kannst|könntest|kann) (?:du|man) (?:(?:mir|uns) )?(?:(?:über|zu|von) ${OBJECT}|dazu|darüber) (?:sagen|erzählen|erklären)`,
    String.raw`^(?:was|wass) (?:macht|tut|ist|bedeutet|enthält|steht in|passiert in) ${OBJECT}`,
    String.raw`^(?:erklär|erkläre|erklären|erklärst|beschreib|beschreibe|fasse)(?: (?:mir|uns))?(?: bitte)?(?: mal)?(?: ${OBJECT})?(?: zusammen)?`,
    String.raw`^(?:kannst|könntest) du (?:(?:mir|uns) )?${OBJECT}(?: (?:erklären|beschreiben|zusammenfassen))?`,
    String.raw`^worum geht es(?: (?:in|bei) ${OBJECT})?`,
    // English
    String.raw`^what (?:can|could) you tell (?:me|us) about ${OBJECT}`,
    String.raw`^(?:can|could) you (?:explain|describe|summarize|summarise) ${OBJECT}`,
    String.raw`^tell (?:me|us) (?:more )?about ${OBJECT}`,
    String.raw`^what (?:does|do) ${OBJECT} do`,
    String.raw`^what is ${OBJECT}(?: (?:for|about))?`,
    String.raw`^what is in ${OBJECT}`,
    String.raw`^what does ${OBJECT} contain`,
    String.raw`^(?:explain|describe|summarize|summarise)(?: to me)?(?: ${OBJECT})?`,
].map(source => new RegExp(source + END, 'u'));

/** Asking for detail: the model answers these as before. */
const DETAIL = /(?:^| )(?:in details?|detailed|detailliert\S*|ausführlich\S*|line by line|zeile für zeile|step by step|schritt für schritt|genau(?= erklär)|im detail|in depth|thoroughly|every line|jede zeile)(?= |$)/gu;

/** Words a typo is corrected to, as K16 does for "wer ruf": "kansnt" is "kannst". */
const VOCABULARY = ['kannst', 'könntest', 'sagen', 'macht', 'klasse', 'funktion', 'methode', 'datei', 'erklär', 'erkläre', 'erklären', 'beschreib', 'beschreibe',
    'diese', 'dieser', 'dieses', 'diesen', 'diesem', 'über', 'erzählen', 'explain', 'describe', 'summarize', 'about', 'tell', 'what', 'does', 'this', 'that',
    'code', 'class', 'function', 'method', 'file', 'symbol', 'modul', 'module', 'zusammen', 'bedeutet', 'enthält', 'contain'];
/** Words of the patterns themselves: never "corrected" into another one ("dies" is no "does"). */
const OWN = new Set([...[DET, ADJ, KIND, PRONOUN, TAIL].flatMap(list => list.split('|')), ...VOCABULARY, 'was', 'wass', 'tut', 'ist', 'kann', 'man', 'dazu', 'darüber',
    'steht', 'passiert', 'worum', 'geht', 'bei', 'can', 'could', 'you', 'more', 'do', 'is', 'to', 'how', 'why', 'with', 'from', 'calls', 'call', 'used', 'uses']);
const SPELLED = { erklaer: 'erklär', erklaere: 'erkläre', erklaeren: 'erklären', ueber: 'über', fuer: 'für', ausfuehrlich: 'ausführlich', koenntest: 'könntest', enthaelt: 'enthält' } as Record<string, string>;

/** The prompt in lower case, words corrected, the selection's name as `<name>`. */
function normalize(prompt: string, names: readonly string[]): string {
    const own = names.flatMap(name => [name, name.split(/[./:]/).filter(Boolean).pop() ?? name]).map(name => name.toLowerCase()).filter(Boolean);
    const text = prompt.toLowerCase().replace(/[’`"]/g, "'").replace(/\bwhat'?s\b/g, 'what is').replace(/'/g, ' ')
        .replace(/[?!,;:()]+/g, ' ').replace(/\.+(?=\s|$)/g, ' ');
    return text.split(/\s+/).filter(Boolean).map(word => {
        if (own.includes(word) || own.includes(word.split(/[.:]/).pop()!)) return '<name>';
        const spelled = SPELLED[word] ?? word;
        if (OWN.has(spelled)) return spelled;
        if (own.some(name => name.length >= 4 && withinEdits(word, name, typoBudget(name)))) return '<name>';
        if (spelled.length < 4) return spelled;
        return VOCABULARY.find(candidate => withinEdits(spelled, candidate, 1)) ?? spelled;
    }).join(' ');
}

/** "general" for a short general question about the selection or the open file, "detail" for the
 * same question asking for detail, undefined for any other prompt. `names` are the selection's. */
export function generalQuestion(prompt: string, names: readonly string[]): 'general' | 'detail' | undefined {
    const text = normalize(prompt, names);
    const detail = new RegExp(DETAIL.source, 'u').test(text);
    const asked = detail ? text.replace(DETAIL, ' ').replace(/\s+/g, ' ').trim() : text;
    if (!GENERAL.some(pattern => pattern.test(asked))) return undefined;
    return detail ? 'detail' : 'general';
}

/** Greetings and probes: a prompt of only these asks nothing. */
const GREETINGS = new Set(['hi', 'hey', 'hello', 'hallo', 'moin', 'servus', 'huhu', 'yo', 'test', 'testing', 'tests', 'ok', 'okay', 'danke', 'thanks', 'thank', 'you',
    'du', 'ja', 'nein', 'yes', 'no', 'guten', 'morgen', 'tag', 'abend', 'good', 'morning', 'evening', 'there', 'bitte', 'please', 'na', 'hm', 'hmm', 'ping', 'asdf']);
/** One word that still asks something, mostly of the answer before: "warum?", "more". */
const ONE_WORD_QUESTION = /^(?:why|warum|wieso|weshalb|how|wie|what|was|who|wer|where|wo|when|wann|which|welche\w*|more|mehr|weiter|continue|und|and|sonst|else|details?|example|beispiel|explain\w*|erkl\S*|describe|beschreib\w*|summar\w*|zusammenfass\w*|callers?|callees?|aufrufer)$/u;

/** A prompt with no question in it: no word at all ("?"), a single word that asks nothing
 * ("test"), or only greetings ("hallo du"). The name of the selection or of a known symbol
 * is a question about it. */
export function noQuestion(prompt: string, known: (word: string) => boolean): boolean {
    const words = prompt.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/-]*/gu) ?? [];
    if (!words.length) return true;
    if (words.some(word => known(word.replace(/[.:/-]+$/, '')))) return false;
    if (words.length === 1) return !ONE_WORD_QUESTION.test(words[0]);
    return words.length <= 3 && words.every(word => GREETINGS.has(word));
}

/** What the examples of a prompt without a question are about; a Galaxy selection with its evidence. */
export type ExampleSubject = { kind: 'galaxy'; name: string; evidence?: GalaxyEvidence } | { kind: 'other'; name: string } | { kind: 'marked' };

/** Kinds asked about as a type, and kinds that hold other symbols. */
const TYPE_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'enum', 'type']);
const CONTAINER_KINDS = new Set(['file', 'folder', 'module', 'package', 'namespace', 'project']);
/** Questions that suit the selected kind: "What does JSONBAgg call?" led a class to "no CALLS edge" (W9). */
function galaxyExamples(text: typeof noQuestionText['en'], name: string, evidence?: GalaxyEvidence): string[] {
    const kind = (evidence && evidence.rootCount <= 1 ? evidence.roots[0]?.kind ?? evidence.selectionKind : evidence?.selectionKind)?.toLowerCase() ?? '';
    if (TYPE_KINDS.has(kind)) return [text.whatIs(name), text.whoUses(name), ...evidence?.relationships.outgoing.some(group => group.type === 'INHERITS') ? [text.whatInherits(name)] : []];
    if (CONTAINER_KINDS.has(kind)) return [text.whatContains(name), text.inDetail(name)];
    return [text.whatDoes(name), text.whoCalls(name), text.whatCalls(name)];
}

/** "No question was recognized in "test"." and two or three questions that work for the selection (C6). */
export function noQuestionAnswer(typed: string, language: 'en' | 'de', subject: ExampleSubject): string {
    const text = noQuestionText[language];
    const examples = subject.kind === 'marked' ? [text.markedDoes, text.markedInDetail]
        : subject.kind === 'galaxy' ? galaxyExamples(text, subject.name, subject.evidence)
            : [text.whatDoes(subject.name), text.inDetail(subject.name)];
    const shown = typed.replace(/\s+/g, ' ').replace(/["`]/g, "'").trim().slice(0, 40);
    return `${text.heading(shown)}\n\n${examples.map(example => `- ${example}`).join('\n')}\n\n_${text.note}_`;
}

/** The names a prompt may use for what is at hand: the selection, the symbols around it, the
 * words of the open file or attached code. A prompt that names one of them is a question. */
export function knownNames(sources: { galaxy?: GalaxyEvidence; texts: readonly string[]; names: readonly string[] }): (word: string) => boolean {
    const words = new Set<string>();
    const add = (text: string) => { for (const word of text.match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu) ?? []) words.add(word.toLowerCase()); };
    sources.texts.forEach(add);
    sources.names.forEach(name => { words.add(name.toLowerCase()); words.add((name.split(/[/.:]/).filter(Boolean).pop() ?? name).toLowerCase()); });
    const galaxy = sources.galaxy;
    if (galaxy) for (const group of [...galaxy.relationships.incoming, ...galaxy.relationships.outgoing]) for (const file of group.files) file.symbols.forEach(symbol => words.add(symbol.name.toLowerCase()));
    const own = sources.names.map(name => name.toLowerCase()).filter(name => name.length >= 4);
    return word => words.has(word.toLowerCase()) || own.some(name => withinEdits(word.toLowerCase(), name, typoBudget(name)));
}
