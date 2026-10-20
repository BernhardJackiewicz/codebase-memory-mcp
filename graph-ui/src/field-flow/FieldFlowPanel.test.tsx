// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FieldFlowPanel, { type FieldFlowPanelProps } from './FieldFlowPanel';
import { fieldFlowFixture, fieldFlowPackageResolutionFixture, fieldFlowProvenanceFixture } from './field-flow-fixture';
import type { FieldFlowLoader } from './field-flow-source';
import type { SourceEvidenceLoader } from './source-evidence';

let container: HTMLDivElement, root: Root, loader: ReturnType<typeof vi.fn<FieldFlowLoader>>, readSource: ReturnType<typeof vi.fn<SourceEvidenceLoader>>;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    loader = vi.fn<FieldFlowLoader>().mockResolvedValue(fieldFlowFixture());
    readSource = vi.fn<SourceEvidenceLoader>().mockImplementation(async request => ({ schema_version: 1, ...request,
        end_line: request.end_line ?? request.start_line, content: 'const verifiedEmail = input.email;', complete: true }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function render(props: Partial<FieldFlowPanelProps> = {}) {
    await act(async () => root.render(<FieldFlowPanel project="sample" generation="g1" active initialFile="src/users.ts" loader={loader} readSource={readSource} {...props} />));
}
async function click(selector: string) {
    const element = container.querySelector<HTMLElement>(selector); expect(element).not.toBeNull(); await act(async () => element!.click());
}
async function input(selector: string, value: string) {
    const element = container.querySelector<HTMLInputElement>(selector)!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
}
describe('static field-flow workspace', () => {
    it('shows an actual package import/export witness without implying graph declaration identities', async () => {
        loader.mockResolvedValue(fieldFlowPackageResolutionFixture());
        await render(); await click('[data-field-submit]');
        const proof = container.querySelector('[data-field-resolution]');
        expect(proof?.textContent).toContain('Package import/export evidence');
        expect(proof?.textContent).toContain('npm_esm_named_export');
        expect(proof?.textContent).toContain('node_modules/example/package.json');
        expect(proof?.textContent).toContain('normalizeEmail');
        expect(proof?.textContent).toContain('bytes 0–19');
        expect(proof?.textContent).toContain('bytes 7–80');
        expect(proof?.textContent).not.toContain('Graph nodes');
    });
    it('shows exact package and resolver provenance only when emitted by the native result', async () => {
        loader.mockResolvedValue(fieldFlowProvenanceFixture());
        await render(); await click('[data-field-submit]'); await click('[data-field-value="v:new"]');
        const packageEvidence = container.querySelector('[data-field-package]');
        expect(packageEvidence?.textContent).toContain('npm:example');
        expect(packageEvidence?.textContent).toContain('1.2.3');
        expect(packageEvidence?.textContent).toContain('dependency-manifest-hash');
        expect(container.querySelector('[data-field-source-hash]')?.textContent).toContain('dependency-body-hash');
        const proof = container.querySelector('[data-field-resolution]');
        expect(proof?.textContent).toContain('lsp_ts_import');
        expect(proof?.textContent).toContain('users.createUser');
        expect(proof?.textContent).toContain('example.normalize');
        expect(proof?.textContent).toContain('bytes 20–31');
        expect(proof?.textContent).toContain('abc123');
        expect(proof?.textContent).toContain('dependency-body-hash');
        await click('[data-field-source]');
        expect(readSource.mock.calls[0][0]).toMatchObject({
            file_path: 'node_modules/example/index.js', source_hash: 'dependency-body-hash',
        });
        loader.mockResolvedValue(fieldFlowFixture());
        await click('[data-field-submit]');
        expect(container.querySelector('[data-field-package]')).toBeNull();
        expect(container.querySelector('[data-field-resolution]')).toBeNull();
    });
    it('makes the server candidate bound actionable and submits an exact later occurrence without changing its identity', async () => {
        const capped = fieldFlowFixture(true);
        capped.values = Array.from({ length: 200 }, (_, index) => ({
            ...capped.values[0], id: `v:${index}`, ref: { project: 'sample', generation: 'g1', value_id: `v:${index}` },
        }));
        capped.gaps.push({ code: 'candidate_limit', file_path: 'backend/app/api/routes/users.py',
            message: 'Further source occurrences exceed the display bound.' });
        loader.mockResolvedValueOnce(capped).mockResolvedValue(fieldFlowFixture(true));
        await render({ initialFile: 'backend/app/api/routes/users.py' }); await click('[data-field-submit]');
        const boundary = container.querySelector('[data-field-candidate-bound]');
        expect(boundary?.textContent).toContain('first 200');
        expect(boundary?.textContent).toContain('exact indexed symbol');
        expect(boundary?.textContent).toContain('byte offset of the value occurrence');
        await click('[data-field-narrow]');
        expect(document.activeElement).toBe(container.querySelector('[data-field-symbol]'));
        expect(loader).toHaveBeenCalledTimes(1);
        await input('[data-field-symbol]', 'read_user_me@3685');
        await input('[data-field-byte]', '3702');
        await click('[data-field-submit]');
        expect(loader.mock.calls[1][0].source).toEqual({
            file_path: 'backend/app/api/routes/users.py', symbol: 'read_user_me@3685', start_byte: 3702,
        });
        expect(container.querySelector('[data-field-candidate-bound]')).toBeNull();
    });
    it('requires explicit source choice and lets users resolve ambiguous occurrences', async () => {
        loader.mockResolvedValueOnce(fieldFlowFixture(true)).mockResolvedValue(fieldFlowFixture());
        await render(); expect(loader).not.toHaveBeenCalled();
        await click('[data-field-submit]');
        expect(loader.mock.calls[0][0]).toMatchObject({ project: 'sample', generation: 'g1', source: { file_path: 'src/users.ts' }, direction: 'forward' });
        expect(container.textContent).toContain('Choose a source occurrence');
        expect(container.querySelector('[data-field-path]')).toBeNull();
        await click('[data-field-candidate="v:new"]');
        expect(loader.mock.calls[1][0].source).toEqual({ value_id: 'v:new' });
        expect(container.querySelector('[data-field-path]')).not.toBeNull();
    });
    it('shows partial analysis, actual certainty and gap causes without claiming observed transport', async () => {
        await render(); await click('[data-field-submit]');
        expect(container.textContent).toContain('Partial indexed field flow');
        expect(container.querySelector('[data-field-certainty="derived"]')?.textContent).toContain('Derived');
        expect(container.textContent).toContain('External call transport is not resolved.');
        expect(container.textContent).toContain('Static dependence does not establish observed execution.');
        await click('[data-field-direction="backward"]');
        expect(loader.mock.calls.at(-1)![0].direction).toBe('backward');
    });
    it('renders only the hash-verified source response, with stale source failures visible', async () => {
        const scroll = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
        try {
        await render(); await click('[data-field-submit]'); await click('[data-field-value="v:new"]'); await click('[data-field-source]');
        expect(readSource.mock.calls[0][0]).toMatchObject({ project: 'sample', generation: 'g1', file_path: 'src/users.ts', source_hash: 'abc123' });
        expect(container.querySelector('[data-verified-source]')?.textContent).toContain('verifiedEmail');
        expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
        await click('[data-source-evidence-close]');
        readSource.mockRejectedValueOnce(new Error('Source changed; reindex.'));
        await click('[data-field-source]');
        expect(container.textContent).toContain('Source changed; reindex.');
        expect(container.textContent).not.toContain('verifiedEmail');
        } finally { delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView; }
    });
    it('aborts requests and hides former candidates immediately when project or generation changes', async () => {
        loader.mockResolvedValueOnce(fieldFlowFixture(true)).mockImplementation(() => new Promise(() => {}));
        await render(); await click('[data-field-submit]');
        const signal = loader.mock.calls[0][1];
        await render({ generation: 'g2' });
        expect(signal.aborted).toBe(true);
        expect(container.querySelector('[data-field-candidate]')).toBeNull();
        expect(container.querySelector('[data-field-path]')).toBeNull();
    });
    it('disables stale partition evidence and preserves backend errors', async () => {
        const stale = fieldFlowFixture(); stale.values[0].analysis_status = 'stale'; loader.mockResolvedValueOnce(stale);
        await render(); await click('[data-field-submit]'); await click('[data-field-value="v:old"]');
        expect(container.querySelector<HTMLButtonElement>('[data-field-source]')?.disabled).toBe(true);
        loader.mockRejectedValueOnce(new Error('Field-flow IR is not indexed for this source.'));
        await click('[data-field-submit]');
        expect(container.querySelector('[role="alert"]')?.textContent).toContain('not indexed');
    });
});
