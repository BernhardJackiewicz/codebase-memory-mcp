import { useEffect, useMemo, useRef, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import type { BrowserAiProgress } from './browser-ai-controller';
import { createBrowserChatRuntime, type BrowserChatRuntime } from './browser-ai-runtime';
import { BROWSER_MODELS, getBrowserModel, isBrowserModelCached, removeBrowserModelCache, type BrowserModel } from './model-policy';
import { takeAgentResume } from './agent-resume';
import { buildChatMessages, selectionLocation, snapshotAttachment, snapshotReaderContext, trimChatHistory, type BrowserChatAttachment, type BrowserChatContext, type BrowserChatReaderContext, type BrowserChatSource, type BrowserChatTurn } from './chat-model';
import { explanationInput, EXPLANATION_DELAY_MS, type ExplanationInput } from './proactive-selection';
import { prepareExplanationContext, selectionSummary, type PreparedExplanationContext } from './explanation-context';
import { AUTO_INPUT_TOKENS, AUTO_OUTPUT_TOKENS, citedInterpretation, explanationMode, explanationSentence, namesNotIn, parseExplanationResponse, explanationMessages, formatExplanationEvidence } from './explanation-response';
import { carriedSource, selectionSubject, SYMBOL_SOURCE_LINES, sourceTargetOf, symbolSource, type SymbolSourceReader } from './symbol-source';
import { relationshipAnswer, relationshipSuggestion } from './relationship-answer';
import { clampTokenLimits, tokenLimitBounds, tokenLimitsFor, useAgentPreferences, type TokenLimits } from './agent-preferences';
import { browserChatText, relationshipWords } from './strings';
import { isGpuRuntimeFailure, BrowserRuntimeFatalError } from './runtime-fault';
import ChatMarkdown from './ChatMarkdown';
import AgentSettingsDialog from './AgentSettingsDialog';
import { useChatHistory } from './use-chat-history';
import { chatTopic, followedTopic, missingContextAnswer } from './chat-context';
import './browser-chat.css';

export type { BrowserChatAttachment, BrowserChatContext, BrowserChatReaderContext, BrowserChatSource } from './chat-model';
export interface BrowserChatDockProps {
    proactiveSelection?: BrowserChatContext;
    selectionScope?: string;
    historyKey?: string;
    proactive?: boolean;
    onAgentStateChange?: (state: 'off' | 'loading' | 'active' | 'busy' | 'error') => void;
    settingsRequest?: number;
    onAgentModelChange?: (name: string) => void;
    open: boolean;
    onClose: () => void;
    showCollapsed?: boolean;
    onOpen?: () => void;
    attachment?: BrowserChatAttachment;
    readerContext?: BrowserChatReaderContext;
    context?: readonly BrowserChatContext[];
    pendingContext?: BrowserChatContext;
    onContextConsumed?: (id: string) => void;
    onContextRemoved?: (id: string) => void;
    onAttachmentConsumed: (id: string) => void;
    onAttachmentRemoved?: (id: string) => void;
    createRuntime?: (modelId: string) => BrowserChatRuntime;
    removeCache?: (modelId: string) => Promise<void>;
    /** Reads a selected symbol's source (get_code_snippet), so explanations stand on code, not names. */
    readSource?: SymbolSourceReader;
    /** Whether a model's files are in the browser cache (K10). */
    isCached?: (modelId: string) => Promise<boolean>;
}

type Phase = 'off' | 'preparing' | 'ready' | 'counting' | 'generating' | 'removing';
type ChatTurn = BrowserChatTurn & { evidence?: PreparedExplanationContext };
type Explanation = { key: string; label: string; answer: string; status: string; error?: string; packet?: PreparedExplanationContext; citation?: ReturnType<typeof citedInterpretation>; mode?: 'interpretation'; shortened?: boolean; limit?: TokenLimits; evidence?: string };
/** Finished explanations per selection, so returning to one does not run the model again. */
const EXPLANATION_CACHE_SIZE = 32;
const initialModel = BROWSER_MODELS.find(model => model.availability === 'available')!;
const cachedInBrowser = (modelId: string) => isBrowserModelCached(getBrowserModel(modelId)).catch(() => false);
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const sizeLabel = (bytes: number): string => bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : `${Math.ceil(bytes / 1_000_000)} MB`;
/** Symbol sources read for explanations and questions, newest last. */
const SOURCE_CACHE_SIZE = 32;

/** The listed facts first, then the model's sentence if it stood the check, then who wrote what (K7). */
function groundedExplanation(summary: readonly string[], sentence: string | undefined, dropped: boolean): string {
    const note = sentence ? browserChatText.factsAndSentence : dropped ? browserChatText.sentenceDropped : browserChatText.factsOnly;
    return [summary.map(line => `- ${line}`).join('\n'), ...sentence ? [sentence] : [], `_${note}_`].join('\n\n');
}

function Attachment({ attachment, label }: { attachment: BrowserChatAttachment; label?: string }): JSX.Element {
    return <details className="cbm-chat-attachment">
        <summary><span aria-hidden="true">⌁</span> {label && `${label} · `}{selectionLocation(attachment)}</summary>
        <pre>{attachment.text}</pre>
        <small>{attachment.project} · Source {attachment.sourceVersion}</small>
    </details>;
}

function SourceDisclosure({ children, title }: { children?: ReactNode; title?: string }): JSX.Element {
    return children ? <details className="cbm-chat-response-source">
        <summary aria-label="Source for this answer"><span className="cbm-chat-speaker" title={title}>Agent</span><span className="cbm-chat-source-toggle">ⓘ Source</span></summary>
        <div className="cbm-chat-source-content">{children}</div>
    </details> : <span className="cbm-chat-speaker" title={title}>Agent</span>;
}

/** Where an answer stopped and what can be changed: the limits it ran into, the way to
 * the output limit and the larger models with their download. */
interface LimitNote { limit: TokenLimits; automatic?: boolean; chatOutput: number; model: BrowserModel; onChangeOutput: () => void }
function TokenLimitNote({ limit, automatic, chatOutput, model, onChangeOutput }: LimitNote): JSX.Element {
    const larger = BROWSER_MODELS.filter(candidate => candidate.availability === 'available' && candidate.bytes > model.bytes);
    return <details className="cbm-chat-limit-note">
        <summary>{browserChatText.shortened}</summary>
        <p>{automatic ? browserChatText.limitAutomatic(limit.outputTokens, chatOutput) : browserChatText.limitReached(limit.inputTokens, limit.outputTokens)}</p>
        <p>{browserChatText.outputRoom(chatOutput, model.maxOutputTokens)}</p>
        <button type="button" onClick={onChangeOutput}>{browserChatText.changeOutputLimit}</button>
        {larger.length > 0 && <><p>{browserChatText.largerModels}</p>
            <ul>{larger.map(candidate => <li key={candidate.id}>{browserChatText.modelDownload(candidate.displayName, sizeLabel(candidate.bytes))}</li>)}</ul></>}
    </details>;
}

/** How an answer was bounded: cut at the output limit, scope too large, history left out,
 * and which of its names the model was not given. */
function AnswerNotes({ shortened, packet, model, historyOmitted, unsupported = [] }: { shortened?: LimitNote; packet?: PreparedExplanationContext; model: string; historyOmitted?: number; unsupported?: readonly string[] }): JSX.Element {
    const capacity = packet?.capacity;
    return <>
        {unsupported.length > 0 && <small className="cbm-chat-answer-note">{browserChatText.unsupportedNames(unsupported.slice(0, 6))}</small>}
        {shortened && <TokenLimitNote {...shortened} />}
        {capacity && <small className="cbm-chat-answer-note">{browserChatText.capacity(capacity.nodes, capacity.edges, model, capacity.shown)}</small>}
        {!!historyOmitted && <small className="cbm-chat-answer-note">{browserChatText.historyTrimmed(historyOmitted)}</small>}
    </>;
}

/** `codeOnly` where the listed facts already stand above it, in the explanation card. */
function PacketSource({ packet, citation, codeOnly = false }: { packet: PreparedExplanationContext; citation?: ReturnType<typeof citedInterpretation>; codeOnly?: boolean }): JSX.Element {
    return <>
        {packet.limitations.map((limit, index) => <p className="cbm-chat-evidence-note" key={index}>{limit}</p>)}
        {citation ? <pre>{citation.quote}</pre> : packet.evidence.filter(item => !codeOnly || item.source === 'code').slice(0, 3).map(item => <div key={item.id}>
            {item.location && <small>{item.location.path}:{item.location.startLine}-{item.location.endLine}</small>}<pre>{item.text}</pre>
        </div>)}
    </>;
}

/** A typed limit applies on blur or Enter, clamped into the model policy. */
function TokenLimitField({ id, label, value, min, max, step, onCommit }: { id: string; label: string; value: number; min: number; max: number; step: number; onCommit: (value: number) => void }): JSX.Element {
    const [text, setText] = useState(String(value));
    useEffect(() => { setText(String(value)); }, [value]);
    const commit = (): void => {
        const typed = Number.parseInt(text, 10);
        const next = Number.isFinite(typed) ? Math.min(max, Math.max(min, typed)) : value;
        setText(String(next));
        if (next !== value) onCommit(next);
    };
    return <div className="cbm-chat-token-limit">
        <label htmlFor={id}>{label}</label>
        <input id={id} type="number" inputMode="numeric" min={min} max={max} step={step} value={text} aria-describedby={`${id}-range`}
            onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }} />
        <small id={`${id}-range`}>{browserChatText.limitRange(min, max)}</small>
    </div>;
}

function ContextSnapshot({ context }: { context: BrowserChatContext }): JSX.Element {
    return <details className="cbm-chat-attachment"><summary>{context.label}</summary><pre>{context.text}</pre></details>;
}

/** Keep mounted when collapsed: state and worker lifetime are independent of visibility. */
export default function BrowserChatDock({ proactiveSelection, selectionScope = "", historyKey, proactive = true, onAgentStateChange, onAgentModelChange, settingsRequest = 0, open, onClose, showCollapsed = false, onOpen, attachment, readerContext, context = [], pendingContext, onContextConsumed, onContextRemoved, onAttachmentConsumed, onAttachmentRemoved, createRuntime = createBrowserChatRuntime, removeCache = removeBrowserModelCache, readSource, isCached = cachedInBrowser }: BrowserChatDockProps): JSX.Element {
    const { preferences, setPreferences } = useAgentPreferences();
    const automatic = preferences.automatic;
    const [explanation, setExplanation] = useState<Explanation>();
    const explanations = useRef(new Map<string, Explanation>());
    const symbolSources = useRef(new Map<string, Promise<BrowserChatSource | undefined>>());
    const [retryExplanation, setRetryExplanation] = useState(0);
    const autoRun = useRef<{ key: string; cancelled: boolean; settled: Promise<void> } | undefined>(undefined);
    const manualRequest = useRef<{ cancelled: boolean } | undefined>(undefined);
    const operationSettled = useRef<Promise<void> | undefined>(undefined);
    const historyProject = useRef(historyKey);
    const [questionQueued, setQuestionQueued] = useState(false);
    const [newExplanation, setNewExplanation] = useState(false);
    const lastAttempt = useRef<string | undefined>(undefined);
    const selected = useMemo(() => explanationInput(selectionScope, readerContext, proactiveSelection), [selectionScope, readerContext, proactiveSelection]);
    const selectionRef = useRef(selected); selectionRef.current = selected;
    const settingsSeen = useRef(settingsRequest);
    const modelId = preferences.modelId;
    const model = BROWSER_MODELS.find(candidate => candidate.id === modelId) ?? initialModel;
    const limits = tokenLimitsFor(preferences, model);
    // Short automatic explanations never exceed the configured limits either.
    const autoOutput = Math.min(AUTO_OUTPUT_TOKENS, limits.outputTokens);
    const autoInput = Math.min(AUTO_INPUT_TOKENS, limits.inputTokens, model.contextTokens - autoOutput);
    // Evidence for a manual question grows with the input limit: about 1.5 characters per
    // token leave room for the question, history and instructions (2048 tokens: 3200).
    const chatEvidence = Math.max(800, Math.floor(limits.inputTokens * 25 / 16));
    const [phase, setPhase] = useState<Phase>('off');
    const { draft, setDraft, turns, setTurns, ready: historyReady, historyNotice, clearHistory } = useChatHistory<ChatTurn>(historyKey);
    const [error, setError] = useState<string>();
    const [runtimeFailed, setRuntimeFailed] = useState(false);
    const [notice, setNotice] = useState<string>();
    const [progress, setProgress] = useState<BrowserAiProgress>();
    /** Models whose files are in the browser cache: checked on start, not remembered per session (K10). */
    const [cached, setCached] = useState<ReadonlySet<string>>(() => new Set());
    const [settingsOpen, setSettingsOpen] = useState(false);
    /** The token-limit note opens the configuration at its output limit. */
    const focusOutputLimit = useRef(false);
    const [newOutput, setNewOutput] = useState(false);
    const [stopping, setStopping] = useState(false);
    const [selectedContext, setSelectedContext] = useState<BrowserChatContext[]>([]);
    const [handledContextId, setHandledContextId] = useState<string>();
    const graphSelection = pendingContext?.id !== handledContextId ? pendingContext : undefined;
    const manualAttachment = readerContext === undefined ? attachment : undefined;
    const currentReader = snapshotReaderContext(readerContext);
    const runtime = useRef<BrowserChatRuntime | undefined>(undefined);
    /** The model the worker was created for; the stored choice can change in another tab. */
    const runtimeModel = useRef<string | undefined>(undefined);
    const epoch = useRef(0);
    const pending = useRef(false);
    const stopRequested = useRef(false);
    const activeTurn = useRef<string | undefined>(undefined);
    const transcript = useRef<HTMLDivElement>(null);
    const followOutput = useRef(true);
    const followExplanation = useRef(false);
    const input = useRef<HTMLTextAreaElement>(null);
    const busy = phase === 'preparing' || phase === 'counting' || phase === 'generating' || phase === 'removing';

    useEffect(() => () => { epoch.current += 1; runtime.current?.dispose(); runtime.current = undefined; }, []);
    useEffect(() => {
        // A model active before a project switch comes back, as does the chosen one when asked
        // to load on start; both only from the cache (K10, K24).
        const resume = takeAgentResume();
        let alive = true;
        void Promise.all(BROWSER_MODELS.filter(candidate => candidate.availability === 'available').map(async candidate => [candidate.id, await isCached(candidate.id)] as const))
            .then(entries => {
                if (!alive) return;
                const found = new Set(entries.filter(([, inCache]) => inCache).map(([id]) => id));
                setCached(found);
                if ((resume || preferences.autoLoad) && found.has(model.id) && !runtime.current && !pending.current) void prepare(true);
            });
        return () => { alive = false; };
    }, []);
    useEffect(() => {
        if (historyProject.current === historyKey) return;
        historyProject.current = historyKey;
        explanations.current.clear(); symbolSources.current.clear(); resetProject();
        setSelectedContext([]); setHandledContextId(undefined); setNewExplanation(false);
    }, [historyKey]);
    useEffect(() => {
        // Navigation must not pull the reader away from a question being answered.
        if (manualRequest.current) { setNewExplanation(!!selected); return; }
        followExplanation.current = open && proactive && automatic && !!selected;
        if (followExplanation.current) {
            if (transcript.current) transcript.current.scrollTop = 0;
            setNewOutput(false); setNewExplanation(false);
        }
    }, [selected?.key, open, proactive, automatic]);
    useEffect(() => {
        // The current explanation precedes manual turns, so its beginning is at the top.
        // Keep it there as it completes unless the reader has deliberately scrolled away.
        if (open && followExplanation.current && transcript.current) transcript.current.scrollTop = 0;
    }, [explanation, open, phase]);
    useEffect(() => {
        const element = transcript.current;
        if (!element || !open || followExplanation.current) return;
        if (followOutput.current) { element.scrollTop = element.scrollHeight; setNewOutput(false); }
        else if (turns.some(turn => turn.status === 'generating')) setNewOutput(true);
    }, [turns, open]);
    useEffect(() => { if (open && (manualAttachment || graphSelection)) input.current?.focus(); }, [open, manualAttachment?.id, graphSelection?.id]);
    useEffect(() => {
        const element = input.current;
        if (!element || !open) return;
        element.style.height = 'auto';
        element.style.height = `${Math.min(104, Math.max(32, element.scrollHeight))}px`;
    }, [draft, open, phase]);

    const agentState = phase === 'off' ? error ? 'error' : 'off' : phase === 'preparing' || phase === 'removing' ? 'loading' : phase === 'ready' ? 'active' : 'busy';
    useEffect(() => { onAgentStateChange?.(agentState); }, [agentState, onAgentStateChange]);
    useEffect(() => { onAgentModelChange?.(model.displayName); }, [model.displayName, onAgentModelChange]);
    useEffect(() => {
        // Explanations belong to the model that wrote them, and a model chosen elsewhere
        // never answers on the worker of the previous one.
        explanations.current.clear();
        if (runtimeModel.current !== undefined && runtimeModel.current !== model.id) release();
    }, [model.id]);
    useEffect(() => {
        if (settingsSeen.current !== settingsRequest) { settingsSeen.current = settingsRequest; setSettingsOpen(true); }
    }, [settingsRequest]);
    useEffect(() => {
        // Runs after the dialog's own showModal, which focuses its first control.
        if (!settingsOpen || !focusOutputLimit.current) return;
        focusOutputLimit.current = false;
        const field = document.getElementById('cbm-chat-output-tokens');
        if (field instanceof HTMLInputElement) { field.focus({ preventScroll: true }); field.select(); field.scrollIntoView?.({ block: 'nearest' }); }
    }, [settingsOpen]);
    const openOutputLimit = (): void => { focusOutputLimit.current = true; setSettingsOpen(true); };
    const limitNote = (shortened: boolean | undefined, limit: TokenLimits | undefined, automatic?: boolean): LimitNote | undefined => shortened
        ? { limit: limit ?? (automatic ? { inputTokens: autoInput, outputTokens: autoOutput } : limits), automatic, chatOutput: limits.outputTokens, model, onChangeOutput: openOutputLimit } : undefined;
    useEffect(() => {
        const run = autoRun.current;
        if (run && !run.cancelled && (run.key !== selected?.key || !automatic || !proactive)) {
            run.cancelled = true; lastAttempt.current = undefined; runtime.current?.stop();
        }
    }, [selected?.key, automatic, proactive]);
    useEffect(() => {
        // Returning to an explained selection shows what was already written, unless its
        // complete scope now carries other evidence, as after a re-index.
        const cached = selected && explanations.current.get(selected.key);
        if (!cached) return;
        if (selected.evidence && cached.evidence !== selected.evidence) {
            explanations.current.delete(selected.key); lastAttempt.current = undefined;
            setExplanation(previous => previous?.key === selected.key ? undefined : previous);
            return;
        }
        lastAttempt.current = cached.key;
        setExplanation(previous => previous?.key === cached.key ? previous : cached);
    }, [selected?.key, selected?.evidence]);
    useEffect(() => {
        if (!historyReady || !proactive || !automatic || !selected || selected.waiting || phase !== 'ready' || manualRequest.current || pending.current
            || lastAttempt.current === selected.key || explanations.current.has(selected.key)) return;
        const snapshot = selected;
        const timer = setTimeout(() => { void explain(snapshot); }, EXPLANATION_DELAY_MS);
        return () => clearTimeout(timer);
    }, [selected?.key, selected?.waiting, selected?.evidence, phase, automatic, proactive, retryExplanation, historyReady]);
    /** The selection's own source: what the view already read, or the selected symbol read
     * once through get_code_snippet. A failed read is retried on the next request. */
    const sourceFor = (context: BrowserChatContext | undefined): Promise<BrowserChatSource | undefined> => {
        const carried = carriedSource(context);
        const target = carried ? undefined : sourceTargetOf(context);
        if (carried || !target || !readSource) return Promise.resolve(carried);
        const cache = symbolSources.current;
        let read = cache.get(target.qualifiedName);
        if (!read) {
            read = readSource(target.qualifiedName, { maxLines: SYMBOL_SOURCE_LINES }).then(snippet => symbolSource(target, snippet, 'indexed-snippet'),
                () => { cache.delete(target.qualifiedName); return undefined; });
            cache.set(target.qualifiedName, read);
            while (cache.size > SOURCE_CACHE_SIZE) cache.delete(cache.keys().next().value!);
        }
        return read;
    };
    const remember = (entry: Explanation): void => {
        const cache = explanations.current;
        cache.delete(entry.key); cache.set(entry.key, entry);
        while (cache.size > EXPLANATION_CACHE_SIZE) cache.delete(cache.keys().next().value!);
    };

    const explain = async (snapshot: ExplanationInput): Promise<void> => {
        const currentRuntime = runtime.current;
        if (!historyReady || !currentRuntime || pending.current || manualRequest.current || selectionRef.current?.key !== snapshot.key) return;
        pending.current = true; stopRequested.current = false; setStopping(false);
        const ticket = ++epoch.current;
        let settle!: () => void;
        const settled = new Promise<void>(resolve => { settle = resolve; });
        operationSettled.current = settled;
        const run = { key: snapshot.key, cancelled: false, settled }; autoRun.current = run; lastAttempt.current = snapshot.key;
        const valid = () => epoch.current === ticket && !run.cancelled && !stopRequested.current && selectionRef.current?.key === snapshot.key;
        // Graph selections show their listed facts at once; the model only adds a sentence.
        const summary = snapshot.reader ? [] : selectionSummary(snapshot.graph);
        const writing = summary.length ? `${summary.map(line => `- ${line}`).join('\n')}\n\n_${sourceTargetOf(snapshot.graph) || carriedSource(snapshot.graph) ? browserChatText.writingSentence : browserChatText.readingFacts}_` : '';
        setExplanation({ key: snapshot.key, label: snapshot.label, answer: writing, status: 'generating' });
        setPhase('counting');
        try {
            const symbol = snapshot.reader ? undefined : await sourceFor(snapshot.graph);
            if (!valid()) return;
            let packet = prepareExplanationContext(snapshot.reader, snapshot.graph, 3200, symbol);
            // Without source the model could only restate the facts or guess from names (an area
            // became "a high-level web framework"): the listed facts are the explanation (K7).
            if (summary.length && explanationMode(packet) === 'graph') {
                const complete: Explanation = { key: snapshot.key, label: snapshot.label, answer: groundedExplanation(summary, undefined, false), status: 'complete', packet,
                    ...snapshot.evidence ? { evidence: snapshot.evidence } : {} };
                remember(complete); setExplanation(complete);
                if (!followExplanation.current) setNewExplanation(true);
                return;
            }
            const subject = snapshot.reader ? undefined : selectionSubject(snapshot.graph);
            let request = explanationMessages(packet, subject);
            let count = await currentRuntime.countTokens(request);
            if (!valid()) return;
            for (let budget = 1900; count > autoInput && budget >= 300; budget = Math.floor(budget * .6)) {
                packet = prepareExplanationContext(snapshot.reader, snapshot.graph, budget, symbol);
                request = explanationMessages(packet, subject);
                count = await currentRuntime.countTokens(request);
                if (!valid()) return;
            }
            if (!packet.evidence.length || count > autoInput) {
                setExplanation({ key: snapshot.key, label: snapshot.label, answer: '', status: 'error', packet, error: !packet.evidence.length ? 'No source or graph evidence is available for this selection.' : 'This selection is too large for the local agent. Select a smaller code range and try again.' });
                return;
            }
            setExplanation({ key: snapshot.key, label: snapshot.label, answer: writing, status: 'generating', packet });
            setPhase('generating');
            // Keep an explanation together and ignore output from superseded selections.
            let shortened = false;
            const answer = await currentRuntime.chat(request, () => {}, { maxOutputTokens: autoOutput, generationProfile: 'automatic-explanation',
                onComplete: ({ stopReason }) => { shortened = stopReason === 'length'; } });
            if (valid()) {
                const result = parseExplanationResponse(answer, packet);
                if (!followExplanation.current) setNewExplanation(true);
                // One sentence beside the facts (two for reader code), and none that names what the evidence lacks.
                const checked = result.status === 'generated' ? explanationSentence(result.markdown, packet, request.map(message => message.content).join('\n')) : {};
                if (summary.length || (result.status === 'generated' && checked.dropped)) {
                    const markdown = summary.length ? groundedExplanation(summary, checked.sentence, checked.dropped !== undefined) : `_${browserChatText.explanationDropped}_`;
                    const complete: Explanation = { key: snapshot.key, label: snapshot.label, answer: markdown, status: 'complete', mode: 'interpretation', packet,
                        ...shortened && checked.sentence ? { shortened, limit: { inputTokens: autoInput, outputTokens: autoOutput } } : {}, ...snapshot.evidence ? { evidence: snapshot.evidence } : {} };
                    remember(complete); setExplanation(complete);
                } else if (result.status === 'generated') {
                    const complete: Explanation = { key: snapshot.key, label: snapshot.label, answer: checked.sentence ?? result.markdown, status: 'complete', mode: 'interpretation', packet, citation: result.citation,
                        ...shortened ? { shortened, limit: { inputTokens: autoInput, outputTokens: autoOutput } } : {}, ...snapshot.evidence ? { evidence: snapshot.evidence } : {} };
                    remember(complete); setExplanation(complete);
                } else setExplanation({ key: snapshot.key, label: snapshot.label, answer: '', status: 'error', packet, error: result.reason });
            }
        } catch (failure) {
            if (epoch.current === ticket && isGpuRuntimeFailure(failure)) { invalidateRuntime(failure); return; }
            if (valid()) setExplanation({ key: snapshot.key, label: snapshot.label, answer: '', status: 'error', error: messageOf(failure) });
        } finally {
            if (epoch.current === ticket) {
                if (run.cancelled || stopRequested.current) setExplanation(previous => previous?.key === snapshot.key ? { ...previous, status: 'stopped' } : previous);
                autoRun.current = undefined; pending.current = false; setStopping(false); setPhase('ready');
            }
            // Cancellation only asks the worker to stop. A waiting question must not
            // use the worker until token counting / generation has actually settled.
            if (operationSettled.current === settled) operationSettled.current = undefined;
            settle();
        }
    };
    const resetProject = (): void => {
        if (!runtime.current || phase === 'preparing' || phase === 'removing') { release(); return; }
        const retainedRuntime = runtime.current;
        const settled = operationSettled.current;
        if (autoRun.current) autoRun.current.cancelled = true;
        if (manualRequest.current) manualRequest.current.cancelled = true;
        autoRun.current = undefined; manualRequest.current = undefined;
        lastAttempt.current = undefined; activeTurn.current = undefined;
        setQuestionQueued(false); setExplanation(undefined); setError(undefined);
        const ticket = ++epoch.current;
        pending.current = !!settled; stopRequested.current = !!settled; setStopping(!!settled);
        if (!settled) { setPhase('ready'); return; }
        // Retain downloaded weights across projects, but drain the old worker request
        // before making the new project's context eligible for inference.
        setPhase('counting'); retainedRuntime.stop();
        void settled.then(() => {
            if (epoch.current !== ticket || runtime.current !== retainedRuntime) return;
            pending.current = false; stopRequested.current = false; setStopping(false); setPhase('ready');
        });
    };
    const release = (): void => {
        if (manualRequest.current) manualRequest.current.cancelled = true;
        manualRequest.current = undefined; operationSettled.current = undefined; setQuestionQueued(false);
        if (autoRun.current) autoRun.current.cancelled = true;
        autoRun.current = undefined; lastAttempt.current = undefined; setExplanation(undefined);
        const id = activeTurn.current;
        if (id) setTurns(previous => previous.map(turn => turn.id === id ? { ...turn, status: 'stopped' } : turn));
        epoch.current += 1; pending.current = false; activeTurn.current = undefined;
        stopRequested.current = false; setStopping(false);
        runtime.current?.dispose(); runtime.current = undefined; runtimeModel.current = undefined;
        setProgress(undefined); setPhase('off'); setRuntimeFailed(false);
    };
    const invalidateRuntime = (failure: unknown): void => {
        const id = activeTurn.current;
        const message = new BrowserRuntimeFatalError(messageOf(failure)).message;
        release(); setRuntimeFailed(true); setError(message);
        if (id) setTurns(previous => previous.map(turn => turn.id === id ? { ...turn, status: 'error', error: message } : turn));
    };
    const prepare = async (cacheOnly = cached.has(model.id)): Promise<void> => {
        if (pending.current || model.availability !== 'available') return;
        release(); pending.current = true;
        const ticket = epoch.current;
        setError(undefined); setNotice(undefined); setPhase('preparing');
        try {
            const nextRuntime = createRuntime(model.id);
            runtime.current = nextRuntime; runtimeModel.current = model.id;
            nextRuntime.setFatalHandler?.(failure => { if (runtime.current === nextRuntime) invalidateRuntime(failure); });
            await nextRuntime.prepare(value => { if (epoch.current === ticket) setProgress(value); }, cacheOnly ? { cacheOnly } : undefined);
            if (epoch.current !== ticket) return;
            setCached(previous => new Set(previous).add(model.id));
            setPhase('ready'); setProgress(undefined); setSettingsOpen(false); pending.current = false;
        } catch (failure) {
            if (epoch.current !== ticket) return;
            release();
            if (cacheOnly) { setCached(previous => { const next = new Set(previous); next.delete(model.id); return next; }); setError(browserChatText.resumeFailed); }
            else setError(messageOf(failure));
        }
    };
    const stop = (): void => {
        if (phase === 'preparing') { release(); setNotice('Download stopped. Cached files can be reused or deleted.'); return; }
        if (manualRequest.current && autoRun.current) {
            manualRequest.current.cancelled = true; manualRequest.current = undefined; setQuestionQueued(false);
            lastAttempt.current = selectionRef.current?.key;
        }
        if ((phase !== 'generating' && phase !== 'counting') || stopRequested.current) return;
        stopRequested.current = true; setStopping(true);
        if (phase === 'generating') runtime.current?.stop();
        // Stay busy until the in-flight GPU operation settles; a second send must not overlap it.
    };
    const send = async (retry?: ChatTurn): Promise<void> => {
        const currentRuntime = runtime.current;
        const automaticRun = autoRun.current;
        if (!historyReady || !currentRuntime || manualRequest.current || stopping || (!automaticRun && (phase !== 'ready' || pending.current)) || (!retry && !draft.trim())) return;
        if (!retry && readerContext?.status === 'loading') return;
        // A manual question switches from reading the current explanation to its reply.
        // Preserve a deliberate history scroll; only automatic explanation following resets it.
        if (followExplanation.current) followOutput.current = true;
        followExplanation.current = false;
        // Capture the question and every source before yielding to cancellation.
        // Later navigation changes the live explainer, never this request.
        const prompt = retry?.prompt ?? draft;
        const source = snapshotAttachment(retry ? retry.attachment : manualAttachment);
        const reader = snapshotReaderContext(retry ? retry.readerContext : readerContext);
        const selectedGraph = !retry && graphSelection ? { ...graphSelection } : undefined;
        const nextContext = selectedGraph ? [...selectedContext.filter(item => item.id !== selectedGraph.id), selectedGraph] : selectedContext;
        const extra = (retry ? retry.context ?? [] : nextContext).map(item => ({ ...item }));
        let packet = retry?.evidence;
        // A listed answer or a suggestion asked again goes to the model: the same question and evidence in a fresh request.
        const ask = retry?.answeredFrom === 'graph' || retry?.answeredFrom === 'suggestion';
        const currentGraph = !retry && !reader && proactiveSelection ? [{ ...proactiveSelection }] : [];
        const consume = (): void => {
            setDraft(previous => previous === prompt ? '' : previous);
            setSelectedContext(previous => previous.filter(item => !extra.some(sent => sent.id === item.id && sent.text === item.text)));
            if (source) onAttachmentConsumed(source.id);
            if (selectedGraph) { setHandledContextId(selectedGraph.id); onContextConsumed?.(selectedGraph.id); }
        };
        // A question without its own context may follow up on attached code in this view.
        const topic = retry ? retry.topic : chatTopic(selectionScope, { reader, graph: currentGraph[0], attachment: source, context: extra })
            ?? followedTopic(turns, selectionScope);
        // Without code or graph facts the model can only guess: say what to select instead.
        if (!retry && !topic) {
            setTurns(previous => [...previous, { id: `local-turn-${crypto.randomUUID()}`, prompt, modelId: model.id, request: [],
                answer: missingContextAnswer(prompt, reader), status: 'complete', answeredFrom: 'local' }]);
            consume();
            return;
        }
        // Callers and callees of the selection come from the loaded graph, complete and
        // without the model: a small model drops and repeats names in long lists.
        const listed = !retry && !source ? relationshipAnswer(prompt, [...currentGraph, ...extra]) : undefined;
        if (listed) {
            setTurns(previous => [...previous, { id: `local-turn-${crypto.randomUUID()}`, prompt, context: extra, topic,
                evidence: prepareExplanationContext(undefined, listed.context, chatEvidence), modelId: model.id, request: [],
                answer: listed.markdown, status: 'complete', answeredFrom: 'graph' }]);
            consume();
            return;
        }
        // Sounds like callers or callees but is not certain: offer the list, do not guess with the model.
        const suggested = !retry && !source ? relationshipSuggestion(prompt, [...currentGraph, ...extra]) : undefined;
        if (suggested) {
            setTurns(previous => [...previous, { id: `local-turn-${crypto.randomUUID()}`, prompt, context: extra, topic,
                evidence: prepareExplanationContext(undefined, suggested.context, chatEvidence), modelId: model.id, request: [],
                answer: suggested.markdown, status: 'complete', answeredFrom: 'suggestion', suggestion: { question: suggested.question, context: suggested.context } }]);
            consume();
            return;
        }
        // Answers about another file or selection stay out: an earlier wrong answer must not
        // become evidence for this one (K17).
        const earlier = (ask ? turns.filter(item => item.id !== retry.id) : turns).filter(item => item.topic?.key === topic?.key);
        let history: ChatTurn[] = earlier;
        const makeRequest = () => buildChatMessages(history, prompt, source, extra, reader, currentGraph, packet ? formatExplanationEvidence(packet) : undefined);
        const queued = { cancelled: false }; manualRequest.current = queued;
        const waitingEpoch = epoch.current;
        // The selected symbol's source grounds a question as it grounds the explanation (K14).
        const symbol = !retry && !reader && currentGraph.length ? await sourceFor(currentGraph[0]) : undefined;
        if (queued.cancelled || manualRequest.current !== queued || epoch.current !== waitingEpoch || runtime.current !== currentRuntime) {
            if (manualRequest.current === queued) manualRequest.current = undefined;
            return;
        }
        if (!retry && ((reader?.source?.text.length ?? 0) > 5000 || currentGraph.length)) packet = prepareExplanationContext(reader, currentGraph, chatEvidence, symbol);
        let request = retry && !ask ? retry.request.map(message => ({ ...message })) : makeRequest();
        if (automaticRun) {
            automaticRun.cancelled = true; lastAttempt.current = undefined;
            setQuestionQueued(true); currentRuntime.stop();
            await automaticRun.settled;
            if (queued.cancelled || manualRequest.current !== queued || epoch.current !== waitingEpoch || runtime.current !== currentRuntime) return;
        }
        setQuestionQueued(false);
        pending.current = true; stopRequested.current = false; setStopping(false);
        const ticket = ++epoch.current;
        let settle!: () => void;
        const settled = new Promise<void>(resolve => { settle = resolve; });
        operationSettled.current = settled;
        setError(undefined); setNotice(undefined); setPhase('counting');
        try {
            let count = await currentRuntime.countTokens(request);
            if (epoch.current !== ticket || stopRequested.current) return;
            const limit = Math.min(limits.inputTokens, model.contextTokens - limits.outputTokens);
            // Earlier turns give way first, oldest first; the question and its evidence stay.
            while ((!retry || ask) && count > limit && history.length) {
                const characters = request.reduce((sum, message) => sum + message.content.length, 0);
                history = trimChatHistory(history, Math.ceil((count - limit) * characters / Math.max(1, count)));
                request = makeRequest(); count = await currentRuntime.countTokens(request);
                if (epoch.current !== ticket || stopRequested.current) return;
            }
            for (let budget = packet ? Math.floor(chatEvidence * .6) : chatEvidence; !retry && count > limit && (reader?.source || currentGraph.length) && budget >= 300; budget = Math.floor(budget * .6)) {
                packet = prepareExplanationContext(reader, currentGraph, budget, symbol);
                request = makeRequest(); count = await currentRuntime.countTokens(request);
                if (epoch.current !== ticket || stopRequested.current) return;
            }
            if (count > limit) {
                setError(`This prompt needs ${count.toLocaleString()} input tokens; the local working limit is ${limit.toLocaleString()}. Select less code or start a new conversation. Nothing was sent or shortened without disclosure.`);
                return;
            }
            const id = retry?.id ?? `local-turn-${crypto.randomUUID()}`;
            const historyOmitted = retry && !ask ? retry.historyOmitted
                : earlier.filter(item => item.status !== 'error' && item.status !== 'generating' && !history.includes(item)).length;
            const turn: ChatTurn = { id, prompt, attachment: source, readerContext: reader, context: extra, evidence: packet, modelId: model.id, request, answer: '', status: 'generating', topic,
                ...historyOmitted ? { historyOmitted } : {} };
            activeTurn.current = id;
            if (retry) setTurns(previous => previous.map(item => item.id === id ? turn : item));
            else { setTurns(previous => [...previous, turn]); consume(); }
            setPhase('generating');
            let shortened = false;
            const output = await currentRuntime.chat(request, chunk => {
                if (epoch.current !== ticket || stopRequested.current) return;
                setTurns(previous => previous.map(item => item.id === id ? { ...item, answer: item.answer + chunk } : item));
            }, { maxOutputTokens: limits.outputTokens, onComplete: ({ stopReason }) => { shortened = stopReason === 'length'; } });
            if (epoch.current !== ticket) return;
            setTurns(previous => previous.map(item => item.id === id ? { ...item, answer: stopRequested.current ? item.answer : output, status: stopRequested.current ? 'stopped' : 'complete',
                ...shortened && !stopRequested.current ? { shortened, limit: { inputTokens: limits.inputTokens, outputTokens: limits.outputTokens } } : {} } : item));
        } catch (failure) {
            if (epoch.current !== ticket) return;
            if (isGpuRuntimeFailure(failure)) { invalidateRuntime(failure); return; }
            const explanation = messageOf(failure);
            const id = activeTurn.current;
            if (id) setTurns(previous => previous.map(turn => turn.id === id ? { ...turn, status: stopRequested.current ? 'stopped' : 'error', error: stopRequested.current ? undefined : explanation } : turn));
            else if (!stopRequested.current) setError(explanation);
        } finally {
            if (manualRequest.current === queued) manualRequest.current = undefined;
            if (epoch.current === ticket) { activeTurn.current = undefined; pending.current = false; setStopping(false); setPhase('ready'); }
            if (operationSettled.current === settled) operationSettled.current = undefined;
            settle();
        }
    };
    /** The suggested list replaces the suggestion; the question stays as typed. */
    const showSuggestedList = (turn: ChatTurn): void => {
        const listed = turn.suggestion && relationshipAnswer(turn.suggestion.question, [turn.suggestion.context]);
        if (!listed) return;
        setTurns(previous => previous.map(item => item.id === turn.id ? { ...item, answer: listed.markdown, answeredFrom: 'graph', suggestion: undefined,
            evidence: prepareExplanationContext(undefined, listed.context, chatEvidence) } : item));
    };
    const deleteCache = async (): Promise<void> => {
        if (pending.current) return;
        release(); pending.current = true;
        const ticket = epoch.current;
        setPhase('removing'); setError(undefined); setNotice(undefined);
        try {
            await removeCache(model.id);
            if (epoch.current !== ticket) return;
            setCached(previous => { const next = new Set(previous); next.delete(model.id); return next; });
            setNotice('Cached model files deleted. Your conversation is still here.');
        } catch (failure) { if (epoch.current === ticket) setError(messageOf(failure)); }
        finally { if (epoch.current === ticket) { pending.current = false; setPhase('off'); } }
    };
    const clear = (): void => {
        if (busy || !historyReady || (!turns.length && !draft) || !window.confirm('Clear this project’s local conversation and saved history? This removes its messages, draft and attached code snapshots.')) return;
        void clearHistory(); setError(undefined); setNewOutput(false); followOutput.current = true;
    };
    const submit = (event: FormEvent): void => { event.preventDefault(); void send(); };
    const status = stopping ? 'Stopping' : phase === 'preparing' ? 'Loading' : phase === 'counting' ? 'Checking context' : phase === 'generating' ? 'Answering' : phase === 'removing' ? 'Deleting cache' : phase === 'ready' ? 'Loaded' : 'Off';
    const needsEnable = phase === 'off';
    const showConversation = turns.length > 0 || draft.length > 0 || phase === 'ready' || phase === 'counting' || phase === 'generating';

    return <>
        {settingsOpen && <AgentSettingsDialog onClose={() => setSettingsOpen(false)}>
        <section id="cbm-chat-model-settings" className="cbm-chat-settings" aria-label="Local model settings">
            {proactive && <label><input type="checkbox" checked={automatic} onChange={event => setPreferences({ automatic: event.target.checked })} /> Explain selections automatically</label>}
            <label title={browserChatText.autoLoadNote}><input id="cbm-chat-auto-load" type="checkbox" checked={preferences.autoLoad} onChange={event => setPreferences({ autoLoad: event.target.checked })} /> {browserChatText.autoLoad}</label>
            <span className="cbm-chat-status" role="status">{status}</span>
            <label htmlFor="cbm-chat-model">Model</label>
            <select id="cbm-chat-model" value={modelId} disabled={busy} onChange={event => { release(); setPreferences({ modelId: event.target.value }); setError(undefined); setNotice(undefined); }}>
                {BROWSER_MODELS.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.displayName} · {candidate.availability === 'unsupported' ? 'Requires runtime support' : candidate.id === model.id && phase === 'ready' ? 'Loaded' : cached.has(candidate.id) ? browserChatText.cached : 'Available'}</option>)}
            </select>
            <p>{sizeLabel(model.bytes)} download · {model.license}. Memory use is higher.</p>
            {model.compatibilityNote && <p>{model.compatibilityNote}</p>}
            <fieldset className="cbm-chat-token-limits">
                <legend>{browserChatText.tokenLimits(model.displayName)}</legend>
                <TokenLimitField id="cbm-chat-input-tokens" label={browserChatText.inputLimit} value={limits.inputTokens} {...tokenLimitBounds(model, limits.outputTokens).input} step={64}
                    onCommit={inputTokens => setPreferences(current => ({ limits: { ...current.limits, [model.id]: clampTokenLimits(model, limits, { inputTokens }) } }))} />
                <TokenLimitField id="cbm-chat-output-tokens" label={browserChatText.outputLimit} value={limits.outputTokens} {...tokenLimitBounds(model, limits.outputTokens).output} step={32}
                    onCommit={outputTokens => setPreferences(current => ({ limits: { ...current.limits, [model.id]: clampTokenLimits(model, limits, { outputTokens }) } }))} />
                <p>{browserChatText.limitsNote(autoInput, autoOutput)}</p>
            </fieldset>
            <p><a href={model.modelCard} target="_blank" rel="noreferrer">Model details</a> · Downloads come from Hugging Face. No model downloads automatically.</p>
            <div className="cbm-chat-model-actions">
                {phase === 'off' && <button type="button" className="cbm-chat-primary" disabled={model.availability !== 'available'} onClick={() => { void prepare(); }}>{runtimeFailed ? 'Reload model' : cached.has(model.id) ? browserChatText.loadCached : 'Download & load'}</button>}
                {(phase === 'ready' || phase === 'generating' || phase === 'counting') && <button type="button" onClick={() => { release(); setNotice('Model unloaded. Conversation and cached files retained.'); }}>Unload model</button>}
                <button type="button" disabled={busy} onClick={() => { void deleteCache(); }}>Delete cached model</button>
            </div>
        </section>
        {historyKey && <section className="cbm-chat-settings" aria-label="Chat history settings">
            <p>Chat history · 24 hours in this browser, per project. Expired history is removed on the next visit.</p>
            <button type="button" disabled={busy || !historyReady || (!turns.length && !draft)} onClick={clear}>Clear history</button>
            {historyNotice && <p role="status">{historyNotice}</p>}
        </section>}
        {phase === 'preparing' && <div className="cbm-chat-loading" role="status"><progress max={100} value={progress?.progress} /><span>{progress?.file ?? 'Preparing browser model…'}</span><button type="button" onClick={stop}>Stop download</button></div>}
        {error && <div className="cbm-chat-error" role="alert">{error}</div>}
        {notice && <p className="cbm-chat-notice" role="status">{notice}</p>}
        </AgentSettingsDialog>}
        {!open && showCollapsed ? <aside className="cbm-chat-dock is-collapsed" aria-label="Local chat">
            <header className="cbm-chat-header"><h2>Chat</h2>
                <button type="button" className="cbm-chat-primary" aria-expanded={false} onClick={onOpen}>Open chat</button>
            </header>
        </aside> : <aside className="cbm-chat-dock" hidden={!open} aria-label="Local chat">
        <header className="cbm-chat-header">
            <h2>Chat</h2>
            {turns.length > 0 && <button type="button" className="cbm-chat-new" disabled={busy} onClick={clear}>{browserChatText.newConversation}</button>}
            <button type="button" className="cbm-chat-icon" aria-label="Collapse local chat" title="Collapse chat; keep conversation" onClick={onClose}>›</button>
        </header>
        {needsEnable && <div className="cbm-chat-enable"><p>Enable the local agent to explain selections and chat.</p><button type="button" onClick={() => setSettingsOpen(true)}>Enable agent</button></div>}
        {(phase === 'preparing' || phase === 'removing') && <p className="cbm-chat-notice" role="status">Preparing agent…</p>}
        {error && !settingsOpen && <div className="cbm-chat-error" role="alert">{error}</div>}
        {showConversation && <div className="cbm-chat-transcript" ref={transcript} role="log" aria-label="Conversation" aria-live="off" onScroll={() => {
            const element = transcript.current;
            if (!element) return;
            if (element.scrollTop > 48) followExplanation.current = false;
            followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
            if (followOutput.current) setNewOutput(false);
        }}>
            {showConversation && !needsEnable && phase !== 'preparing' && phase !== 'removing' && proactive && automatic && selected && <section className="cbm-chat-explanation" aria-label="Current selection explanation">
                <SourceDisclosure title="Generated explanation; check source for exact behavior.">
                    {explanation?.key === selected.key && explanation.packet ? <PacketSource packet={explanation.packet} citation={explanation.citation} codeOnly={!selected.reader} /> : null}
                </SourceDisclosure>
                {explanation?.key === selected.key ? <>
                    <ChatMarkdown text={explanation.answer || (explanation.status === 'generating' ? 'Explaining selection…' : explanation.status === 'stopped' ? 'Explanation stopped.' : '')} />
                    {explanation.status !== 'generating' && <AnswerNotes shortened={limitNote(explanation.shortened, explanation.limit, true)} packet={explanation.packet} model={model.displayName} />}
                    {explanation.error && <p className="cbm-chat-turn-error" role="alert">{explanation.error}</p>}
                    {explanation.status !== 'generating' && <button type="button" className="cbm-chat-retry" disabled={phase !== 'ready' || !!selected.waiting} onClick={() => {
                        lastAttempt.current = undefined; explanations.current.delete(selected.key); setRetryExplanation(value => value + 1);
                    }}>Explain again</button>}
                </> : <p>{selected.waiting === 'loading' ? browserChatText.waitingForScope : selected.waiting === 'partial' ? browserChatText.partialScope
                    : manualRequest.current ? 'This selection will be explained after your answer.' : 'Preparing explanation…'}</p>}
            </section>}
            {turns.length === 0 && !(proactive && automatic && selected) && <div className="cbm-chat-empty"><span aria-hidden="true">⌁</span><h3>Ask about the code.</h3><p>{readerContext ? 'The current file is included automatically. Mark code to focus your next message on that exact selection.' : 'Ask a question, or add source and graph context to your next message.'}</p></div>}
            {turns.map((turn, index) => <article className="cbm-chat-turn" key={turn.id}>
                {turn.topic && index > 0 && turn.topic.key !== turns.slice(0, index).reverse().find(item => item.topic)?.topic?.key
                    && <p className="cbm-chat-topic-break">{browserChatText.topicBreak(turn.topic.label)}</p>}
                <div className="cbm-chat-question"><span className="cbm-chat-speaker">You</span><ChatMarkdown text={turn.prompt} /></div>
                <div className="cbm-chat-answer"><SourceDisclosure>
                    {turn.evidence || turn.attachment || turn.readerContext?.source || turn.context?.length ? <>
                        {turn.evidence ? <PacketSource packet={turn.evidence} /> : <>
                            {turn.attachment && <Attachment attachment={turn.attachment} />}
                            {turn.readerContext?.source && <><Attachment attachment={turn.readerContext.source} label={turn.readerContext.source.kind === 'selection' ? 'Selection snapshot' : 'File snapshot'} />{turn.readerContext.source.partial && <p className="cbm-chat-evidence-note">{turn.readerContext.source.partial}</p>}</>}
                        </>}
                        {turn.context?.map(item => <ContextSnapshot key={item.id} context={item} />)}
                    </> : null}
                </SourceDisclosure><div className="cbm-chat-answer-text"><ChatMarkdown text={turn.answer || (turn.status === 'generating' ? 'Thinking…' : turn.status === 'stopped' ? 'Stopped before an answer.' : '')} /></div>
                    {turn.status === 'stopped' && turn.answer && <small>Stopped · partial answer</small>}
                    {turn.status !== 'generating' && !turn.answeredFrom && <AnswerNotes shortened={limitNote(turn.shortened, turn.limit)} packet={turn.evidence}
                        unsupported={turn.answer ? namesNotIn(turn.answer, turn.request.map(message => message.content).join('\n')) : []} model={BROWSER_MODELS.find(candidate => candidate.id === turn.modelId)?.displayName ?? turn.modelId} historyOmitted={turn.historyOmitted} />}
                    {turn.status === 'error' && <p className="cbm-chat-turn-error" role="alert">{turn.error}</p>}
                    {index === turns.length - 1 && turn.answeredFrom === 'suggestion' && turn.suggestion && <button type="button" className="cbm-chat-retry"
                        onClick={() => showSuggestedList(turn)}>{relationshipWords.en.showList}</button>}
                    {index === turns.length - 1 && turn.status !== 'generating' && turn.answeredFrom !== 'local' && <button type="button" className="cbm-chat-retry" disabled={phase !== 'ready'} onClick={() => { void send(turn); }}>{turn.answeredFrom ? browserChatText.askModel : 'Retry'}</button>}
                </div>
            </article>)}
        </div>}
        {newOutput && <button type="button" className="cbm-chat-jump" onClick={() => { followOutput.current = true; setNewOutput(false); if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; }}>Latest answer ↓</button>}
        {newExplanation && proactive && automatic && selected && <button type="button" className="cbm-chat-jump" onClick={() => { followExplanation.current = true; setNewExplanation(false); if (transcript.current) transcript.current.scrollTop = 0; }}>Current selection ↑</button>}
        <form className="cbm-chat-composer" onSubmit={submit}>
            {questionQueued && <p className="cbm-chat-source-state" role="status">Your question is next…</p>}
            {currentReader && !currentReader.source && <p className="cbm-chat-source-state" role="status" title={currentReader.path}>{currentReader.status === 'loading' ? 'Loading current file…' : currentReader.status === 'empty' ? 'Open a file to include its code.' : 'Current file source is unavailable.'}</p>}
            {manualAttachment && <div className="cbm-chat-pending"><div className="cbm-chat-pending-title"><span>Attached to next message</span><button type="button" aria-label="Remove code attachment" disabled={!onAttachmentRemoved} onClick={() => onAttachmentRemoved?.(manualAttachment.id)}>×</button></div><Attachment attachment={manualAttachment} /></div>}
            {graphSelection && <div className="cbm-chat-pending"><div className="cbm-chat-pending-title"><span>Graph selection for next message</span><button type="button" aria-label="Remove graph selection" onClick={() => { setHandledContextId(graphSelection.id); onContextRemoved?.(graphSelection.id); }}>×</button></div><ContextSnapshot context={graphSelection} /></div>}
            {selectedContext.map(item => <div className="cbm-chat-pending" key={item.id}><div className="cbm-chat-pending-title"><span>Context for next message</span><button type="button" aria-label={`Remove ${item.label}`} onClick={() => setSelectedContext(previous => previous.filter(selected => selected.id !== item.id))}>×</button></div><ContextSnapshot context={item} /></div>)}
            {context.length > 0 && <details className="cbm-chat-context-options"><summary>Add context</summary><fieldset><legend>Include in the next message</legend>{context.map(item => <label key={item.id}><input type="checkbox" checked={selectedContext.some(selected => selected.id === item.id)} onChange={event => {
                const checked = event.target.checked;
                setSelectedContext(previous => checked ? [...previous.filter(selected => selected.id !== item.id), { ...item }] : previous.filter(selected => selected.id !== item.id));
            }} />{item.label}</label>)}</fieldset></details>}
            {showConversation && <><label className="cbm-chat-visually-hidden" htmlFor="cbm-chat-prompt">Message local model</label>
            <div className="cbm-chat-input-row"><textarea ref={input} id="cbm-chat-prompt" value={draft} placeholder="Ask about this code…" rows={1} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
            }} />
                {(phase === 'counting' || phase === 'generating') && !(autoRun.current && !manualRequest.current && draft.trim() && !stopping) ? <button type="button" className="cbm-chat-send" aria-label={stopping ? 'Stopping…' : 'Stop'} title="Stop generating" disabled={stopping} onClick={stop}>■</button> : <button className="cbm-chat-primary cbm-chat-send" type="submit" aria-label="Send ↑" title="Send message" disabled={!historyReady || (!autoRun.current && phase !== 'ready') || !!manualRequest.current || !draft.trim() || readerContext?.status === 'loading'}>↑</button>}
            </div>

            </>}
        </form>
    </aside>}
    </>;
}
