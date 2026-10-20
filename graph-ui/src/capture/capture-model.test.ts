import { describe, expect, it } from 'vitest';
import { captureSlice, mergeCaptureEvents } from './capture-model';
import { captureEvent } from './capture-fixture';

describe('observed event slices', () => {
    it('follows only declared input identities in the same producer namespace', () => {
        const events = [
            captureEvent(),
            captureEvent({ id: 2, sequence: 2, operation: 'assign', value_id: 'value-2', inputs: ['value-1'] }),
            captureEvent({ id: 3, producer_id: 'python-B', value_id: 'value-1', preview: 'same value' }),
            captureEvent({ id: 4, sequence: 3, operation: 'db_write', value_id: undefined, inputs: ['value-2'] }),
        ];
        const slice = captureSlice(events, 2);
        expect(slice.events.map(event => event.id)).toEqual([1, 2, 4]);
        expect(slice.links.map(link => [link.source, link.target])).toEqual([[1, 2], [2, 4]]);
        expect(slice.unresolvedInputs).toBe(0);
    });
    it('reports unresolved and ambiguous input identities without inventing an edge', () => {
        const events = [captureEvent(), captureEvent({ id: 2, sequence: 2 }),
            captureEvent({ id: 3, sequence: 3, value_id: 'v3', inputs: ['value-1', 'missing'] })];
        const slice = captureSlice(events, 3);
        expect(slice.events.map(event => event.id)).toEqual([3]);
        expect(slice.links).toEqual([]);
        expect(slice.unresolvedInputs).toBe(2);
    });
    it('links across producers only when the adapter reports an explicit producer reference', () => {
        const events = [captureEvent(), captureEvent({
            id: 2, producer_id: 'python-B', value_id: 'remote-value', inputs: [],
            input_refs: [{ producer_id: 'node-A', value_id: 'value-1' }],
        })];
        expect(captureSlice(events, 2).links).toEqual([{ source: 1, target: 2, producer_id: 'node-A', value_id: 'value-1' }]);
    });
    it('merges incremental pages idempotently and preserves server ordering', () => {
        const first = captureEvent(), second = captureEvent({ id: 4, sequence: 2 });
        expect(mergeCaptureEvents([first], [second, first]).map(event => event.id)).toEqual([1, 4]);
    });
});
