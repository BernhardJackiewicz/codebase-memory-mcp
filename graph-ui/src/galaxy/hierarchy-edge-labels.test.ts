import { expect, it } from 'vitest';
import { hierarchyEdgeLabels } from './HierarchyEdgeLabels';

it('hand test K5: writes one label per node pair, its types without repeats and CALLS first', () => {
    const labels = hierarchyEdgeLabels([
        { source: 10, target: 1, type: 'TESTS' }, { source: 10, target: 1, type: 'CALLS', line: 5 }, { source: 10, target: 1, type: 'CALLS', line: 9 },
        { source: 30, target: 1, type: 'DEFINES' }, { source: 1, target: 40, type: 'INHERITS' }, { source: 40, target: 1, type: 'USAGE' },
        { source: 7, target: 7, type: 'CALLS' },
    ]);
    expect(labels.map(label => [label.key, label.text])).toEqual([['1:10', 'CALLS · TESTS'], ['1:30', 'DEFINES'], ['1:40', 'INHERITS · USAGE']]);
});
