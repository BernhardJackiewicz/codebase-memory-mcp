/** Opening another project reloads the page, and the worker with the loaded model goes
 * with it (K24). The switch leaves a short note in this tab; the next page loads the
 * same model again, only from the browser cache. */
export const AGENT_RESUME_KEY = 'cbm-agent-resume';
/** A switch is a navigation of a few seconds; a stale note must not load a model later. */
export const AGENT_RESUME_WINDOW_MS = 60_000;

const thisPage = (): number => typeof performance === 'undefined' ? 0 : performance.timeOrigin;

export function requestAgentResume(now = Date.now()): void {
    try { window.sessionStorage.setItem(AGENT_RESUME_KEY, JSON.stringify({ at: now })); } catch { /* Without storage the next page starts with the agent off. */ }
}

/** True for a fresh note, for the first page that reads it only: a later reload does not
 * resume again, while a second read on the same page (React's development double effect) does. */
export function takeAgentResume(now = Date.now(), page = thisPage()): boolean {
    try {
        const note = JSON.parse(window.sessionStorage.getItem(AGENT_RESUME_KEY) ?? 'null') as { at?: unknown; page?: unknown } | null;
        const fresh = typeof note?.at === 'number' && now >= note.at && now - note.at <= AGENT_RESUME_WINDOW_MS;
        if (!fresh || (note!.page !== undefined && note!.page !== page)) { window.sessionStorage.removeItem(AGENT_RESUME_KEY); return false; }
        window.sessionStorage.setItem(AGENT_RESUME_KEY, JSON.stringify({ at: note!.at, page }));
        return true;
    } catch { return false; }
}
