/**
 * The Architecture entry for Back and Forward (hand test K27): which place the
 * workspace shows, without what it loaded for it.
 *
 * One entry is the subtab and what that subtab has opened: in Overview the area
 * or file and Plan or 3D, in Routes the perspective and the route filter (an
 * opened route group is that filter), in System structure the focus and the
 * expanded groups, in Behavior the start, the destination and where a followed
 * call began. It holds identities and names only, never projections, scenes or
 * cameras, so nothing grows with the session. The model behind it is the one
 * Galaxy uses (src/graph/navigation-history.ts); the concept is in
 * docs/development/pr-2068-galaxy-history.md.
 */
import type { NavigationHistoryOptions } from '../graph/navigation-history';
import type { ArchitectureView } from './architecture-model';
import type { SystemSymbol } from './system-architecture-source';
import { architectureHistoryText as text, architectureText } from './strings';

export type RoutesPerspective = 'services' | 'endpoints';

/** Overview, Entry points, Hotspots and Endpoints draw the same map (SpatialArchitecture). */
export interface SpatialPlace { areaPath?: string; filePath?: string; hotspotArea?: string; planar: boolean }

/**
 * A Behavior start as SystemArchitecture requests it. The numeric identity
 * belongs to one analysis snapshot, which `generation` and `expectedGeneration`
 * guard; the names are for the tooltip.
 */
export interface BehaviorPlace {
    project: string; generation?: string; expectedGeneration?: string;
    id?: number; name?: string; targetId?: number; targetName?: string;
    /** The start a followed call ("follow calls", double-click) began from; empty background returns there. */
    from?: SystemSymbol;
}

export interface SystemPlace {
    focus?: { id: string; label: string }; expanded: readonly string[]; behavior?: BehaviorPlace;
    /** The start Behavior shows when none was requested (the server picks one, or the first entry point): for the tooltip only. */
    shown?: string;
}

export interface ArchitectureHistoryEntry {
    view: ArchitectureView;
    spatial: SpatialPlace;
    routes: RoutesPerspective;
    /** The Routes filter, as far as it is a step: a route group or typing that paused. */
    filter: string;
    system: SystemPlace;
}

/** A part of the place handed to a view, and how it reports a change; `automatic` marks one the page made itself. */
export type PlaceChange<T> = (change: Partial<T>, automatic?: boolean) => void;

/** What System structure and Behavior need for the shared Back in their own toolbar. */
export interface SharedBack { target?: string; onBack: () => void }

export function initialArchitecturePlace(view: ArchitectureView): ArchitectureHistoryEntry {
    return { view: view === 'dependencies' ? 'overview' : view, spatial: { planar: false }, routes: 'services', filter: '', system: { expanded: [] } };
}

/** What the subtab of an entry shows, without Plan or 3D and without expanded groups. */
function location(entry: ArchitectureHistoryEntry): unknown[] {
    const { spatial, system } = entry;
    switch (entry.view) {
        case 'overview': case 'dependencies': return [spatial.areaPath ?? null, spatial.filePath ?? null];
        case 'hotspots': return [spatial.hotspotArea ?? null];
        case 'routes': return [entry.routes, entry.filter];
        case 'structure': return [system.focus?.id ?? null];
        case 'behavior': return [system.behavior?.id ?? null, system.behavior?.targetId ?? null];
        default: return [];
    }
}

/** Whether the subtab of an entry draws the shared map with its Plan and 3D switch. */
function drawsMap(entry: ArchitectureHistoryEntry): boolean {
    return entry.view !== 'structure' && entry.view !== 'behavior' && (entry.view !== 'routes' || entry.routes === 'endpoints');
}

const viewOf = (entry: ArchitectureHistoryEntry): ArchitectureView => (entry.view === 'dependencies' ? 'overview' : entry.view);

export const architectureHistoryOptions: NavigationHistoryOptions<ArchitectureHistoryEntry> = {
    key: (entry) => JSON.stringify([viewOf(entry), ...location(entry), drawsMap(entry) && entry.spatial.planar,
        entry.view === 'structure' ? [...entry.system.expanded].sort() : null]),
    recentKey: (entry) => JSON.stringify([viewOf(entry), ...location(entry)]),
};

/** The subtab an entry stands on, as the tab names it. Entry points is a mode within Overview. */
export function architectureEntryName(entry: ArchitectureHistoryEntry): string {
    return architectureText.views[viewOf(entry) === 'entryPoints' ? 'overview' : viewOf(entry)];
}

function details(entry: ArchitectureHistoryEntry): string[] {
    const { spatial, system } = entry;
    const parts: (string | undefined)[] = [];
    switch (viewOf(entry)) {
        case 'overview': parts.push(spatial.filePath ?? spatial.areaPath); break;
        case 'entryPoints': parts.push(architectureText.views.entryPoints); break;
        case 'hotspots': parts.push(spatial.hotspotArea); break;
        case 'routes': parts.push(architectureText.routesPerspective[entry.routes], entry.filter.trim() || undefined); break;
        case 'structure': parts.push(system.focus?.label, system.expanded.length ? text.groupsOpen(system.expanded.length) : undefined); break;
        case 'behavior': {
            const start = system.behavior?.id === undefined ? system.behavior?.name ?? system.shown : system.behavior.name;
            const target = system.behavior?.targetId === undefined ? undefined : system.behavior.targetName;
            parts.push(start && target ? text.reach(start, target) : start, system.behavior?.from ? text.followedFrom(system.behavior.from.name) : undefined);
            break;
        }
    }
    if (drawsMap(entry) && spatial.planar) parts.push(text.plan);
    return parts.filter((part): part is string => Boolean(part));
}

/** What a place shows besides its subtab, for the line under the name in the Recent list. Empty at the top of a subtab. */
export function architectureEntryDetail(entry: ArchitectureHistoryEntry): string {
    return details(entry).join(text.separator);
}

/** How an entry is named in a Back or Forward tooltip: "Overview · django". */
export function architectureEntryLabel(entry: ArchitectureHistoryEntry): string {
    return [architectureEntryName(entry), ...details(entry)].join(text.separator);
}
