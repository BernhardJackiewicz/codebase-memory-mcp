// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_RESUME_KEY, AGENT_RESUME_WINDOW_MS, requestAgentResume, takeAgentResume } from './agent-resume';
import { BROWSER_MODEL, browserModelBaseUrl, BROWSER_MODELS, isBrowserModelCached } from './model-policy';

afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe('keeping the agent across a project switch (K24)', () => {
    it('resumes on the first page after the switch, in this tab, shortly after it', () => {
        requestAgentResume(1000);
        expect(JSON.parse(window.sessionStorage.getItem(AGENT_RESUME_KEY)!)).toEqual({ at: 1000 });
        expect(takeAgentResume(1000 + AGENT_RESUME_WINDOW_MS - 1, 7)).toBe(true);
        // The same page reads it again (React's development double effect); a later reload does not.
        expect(takeAgentResume(1000, 7)).toBe(true);
        expect(takeAgentResume(1000, 8)).toBe(false);
        expect(window.sessionStorage.getItem(AGENT_RESUME_KEY)).toBeNull();
    });

    it('does not resume after the window, from malformed data or without storage', () => {
        requestAgentResume(1000);
        expect(takeAgentResume(1000 + AGENT_RESUME_WINDOW_MS + 1)).toBe(false);
        window.sessionStorage.setItem(AGENT_RESUME_KEY, '{bad');
        expect(takeAgentResume(1000)).toBe(false);
        vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} });
        expect(() => requestAgentResume()).not.toThrow();
        expect(takeAgentResume()).toBe(false);
    });
});

describe('a cached model (K10)', () => {
    const cacheWith = (urls: string[]) => ({ has: vi.fn(async () => true), open: vi.fn(async () => ({ keys: async () => urls.map(url => new Request(url)) })) });

    it('is cached only when every pinned file is in its dedicated cache', async () => {
        const model = BROWSER_MODELS[0];
        const all = model.files.map(file => `${browserModelBaseUrl(model)}${file}`);
        vi.stubGlobal('caches', cacheWith(all));
        expect(await isBrowserModelCached(model)).toBe(true);
        vi.stubGlobal('caches', cacheWith(all.slice(0, -1)));
        expect(await isBrowserModelCached(model)).toBe(false);
        vi.stubGlobal('caches', cacheWith(all.map(url => url.replace(BROWSER_MODEL.revision, 'main'))));
        expect(await isBrowserModelCached(model)).toBe(false);
    });

    it('never creates the cache it checks, and says not cached without Cache Storage', async () => {
        const storage = { has: vi.fn(async () => false), open: vi.fn() };
        vi.stubGlobal('caches', storage);
        expect(await isBrowserModelCached(BROWSER_MODELS[0])).toBe(false);
        expect(storage.open).not.toHaveBeenCalled();
        vi.stubGlobal('caches', undefined);
        expect(await isBrowserModelCached(BROWSER_MODELS[0])).toBe(false);
    });
});
