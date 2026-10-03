import { expect, it } from 'vitest';
import { EDGE_LABEL_MIN_NAME_PIXELS, edgeLabelVisible, hierarchyEdgeLabels, hierarchyLabelSpot } from './HierarchyEdgeLabels';

it('hand test K5: writes one label per node pair, its types without repeats and CALLS first', () => {
    const labels = hierarchyEdgeLabels([
        { source: 10, target: 1, type: 'TESTS' }, { source: 10, target: 1, type: 'CALLS', line: 5 }, { source: 10, target: 1, type: 'CALLS', line: 9 },
        { source: 30, target: 1, type: 'DEFINES' }, { source: 1, target: 40, type: 'INHERITS' }, { source: 40, target: 1, type: 'USAGE' },
        { source: 7, target: 7, type: 'CALLS' },
    ]);
    expect(labels.map(label => [label.key, label.text])).toEqual([['1:10', 'CALLS · TESTS'], ['1:30', 'DEFINES'], ['1:40', 'INHERITS · USAGE']]);
});

/*
 * Review of K5: at two layers (JSONBAgg, 90 nodes) eighty labels stood on the
 * first eighty pairs in edge order, rows of "DEFINES" without a name in sight.
 * The lines at the root keep a label each; a fan further out, one node to many
 * of the same types, carries one label with its count on its middle line.
 */
it('labels every line at the root, and a fan further out once with its count, nearest the root first', () => {
    const at = (hop: number, x: number, y: number) => ({ hop, x, y });
    const layout = new Map([[1, at(0, 0, 0)], [10, at(1, -200, 32)], [11, at(1, -200, 0)], [30, at(1, -200, -32)],
        [50, at(2, -400, 32)], [51, at(2, -400, 0)], [52, at(2, -400, -32)], [60, at(2, -400, 64)]]);
    const labels = hierarchyEdgeLabels([
        { source: 30, target: 52, type: 'DEFINES' }, { source: 30, target: 50, type: 'DEFINES' }, { source: 10, target: 60, type: 'CALLS' },
        { source: 10, target: 1, type: 'CALLS' }, { source: 11, target: 1, type: 'CALLS' }, { source: 30, target: 1, type: 'DEFINES' },
        { source: 30, target: 51, type: 'DEFINES' }, { source: 50, target: 51, type: 'CALLS' },
    ], layout);
    expect(labels.map(label => [label.text, label.source, label.target])).toEqual([
        ['CALLS', 10, 1], ['CALLS', 11, 1], ['DEFINES', 30, 1],
        ['DEFINES ×3', 30, 51], ['CALLS', 10, 60], ['CALLS', 50, 51],
    ]);
});

/*
 * Review of K5, seen in the browser: at two layers the fitted picture drew the
 * names at about 5 px, and seventy edge labels at a fixed 10 px covered it.
 * An edge label stands beside a name only where the names can be read, and
 * only on the lines in view.
 */
it('shows an edge label only while the names read and its line is in view', () => {
    const canvas = { left: 0, top: 0, right: 1600, bottom: 900 };
    expect(EDGE_LABEL_MIN_NAME_PIXELS).toBeGreaterThanOrEqual(8);
    expect(edgeLabelVisible(12, { x: 800, y: 450 }, canvas)).toBe(true);
    expect(edgeLabelVisible(5, { x: 800, y: 450 }, canvas)).toBe(false);
    expect(edgeLabelVisible(12, { x: -40, y: 450 }, canvas)).toBe(false);
    expect(edgeLabelVisible(12, { x: 800, y: 960 }, canvas)).toBe(false);
});

it('gathers lines that converge further out on one node too, when they leave no fan of their own', () => {
    const at = (hop: number, x: number, y: number) => ({ hop, x, y });
    const layout = new Map([[1, at(0, 0, 0)], [10, at(1, -200, 32)], [11, at(1, -200, 0)], [12, at(1, -200, -32)], [70, at(2, -400, 0)], [71, at(2, -400, 32)]]);
    const labels = hierarchyEdgeLabels([
        { source: 10, target: 70, type: 'WRITES' }, { source: 11, target: 70, type: 'WRITES' }, { source: 12, target: 70, type: 'WRITES' },
        { source: 12, target: 71, type: 'CALLS' },
    ], layout);
    expect(labels.map(label => [label.text, label.source, label.target])).toEqual([['WRITES ×3', 11, 70], ['CALLS', 12, 71]]);
});

it('drops a hierarchy edge label that finds no free place instead of laying it over a name', () => {
    const name = { left: 90, right: 210, top: 90, bottom: 110 };
    // A short edge whose whole neighbourhood is a name: no spot without overlap.
    expect(hierarchyLabelSpot({ x: 100, y: 100 }, { x: 200, y: 100 }, { width: 60, height: 14 }, [{ left: 0, right: 400, top: 0, bottom: 200 }], [])).toBeUndefined();
    const spot = hierarchyLabelSpot({ x: 100, y: 100 }, { x: 400, y: 100 }, { width: 60, height: 14 }, [name], []);
    expect(spot).toBeDefined();
    expect(spot!.rect.left >= name.right || spot!.rect.bottom <= name.top || spot!.rect.top >= name.bottom).toBe(true);
});
