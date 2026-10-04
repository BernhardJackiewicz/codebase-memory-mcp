import { expect, it } from 'vitest';
import { galaxyHierarchyText } from './galaxy-strings';

/*
 * Second review of K5: the hint and the note in the picture say what carries
 * a name above the budget, for every depth and trace direction, and only give
 * advice that helps there.
 */
it('K5: the hierarchy hint and note say who is named and what brings the rest back', () => {
    const view = (names: 'all' | 'neighbours' | 'none', sides = { root: true, incoming: 0, outgoing: 0 }) => ({ mixed: 0, names, budget: 150, neighbours: 554, sides });
    expect(galaxyHierarchyText.hint('both', { ...view('all'), mixed: 3 }))
        .toBe('hierarchy: incoming relationships on the left, the root in the middle, outgoing on the right; each column is one layer further in the same direction; '
            + '3 nodes reached through both directions, such as a callee of a caller, stand in the band below; the type and direction of each relationship at its line');
    expect(galaxyHierarchyText.hint('inbound', view('neighbours'))).toBe('hierarchy: what reaches the root, one column per layer to the left; '
        + 'above 150 nodes only the root and its direct neighbours carry names, so remove layers or trace fewer edge types to see all names');
    // One layer with a hub: removing a layer is no advice; one side still fits the budget.
    expect(galaxyHierarchyText.hint('both', view('none', { root: true, incoming: 0, outgoing: 11 })))
        .toContain('and the root has 554 direct neighbours, so only the root and its 11 outgoing neighbours carry names; trace one direction or fewer edge types to see the rest');
    expect(galaxyHierarchyText.hint('outbound', view('none'))).toContain('so only the root carries a name; trace fewer edge types to see the rest');
    expect(galaxyHierarchyText.namesNote('both', 555, 'none', 554, 150, { root: true, incoming: 0, outgoing: 11 }))
        .toBe('555 nodes, 554 of them direct neighbours of the root: names for the root and its 11 outgoing neighbours only (up to 150 names). Trace one direction or fewer edge types to see the rest.');
    // Hundreds of roots (a folder): nobody is named, and the note says so.
    expect(galaxyHierarchyText.namesNote('inbound', 1687, 'none', 1319, 150, { root: false, incoming: 0, outgoing: 0 }))
        .toBe(`${(1687).toLocaleString()} nodes: no names above 150 nodes. Trace fewer edge types to see them.`);
    expect(galaxyHierarchyText.hint('both', view('none', { root: false, incoming: 0, outgoing: 0 })))
        .toContain('names and edge types show for up to 150 nodes, so trace one direction or fewer edge types to see them');
    expect(galaxyHierarchyText.bandTitle(1)).toBe('Mixed directions · 1 node');
});
