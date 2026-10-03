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
    /** The short labels of a narrow toolbar (review of K3). */
    pathToNarrow: 'Path…',
    callOrderNarrow: 'Calls',
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

/** Back, Forward and the recent roots of the scoped Galaxy (K2). */
export const galaxyHistoryText = {
    back: 'Back',
    forward: 'Forward',
    backGlyph: '←',
    forwardGlyph: '→',
    backTo: (label: string) => `Back to ${label} (Alt+Left)`,
    forwardTo: (label: string) => `Forward to ${label} (Alt+Right)`,
    noBack: 'Nothing to go back to yet',
    noForward: 'Nothing to go forward to',
    recent: 'Recent',
    recentGlyph: '▾',
    recentTitle: 'Jump straight to a recently visited root with its last depth, direction and edge types',
    recentList: 'Recently visited roots',
    /** The accessible name of the Back, Forward and Recent group. */
    group: 'History',
    allGraph: 'All graph',
    layers: (depth: number) => (depth === 1 ? '1 layer' : `${depth} layers`),
    direction: { inbound: 'incoming', outbound: 'outgoing' } as Record<'inbound' | 'outbound', string>,
    noTypes: 'no edge types',
    hierarchy: 'hierarchy',
    callOrder: 'call order',
    pathTo: (name: string) => `path to ${name}`,
};

/** The hierarchy of a Galaxy scope (hand test K5): what the columns mean, per trace direction. */
export const galaxyHierarchyText = {
    /** With `namesUpTo` the scope is past the name budget: no names and no edge labels, and the hint says how to get them back. */
    hint: (direction: 'both' | 'inbound' | 'outbound', namesUpTo?: number) => (direction === 'inbound'
        ? 'hierarchy: what reaches the root, one column per layer to the left'
        : direction === 'outbound'
            ? 'hierarchy: what the root reaches, one column per layer to the right'
            : 'hierarchy: incoming relationships on the left, the root in the middle, outgoing on the right; one column per layer')
        + (namesUpTo === undefined ? ', edge types at the lines'
            : `; names and edge types show for up to ${namesUpTo.toLocaleString()} nodes, so remove a layer or trace fewer edge types to see them`),
};

const count = (value: number, one: string, many: string) => `${value.toLocaleString()} ${value === 1 ? one : many}`;

/** Loading, cancelling and the render limit of a scope layer (hand test K8). */
export const galaxyLayerText = {
    checking: 'Checking index…',
    loading: (layer: number) => `Loading layer ${layer}…`,
    // A comma, not the dot of the finished counts: tools that wait for "N nodes · M edges" must not take this for done.
    loadingProgress: (layer: number, nodes: number, edges: number) =>
        `Loading layer ${layer}: ${count(nodes, 'node', 'nodes')}, ${count(edges, 'edge', 'edges')} so far`,
    /** The tooltip of a running load: which request it is on, page by page (review of K8). */
    loadingRequest: (request: number) => `Request ${request.toLocaleString()} to the index; "−" cancels.`,
    arranging: 'Arranging nodes…',
    counts: (nodes: number, edges: number) => `${count(nodes, 'node', 'nodes')} · ${count(edges, 'edge', 'edges')}`,
    endOfTrace: ' · end of trace',
    // "Partial" leads, so a narrow toolbar that cuts the end never cuts the warning.
    partial: (counts: string) => `Partial: ${counts}`,
    partialPreview: 'Partial preview',
    previewLoading: (layer: number) => `Partial preview while layer ${layer} loads`,
    partialTitle: (layer: number, limit: number, kind: 'nodes' | 'edges') =>
        `Layer ${layer} stopped at the render limit of ${limit.toLocaleString()} ${kind}. Raise the limit under Limits or trace fewer edge types to load all of it.`,
    removeLayer: 'Remove the outermost layer',
    cancelLoading: (layer: number) => `Cancel loading layer ${layer} and return to ${layer - 1 === 1 ? '1 layer' : `${layer - 1} layers`}`,
    /* Measured, not promised: a hub at the edge can bring far more than the last layer did (JSONBAgg layer 3: about 400 expected, over 9,000 loaded). */
    /* With `calls` the index has counted the calls at the edge nodes (review of K8): a floor, where the growth alone missed the hubs. */
    expandTitle: (layer: number, frontier: number, estimate: number, limit: number, calls?: number) =>
        `Load layer ${layer}: ${count(frontier, 'node', 'nodes')} to expand. `
        + (calls === undefined
            ? `Growing like the last layer it adds about ${estimate.toLocaleString()} nodes; a hub can add many more. `
            : `The index lists ${count(calls, 'call', 'calls')} at them that ${calls === 1 ? 'is' : 'are'} not loaded yet; growing like the last layer it adds about ${estimate.toLocaleString()} nodes. `)
        + `Loading stops at the render limit of ${limit.toLocaleString()} nodes and marks the layer partial.`,
    expandOverLimit: 'Likely past the render limit.',
    expandPartial: 'This layer stopped at the render limit, so there is no complete edge to grow from. Raise the limit under Limits first.',
    expandEnd: 'End of trace: no relationship leads further.',
};

/** Compact toolbar words, so the scoped toolbar keeps to one row at 1600 px. */
export const galaxyToolbarText = {
    groups: (count: number) => `${count.toLocaleString()} groups`,
    groupsTitle: (count: number) => `${count.toLocaleString()} connection groups. Groups reflect connections in this trace, not inferred architecture components.`,
    limits: 'Limits',
    limitsTitle: 'Rendered node and edge limits',
    more: 'More',
    moreGlyph: '⋯',
    moreTitle: 'More: open the source, rendered node and edge limits, connection groups',
    openSource: 'Open source',
    openRootTitle: (name: string, path: string, line?: number) => `Open the source of ${name} in Explore: ${path}${line ? `:${line}` : ''}`,
    /** The root button's accessible name: its action, with the visible name in it. */
    openRootLabel: (name: string) => `Open the source of ${name}`,
    traceTitle: 'Trace direction: incoming, outgoing or both',
    expand: 'Expand +1',
    expandNarrow: '+1',
    outsideLimits: (nodes: number, edges: number) => `${nodes.toLocaleString()} nodes · ${edges.toLocaleString()} edges outside render limits`,
};
