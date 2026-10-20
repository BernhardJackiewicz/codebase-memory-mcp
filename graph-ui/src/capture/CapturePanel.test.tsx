// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CapturePanel, { type CapturePanelProps } from './CapturePanel';
import { captureEvent, captureSession, captureStarted } from './capture-fixture';
import type { CaptureApi } from './capture-source';

let container: HTMLDivElement, root: Root, api: CaptureApi;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    api = {
        list: vi.fn().mockResolvedValue([]), start: vi.fn().mockResolvedValue(captureStarted()),
        stop: vi.fn().mockResolvedValue(captureSession({ status: 'stopped', accepted_events: 1 })),
        remove: vi.fn().mockResolvedValue(undefined),
        events: vi.fn().mockResolvedValue({ schema_version: 1, session: captureSession({ accepted_events: 1 }),
            events: [captureEvent()], next_after: 1, complete: true }),
    };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
async function render(props: Partial<CapturePanelProps> = {}) {
    await act(async () => root.render(<CapturePanel project="sample" generation="g1" active api={api} onNavigate={vi.fn()} readAdapters={async () => []} {...props} />));
}
async function click(selector: string) {
    const button = container.querySelector<HTMLElement>(selector); expect(button).not.toBeNull();
    await act(async () => button!.click());
}
async function input(selector: string, value: string) {
    const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
describe('local capture workspace', () => {
    it('offers only a locally bundled adapter and keeps session tokens out of launch commands', async () => {
        const readAdapters = vi.fn().mockResolvedValue([{ profile: 'node', archive: '/capture-adapters/javascript.zip', sha256: 'a'.repeat(64), size: 1024 }]);
        await render({ readAdapters }); await click('[data-capture-start]');
        expect(container.querySelector('[data-capture-download]')?.getAttribute('href')).toBe('/capture-adapters/javascript.zip');
        expect(container.querySelector('[data-capture-launch-command]')?.textContent).toContain('node --import');
        expect(container.querySelector('[data-capture-launch-command]')?.textContent).not.toContain(captureStarted().token);
        await click('[data-capture-stop]');
        expect(container.querySelector('[data-capture-launch-command]')).toBeNull();
    });
    it('reads hash-bound source bytes for an event instead of opening an unchecked current file', async () => {
        const onNavigate = vi.fn(), readSource = vi.fn().mockImplementation(async request => ({ schema_version: 1, ...request,
            end_line: request.start_line, content: 'verified capture source', complete: true }));
        await render({ onNavigate, readSource }); await click('[data-capture-start]'); await click('[data-capture-event="1"]'); await click('[data-capture-source]');
        expect(readSource).toHaveBeenCalledWith({ project: 'sample', generation: 'g1', file_path: 'src/users.ts', source_hash: 'sha256:abc', start_line: 12, end_line: 24 }, expect.any(AbortSignal));
        expect(container.querySelector('[data-verified-source]')?.textContent).toContain('verified capture source');
        expect(onNavigate).not.toHaveBeenCalled();
    });
    it('starts a session only on explicit click with raw values disabled and explains manual app start', async () => {
        await render();
        expect(api.start).not.toHaveBeenCalled();
        expect(container.querySelector<HTMLInputElement>('[data-capture-values]')?.checked).toBe(false);
        await click('[data-capture-start]');
        expect(api.start).toHaveBeenCalledWith({ project: 'sample', generation: 'g1', profile: 'node', values_enabled: false, allowed_fields: [] }, expect.any(AbortSignal));
        expect(container.textContent).toContain('Start your application manually');
        expect(container.textContent).toContain('Application instrumentation must be installed separately.');
        expect(container.querySelector('[data-capture-copy-token]')).not.toBeNull();
        expect(container.querySelector('[data-capture-event="1"]')).not.toBeNull();
    });
    it('requires an explicit field allowlist before enabling raw previews', async () => {
        await render(); await click('[data-capture-values]');
        expect(container.querySelector<HTMLButtonElement>('[data-capture-start]')?.disabled).toBe(true);
        await input('[data-capture-fields]', 'user.email\nrequest.test_id');
        await click('[data-capture-start]');
        expect(api.start).toHaveBeenCalledWith(expect.objectContaining({
            values_enabled: true, allowed_fields: ['user.email', 'request.test_id'],
        }), expect.any(AbortSignal));
    });
    it('keeps stopped events inspectable until deletion and clears session credentials on stop', async () => {
        await render(); await click('[data-capture-start]'); await click('[data-capture-stop]');
        expect(api.stop).toHaveBeenCalledWith('capture-1', expect.any(AbortSignal));
        expect(container.querySelector('[data-capture-event="1"]')).not.toBeNull();
        expect(container.querySelector('[data-capture-copy-token]')).toBeNull();
        await click('[data-capture-delete]');
        expect(api.remove).toHaveBeenCalledWith('capture-1', expect.any(AbortSignal));
        expect(container.querySelector('[data-capture-event="1"]')).toBeNull();
    });
    it('cancels project polling and hides prior credentials and events immediately on switch', async () => {
        vi.useFakeTimers();
        await render(); await click('[data-capture-start]');
        const signal = vi.mocked(api.events).mock.calls[0][2];
        await render({ project: 'other' });
        expect(signal.aborted).toBe(true);
        expect(container.querySelector('[data-capture-event="1"]')).toBeNull();
        expect(container.querySelector('[data-capture-copy-token]')).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        expect(api.events).toHaveBeenCalledTimes(1);
    });
    it('shows stale source status without implying source identity or field lineage from spans', async () => {
        const onNavigate = vi.fn();
        vi.mocked(api.events).mockResolvedValue({ schema_version: 1, session: captureSession(), events: [
            captureEvent({ source_status: 'stale', operation: 'span', value_id: undefined, inputs: [] }),
        ], next_after: 1, complete: true });
        await render({ onNavigate }); await click('[data-capture-start]'); await click('[data-capture-event="1"]');
        expect(container.textContent).toContain('stale');
        expect(container.textContent).toContain('Call spans do not establish field-level value flow.');
        expect(container.querySelector<HTMLButtonElement>('[data-capture-source]')?.disabled).toBe(true);
        expect(onNavigate).not.toHaveBeenCalled();
    });
    it('never renders a raw preview unless its exact field was enabled for that session', async () => {
        vi.mocked(api.events).mockResolvedValue({ schema_version: 1, session: captureSession({
            values_enabled: true, allowed_fields: ['request.test_id'],
        }), events: [captureEvent({ preview: 'private-example@example.test' })], next_after: 1, complete: true });
        await render(); await click('[data-capture-start]'); await click('[data-capture-event="1"]');
        expect(container.textContent).not.toContain('private-example@example.test');
    });
    it('keeps a previous snapshot inspectable but disables its source jump', async () => {
        const older = captureSession({ generation: 'g0', status: 'stopped' });
        vi.mocked(api.list).mockResolvedValue([older]);
        vi.mocked(api.events).mockResolvedValue({ schema_version: 1, session: older, events: [captureEvent()], next_after: 1, complete: true });
        await render(); await click('[data-capture-session="capture-1"]'); await click('[data-capture-event="1"]');
        expect(container.textContent).toContain('different index generation');
        expect(container.querySelector<HTMLButtonElement>('[data-capture-source]')?.disabled).toBe(true);
    });
    it('removes expired server sessions on refresh instead of retaining a stale local list', async () => {
        vi.mocked(api.list).mockResolvedValueOnce([captureSession({ status: 'stopped' })]).mockResolvedValue([]);
        await render(); await click('[data-capture-session="capture-1"]');
        await click('[data-capture-refresh]');
        expect(container.querySelector('[data-capture-session="capture-1"]')).toBeNull();
        expect(container.querySelector('[data-capture-event="1"]')).toBeNull();
    });
});
