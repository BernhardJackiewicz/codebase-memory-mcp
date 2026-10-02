/**
 * The words of the Galaxy path view, beside the view like the other domain
 * copy (agents/agent-strings.ts, architecture/strings.ts).
 *
 * One rule for every sentence here: a path is counted in hops over the
 * relationships that are loaded in this scope, nothing more. It is not a
 * runtime trace and it does not claim that nothing else connects the two.
 */
export const galaxyPathText = {
    pathTo: 'Path to…',
    pathToTitle: 'Highlight the shortest path from the root to a node in this scope',
    pathSearch: 'Find a path target',
    pathSearchPlaceholder: 'Node in this scope…',
    pathNoMatch: 'No matching node in the loaded scope.',
    pathMore: (count: number) => `${count.toLocaleString()} more, type to narrow`,
    callOrder: 'Call order',
    callOrderTitle: 'Step through the outgoing calls of the root in source line order',
    callOrderUnavailable: 'The root has no outgoing calls in the loaded scope',
    panel: 'Path steps',
    pathHeading: (target: string, hops: number) => `Path to ${target} · ${hops === 1 ? '1 hop' : `${hops} hops`}`,
    callsHeading: (root: string, calls: number) => `Calls of ${root} · ${calls === 1 ? '1 call' : `${calls} calls`}`,
    noPath: (target: string) => `No path to ${target} over the loaded relationships in this trace direction. Expand the scope or trace both directions.`,
    isRoot: (target: string) => `${target} is the root of this scope.`,
    hop: (hop: number) => `hop ${hop}`,
    line: (line: number) => `line ${line}`,
    lineUnknown: 'no line',
    /** The hop as the reader follows it, with the indexed direction kept. */
    step: (from: string, type: string, to: string, forward: boolean) =>
        (forward ? `${from} --${type}--> ${to}` : `${from} <--${type}-- ${to}`),
    previous: 'Previous',
    next: 'Next',
    clear: 'Clear',
    clearTitle: 'Return to the whole scope (Esc)',
    position: (index: number, total: number) => `${index} of ${total}`,
};
