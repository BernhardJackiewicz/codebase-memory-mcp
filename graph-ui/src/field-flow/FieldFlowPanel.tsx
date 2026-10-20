import { useEffect, useMemo, useRef, useState } from 'react';
import type { SystemGraphEntity } from '../architecture/system-graph-source';
import { anchoredEntities, fieldLabel, parseFieldSelector } from './field-flow-model';
import { loadFieldFlow, type FieldCertainty, type FieldFlowLoader, type FieldFlowRequest, type FieldFlowResult,
    type FieldSelector, type FlowDirection, type SourceSpan } from './field-flow-source';
import { type SourceEvidenceLoader, type SourceEvidenceRequest } from './source-evidence';
import VerifiedSource from './VerifiedSource';
import { PackageProvenance, ResolverProvenance } from './FieldProvenance';
import './field-flow.css';

export interface FieldFlowPanelProps {
    project: string; generation: string; active: boolean; initialFile?: string; entities?: readonly SystemGraphEntity[];
    loader?: FieldFlowLoader; readSource?: SourceEvidenceLoader; onSelectEntity?: (entity: SystemGraphEntity) => void;
}
export const certaintyLabels: Record<FieldCertainty, string> = { proven: 'Proven', may: 'Possible', derived: 'Derived', control: 'Control only', unknown: 'Unknown' };
const certaintyMeaning: Record<FieldCertainty, string> = {
    proven: 'The indexed rule proves this static value dependence.',
    may: 'Alternative branches or aliasing make this a possible dependence.',
    derived: 'The target is derived from the source; its value need not be identical.',
    control: 'A control dependency does not prove transport of a field value.',
    unknown: 'The analyzer cannot establish this dependence.',
};
export default function FieldFlowPanel(props: FieldFlowPanelProps) {
    return <FieldWorkspace key={JSON.stringify([props.project, props.generation, props.initialFile])} {...props} />;
}
function FieldWorkspace({ project, generation, active, initialFile = '', entities = [], loader = loadFieldFlow, readSource, onSelectEntity }: FieldFlowPanelProps) {
    const [file, setFile] = useState(initialFile), [symbol, setSymbol] = useState(''), [fields, setFields] = useState(''), [byte, setByte] = useState('');
    const [direction, setDirection] = useState<FlowDirection>('forward');
    const [request, setRequest] = useState<FieldFlowRequest>(), [revision, setRevision] = useState(0);
    const [reading, setReading] = useState<{ result?: FieldFlowResult; error?: string; busy?: boolean }>({});
    const [formError, setFormError] = useState<string>(), [selected, setSelected] = useState<string>();
    const [evidence, setEvidence] = useState<SourceEvidenceRequest>();
    const [pathLimit, setPathLimit] = useState(8), [candidateLimit, setCandidateLimit] = useState(24);
    const symbolInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (!request || !active) return;
        const controller = new AbortController(); setReading({ busy: true }); setEvidence(undefined);
        void loader(request, controller.signal).then(result => {
            if (controller.signal.aborted) return;
            if (result.project !== project || result.generation !== generation) throw new Error('Field-flow project or generation changed. Reload source occurrences.');
            setReading({ result }); setSelected('value_id' in request.source ? request.source.value_id : result.values[0]?.id);
            setPathLimit(8); setCandidateLimit(24);
        }).catch(cause => { if (!controller.signal.aborted) setReading({ error: cause instanceof Error ? cause.message : 'Field flow could not be read.' }); });
        return () => controller.abort();
    }, [request, revision, active, project, generation, loader]);
    const trace = (source: FieldSelector) => {
        setFormError(undefined); setSelected(undefined); setEvidence(undefined);
        setRequest({ project, generation, source, direction }); setRevision(value => value + 1);
    };
    const edit = (update: () => void) => { update(); setRequest(undefined); setReading({}); setSelected(undefined); setEvidence(undefined); setFormError(undefined); };
    const switchDirection = (next: FlowDirection) => {
        setDirection(next); setEvidence(undefined);
        if (request) setRequest({ ...request, direction: next });
    };
    const result = reading.result;
    const values = useMemo(() => new Map(result?.values.map(value => [value.id, value]) ?? []), [result]);
    const links = useMemo(() => new Map(result?.links.map(link => [link.id, link]) ?? []), [result]);
    const operations = useMemo(() => new Map(result?.operations.map(operation => [operation.id, operation]) ?? []), [result]);
    const current = selected ? values.get(selected) : undefined;
    const anchors = current ? anchoredEntities(current, entities) : [];
    const viewSource = (source: SourceSpan) => setEvidence({ project, generation, file_path: source.file_path,
        source_hash: source.source_hash, start_line: source.start_line, end_line: source.end_line });
    return <section className="field-flow" data-testid="field-flow" aria-label="Static field flow">
        <div className="field-flow-heading"><h3>Trace a field</h3><span>Static source analysis</span></div>
        <p>Choose a source occurrence and follow its indexed value dependencies. Static dependence does not establish observed execution.</p>
        <form className="field-flow-form" onSubmit={event => {
            event.preventDefault(); try { trace(parseFieldSelector(file, symbol, fields, byte)); }
            catch (cause) { setFormError(cause instanceof Error ? cause.message : 'Check the source selector.'); }
        }}>
            <label>Source file<input data-field-file value={file} onChange={event => edit(() => setFile(event.target.value))} placeholder="src/users.ts" required /></label>
            <label>Symbol (optional)<input data-field-symbol ref={symbolInput} value={symbol} onChange={event => edit(() => setSymbol(event.target.value))} placeholder="Exact indexed symbol" /></label>
            <label>Field path (JSON segments, optional)<input data-field-segments value={fields} onChange={event => edit(() => setFields(event.target.value))} placeholder={'["user","email"]'} /></label>
            <label>Byte offset (optional)<input data-field-byte type="number" min="0" step="1" value={byte} onChange={event => edit(() => setByte(event.target.value))} title="Zero-based UTF-8 byte offset of the exact value occurrence, not a line number or function declaration." /></label>
            <div className="field-flow-directions" role="group" aria-label="Field flow direction">
                <button type="button" data-field-direction="backward" aria-pressed={direction === 'backward'} onClick={() => switchDirection('backward')}>← Upstream</button>
                <button type="button" data-field-direction="forward" aria-pressed={direction === 'forward'} onClick={() => switchDirection('forward')}>Downstream →</button>
            </div>
            <button type="submit" data-field-submit disabled={!active || !file.trim() || reading.busy}>Find field occurrences</button>
        </form>
        {(formError || reading.error) && <p role="alert">{formError ?? reading.error}</p>}
        {reading.busy && <p role="status">Reading field-flow evidence…</p>}
        {result && <>
            {result.gaps.some(gap => gap.code === 'candidate_limit') && <aside className="field-flow-boundary" data-field-candidate-bound aria-label="Narrow source selection">
                <strong>Only the first {result.values.length} matching occurrences were returned.</strong>
                <p>To reach a later function, narrow the source selector using its exact indexed symbol or the byte offset of the value occurrence.
                    {' '}Symbol names are exact, including any indexed suffix. Byte offsets are zero-based UTF-8 positions, not line numbers.
                    {' '}“More occurrences” only reveals the candidates already returned; it cannot retrieve omitted matches.</p>
                <button type="button" data-field-narrow onClick={() => {
                    symbolInput.current?.focus(); symbolInput.current?.scrollIntoView?.({ block: 'center' });
                }}>Narrow source selection</button>
            </aside>}
            <div className="field-flow-heading"><h4>{result.status === 'selection_required' ? 'Choose a source occurrence'
                : result.complete && result.gaps.length === 0 ? 'Indexed field-flow slice' : 'Partial indexed field flow'}</h4>
                <span>{result.values.length} occurrences · {result.links.length} dependencies</span></div>
            {result.status === 'selection_required' ? <><p>Several indexed occurrences match this selector. Choose the exact version and source location.</p>
                <ul className="field-flow-candidates">{result.values.slice(0, candidateLimit).map(value => <li key={value.id}>
                    <button type="button" data-field-candidate={value.id} onClick={() => trace({ value_id: value.id })} disabled={!active}>
                        <strong>{fieldLabel(value)}</strong><span>{value.symbol} · version {value.version} · {value.kind}</span>
                        <small>{value.source.file_path}:{value.source.start_line} · bytes {value.source.start_byte}–{value.source.end_byte} · {value.analysis_status}</small>
                    </button></li>)}</ul>
                {result.values.length > candidateLimit && <button type="button" onClick={() => setCandidateLimit(count => count + 24)}>More occurrences</button>}
            </> : <>
                {result.paths.length === 0 && <p>No supported field path was returned. Review the analysis gaps below.</p>}
                <div className="field-flow-paths">{result.paths.slice(0, pathLimit).map((path, index) => <ol className="field-flow-path" data-field-path={index} key={index}
                    aria-label={`${path.direction === 'forward' ? 'Downstream' : 'Upstream'} static path ${index + 1}`}>
                    {path.values.map((id, at) => {
                        const value = values.get(id)!, edge = at ? links.get(path.links[at - 1]) : undefined;
                        return <li key={`${id}:${at}`}>
                            {edge && <span className="field-flow-step" data-field-certainty={edge.certainty} title={certaintyMeaning[edge.certainty]}>
                                {path.direction === 'forward' ? '→' : '←'} {edge.kind} · {certaintyLabels[edge.certainty]}</span>}
                            <button type="button" data-field-value={id} aria-pressed={selected === id} onClick={() => { setSelected(id); setEvidence(undefined); }}>
                                <strong>{fieldLabel(value)}</strong><small>{value.symbol || value.kind} · version {value.version}</small><small>{value.source.file_path}:{value.source.start_line} · byte {value.source.start_byte}</small>
                            </button>
                        </li>;
                    })}
                </ol>)}</div>
                {result.paths.length > pathLimit && <button type="button" onClick={() => setPathLimit(count => count + 8)}>More paths</button>}
                {current && <section className="field-flow-detail" aria-label="Field occurrence evidence">
                    <h4>{fieldLabel(current)}</h4><p>{current.symbol} · {current.kind} · version {current.version} · {current.analysis_status}</p>
                    <p className="field-flow-identity">Occurrence <code>{current.id}</code> · bytes {current.source.start_byte}–{current.source.end_byte}</p>
                    <p className="field-flow-identity">Binding identity <code>{current.binding || 'Not recorded'}</code></p>
                    <p className="field-flow-identity" data-field-source-hash>Indexed source hash <code>{current.source.source_hash}</code></p>
                    {current.package && <PackageProvenance value={current.package} />}
                    <button type="button" data-field-source disabled={!active || current.analysis_status !== 'ready'} onClick={() => viewSource(current.source)}>
                        Verify source · {current.source.file_path}:{current.source.start_line}</button>
                    {current.analysis_status === 'stale' && <p role="status">This analysis partition is stale. Reindex before inspecting matching source evidence.</p>}
                    {anchors.length > 0 && <div className="field-flow-anchors"><span>Indexed symbol in system graph:</span>{anchors.map(entity =>
                        <button type="button" data-field-entity={entity.id} key={entity.id} disabled={!onSelectEntity} onClick={() => onSelectEntity?.(entity)}>{entity.name}</button>)}</div>}
                    {result.links.filter(edge => edge.source === current.id || edge.target === current.id).map(edge => {
                        const operation = operations.get(edge.operation_id)!;
                        return <div className="field-flow-operation" key={edge.id}><p>{fieldLabel(values.get(edge.source)!)} → {fieldLabel(values.get(edge.target)!)}</p>
                            <p><strong>{operation.kind}{operation.operator_name ? ` · ${operation.operator_name}` : ''}</strong> · <span data-field-certainty={edge.certainty}>{certaintyLabels[edge.certainty]}</span></p>
                            <p>{certaintyMeaning[edge.certainty]}</p><button type="button" data-field-operation={operation.id} disabled={!active}
                                onClick={() => viewSource(operation.source)}>Verify operation source · {operation.source.file_path}:{operation.source.start_line}</button>
                            {edge.resolution && <ResolverProvenance proof={edge.resolution} />}</div>;
                    })}
                </section>}
            </>}
            <details className="field-flow-gaps" open={result.gaps.length > 0}><summary>Analysis limits and gaps ({result.gaps.length})</summary>
                <p>Coverage: indexed flow IR slice. These paths cover only resolved static dependencies within the configured bounds.</p>
                <p>Depth {result.limits.max_depth} · paths {result.limits.max_paths} · states {result.limits.visited_states}/{result.limits.max_states} · call depth {result.limits.max_call_depth}</p>
                <ul>{result.gaps.map((gap, index) => <li key={index} data-field-gap={gap.code}><strong>{gap.code.replaceAll('_', ' ')}</strong><span>{gap.message}</span>
                    {gap.file_path && <small>{gap.file_path}{gap.source?.start_line ? `:${gap.source.start_line}` : ''}</small>}</li>)}</ul>
            </details>
        </>}
        {evidence && <VerifiedSource request={evidence} active={active} loader={readSource} onClose={() => setEvidence(undefined)} />}
    </section>;
}
