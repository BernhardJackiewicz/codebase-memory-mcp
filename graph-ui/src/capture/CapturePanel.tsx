import { useEffect, useMemo, useRef, useState } from 'react';
import { captureApi, captureFields, CAPTURE_PROFILES, validCaptureFields, validCaptureOrigin,
    type CaptureApi, type CaptureEvent, type CaptureProfile, type CaptureSession, type CaptureStarted } from './capture-source';
import { captureSlice, mergeCaptureEvents } from './capture-model';
import VerifiedSource from '../field-flow/VerifiedSource';
import type { SourceEvidenceLoader, SourceEvidenceRequest } from '../field-flow/source-evidence';
import './capture.css';
import CaptureAdapterSetup from './CaptureAdapterSetup';
import type { AdapterLoader } from './capture-adapters';

export interface CapturePanelProps {
    project: string; generation: string; active: boolean; api?: CaptureApi;
    onNavigate: (path: string, line?: number, name?: string) => void;
    readSource?: SourceEvidenceLoader;
    readAdapters?: AdapterLoader;
}
const PAGE_SIZE = 40;
const message = (error: unknown) => error instanceof Error ? error.message : 'Local capture request failed.';
function sameSnapshot(session: CaptureSession, project: string, generation: string): boolean {
    return session.project === project && session.generation === generation;
}
function localEndpoint(value: string): string | undefined {
    try {
        const url = new URL(value, window.location.origin);
        return url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
    } catch { return undefined; }
}
function dateLabel(time: number): string {
    return new Date(time < 1e12 ? time * 1000 : time).toLocaleString();
}
/** Keying the workspace drops tokens and pending reads synchronously on project/snapshot switches. */
export default function CapturePanel(props: CapturePanelProps) {
    return <CaptureWorkspace key={JSON.stringify([props.project, props.generation])} {...props} />;
}
function CaptureWorkspace({ project, generation, active, api = captureApi, readSource, readAdapters }: CapturePanelProps) {
    const [profile, setProfile] = useState<CaptureProfile>('node'), [values, setValues] = useState(false);
    const [fields, setFields] = useState(''), [origin, setOrigin] = useState('');
    const [setupOrigin, setSetupOrigin] = useState<string>();
    const [sessions, setSessions] = useState<CaptureSession[]>([]), [selectedId, setSelectedId] = useState<string>();
    const [credentials, setCredentials] = useState<CaptureStarted>(), [events, setEvents] = useState<CaptureEvent[]>([]);
    const [selectedEventId, setSelectedEventId] = useState<number>(), [limit, setLimit] = useState(PAGE_SIZE);
    const [sourceEvidence, setSourceEvidence] = useState<{ session: string; event: number; request: SourceEvidenceRequest }>();
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<string>();
    const [copyStatus, setCopyStatus] = useState(''), [pollEpoch, setPollEpoch] = useState(0), [listEpoch, setListEpoch] = useState(0);
    const operation = useRef(new AbortController()), cursor = useRef({ id: '', after: 0 });
    const mutationVersion = useRef(0);
    const session = sessions.find(item => item.id === selectedId);
    const sessionGeneration = session?.generation;
    const allowedFields = useMemo(() => values ? captureFields(fields) : [], [values, fields]);
    const canStart = active && !busy && Boolean(project && generation) && (!values || validCaptureFields(allowedFields))
        && (profile !== 'browser' || !origin || validCaptureOrigin(origin));
    const selectedEvent = events.find(event => event.id === selectedEventId);
    const slice = useMemo(() => selectedEventId === undefined ? undefined : captureSlice(events, selectedEventId), [events, selectedEventId]);
    const matchesCurrent = session ? sameSnapshot(session, project, generation) : false;

    useEffect(() => {
        const controller = new AbortController(); operation.current = controller;
        setBusy(false);
        return () => { controller.abort(); };
    }, [active]);
    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        const requestedVersion = mutationVersion.current;
        setLoading(true);
        void api.list(project, controller.signal).then(result => {
            if (controller.signal.aborted) return;
            if (result.some(item => item.project !== project)) throw new Error('Capture sessions belong to another project.');
            if (requestedVersion === mutationVersion.current) setSessions(result);
            setLoading(false);
        }).catch(reason => { if (!controller.signal.aborted) { setError(message(reason)); setLoading(false); } });
        return () => controller.abort();
    }, [active, api, project, listEpoch]);
    useEffect(() => {
        if (selectedId && !session && !loading) {
            setSelectedId(undefined); setEvents([]); setSelectedEventId(undefined); setCredentials(undefined);
        }
    }, [selectedId, session, loading]);
    useEffect(() => {
        if (!active || !selectedId || !sessionGeneration) return;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        if (cursor.current.id !== selectedId) cursor.current = { id: selectedId, after: 0 };
        const read = async () => {
            try {
                const page = await api.events(selectedId, cursor.current.after, controller.signal);
                if (controller.signal.aborted) return;
                if (page.session.id !== selectedId || page.session.project !== project || page.session.generation !== sessionGeneration) throw new Error('Capture events belong to another session, project or index generation.');
                const advanced = page.next_after > cursor.current.after;
                cursor.current.after = page.next_after;
                setEvents(current => mergeCaptureEvents(current, page.events));
                setSessions(current => current.map(item => item.id === selectedId ? page.session : item));
                if (!page.complete || page.session.status === 'recording') {
                    timer = setTimeout(() => void read(), !page.complete && advanced ? 100 : 1000);
                }
            } catch (reason) { if (!controller.signal.aborted) setError(message(reason)); }
        };
        void read();
        return () => { controller.abort(); if (timer !== undefined) clearTimeout(timer); };
    }, [active, api, selectedId, sessionGeneration, project, pollEpoch]);
    const selectSession = (id: string) => {
        if (id === selectedId) return;
        setSelectedId(id); setEvents([]); setSelectedEventId(undefined); setLimit(PAGE_SIZE); setError(undefined); setCopyStatus('');
        if (credentials?.session.id !== id) setCredentials(undefined);
    };
    const mutate = async (action: (signal: AbortSignal) => Promise<void>) => {
        if (busy || !active) return;
        mutationVersion.current++;
        const signal = operation.current.signal; setBusy(true); setError(undefined); setCopyStatus('');
        try { await action(signal); } catch (reason) { if (!signal.aborted) setError(message(reason)); }
        finally { if (!signal.aborted) setBusy(false); }
    };
    const start = () => void mutate(async signal => {
        const started = await api.start({ project, generation, profile, values_enabled: values, allowed_fields: allowedFields,
            ...(profile === 'browser' && origin ? { allowed_origin: origin } : {}) }, signal);
        if (signal.aborted) return;
        if (!sameSnapshot(started.session, project, generation)) throw new Error('Capture started against a different project or generation.');
        setSessions(current => [started.session, ...current.filter(item => item.id !== started.session.id)]);
        setCredentials(started); setSelectedId(started.session.id); setEvents([]); setSelectedEventId(undefined); setLimit(PAGE_SIZE);
        setSetupOrigin(profile === 'browser' ? origin : undefined);
        // Opt-in is per session; a later capture always starts from metadata-only settings.
        setValues(false); setFields('');
    });
    const stop = () => session && void mutate(async signal => {
        const stopped = await api.stop(session.id, signal);
        if (signal.aborted) return;
        setSessions(current => current.map(item => item.id === stopped.id ? stopped : item));
        setCredentials(undefined); setPollEpoch(value => value + 1);
    });
    const remove = () => session && void mutate(async signal => {
        await api.remove(session.id, signal);
        if (signal.aborted) return;
        setSessions(current => current.filter(item => item.id !== session.id));
        setSelectedId(undefined); setEvents([]); setSelectedEventId(undefined); setCredentials(undefined);
    });
    const copy = async (value: string, label: string) => {
        try { await navigator.clipboard.writeText(value); setCopyStatus(`${label} copied.`); }
        catch { setCopyStatus(`Could not copy ${label.toLowerCase()}. Select and copy it manually.`); }
    };
    return <section className="capture-panel" data-testid="capture-panel" aria-label="Local live capture">
        <header className="capture-header"><div><h3>Local live capture</h3>
            <p>Start a local receiver session, then start your application manually with its development adapter.</p></div>
            <button type="button" className="atlas-arch-action" data-capture-refresh disabled={!active || busy} onClick={() => { setError(undefined); setListEpoch(value => value + 1); }}>Refresh sessions</button></header>
        <p className="capture-muted">Sessions and events stay in server memory until deleted or the server exits. Expiry stops recording and preserves events for review. Starting capture does not launch or modify your application. CUDA is static analysis only.</p>
        <form className="capture-form" onSubmit={event => { event.preventDefault(); if (canStart) start(); }}>
            <label>Runtime profile<select aria-label="Capture runtime profile" value={profile} onChange={event => {
                setProfile(event.target.value as CaptureProfile);
                if (event.target.value === 'browser' && !origin) setOrigin('http://127.0.0.1:4319');
            }}>
                {CAPTURE_PROFILES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            {profile === 'browser' && <label>Allowed local application origin
                <input aria-label="Allowed capture origin" type="url" placeholder="http://localhost:5173" value={origin} onChange={event => setOrigin(event.target.value)} />
                <small>Optional. Allow exactly this application origin to send browser events.</small></label>}
            <label className="capture-check"><input type="checkbox" data-capture-values checked={values} onChange={event => setValues(event.target.checked)} />
                Include raw values for explicitly chosen test fields in this session</label>
            {values && <label>Allowed test field paths, one per line
                <textarea data-capture-fields aria-label="Allowed test field paths" rows={3} value={fields} onChange={event => setFields(event.target.value)} placeholder={'user.email\nrequest.test_id'} />
                <small>No wildcards. Only use test data. Raw values remain off for all other fields.</small></label>}
            <button className="atlas-arch-action" type="submit" data-capture-start disabled={!canStart}>{busy ? 'Working…' : 'Start capture session'}</button>
        </form>
        <p className="capture-muted">A profile selects an adapter family. The session reports the capabilities actually available.</p>
        {error && <div role="alert" className="capture-error">{error}
            <button type="button" className="atlas-arch-action" onClick={() => { setError(undefined); setListEpoch(value => value + 1); setPollEpoch(value => value + 1); }}>Retry capture read</button></div>}
        {loading ? <p role="status">Loading local sessions…</p> : sessions.length === 0 ? <p>No local capture sessions for this project.</p> : null}
        {sessions.length > 0 && <div className="capture-sessions" role="group" aria-label="Capture sessions">{sessions.map(item =>
            <button type="button" key={item.id} data-capture-session={item.id} aria-pressed={selectedId === item.id} onClick={() => selectSession(item.id)}>
                {item.profile} · {item.status}<small>{item.id}</small></button>)}</div>}
        {session && <div className="capture-session" data-capture-session-detail={session.id}>
            <div className="capture-session-heading"><div><h4>{session.profile} · {session.status}</h4>
                <p>{session.accepted_events.toLocaleString()} accepted · {session.dropped_events.toLocaleString()} dropped · limit {session.max_events.toLocaleString()}</p></div>
                <div className="capture-actions">
                    {session.status === 'recording' && <button type="button" className="atlas-arch-action" data-capture-stop disabled={busy || !active} onClick={stop}>Stop capture</button>}
                    <button type="button" className="atlas-arch-action" data-capture-delete disabled={busy || !active} onClick={remove}>Delete session and events</button>
                </div>
            </div>
            <p className="capture-muted">Created {dateLabel(session.created_at)} · expires {dateLabel(session.expires_at)}</p>
            <p className="capture-identity">Index generation: <code>{session.generation}</code></p>
            {!matchesCurrent && <p className="capture-error">This session belongs to a different index generation. Its events remain inspectable; source navigation requires the matching index.</p>}
            <p>{session.values_enabled ? `Raw test values enabled only for: ${session.allowed_fields.join(', ')}` : 'Raw values are off. Only event metadata and opaque value identities are shown.'}</p>
            <div className="capture-capabilities"><strong>Reported capabilities</strong>
                {session.capabilities.length ? <ul>{session.capabilities.map((capability, index) => <li key={`${capability}:${index}`}>{capability}</li>)}</ul>
                    : <p>No instrumentation capability has been reported.</p>}
                {session.gaps.length > 0 && <><strong>Coverage gaps</strong><ul>{session.gaps.map((gap, index) => <li key={`${gap}:${index}`}>{gap}</li>)}</ul></>}
            </div>
            {credentials?.session.id === session.id && session.status === 'recording' && <div className="capture-setup" aria-label="Capture setup">
                <h4>Start your application manually</h4>
                <p>Use the session token with the adapter instructions below. The token is shown only for this newly created session and is not saved by Lens.</p>
                <label>Session token<input type="password" readOnly value={credentials.token} aria-label="Capture session token" autoComplete="off" spellCheck={false} /></label>
                <button type="button" className="atlas-arch-action" data-capture-copy-token onClick={() => void copy(credentials.token, 'Session token')}>Copy session token</button>
                <dl>{([['Lineage receiver', credentials.lineage_url], ['Call span receiver', credentials.traces_url]] as const).map(([label, value]) =>
                    <div key={label}><dt>{label}</dt><dd><code>{localEndpoint(value) ?? 'Receiver URL is outside this local server.'}</code></dd></div>)}</dl>
                <ol>{credentials.instructions.map((instruction, index) => <li key={index}><pre>{instruction}</pre></li>)}</ol>
                <button type="button" className="atlas-arch-action" onClick={() => void copy(credentials.instructions.join('\n'), 'Adapter instructions')}>Copy adapter instructions</button>
                {localEndpoint(credentials.lineage_url) && <CaptureAdapterSetup session={session} endpoint={localEndpoint(credentials.lineage_url)!}
                    origin={setupOrigin} loader={readAdapters} copy={copy} />}
            </div>}
            {copyStatus && <p role="status">{copyStatus}</p>}
            <div className="capture-evidence">
                <div><h4>Observed events ({events.length.toLocaleString()})</h4>
                    <p className="capture-muted">Call spans do not establish field-level value flow. Value links require explicit adapter input identities.</p>
                    {events.length === 0 ? <p>No events received. Start the instrumented application separately.</p> : <ol className="capture-event-list">
                        {events.slice(-limit).map(event => <li key={event.id}><button type="button" data-capture-event={event.id} aria-pressed={selectedEventId === event.id} onClick={() => setSelectedEventId(event.id)}>
                            <strong>{event.operation}</strong><span>{event.access_path ?? event.invocation_id}</span><small>{event.producer_id} · {event.language} · source {event.source_status}</small>
                        </button></li>)}</ol>}
                    {events.length > limit && <button className="atlas-arch-action" type="button" onClick={() => setLimit(value => value + PAGE_SIZE)}>Show older events ({events.length - limit})</button>}
                </div>
                {selectedEvent && <aside className="capture-event-detail" aria-label="Observed event evidence">
                    <h4>{selectedEvent.operation} · {selectedEvent.access_path ?? selectedEvent.invocation_id}</h4>
                    <dl><div><dt>Producer</dt><dd>{selectedEvent.producer_id}</dd></div><div><dt>Invocation</dt><dd>{selectedEvent.invocation_id}</dd></div>
                        <div><dt>Opaque value ID</dt><dd>{selectedEvent.value_id ?? 'No value identity reported'}</dd></div>
                        <div><dt>Source status</dt><dd data-capture-source-status={selectedEvent.source_status}>{selectedEvent.source_status}</dd></div></dl>
                    {selectedEvent.source && <><button type="button" className="atlas-arch-source" data-capture-source disabled={!active || !matchesCurrent || selectedEvent.source_status !== 'matched'}
                        onClick={() => setSourceEvidence({ session: session.id, event: selectedEvent.id, request: { project, generation: session.generation,
                            file_path: selectedEvent.source!.file_path, source_hash: selectedEvent.source!.source_hash, start_line: selectedEvent.source!.line,
                            end_line: selectedEvent.source!.line + 12 } })}>
                        Verify source · {selectedEvent.source.file_path}:{selectedEvent.source.line}</button><p className="capture-identity">Source hash: <code>{selectedEvent.source.source_hash}</code></p></>}
                    {selectedEvent.detail && <p>{selectedEvent.detail}</p>}
                    {session.values_enabled && selectedEvent.access_path && session.allowed_fields.includes(selectedEvent.access_path) && selectedEvent.preview !== undefined
                        && <div className="capture-preview"><strong>Explicit test field preview</strong><pre>{selectedEvent.preview}</pre></div>}
                    <h4>Declared value slice</h4>
                    <p>{slice!.events.length} observed events · {slice!.links.length} explicit input links</p>
                    {slice!.unresolvedInputs > 0 && <p>{slice!.unresolvedInputs} input identities are unresolved or ambiguous in the received events.</p>}
                    {slice!.links.length > 0 ? <ol className="capture-slice-links">{slice!.links.map(link => <li key={`${link.source}:${link.target}:${link.producer_id}:${link.value_id}`}>
                        <button type="button" onClick={() => setSelectedEventId(link.source)}>Event {link.source}</button>
                        <span> → </span><button type="button" onClick={() => setSelectedEventId(link.target)}>Event {link.target}</button>
                        <small>{link.producer_id} · {link.value_id}</small></li>)}</ol> : <p>No explicit value links were reported for this event.</p>}
                </aside>}
            </div>
            {sourceEvidence && matchesCurrent && sourceEvidence.session === session.id && sourceEvidence.event === selectedEventId
                && <VerifiedSource request={sourceEvidence.request} active={active} loader={readSource} onClose={() => setSourceEvidence(undefined)} />}
        </div>}
    </section>;
}
