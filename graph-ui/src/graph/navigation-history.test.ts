import { describe, expect, it } from 'vitest';
import {
    NAVIGATION_HISTORY_LIMIT,
    emptyNavigationHistory,
    moveNavigation,
    peekNavigation,
    pushNavigation,
    type NavigationHistory,
    type NavigationHistoryOptions,
} from './navigation-history';

interface Entry { root?: string; depth: number }
const options: NavigationHistoryOptions<Entry> = { key: (entry) => `${entry.root ?? '*'}@${entry.depth}`, recentKey: (entry) => entry.root };
const keys = (history: NavigationHistory<Entry>) => history.entries.map(options.key);
const push = (history: NavigationHistory<Entry>, ...entries: Entry[]) => entries.reduce((next, entry) => pushNavigation(next, entry, options), history);

describe('bounded back and forward history', () => {
    it('moves a cursor back and forward like a browser, and stops at both ends', () => {
        let history = push(emptyNavigationHistory<Entry>(), { depth: 0 }, { root: 'A', depth: 1 }, { root: 'B', depth: 1 });
        expect(peekNavigation(history, -1)).toEqual({ root: 'A', depth: 1 });
        expect(peekNavigation(history, 1)).toBeUndefined();
        history = moveNavigation(history, -1, options);
        history = moveNavigation(history, -1, options);
        expect(history.index).toBe(0);
        expect(peekNavigation(history, -1)).toBeUndefined();
        expect(moveNavigation(history, -1, options)).toBe(history);
        history = moveNavigation(history, 1, options);
        expect(history.entries[history.index]).toEqual({ root: 'A', depth: 1 });
        expect(peekNavigation(history, 1)).toEqual({ root: 'B', depth: 1 });
    });

    it('merges a step equal to the current one, but keeps a later revisit as its own step', () => {
        const history = push(emptyNavigationHistory<Entry>(), { root: 'A', depth: 1 }, { root: 'A', depth: 1 }, { root: 'A', depth: 2 },
            { root: 'B', depth: 1 }, { root: 'A', depth: 2 });
        expect(keys(history)).toEqual(['A@1', 'A@2', 'B@1', 'A@2']);
    });

    it('drops the forward branch on a new navigation after going back', () => {
        let history = push(emptyNavigationHistory<Entry>(), { root: 'A', depth: 1 }, { root: 'B', depth: 1 }, { root: 'C', depth: 1 });
        history = moveNavigation(moveNavigation(history, -1, options), -1, options);
        history = push(history, { root: 'D', depth: 1 });
        expect(keys(history)).toEqual(['A@1', 'D@1']);
        expect(peekNavigation(history, 1)).toBeUndefined();
    });

    it('never holds more than the limit and drops the oldest entries first', () => {
        const many = Array.from({ length: NAVIGATION_HISTORY_LIMIT + 40 }, (_, at) => ({ root: `N${at}`, depth: 1 }));
        const history = push(emptyNavigationHistory<Entry>(), ...many);
        expect(history.entries).toHaveLength(NAVIGATION_HISTORY_LIMIT);
        expect(history.entries[0]!.root).toBe('N40');
        expect(history.entries.at(-1)!.root).toBe(`N${NAVIGATION_HISTORY_LIMIT + 39}`);
        expect(history.index).toBe(NAVIGATION_HISTORY_LIMIT - 1);
        const short = push(emptyNavigationHistory<Entry>(), ...many.slice(0, 5));
        expect(pushNavigation(short, { root: 'X', depth: 1 }, { ...options, limit: 3 }).entries.map((entry) => entry.root)).toEqual(['N3', 'N4', 'X']);
    });

    it('keeps the last distinct roots, newest first, independent of the cursor', () => {
        let history = push(emptyNavigationHistory<Entry>(), { depth: 0 }, { root: 'A', depth: 1 }, { root: 'B', depth: 1 },
            { root: 'A', depth: 3 }, { root: 'C', depth: 1 });
        expect(history.recent).toEqual([{ root: 'C', depth: 1 }, { root: 'A', depth: 3 }, { root: 'B', depth: 1 }]);
        history = moveNavigation(history, -1, options);
        // Going back visits A again: it moves to the front, nothing is lost.
        expect(history.recent.map((entry) => entry.root)).toEqual(['A', 'C', 'B']);
        const capped = push(emptyNavigationHistory<Entry>(), ...Array.from({ length: 12 }, (_, at) => ({ root: `R${at}`, depth: 1 })));
        expect(capped.recent).toHaveLength(8);
        expect(capped.recent[0]!.root).toBe('R11');
    });
});
