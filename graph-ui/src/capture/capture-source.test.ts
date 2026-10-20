import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureApi, readCaptureEvents, readCaptureSession, readCaptureStarted } from './capture-source';
import { captureEvent, captureSession, captureStarted } from './capture-fixture';

afterEach(() => vi.unstubAllGlobals());
describe('native local capture protocol', () => {
    it('starts only a generation-bound session with an exact opt-in field allowlist', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(captureStarted())));
        vi.stubGlobal('fetch', fetch);
        const controller = new AbortController();
        await captureApi.start({ project: 'sample', generation: 'g1', profile: 'node', values_enabled: false, allowed_fields: [] }, controller.signal);
        expect(fetch).toHaveBeenCalledWith('/api/capture/sessions', expect.objectContaining({
            method: 'POST', signal: controller.signal,
            body: JSON.stringify({ project: 'sample', generation: 'g1', profile: 'node', values_enabled: false, allowed_fields: [] }),
        }));
        await expect(captureApi.start({ project: 'sample', generation: 'g1', profile: 'node', values_enabled: true, allowed_fields: [] }, controller.signal)).rejects.toThrow(/field/i);
        await expect(captureApi.start({ project: 'sample', generation: 'g1', profile: 'node', values_enabled: true, allowed_fields: ['*'] }, controller.signal)).rejects.toThrow(/field/i);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('accepts backend capability gaps without advertising an unknown adapter as supported', () => {
        expect(readCaptureSession(captureSession({ profile: 'future-profile', capabilities: [], gaps: ['Unavailable adapter.'] })).capabilities).toEqual([]);
        expect(() => readCaptureSession(captureSession({ generation: '' }))).toThrow(/session/i);
        expect(() => readCaptureSession(captureSession({ accepted_events: -1 }))).toThrow(/session/i);
    });
    it('does not accept malformed event cursors or foreign sessions', async () => {
        const page = { schema_version: 1, session: captureSession(), events: [captureEvent()], next_after: 1, complete: false };
        expect(readCaptureEvents(page).events[0].source_status).toBe('matched');
        expect(() => readCaptureEvents({ ...page, next_after: -1 })).toThrow(/events/i);
        expect(() => readCaptureEvents({ ...page, events: [captureEvent({ source_status: 'invented' as never })] })).toThrow(/events/i);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(page))));
        await expect(captureApi.events('another-session', 0, new AbortController().signal)).rejects.toThrow(/session/i);
    });
    it('rejects malformed credential responses without storing their token', () => {
        expect(readCaptureStarted(captureStarted()).token).toBe('ephemeral-test-token');
        expect(() => readCaptureStarted({ ...captureStarted(), instructions: 'Run this' })).toThrow(/start/i);
    });
    it('reports native HTTP errors and forwards pagination plus cancellation', async () => {
        const signal = new AbortController().signal;
        const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Snapshot changed.' }), { status: 409 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: 1, session: captureSession(), events: [], next_after: 7, complete: true })));
        vi.stubGlobal('fetch', fetch);
        await expect(captureApi.stop('capture-1', signal)).rejects.toThrow('Snapshot changed.');
        await captureApi.events('capture-1', 7, signal);
        expect(fetch).toHaveBeenLastCalledWith('/api/capture/events?id=capture-1&after=7', expect.objectContaining({ signal }));
    });
});
