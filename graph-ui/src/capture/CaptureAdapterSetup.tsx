import { useEffect, useState } from 'react';
import type { CaptureSession } from './capture-source';
import { ADAPTER_DETAILS, adapterCommands, loadAdapters, type AdapterLoader, type CaptureAdapter } from './capture-adapters';
export default function CaptureAdapterSetup({ session, endpoint, origin, loader = loadAdapters, copy }: {
    session: CaptureSession; endpoint: string; origin?: string; loader?: AdapterLoader;
    copy: (value: string, label: string) => Promise<void>;
}) {
    const [adapters, setAdapters] = useState<CaptureAdapter[]>(), [error, setError] = useState<string>();
    useEffect(() => {
        const controller = new AbortController();
        void loader(controller.signal).then(result => { if (!controller.signal.aborted) setAdapters(result); })
            .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Adapter manifest could not be read.'); });
        return () => controller.abort();
    }, [loader]);
    const adapter = adapters?.find(item => item.profile === session.profile);
    const commands = adapter ? adapterCommands(session, endpoint, origin) : undefined;
    const details = ADAPTER_DETAILS[session.profile];
    return <div className="capture-adapter-setup" data-capture-adapter-setup>
        <h4>Local development adapter</h4>
        {error ? <p>{error}</p> : !adapters ? <p>Checking adapters included in this build…</p> : !adapter
            ? <p>No automatic adapter for this profile is included in this build. Receiver availability alone does not provide instrumentation.</p>
            : <><p><a className="atlas-arch-action" data-capture-download href={adapter.archive} download>Download {session.profile} adapter ZIP</a>
                {' '}· {(adapter.size / 1024).toFixed(0)} KB</p>
                <p>Extract into a temporary directory. Replace the paths below and launch manually in your terminal. Stop using the loader on the next launch to remove the probes.</p>
                {details && <><p data-capture-adapter-prerequisites>{details.prerequisites}</p><p data-capture-adapter-limits>{details.limits}</p></>}
                {session.profile === 'browser' && <p>Native ESM development pages only. Open the overlay at <code>http://127.0.0.1:{origin ? new URL(origin).port : '4319'}</code>.
                    {' '}This exact origin must be allowed when starting this session. Existing bundler servers are not instrumented by this overlay.</p>}
                {session.profile === 'browser' && !commands && <p role="note">This session does not allow the bundled overlay origin.
                    {' '}Create a browser session allowing exactly <code>http://127.0.0.1:4319</code> to use its manual launch command.</p>}
                {!details && <p>Read the archive’s adapter instructions for its supported local build and launch. No launch command is available for this profile here.</p>}
                {commands && <><pre data-capture-launch-command>{commands}</pre><button type="button" className="atlas-arch-action"
                    data-capture-copy-launch onClick={() => void copy(commands, 'Manual launch command')}>Copy manual launch command</button></>}
                <p className="capture-muted">Commands are for Bash/Zsh and prompt for the token without displaying it. Raw values require the same explicit allowlist in both this session and the adapter.</p>
            </>}
    </div>;
}
