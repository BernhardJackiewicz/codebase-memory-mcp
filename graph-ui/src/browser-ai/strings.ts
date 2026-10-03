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
 * relationship answer, which follows the language of the question. */
const englishRelationshipWords = {
    from: 'from', to: 'to',
    more: (count: number) => `+${count} more`,
    hops: (depth: number) => depth === 0 ? 'the selection only' : depth === 1 ? '1 hop' : `${depth} hops`,
    both: 'in both directions', inbound: 'incoming only', outbound: 'outgoing only',
    allTypes: 'all relationship types',
    onlyTypes: (types: readonly string[]) => types.length ? `only ${types.join(', ')}` : 'no relationship types',
    size: (nodes: number, edges: number) => `${nodes} ${nodes === 1 ? 'symbol' : 'symbols'} and ${edges} ${edges === 1 ? 'relationship' : 'relationships'}`,
    complete: 'complete for the indexed graph',
    loading: 'still loading, so this is a partial preview',
    partial: (error?: string) => `incomplete${error ? `: ${error}` : ''}`,
    exhausted: 'nothing further beyond this depth',
    scope: (shape: string, size: string, state: string) => `Scope: ${shape}; ${size}; ${state}.`,
    incoming: (total: number, symbols?: number) => `Incoming relationships: ${total}${symbols === undefined ? '' : ` from ${symbols} ${symbols === 1 ? 'symbol' : 'symbols'}`}.`,
    outgoing: (total: number, symbols?: number) => `Outgoing relationships: ${total}${symbols === undefined ? '' : ` to ${symbols} ${symbols === 1 ? 'symbol' : 'symbols'}`}.`,
    noIncoming: 'Incoming relationships: none in this scope.',
    noOutgoing: 'Outgoing relationships: none in this scope.',
    incomingNotLoaded: 'Incoming relationships: not loaded; the scope does not follow incoming edges.',
    outgoingNotLoaded: 'Outgoing relationships: not loaded; the scope does not follow outgoing edges.',
    cut: (side: 'incoming' | 'outgoing') => `${side === 'incoming' ? 'Incoming' : 'Outgoing'} relationships: left out of this snapshot.`,
    truncated: 'the snapshot left part of its relationships out, so counts and names can be incomplete',
    moreTypes: (count: number) => `+${count} more relationship ${count === 1 ? 'type' : 'types'}`,
    internal: (summary: string) => `Between the selected symbols: ${summary}.`,
    beyond: (summary: string) => `Further out in the scope: ${summary}.`,
    callersOf: (name: string) => `Callers of ${name} in the loaded graph`,
    calleesOf: (name: string) => `Called by ${name} in the loaded graph`,
    noCalls: (name: string, side: 'incoming' | 'outgoing') => side === 'incoming'
        ? `No CALLS edge reaches ${name} in this scope.` : `${name} has no outgoing CALLS edge in this scope.`,
    otherRelationships: 'Other relationships in the same direction:',
    noRelationships: 'None in this scope.',
    notLoaded: (side: 'incoming' | 'outgoing'): string => side === 'incoming'
        ? 'The current scope does not follow incoming relationships. Trace incoming or both directions, then ask again.'
        : 'The current scope does not follow outgoing relationships. Trace outgoing or both directions, then ask again.',
    notExpanded: 'The current scope shows the selection only. Expand it by one layer, then ask again.',
    stillLoading: 'The scope is still loading; this list can grow.',
    listedFromGraph: 'Listed from the indexed graph; not generated by the model.',
    didYouMean: (side: 'incoming' | 'outgoing', name: string) => side === 'incoming' ? `Did you mean: callers of ${name}?` : `Did you mean: what ${name} calls?`,
    uncertain: 'The question was not recognized for certain. Show the list from the indexed graph, or ask the model instead.',
    showList: 'Show the list',
};
export type RelationshipWords = typeof englishRelationshipWords;

export const relationshipWords: { en: RelationshipWords; de: RelationshipWords } = {
    en: englishRelationshipWords,
    de: {
        from: 'von', to: 'zu',
        more: (count: number) => `+${count} weitere`,
        hops: (depth: number) => depth === 0 ? 'nur die Auswahl' : depth === 1 ? '1 Schritt' : `${depth} Schritte`,
        both: 'in beide Richtungen', inbound: 'nur eingehend', outbound: 'nur ausgehend',
        allTypes: 'alle Beziehungstypen',
        onlyTypes: (types: readonly string[]) => types.length ? `nur ${types.join(', ')}` : 'keine Beziehungstypen',
        size: (nodes: number, edges: number) => `${nodes} ${nodes === 1 ? 'Symbol' : 'Symbole'} und ${edges} ${edges === 1 ? 'Beziehung' : 'Beziehungen'}`,
        complete: 'vollständig für den indizierten Graphen',
        loading: 'lädt noch, das ist eine Vorschau',
        partial: (error?: string) => `unvollständig${error ? `: ${error}` : ''}`,
        exhausted: 'dahinter folgt nichts mehr',
        scope: (shape: string, size: string, state: string) => `Ausschnitt: ${shape}; ${size}; ${state}.`,
        incoming: (total: number, symbols?: number) => `Eingehende Beziehungen: ${total}${symbols === undefined ? '' : ` von ${symbols} ${symbols === 1 ? 'Symbol' : 'Symbolen'}`}.`,
        outgoing: (total: number, symbols?: number) => `Ausgehende Beziehungen: ${total}${symbols === undefined ? '' : ` zu ${symbols} ${symbols === 1 ? 'Symbol' : 'Symbolen'}`}.`,
        noIncoming: 'Eingehende Beziehungen: keine in diesem Ausschnitt.',
        noOutgoing: 'Ausgehende Beziehungen: keine in diesem Ausschnitt.',
        incomingNotLoaded: 'Eingehende Beziehungen: nicht geladen; der Ausschnitt folgt keinen eingehenden Kanten.',
        outgoingNotLoaded: 'Ausgehende Beziehungen: nicht geladen; der Ausschnitt folgt keinen ausgehenden Kanten.',
        cut: (side: 'incoming' | 'outgoing') => `${side === 'incoming' ? 'Eingehende' : 'Ausgehende'} Beziehungen: in diesem Schnappschuss ausgelassen.`,
        truncated: 'der Schnappschuss hat einen Teil der Beziehungen ausgelassen, Anzahlen und Namen können unvollständig sein',
        moreTypes: (count: number) => `+${count} weitere ${count === 1 ? 'Beziehungstyp' : 'Beziehungstypen'}`,
        internal: (summary: string) => `Zwischen den ausgewählten Symbolen: ${summary}.`,
        beyond: (summary: string) => `Weiter außen im Ausschnitt: ${summary}.`,
        callersOf: (name: string) => `Aufrufer von ${name} im geladenen Graphen`,
        calleesOf: (name: string) => `Von ${name} aufgerufen, im geladenen Graphen`,
        noCalls: (name: string, side: 'incoming' | 'outgoing') => side === 'incoming'
            ? `Keine CALLS-Kante führt in diesem Ausschnitt zu ${name}.` : `${name} hat in diesem Ausschnitt keine ausgehende CALLS-Kante.`,
        otherRelationships: 'Weitere Beziehungen in derselben Richtung:',
        noRelationships: 'Keine in diesem Ausschnitt.',
        notLoaded: (side: 'incoming' | 'outgoing') => side === 'incoming'
            ? 'Der aktuelle Ausschnitt folgt keinen eingehenden Beziehungen. Verfolge eingehend oder beide Richtungen und frage noch einmal.'
            : 'Der aktuelle Ausschnitt folgt keinen ausgehenden Beziehungen. Verfolge ausgehend oder beide Richtungen und frage noch einmal.',
        notExpanded: 'Der aktuelle Ausschnitt zeigt nur die Auswahl. Erweitere ihn um eine Ebene und frage noch einmal.',
        stillLoading: 'Der Ausschnitt lädt noch; die Liste kann wachsen.',
        listedFromGraph: 'Aus dem indizierten Graphen gelistet, nicht vom Modell erzeugt.',
        didYouMean: (side: 'incoming' | 'outgoing', name: string) => side === 'incoming' ? `Meintest du: Aufrufer von ${name}?` : `Meintest du: von ${name} aufgerufene Symbole?`,
        uncertain: 'Die Frage wurde nicht sicher erkannt. Zeige die Liste aus dem indizierten Graphen oder frage stattdessen das Modell.',
        showList: 'Liste anzeigen',
    },
};

/** Notes of the local chat dock about how an answer was produced or bounded. */
const tokens = (value: number) => value.toLocaleString('en-US');
export const browserChatText = {
    shortened: 'Token limit reached: the answer was cut short',
    /** What the expanded token-limit note says, with the limits the answer ran into. */
    limitReached: (input: number, output: number) => `This answer used all ${tokens(output)} output tokens it was allowed. The input limit is ${tokens(input)} tokens for the question, its source and earlier messages.`,
    limitAutomatic: (automatic: number, output: number) => `Automatic explanations stop after ${tokens(automatic)} output tokens so they stay short. A question in the chat may answer with up to ${tokens(output)} output tokens.`,
    outputRoom: (output: number, max: number) => output < max ? `You can raise the output limit up to ${tokens(max)} tokens in the agent configuration.`
        : `The output limit is at the maximum of ${tokens(max)} tokens for this model.`,
    changeOutputLimit: 'Change the output limit',
    largerModels: 'A larger model may stay closer to the question. Each needs a one-time download, and its memory use is higher than the download:',
    modelDownload: (name: string, size: string) => `${name} · ${size} download`,
    newConversation: 'New conversation',
    /** Above the first question about another file or selection (K17). */
    topicBreak: (label: string) => `New topic: ${label}. Earlier messages are not sent with these questions.`,
    /** Offered under a listed answer, which the model did not write. */
    askModel: 'Ask the model',
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

/** The chat's own reply when a question has no code or graph context (K11), in the language of the question. */
export const browserChatContextText = {
    en: {
        nothingSelected: 'Nothing is selected for me to explain yet. Select a node in Galaxy or a part in Architecture, or open a file in Explore, then ask again.',
        noFileOpen: 'No file is open in Explore. Open a file, or mark code in it, then ask again.',
        sourceUnavailable: (path: string) => `The source of \`${path.replace(/`/g, "'")}\` is not available. Open the file again or choose another one, then ask again.`,
        notAsked: 'Answered without the model: without code or graph facts it could only guess.',
    },
    de: {
        nothingSelected: 'Es ist noch nichts ausgewählt, das ich erklären könnte. Wähle einen Knoten in Galaxy oder einen Teil in Architecture, oder öffne eine Datei in Explore, und frage dann noch einmal.',
        noFileOpen: 'In Explore ist keine Datei geöffnet. Öffne eine Datei oder markiere Code darin und frage dann noch einmal.',
        sourceUnavailable: (path: string) => `Der Quelltext von \`${path.replace(/`/g, "'")}\` ist nicht verfügbar. Öffne die Datei noch einmal oder wähle eine andere und frage dann noch einmal.`,
        notAsked: 'Ohne das Modell beantwortet: ohne Code oder Graph-Fakten könnte es nur raten.',
    },
};
