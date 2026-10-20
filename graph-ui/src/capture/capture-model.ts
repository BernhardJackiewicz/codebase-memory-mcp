import type { CaptureEvent } from './capture-source';

export interface CaptureLink { source: number; target: number; producer_id: string; value_id: string }
export interface CaptureSlice { events: CaptureEvent[]; links: CaptureLink[]; unresolvedInputs: number }
const identity = (producer: string, value: string) => JSON.stringify([producer, value]);

/** Only explicit versioned value identities establish edges; previews and span IDs never do. */
export function captureSlice(events: readonly CaptureEvent[], selectedId: number): CaptureSlice {
    const producers = new Map<string, CaptureEvent[]>();
    for (const event of events) if (event.value_id) {
        const key = identity(event.producer_id, event.value_id), previous = producers.get(key);
        if (previous) previous.push(event); else producers.set(key, [event]);
    }
    const links: CaptureLink[] = [], missing = new Map<number, number>();
    for (const event of events) {
        const refs = [...event.inputs.map(value_id => ({ producer_id: event.producer_id, value_id })), ...event.input_refs ?? []];
        const seen = new Set<string>();
        for (const ref of refs) {
            const key = identity(ref.producer_id, ref.value_id);
            if (seen.has(key)) continue;
            seen.add(key);
            const matches = producers.get(key);
            if (matches?.length === 1 && matches[0].id !== event.id) {
                links.push({ source: matches[0].id, target: event.id, ...ref });
            } else missing.set(event.id, (missing.get(event.id) ?? 0) + 1);
        }
    }
    const outgoing = new Map<number, number[]>(), incoming = new Map<number, number[]>();
    for (const link of links) {
        const next = outgoing.get(link.source);
        if (next) next.push(link.target); else outgoing.set(link.source, [link.target]);
        const previous = incoming.get(link.target);
        if (previous) previous.push(link.source); else incoming.set(link.target, [link.source]);
    }
    const selected = new Set([selectedId]);
    for (const adjacency of [incoming, outgoing]) {
        const queue = [selectedId], visited = new Set(queue);
        for (let cursor = 0; cursor < queue.length; cursor++) {
            for (const next of adjacency.get(queue[cursor]) ?? []) {
                if (!visited.has(next)) { visited.add(next); selected.add(next); queue.push(next); }
            }
        }
    }
    return {
        events: events.filter(event => selected.has(event.id)),
        links: links.filter(link => selected.has(link.source) && selected.has(link.target)),
        unresolvedInputs: [...selected].reduce((count, id) => count + (missing.get(id) ?? 0), 0),
    };
}
export function mergeCaptureEvents(previous: readonly CaptureEvent[], incoming: readonly CaptureEvent[]): CaptureEvent[] {
    const values = new Map(previous.map(event => [event.id, event]));
    incoming.forEach(event => { if (!values.has(event.id)) values.set(event.id, event); });
    return [...values.values()].sort((a, b) => a.id - b.id);
}
