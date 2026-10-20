import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadSourceEvidence, type SourceEvidence, type SourceEvidenceLoader, type SourceEvidenceRequest } from './source-evidence';
import './field-flow.css';

export interface VerifiedSourceProps { request: SourceEvidenceRequest; active: boolean; loader?: SourceEvidenceLoader; onClose: () => void }
export default function VerifiedSource(props: VerifiedSourceProps) {
    return <SourceContent key={JSON.stringify(props.request)} {...props} />;
}
function SourceContent({ request, active, loader = loadSourceEvidence, onClose }: VerifiedSourceProps) {
    const [source, setSource] = useState<SourceEvidence>(), [error, setError] = useState<string>();
    const host = useRef<HTMLElement>(null);
    useLayoutEffect(() => { host.current?.scrollIntoView?.({ block: 'nearest' }); }, [source, error]);
    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        void loader(request, controller.signal).then(result => {
            if (!controller.signal.aborted) setSource(result);
        }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Source evidence unavailable.'); });
        return () => controller.abort();
    }, [active, loader, request]);
    return <section ref={host} className="verified-source" aria-label="Verified source evidence">
        <div className="field-flow-heading"><h4>Source evidence</h4><button type="button" data-source-evidence-close onClick={onClose}>Close</button></div>
        <p>{request.file_path} · lines {source?.start_line ?? request.start_line}–{source?.end_line ?? request.end_line ?? request.start_line}</p>
        <p className="field-flow-identity">Index {request.generation} · SHA <code>{request.source_hash}</code></p>
        {error ? <p role="alert">{error}</p> : source ? <><p>Source hash and index generation verified.</p>
            <pre data-verified-source><code>{source.content.replace(/\n$/, '').split('\n').map((line, index) => <span className="verified-source-line" key={index}>
                <span aria-hidden="true">{source.start_line + index}</span>{line}{'\n'}</span>)}</code></pre>
            {!source.complete && <p role="status">Source excerpt limited to 200 lines.</p>}</> : <p role="status">Verifying source identity…</p>}
    </section>;
}
