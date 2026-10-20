// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CaptureAdapterSetup from './CaptureAdapterSetup';
import { captureSession } from './capture-fixture';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe('bundled capture adapter setup', () => {
    it.each(['node', 'browser', 'python', 'go', 'dotnet', 'jvm', 'rust', 'php', 'native'])('offers a manual %s launch with its actual prerequisites and limits', async profile => {
        const copy = vi.fn().mockResolvedValue(undefined);
        await act(async () => root.render(<CaptureAdapterSetup session={captureSession({ profile })}
            endpoint="http://127.0.0.1:9749/v1/cbm/lineage?session=example" origin="http://127.0.0.1:4319" copy={copy}
            loader={async () => [{ profile, archive: `/capture-adapters/${profile}.zip`, sha256: 'a'.repeat(64), size: 5000 }]} />));
        expect(container.querySelector('[data-capture-download]')?.getAttribute('href')).toBe(`/capture-adapters/${profile}.zip`);
        expect(container.querySelector('[data-capture-adapter-prerequisites]')?.textContent?.length).toBeGreaterThan(20);
        expect(container.querySelector('[data-capture-adapter-limits]')?.textContent?.length).toBeGreaterThan(20);
        const commands = container.querySelector('[data-capture-launch-command]')?.textContent;
        expect(commands).toContain('read -r -s CBM_CAPTURE_TOKEN');
        expect(commands).toContain('export CBM_CAPTURE_VALUES=0');
        expect(commands).toContain("export CBM_CAPTURE_FIELDS='[]'");
        expect(copy).not.toHaveBeenCalled();
        await act(async () => container.querySelector<HTMLButtonElement>('[data-capture-copy-launch]')!.click());
        expect(copy).toHaveBeenCalledExactlyOnceWith(commands, 'Manual launch command');
    });
    it('does not advertise known profiles absent from the build manifest', async () => {
        await act(async () => root.render(<CaptureAdapterSetup session={captureSession({ profile: 'rust' })}
            endpoint="http://127.0.0.1:9749/v1/cbm/lineage?session=example" copy={vi.fn()}
            loader={async () => []} />));
        expect(container.querySelector('[data-capture-download]')).toBeNull();
        expect(container.querySelector('[data-capture-launch-command]')).toBeNull();
        expect(container.textContent).toContain('No automatic adapter');
    });
});
