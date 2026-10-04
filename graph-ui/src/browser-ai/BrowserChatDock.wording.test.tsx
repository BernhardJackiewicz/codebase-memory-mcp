// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BrowserChatDock, { type BrowserChatDockProps, type BrowserChatReaderContext } from './BrowserChatDock';
import type { BrowserAiProgress, BrowserChatMessage } from './browser-ai-runtime';
import type { BrowserChatOptions } from './browser-ai-controller';
import { jsonbAggEvidence } from './galaxy-evidence.fixture';

/* The chat dock shows the wording of the third review (W5 to W10) where it builds it. */

let container: HTMLDivElement;
let root: Root;
let renderedProps: BrowserChatDockProps;
beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

const snippet = { source: 'class JSONBAgg(OrderableAggMixin, Aggregate):\n    function = "JSONB_AGG"\n    allow_distinct = True\n',
    file_path: '/abs/django/contrib/postgres/aggregates/general.py', start_line: 50, end_line: 52, source_mode: 'full' };
function fixture() {
    const runtime = {
        prepare: vi.fn(async (_progress: (value: BrowserAiProgress) => void, _options?: { cacheOnly?: boolean }) => {}),
        explain: vi.fn(async () => 'Legacy'),
        countTokens: vi.fn(async (_messages: readonly BrowserChatMessage[]) => 100),
        chat: vi.fn(async (_messages: readonly BrowserChatMessage[], _onToken: (chunk: string) => void, _options?: BrowserChatOptions) => 'Adds the two values.'),
        stop: vi.fn(), dispose: vi.fn(),
    };
    const props = { proactive: false, open: true, onClose: vi.fn(), onAttachmentConsumed: vi.fn(), onAttachmentRemoved: vi.fn(), createRuntime: vi.fn(() => runtime),
        removeCache: vi.fn(async () => {}), readSource: vi.fn(async () => snippet) };
    return { runtime, props };
}
const reader = (text: string, path: string): BrowserChatReaderContext => ({ project: 'sample', path, status: 'ready',
    source: { id: `reader-${path}`, text, path, kind: 'file', project: 'sample', startLine: 1, startColumn: 1, endLine: text.split('\n').length, endColumn: 1, sourceVersion: 'sha256:1' } });
async function render(props: BrowserChatDockProps): Promise<void> { renderedProps = props; await act(async () => root.render(<BrowserChatDock {...props} />)); }
function button(label: string): HTMLButtonElement {
    const target = [...document.body.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
    expect(target, `button ${label}`).toBeDefined(); return target!;
}
async function load(): Promise<void> {
    await render({ ...renderedProps, settingsRequest: (renderedProps.settingsRequest ?? 0) + 1 });
    await act(async () => button('Download & load').click());
}
async function ask(value: string): Promise<void> {
    const input = container.querySelector('textarea')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Send ↑').click());
}
const last = () => [...container.querySelectorAll('.cbm-chat-turn')].at(-1)!;
const answer = () => last().querySelector('.cbm-chat-answer-text')?.textContent ?? '';
const card = () => container.querySelector('[aria-label="Current selection explanation"]')?.textContent ?? '';
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(650); }); };

describe('the note under a left out model sentence (W5)', () => {
    it('names the claim word of a German general question and that it was checked against the source', async () => {
        const { props, runtime } = fixture();
        runtime.chat.mockResolvedValueOnce('JSON-BAgg ist eine Aggregation, die die Zeilen in einen JSON-Array umwandelt.');
        await render({ ...props, proactiveSelection: jsonbAggEvidence() }); await load();
        await ask('was macht diese klasse? sehr kurze antwort');
        expect(answer()).not.toContain('JSON-Array');
        expect(answer()).toContain('Der Satz des Modells behauptete etwas, das der Quelltext nicht zeigt (hier: „Array“), und wurde weggelassen.');
        expect(answer()).not.toContain('das die Fakten nicht zeigen');
    });

    it('names the claim word of an English one', async () => {
        const { props, runtime } = fixture();
        runtime.chat.mockResolvedValueOnce('JSONBAgg aggregates rows into one output value.');
        await render({ ...props, proactiveSelection: jsonbAggEvidence() }); await load();
        await ask('What does this class do?');
        expect(answer()).toContain('The model\'s sentence claimed something the source does not show (here: "output") and was left out.');
    });

    it('names the unknown name under an automatic explanation and under a configuration file card', async () => {
        vi.useFakeTimers();
        const { props, runtime } = fixture();
        runtime.chat.mockResolvedValueOnce('JSONBAgg is checked by the flake8 linter.');
        await render({ ...props, proactive: true, proactiveSelection: jsonbAggEvidence() }); await load(); await settle();
        expect(card()).toContain('The model\'s sentence named something that is in neither the source nor the facts (here: flake8) and was left out.');
        runtime.chat.mockResolvedValueOnce('This file configures `flake8` for the Python sources.');
        await render({ ...props, proactive: true, selectionScope: 'django-demo:explore', readerContext: reader('[metadata]\nname = demo\n', 'setup.cfg') }); await settle();
        await act(async () => button('Ask the model').click()); await settle();
        expect(card()).toContain('Read from the file. The model\'s text named something the file does not show (here: flake8) and was left out.');
    });
});
