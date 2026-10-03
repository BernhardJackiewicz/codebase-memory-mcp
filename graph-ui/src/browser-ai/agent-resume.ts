/** Opening another project reloads the page, and the worker with the loaded model goes
 * with it (K24). The switch leaves a short note in this tab; the next page loads the
 * same model again, only from the browser cache. */
export const AGENT_RESUME_KEY = 'cbm-agent-resume';
/** A switch is a navigation of a few seconds; a stale note must not load a model later. */
export const AGENT_RESUME_WINDOW_MS = 60_000;

export function requestAgentResume(now = Date.now()): void {
    try { window.sessionStorage.setItem(AGENT_RESUME_KEY, JSON.stringify({ at: now })); } catch { /* Without storage the next page starts with the agent off. */ }
}

/** True once for a fresh note; reading removes it. */
export function takeAgentResume(now = Date.now()): boolean {
    let raw: string | null = null;
    try { raw = window.sessionStorage.getItem(AGENT_RESUME_KEY); window.sessionStorage.removeItem(AGENT_RESUME_KEY); } catch { return false; }
    try {
        const at = (JSON.parse(raw ?? 'null') as { at?: unknown } | null)?.at;
        return typeof at === 'number' && now >= at && now - at <= AGENT_RESUME_WINDOW_MS;
    } catch { return false; }
}
