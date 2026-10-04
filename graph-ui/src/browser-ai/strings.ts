export const browserAiText = {
    title: 'Browser AI',
    subtitle: 'Optional explanations, generated on this device.',
    close: 'Close browser AI',
    model: 'Model',
    download: 'Download & enable',
    prepare: 'Enable from cache / download',
    preparing: 'Preparing the browser model...',
    ready: 'Ready on this device',
    generating: 'Writing a short explanation...',
    off: 'Off',
    cancel: 'Cancel',
    disable: 'Disable',
    remove: 'Remove downloaded model',
    removing: 'Removing the model cache...',
    explain: 'Explain source',
    failed: 'Browser AI could not complete this step.',
    optIn: 'Enabling downloads about 566 MB from Hugging Face if the files are not already cached. Model files stay in this browser. Opening this panel makes no download request.',
    device: 'Requires WebGPU with shader-f16 and enough free GPU memory. Runtime code is bundled with CBM. The local-model sidecar remains available separately.',
    privacy: 'Source is processed on this device. It is not sent to Hugging Face or another inference service.',
    storage: 'Downloads use a dedicated browser cache. Disable stops the worker; Remove also deletes this model cache. Closing the panel disables the model.',
    excerpt: 'Source to explain',
    truncated: 'Only the first 6,000 characters of this excerpt will be used.',
    noSource: 'Open a file or focus a function in Explore, then return here.',
    output: 'Unverified explanation',
    outputNote: 'Generated text can be wrong. Check it against the source and indexed evidence.',
    provenance: 'Model details',
    revision: 'Pinned revision',
    format: 'q4f16 · 160 output tokens maximum',
    progress: (loaded: number, total: number) => `${(loaded / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB`,
    location: (path: string, line: number) => `${path}:${line}`,
};

/** Words for graph facts in the prompt (always English) and for the listed
 * relationship answer, which follows the language of the question. Numbers are
 * written as the language writes them: 5,548 and 5.548 (C1). */
const en = (value: number) => value.toLocaleString('en-US');
const de = (value: number) => value.toLocaleString('de-DE');
const englishRelationshipWords = {
    from: 'from', to: 'to',
    more: (count: number) => `+${en(count)} more`,
    hops: (depth: number) => depth === 0 ? 'the selection only' : depth === 1 ? '1 hop' : `${depth} hops`,
    both: 'in both directions', inbound: 'incoming only', outbound: 'outgoing only',
    allTypes: 'all relationship types',
    onlyTypes: (types: readonly string[]) => types.length ? `only ${types.join(', ')}` : 'no relationship types',
    size: (nodes: number, edges: number) => `${en(nodes)} ${nodes === 1 ? 'symbol' : 'symbols'} and ${en(edges)} ${edges === 1 ? 'relationship' : 'relationships'}`,
    /** The scope finished loading; it is not the whole graph (W4). */
    complete: 'fully loaded',
    loading: 'still loading, so this is a partial preview',
    partial: (error?: string) => `incomplete${error ? `: ${error}` : ''}`,
    /** A layer stopped at the render limit: the layers inside it are whole, it and those further out are not (C1). As the
     * Galaxy tooltip says it, loading stops after the request that passes the limit (5,548 of 5,000), and the scene draws up
     * to the limit. The limit gets a sentence of its own, so nodes never stand beside the symbols of the scope size (W1). */
    renderLimited: (layer: number, limit: number, kind: 'nodes' | 'edges') => `partial. Layer ${layer} stopped loading after the request that took it past `
        + `the render limit of ${en(limit)} ${kind}; the scene draws at most ${en(limit)} ${kind}, `
        + (layer > 1 ? 'so counts and names further out can be incomplete' : 'so counts and names can be incomplete, the direct relationships included'),
    exhausted: 'nothing further beyond this depth',
    scope: (shape: string, size: string, state: string) => `Scope: ${shape}; ${size}; ${state}.`,
    incoming: (total: number, symbols?: number) => `Incoming relationships: ${en(total)}${symbols === undefined ? '' : ` from ${en(symbols)} ${symbols === 1 ? 'symbol' : 'symbols'}`}.`,
    outgoing: (total: number, symbols?: number) => `Outgoing relationships: ${en(total)}${symbols === undefined ? '' : ` to ${en(symbols)} ${symbols === 1 ? 'symbol' : 'symbols'}`}.`,
    noIncoming: 'Incoming relationships: none in this scope.',
    noOutgoing: 'Outgoing relationships: none in this scope.',
    incomingNotLoaded: 'Incoming relationships: not loaded; the scope does not follow incoming edges.',
    outgoingNotLoaded: 'Outgoing relationships: not loaded; the scope does not follow outgoing edges.',
    cut: (side: 'incoming' | 'outgoing') => `${side === 'incoming' ? 'Incoming' : 'Outgoing'} relationships: left out of this snapshot.`,
    truncated: 'the snapshot left part of its relationships out, so counts and names can be incomplete',
    moreTypes: (count: number) => `+${en(count)} more relationship ${count === 1 ? 'type' : 'types'}`,
    internal: (summary: string) => `Between the selected symbols: ${summary}.`,
    beyond: (summary: string) => `Further out in the scope: ${summary}.`,
    selected: (what: string) => `Selected: ${what}.`,
    documentation: (text: string) => `Documentation: ${text}`,
    notInScope: (label: string, kind: string) => `Selected: ${label} (${kind}); its symbols are not in the loaded scope.`,
    selectedGroup: (kind: string, label: string, count: number, listed: string, omitted: number) =>
        `Selected ${kind}: ${label} with ${en(count)} symbols: ${listed}${omitted > 0 ? `; +${en(omitted)} more` : ''}.`,
    callersOf: (name: string) => `Callers of ${name} in the loaded graph`,
    calleesOf: (name: string) => `What ${name} calls in the loaded graph`,
    /** The total of a listed answer: "23 incoming relationships from 12 symbols", never "23 from 12" (C2). */
    total: (side: 'incoming' | 'outgoing', total: number, symbols?: number) => `${en(total)} ${side} ${total === 1 ? 'relationship' : 'relationships'}`
        + `${symbols === undefined ? '' : ` ${side === 'incoming' ? 'from' : 'to'} ${en(symbols)} ${symbols === 1 ? 'symbol' : 'symbols'}`}.`,
    /** One edge type of a listed answer with the number of its symbols: "TESTS (11)". */
    typeCount: (type: string, count: number) => `${type} (${en(count)})`,
    /** What an incoming DEFINES edge from a file, module or class says about the selection. */
    definer: (kind: string, count: number, name: string) => count === 1 ? `the ${kind.toLowerCase()} that defines ${name}` : `the ${kind.toLowerCase()}s that define ${name}`,
    noCalls: (name: string, side: 'incoming' | 'outgoing') => side === 'incoming'
        ? `No CALLS edge reaches ${name} in this scope.` : `${name} has no outgoing CALLS edge in this scope.`,
    otherRelationships: (side: 'incoming' | 'outgoing') => `Other ${side} relationships:`,
    noRelationships: 'None in this scope.',
    notLoaded: (side: 'incoming' | 'outgoing'): string => side === 'incoming'
        ? 'The current scope does not follow incoming relationships. Trace incoming or both directions, then ask again.'
        : 'The current scope does not follow outgoing relationships. Trace outgoing or both directions, then ask again.',
    notExpanded: 'The current scope shows the selection only. Expand it by one layer, then ask again.',
    stillLoading: 'The scope is still loading; this list can grow.',
    listedFromGraph: 'Listed from the indexed graph; not generated by the model.',
    didYouMean: (side: 'incoming' | 'outgoing', name: string) => side === 'incoming' ? `Did you mean: callers of ${name}?` : `Did you mean: what ${name} calls?`,
    didYouMeanBoth: (name: string) => `Did you mean: callers of ${name} and what it calls?`,
    uncertain: 'The question was not recognized for certain. Show the list from the indexed graph, or ask the model instead.',
    uncertainName: (typed: string) => `${typed} is not exactly the name of the selection. Show the list from the indexed graph, or ask the model instead.`,
    showList: 'Show the list',
    /** Offered under a listed answer or a suggestion, which the model did not write. */
    askModel: 'Ask the model',
};
export type RelationshipWords = typeof englishRelationshipWords;

export const relationshipWords: { en: RelationshipWords; de: RelationshipWords } = {
    en: englishRelationshipWords,
    de: {
        from: 'von', to: 'zu',
        more: (count: number) => `+${de(count)} weitere`,
        hops: (depth: number) => depth === 0 ? 'nur die Auswahl' : depth === 1 ? '1 Schritt' : `${depth} Schritte`,
        both: 'in beide Richtungen', inbound: 'nur eingehend', outbound: 'nur ausgehend',
        allTypes: 'alle Beziehungstypen',
        onlyTypes: (types: readonly string[]) => types.length ? `nur ${types.join(', ')}` : 'keine Beziehungstypen',
        size: (nodes: number, edges: number) => `${de(nodes)} ${nodes === 1 ? 'Symbol' : 'Symbole'} und ${de(edges)} ${edges === 1 ? 'Beziehung' : 'Beziehungen'}`,
        complete: 'vollständig geladen',
        loading: 'lädt noch, das ist eine Vorschau',
        partial: (error?: string) => `unvollständig${error ? `: ${error}` : ''}`,
        renderLimited: (layer: number, limit: number, kind: 'nodes' | 'edges') => {
            const unit = kind === 'nodes' ? 'Knoten' : 'Kanten';
            return `unvollständig. Ebene ${layer} hörte nach der Anfrage auf zu laden, die sie über das Darstellungslimit von ${de(limit)} ${unit} brachte; `
                + `die Szene zeichnet höchstens ${de(limit)} ${unit}, `
                + (layer > 1 ? 'daher können Anzahlen und Namen weiter außen fehlen' : 'daher können Anzahlen und Namen fehlen, auch bei den direkten Beziehungen');
        },
        exhausted: 'dahinter folgt nichts mehr',
        scope: (shape: string, size: string, state: string) => `Ausschnitt: ${shape}; ${size}; ${state}.`,
        incoming: (total: number, symbols?: number) => `Eingehende Beziehungen: ${de(total)}${symbols === undefined ? '' : ` aus ${de(symbols)} ${symbols === 1 ? 'Symbol' : 'Symbolen'}`}.`,
        outgoing: (total: number, symbols?: number) => `Ausgehende Beziehungen: ${de(total)}${symbols === undefined ? '' : ` zu ${de(symbols)} ${symbols === 1 ? 'Symbol' : 'Symbolen'}`}.`,
        noIncoming: 'Eingehende Beziehungen: keine in diesem Ausschnitt.',
        noOutgoing: 'Ausgehende Beziehungen: keine in diesem Ausschnitt.',
        incomingNotLoaded: 'Eingehende Beziehungen: nicht geladen; der Ausschnitt folgt keinen eingehenden Kanten.',
        outgoingNotLoaded: 'Ausgehende Beziehungen: nicht geladen; der Ausschnitt folgt keinen ausgehenden Kanten.',
        cut: (side: 'incoming' | 'outgoing') => `${side === 'incoming' ? 'Eingehende' : 'Ausgehende'} Beziehungen: in diesem Schnappschuss ausgelassen.`,
        truncated: 'der Schnappschuss hat einen Teil der Beziehungen ausgelassen, Anzahlen und Namen können unvollständig sein',
        moreTypes: (count: number) => `+${de(count)} weitere ${count === 1 ? 'Beziehungstyp' : 'Beziehungstypen'}`,
        internal: (summary: string) => `Zwischen den ausgewählten Symbolen: ${summary}.`,
        beyond: (summary: string) => `Weiter außen im Ausschnitt: ${summary}.`,
        selected: (what: string) => `Ausgewählt: ${what}.`,
        documentation: (text: string) => `Dokumentation: ${text}`,
        notInScope: (label: string, kind: string) => `Ausgewählt: ${label} (${kind}); seine Symbole sind nicht im geladenen Ausschnitt.`,
        selectedGroup: (kind: string, label: string, count: number, listed: string, omitted: number) =>
            `Ausgewählt (${kind}): ${label} mit ${de(count)} Symbolen: ${listed}${omitted > 0 ? `; +${de(omitted)} weitere` : ''}.`,
        callersOf: (name: string) => `Aufrufer von ${name} im geladenen Graphen`,
        calleesOf: (name: string) => `Was ${name} im geladenen Graphen aufruft`,
        total: (side: 'incoming' | 'outgoing', total: number, symbols?: number) => `${de(total)} ${side === 'incoming' ? 'eingehende' : 'ausgehende'} ${total === 1 ? 'Beziehung' : 'Beziehungen'}`
            + `${symbols === undefined ? '' : ` ${side === 'incoming' ? 'aus' : 'zu'} ${de(symbols)} ${symbols === 1 ? 'Symbol' : 'Symbolen'}`}.`,
        typeCount: (type: string, count: number) => `${type} (${de(count)})`,
        definer: (kind: string, count: number, name: string) => {
            const noun = ({ file: ['die Datei', 'die Dateien'], module: ['das Modul', 'die Module'], class: ['die Klasse', 'die Klassen'] } as Record<string, string[]>)[kind.toLowerCase()]
                ?? [`${kind}`, `${kind}`];
            return count === 1 ? `${noun[0]}, ${noun[0].startsWith('das') ? 'das' : 'die'} ${name} definiert` : `${noun[1]}, die ${name} definieren`;
        },
        noCalls: (name: string, side: 'incoming' | 'outgoing') => side === 'incoming'
            ? `Keine CALLS-Kante führt in diesem Ausschnitt zu ${name}.` : `${name} hat in diesem Ausschnitt keine ausgehende CALLS-Kante.`,
        otherRelationships: (side: 'incoming' | 'outgoing') => `Weitere ${side === 'incoming' ? 'eingehende' : 'ausgehende'} Beziehungen:`,
        noRelationships: 'Keine in diesem Ausschnitt.',
        notLoaded: (side: 'incoming' | 'outgoing') => side === 'incoming'
            ? 'Der aktuelle Ausschnitt folgt keinen eingehenden Beziehungen. Verfolge eingehend oder beide Richtungen und frage noch einmal.'
            : 'Der aktuelle Ausschnitt folgt keinen ausgehenden Beziehungen. Verfolge ausgehend oder beide Richtungen und frage noch einmal.',
        notExpanded: 'Der aktuelle Ausschnitt zeigt nur die Auswahl. Erweitere ihn um eine Ebene und frage noch einmal.',
        stillLoading: 'Der Ausschnitt lädt noch; die Liste kann wachsen.',
        listedFromGraph: 'Aus dem indizierten Graphen gelistet, nicht vom Modell erzeugt.',
        didYouMean: (side: 'incoming' | 'outgoing', name: string) => side === 'incoming' ? `Meintest du: Aufrufer von ${name}?` : `Meintest du: von ${name} aufgerufene Symbole?`,
        didYouMeanBoth: (name: string) => `Meintest du: Aufrufer von ${name} und was ${name} aufruft?`,
        uncertain: 'Die Frage wurde nicht sicher erkannt. Zeige die Liste aus dem indizierten Graphen oder frage stattdessen das Modell.',
        uncertainName: (typed: string) => `${typed} ist nicht genau der Name der Auswahl. Zeige die Liste aus dem indizierten Graphen oder frage stattdessen das Modell.`,
        showList: 'Liste anzeigen',
        askModel: 'Modell fragen',
    },
};

/** Notes of the local chat dock about how an answer was produced or bounded. */
const tokens = (value: number) => value.toLocaleString('en-US');
export const browserChatText = {
    shortened: 'Token limit reached: the answer was cut short',
    /** What the expanded token-limit note says, with the limits the answer ran into. */
    limitReached: (input: number, output: number) => `This answer used all ${tokens(output)} output tokens it was allowed. The input limit is ${tokens(input)} tokens for the question, its source and earlier messages.`,
    limitAutomatic: (automaticInput: number, automatic: number, input: number, output: number) => `Automatic explanations stop after ${tokens(automatic)} output tokens so they stay short, and read at most ${tokens(automaticInput)} input tokens of source and facts. A question in the chat may read up to ${tokens(input)} input tokens and answer with up to ${tokens(output)} output tokens.`,
    outputRoom: (output: number, max: number) => output < max ? `You can raise the output limit up to ${tokens(max)} tokens in the agent configuration.`
        : `The output limit is at the maximum of ${tokens(max)} tokens for this model.`,
    changeOutputLimit: 'Change the output limit',
    largerModels: 'A larger model may stay closer to the question. Each needs a one-time download, and its memory use is higher than the download:',
    modelDownload: (name: string, size: string) => `${name} · ${size} download`,
    newConversation: 'New conversation',
    /** The model's state in the agent configuration (K10). */
    cached: 'Cached',
    loadCached: 'Load model (cached, no download)',
    autoLoad: 'Load the chosen model on start when it is cached',
    autoLoadNote: 'Only from this browser\'s cache; nothing is downloaded on start. A project switch stays in this page and keeps a loaded model without loading it again, so this option only matters when the page is opened or reloaded.',
    resumeFailed: 'The cached model could not be loaded without a download. Load it in the agent configuration.',
    /** Under an answer that names what its source and graph facts do not contain (K12). */
    unsupportedNames: (names: readonly string[]) => `Not in the source or graph facts this answer was given: ${names.join(', ')}. Check these names before relying on them.`,
    /** Who wrote which part of a grounded automatic explanation (K7). */
    factsAndSentence: 'Facts listed from the indexed graph; the last sentence is generated by the model.',
    factsOnly: 'Listed from the indexed graph; not generated by the model.',
    sentenceDropped: "Listed from the indexed graph. The model's sentence named something the evidence does not show and was left out.",
    explanationDropped: "The model's explanation named something the source does not show and was left out. Ask a question about the code instead.",
    /** The same for facts read from an open workflow file (K12). */
    fileFactsAndSentence: 'Facts read from the file; the text after them is generated by the model.',
    fileFactsOnly: 'Read from the file; not generated by the model.',
    fileSentenceDropped: "Read from the file. The model's text named something the file does not show and was left out.",
    writingSentence: 'Reading the source; the model is adding one sentence…',
    readingFacts: 'Listing the facts…',
    /** Above the first question about another file or selection (K17). */
    topicBreak: (label: string) => `New topic: ${label}. Earlier messages are not sent with these questions.`,
    capacity: (nodes: number, edges: number, model: string, shown: number) =>
        `${nodes} nodes / ${edges} edges: too large for the local ${model} model; showing ${shown}`,
    historyTrimmed: (count: number) => `${count} earlier ${count === 1 ? 'message was' : 'messages were'} left out to fit the input limit.`,
    waitingForScope: 'Waiting for the complete scope before explaining…',
    partialScope: 'This scope did not load completely, so it is not explained automatically.',
    tokenLimits: (model: string) => `Token limits for ${model}`,
    inputLimit: 'Input (context)',
    outputLimit: 'Output (answer)',
    limitRange: (min: number, max: number) => `${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} tokens`,
    limitsNote: (input: number, output: number) => `Stored in this browser for each model. Automatic explanations use at most ${input.toLocaleString('en-US')} input and ${output.toLocaleString('en-US')} output tokens.`,
};

/** Who wrote which part of the answer to a general question about a selection, in its language (C5). */
export const groundedText = {
    en: { factsAndSentence: browserChatText.factsAndSentence, factsOnly: browserChatText.factsOnly, sentenceDropped: browserChatText.sentenceDropped,
        writingSentence: browserChatText.writingSentence },
    de: {
        factsAndSentence: 'Fakten aus dem indizierten Graphen gelistet; der letzte Satz ist vom Modell erzeugt.',
        factsOnly: 'Aus dem indizierten Graphen gelistet, nicht vom Modell erzeugt.',
        sentenceDropped: 'Aus dem indizierten Graphen gelistet. Der Satz des Modells nannte etwas, das die Fakten nicht zeigen, und wurde weggelassen.',
        writingSentence: 'Der Quelltext wird gelesen; das Modell fügt einen Satz hinzu…',
    },
};

/** The reply to a prompt that asks nothing ("test", "hallo"): questions it could ask (C6). */
export const noQuestionText = {
    en: {
        heading: (typed: string) => `No question was recognized in "${typed}". You can ask, for example:`,
        note: 'Answered without the model.',
        whatDoes: (name: string) => `What does ${name} do?`,
        whoCalls: (name: string) => `Who calls ${name}?`,
        whatCalls: (name: string) => `What does ${name} call?`,
        inDetail: (name: string) => `Explain ${name} in detail.`,
        markedDoes: 'What does the marked code do?',
        markedInDetail: 'Explain the marked code line by line.',
    },
    de: {
        heading: (typed: string) => `In "${typed}" wurde keine Frage erkannt. Frage zum Beispiel:`,
        note: 'Ohne das Modell beantwortet.',
        whatDoes: (name: string) => `Was macht ${name}?`,
        whoCalls: (name: string) => `Wer ruft ${name} auf?`,
        whatCalls: (name: string) => `Was ruft ${name} auf?`,
        inDetail: (name: string) => `Erklär ${name} ausführlich.`,
        markedDoes: 'Was macht der markierte Code?',
        markedInDetail: 'Erklär den markierten Code Zeile für Zeile.',
    },
};

/** The chat's own reply when a question has no code or graph context (K11), in the language of the question. */
export const browserChatContextText = {
    en: {
        nothingSelected: 'Nothing is selected for me to explain. Select a node in Galaxy or a part in Architecture, or open a file in Explore, then ask again.',
        noFileOpen: 'No file is open in Explore. Open a file, or mark code in it, then ask again.',
        sourceUnavailable: (path: string) => `The source of \`${path.replace(/`/g, "'")}\` is not available. Open the file again or choose another one, then ask again.`,
        notAsked: 'Answered without the model: without code or graph facts it could only guess.',
    },
    de: {
        nothingSelected: 'Es ist nichts ausgewählt, das ich erklären könnte. Wähle einen Knoten in Galaxy oder einen Teil in Architecture, oder öffne eine Datei in Explore, und frage dann noch einmal.',
        noFileOpen: 'In Explore ist keine Datei geöffnet. Öffne eine Datei oder markiere Code darin und frage dann noch einmal.',
        sourceUnavailable: (path: string) => `Der Quelltext von \`${path.replace(/`/g, "'")}\` ist nicht verfügbar. Öffne die Datei noch einmal oder wähle eine andere und frage dann noch einmal.`,
        notAsked: 'Ohne das Modell beantwortet: ohne Code oder Graph-Fakten könnte es nur raten.',
    },
};

const count = (value: number) => value.toLocaleString('en-US');
const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;
/** Architecture selections as sentences: for the prompt and for the explanation card. */
export const architectureWords = {
    kinds: { area: 'source area', file: 'file', symbol: 'symbol', route: 'route' },
    more: (value: number) => `+${count(value)} more`,
    selected: (kind: string, name: string, detail?: string) => `Selected ${kind}: ${name}${detail ? ` (${detail})` : ''}.`,
    selectedSymbol: (symbol: string) => `Selected symbol: ${symbol}.`,
    openedArea: (path: string) => `Opened source area: ${path}.`,
    openedFile: (path: string) => `Opened file: ${path}.`,
    openedHotspots: (path: string) => `Opened hotspot area: ${path}.`,
    scopePart: (name: string, kind: string, files?: number, lines?: number) =>
        `${name} (${kind}${files !== undefined ? `, ${plural(files, 'file', 'files')}` : ''}${lines !== undefined ? `, ${plural(lines, 'indexed line', 'indexed lines')}` : ''})`,
    /** The parts a view shows of an opened area or file: the ones inside it, largest first, and the ones outside it. */
    parts: (items: readonly string[], total: number, scope: 'area' | 'file' = 'area', outside: readonly string[] = [], outsideTotal = outside.length) => {
        const more = (listed: readonly string[], all: number) => all > listed.length ? `, +${count(all - listed.length)} more` : '';
        if (!outsideTotal) return `Parts shown (${count(total)}, largest first): ${items.join(', ')}${total > items.length ? `; ${count(total - items.length)} more` : ''}.`;
        const inside = total ? `${count(total)} inside the ${scope}, largest first: ${items.join(', ')}${more(items, total)}; ` : '';
        return `Parts shown (${count(total + outsideTotal)}): ${inside}${count(outsideTotal)} outside it: ${outside.join(', ')}${more(outside, outsideTotal)}.`;
    },
    outside: (name: string) => `${name} (outside)`,
    partConnections: (described: readonly string[], omitted: number) => `Connections of its parts: ${described.join('; ')}${omitted ? `; ${plural(omitted, 'more connection', 'more connections')} not listed` : ''}.`,
    measured: (lines: number, measured: number, files: number, languages: readonly string[]) =>
        `${plural(lines, 'indexed line', 'indexed lines')} in ${plural(measured, 'measured file', 'measured files')} of ${count(files)}${languages.length ? `; files by language: ${languages.join(', ')}` : ''}.`,
    fanIn: (value: number) => `fan-in ${count(value)}`,
    complexity: (value: number) => `complexity ${count(value)}`,
    hotspots: (total: number, ranked: readonly string[]) => `${plural(total, 'hotspot finding', 'hotspot findings')}: ${ranked.join(', ')}.`,
    members: (listed: string) => `Indexed members include ${listed}.`,
    to: (name: string) => `to ${name}`,
    from: (name: string) => `from ${name}`,
    connections: (described: readonly string[], omitted: number) => `Connections ${described.join('; ')}${omitted ? `; ${plural(omitted, 'more connection', 'more connections')} not listed` : ''}.`,
    view: (view: string, nodes: number, edges: number) => `The ${view} view shows ${plural(nodes, 'part', 'parts')} and ${plural(edges, 'connection', 'connections')}.`,
    connection: (source: string, target: string, type: string, total?: number) => `Selected connection: ${source} → ${target}, ${type}${total !== undefined ? ` ×${count(total)}` : ''}.`,
    example: (from: string, type: string, to: string, where?: string) => `${from} ${type} ${to}${where ? ` (${where})` : ''}`,
    examples: (items: readonly string[]) => `For example: ${items.join('; ')}.`,
    operation: (symbol: string) => `Starting operation: ${symbol}.`,
    call: (caller: string, callee: string, where?: string) => `Selected call: ${caller} calls ${callee}${where ? ` at ${where}` : ''}.`,
    callAt: (line: number, args: readonly string[], callee?: string) => `line ${line}${callee ? ` calls ${callee}` : ''}${args.length ? ` with ${args.join(', ')}` : ''}`,
    directCalls: (total: number, calls: readonly string[]) => `${plural(total, 'direct call', 'direct calls')} with call-site evidence${calls.length ? `: ${calls.join('; ')}` : ''}.`,
    path: (names: readonly string[]) => `Call chain: ${names.join(' → ')}.`,
    component: (name: string, members?: number, files?: number) => `Component: ${name}${members !== undefined ? `, ${plural(members, 'member', 'members')}` : ''}${files !== undefined ? ` in ${plural(files, 'file', 'files')}` : ''}.`,
    part: (kind: 'component' | 'group', name: string, members?: number, files?: number, components?: number, role?: string) =>
        `Selected ${kind}: ${name}${components !== undefined ? `, ${plural(components, 'component', 'components')}` : ''}${members !== undefined ? `, ${plural(members, 'member', 'members')}` : ''}${files !== undefined ? ` in ${plural(files, 'file', 'files')}` : ''}${role === 'test' ? ', tests' : ''}.`,
    representatives: (listed: string) => `Representative symbols: ${listed}.`,
    incoming: (items: readonly string[], total: number) => `Incoming from ${items.join(', ')}${total > items.length ? `; ${count(total - items.length)} more` : ''}.`,
    outgoing: (items: readonly string[], total: number) => `Outgoing to ${items.join(', ')}${total > items.length ? `; ${count(total - items.length)} more` : ''}.`,
};

const counted = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`;
const gezaehlt = (value: number, one: string, many: string) => `${value.toLocaleString('de-DE')} ${value === 1 ? one : many}`;
/** A GitHub Actions workflow as facts counted from its keys: for the prompt and the explanation card (K12). */
export const workflowWords = {
    heading: 'Facts read from the file (counted, not guessed):',
    name: (name: string) => `Workflow name: ${name}.`,
    triggers: (items: readonly string[]) => `${items.length === 1 ? 'Trigger' : 'Triggers'}: ${items.join(', ')}.`,
    trigger: (event: string, types: readonly string[]) => `${event}${types.length ? ` (types: ${types.join(', ')})` : ''}`,
    jobs: (total: number, items: readonly string[]) => `${counted(total, 'job', 'jobs')}: ${items.join('; ')}${total > items.length ? `; +${(total - items.length).toLocaleString('en-US')} more` : ''}.`,
    job: (id: string, name: string | undefined, runsOn: string | undefined, steps: number) =>
        `${id} (${[name ? `"${name}"` : '', runsOn ? `runs on ${runsOn}` : '', counted(steps, 'step', 'steps')].filter(Boolean).join(', ')})`,
    uses: (items: readonly string[]) => `Actions used: ${items.join(', ')}.`,
};
export type WorkflowWords = typeof workflowWords;
/** The same facts for an outline asked for in German (C7). */
export const germanWorkflowWords: WorkflowWords = {
    heading: 'Aus der Datei gelesene Fakten (gezählt, nicht geraten):',
    name: (name: string) => `Name des Workflows: ${name}.`,
    triggers: (items: readonly string[]) => `Auslöser: ${items.join(', ')}.`,
    trigger: (event: string, types: readonly string[]) => `${event}${types.length ? ` (Typen: ${types.join(', ')})` : ''}`,
    jobs: (total: number, items: readonly string[]) => `${gezaehlt(total, 'Job', 'Jobs')}: ${items.join('; ')}${total > items.length ? `; +${(total - items.length).toLocaleString('de-DE')} weitere` : ''}.`,
    job: (id: string, name: string | undefined, runsOn: string | undefined, steps: number) =>
        `${id} (${[name ? `"${name}"` : '', runsOn ? `läuft auf ${runsOn}` : '', gezaehlt(steps, 'Schritt', 'Schritte')].filter(Boolean).join(', ')})`,
    uses: (items: readonly string[]) => `Verwendete Actions: ${items.join(', ')}.`,
};

/** The outline of a configuration file, answered from the file instead of the model (C7). */
const englishOutlineWords = {
    heading: (name: string, kind: string, lines: number) => `${name}: ${kind}, ${counted(lines, 'line', 'lines')}. Read from the file:`,
    kinds: { yaml: 'YAML configuration', json: 'JSON data', toml: 'TOML configuration', workflow: 'GitHub Actions workflow' },
    list: (total: number) => `list of ${total.toLocaleString('en-US')}`,
    keys: (total: number) => counted(total, 'key', 'keys'),
    empty: 'empty',
    text: 'text block',
    more: (total: number) => `+${total.toLocaleString('en-US')} more`,
    cut: 'The rest of the file is left out here.',
    note: 'Read from the file; not generated by the model.',
};
export const fileOutlineWords: { en: typeof englishOutlineWords; de: typeof englishOutlineWords } = {
    en: englishOutlineWords,
    de: {
        heading: (name: string, kind: string, lines: number) => `${name}: ${kind}, ${gezaehlt(lines, 'Zeile', 'Zeilen')}. Aus der Datei gelesen:`,
        kinds: { yaml: 'YAML-Konfiguration', json: 'JSON-Daten', toml: 'TOML-Konfiguration', workflow: 'GitHub-Actions-Workflow' },
        list: (total: number) => `Liste mit ${gezaehlt(total, 'Eintrag', 'Einträgen')}`,
        keys: (total: number) => gezaehlt(total, 'Schlüssel', 'Schlüssel'),
        empty: 'leer',
        text: 'Textblock',
        more: (total: number) => `+${total.toLocaleString('de-DE')} weitere`,
        cut: 'Der Rest der Datei ist hier ausgelassen.',
        note: 'Aus der Datei gelesen, nicht vom Modell erzeugt.',
    },
};

const listed = (items: readonly string[], total: number) => `${items.join(', ')}${total > items.length ? `, +${(total - items.length).toLocaleString('en-US')} more` : ''}`;
/** A configuration or text file as facts read from its text: for the prompt and the explanation card (K12). */
export const fileWords = {
    kind: (kind: string, lines?: number) => `File kind: ${kind}${lines === undefined ? '' : `; ${counted(lines, 'line', 'lines')}`}.`,
    selected: (start: number, end: number) => start === end ? `Selected line ${start} of the file.` : `Selected lines ${start}-${end} of the file.`,
    topKeys: (total: number, items: readonly string[]) => `Top-level keys (${total.toLocaleString('en-US')}): ${listed(items, total)}.`,
    keys: (total: number, items: readonly string[]) => `Keys (${total.toLocaleString('en-US')}): ${listed(items, total)}.`,
    /** What a key holds: "(2 keys: `web`, `db`)", "(list of 2)", "(text)". */
    children: (total: number, items: readonly string[]) => total ? `${counted(total, 'key', 'keys')}: ${listed(items, total)}` : 'no keys',
    keyCount: (total: number) => counted(total, 'key', 'keys'),
    list: (total: number) => `list of ${total.toLocaleString('en-US')}`,
    /** The keys the items of a list have: "item keys: `repo`, `rev`, `hooks`". */
    itemKeys: (total: number, items: readonly string[]) => `item keys: ${listed(items, total)}`,
    value: { text: 'text', number: 'number', boolean: 'true or false', empty: 'null' },
    items: (total: number) => `A list of ${counted(total, 'item', 'items')}.`,
    invalidJson: 'The text is not valid JSON, so no keys are counted.',
    tables: (total: number, items: readonly string[]) => `Tables (${total.toLocaleString('en-US')}): ${listed(items, total)}.`,
    sections: (total: number, items: readonly string[]) => `Sections (${total.toLocaleString('en-US')}): ${listed(items, total)}.`,
    title: (title: string) => `Title: ${title}.`,
    codeBlocks: (total: number) => `${counted(total, 'code block', 'code blocks')}.`,
    patterns: (total: number, items: readonly string[]) => `${counted(total, 'pattern', 'patterns')}: ${listed(items, total)}.`,
    root: (name: string) => `Root element: ${name}.`,
};
