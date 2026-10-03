/*
 * Die Kantenarten an den Linien der Hierarchie (Handtest K5).
 *
 * In der Hierarchie eines Ausschnitts war nicht zu erkennen, welche Linie ein
 * Aufruf, ein Test oder eine Definition ist. Jetzt steht die Art an der Linie,
 * eine Beschriftung je Knotenpaar: ein Test, der JSONBAgg aufruft UND testet,
 * traegt "CALLS · TESTS" statt zweier Schilder auf derselben Linie. Die Labels
 * weichen den Namen der Knoten aus, wie die Labels eines Pfades
 * (src/galaxy/path-frame.ts); die Namen sind hier Sprites der Szene, ihre
 * Kaesten kommen aus NodeLabels (`onLabelLayout`) in Weltkoordinaten.
 */
import { useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { placeAlongSegment, type ScreenRect } from './path-frame';
import type { LabelBox } from './NodeLabels';
import { HIERARCHY_LABEL_FONT_SIZE } from './hierarchy-layout';
import type { GraphEdge, GraphNode } from './types';

/** Mehr Schilder waeren kein Text mehr, sondern eine Flaeche. */
export const HIERARCHY_EDGE_LABEL_BUDGET = 80;

export interface HierarchyEdgeLabel { key: string; source: number; target: number; text: string }

/** Wo ein Knoten in der Hierarchie steht: Ebene und Lage. */
export type HierarchySpot = { hop: number; x: number; y: number };

/*
 * Ein Schild je Knotenpaar, die Arten ohne Doppelte, CALLS zuerst.
 *
 * Mit `layout` (Review zu K5): bei zwei Ebenen um JSONBAgg standen achtzig
 * Schilder auf den ersten achtzig Paaren in Kantenreihenfolge, Reihen von
 * "DEFINES" ohne einen Namen. Jetzt traegt jede Linie an der Wurzel ihr
 * Schild; weiter draussen bekommt ein Faecher, ein Knoten zu vielen ueber
 * dieselben Arten, EIN Schild mit seiner Zahl auf seiner mittleren Linie. Die
 * Reihenfolge geht von der Wurzel nach aussen, damit eine Obergrenze die
 * aeusseren Schilder trifft und nicht die inneren.
 */
export function hierarchyEdgeLabels(edges: readonly GraphEdge[], layout?: ReadonlyMap<number, HierarchySpot>): HierarchyEdgeLabel[] {
    const pairs = new Map<string, { source: number; target: number; types: Set<string> }>();
    for (const edge of edges) {
        if (edge.source === edge.target) continue;
        const [a, b] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
        const key = `${a}:${b}`;
        const pair = pairs.get(key) ?? { source: edge.source, target: edge.target, types: new Set<string>() };
        pair.types.add(edge.type); pairs.set(key, pair);
    }
    const labels = [...pairs].map(([key, pair]) => ({ key, source: pair.source, target: pair.target,
        text: [...pair.types].sort((x, y) => Number(y === 'CALLS') - Number(x === 'CALLS') || x.localeCompare(y)).join(' · ') }));
    if (!layout) return labels;
    const placed: { hop: number; order: number; label: HierarchyEdgeLabel }[] = [];
    type Member = { label: HierarchyEdgeLabel; order: number; hop: number; nearId: number; farId: number; near: HierarchySpot; far: HierarchySpot };
    const outer: Member[] = [];
    labels.forEach((label, order) => {
        const a = layout.get(label.source), b = layout.get(label.target);
        if (!a || !b || a.hop === b.hop) { placed.push({ hop: a?.hop ?? Number.MAX_SAFE_INTEGER, order, label }); return; }
        const [nearId, farId, near, far] = a.hop < b.hop ? [label.source, label.target, a, b] : [label.target, label.source, b, a];
        if (near.hop === 0) { placed.push({ hop: 0, order, label }); return; }
        outer.push({ label, order, hop: near.hop, nearId, farId, near, far });
    });
    // Erst die Faecher, die von einem Knoten ausgehen, dann die, die auf einen Knoten zulaufen.
    const gather = (members: Member[], keyOf: (member: Member) => string, yOf: (member: Member) => number, last: boolean): Member[] => {
        const fans = new Map<string, Member[]>();
        for (const member of members) fans.set(keyOf(member), [...fans.get(keyOf(member)) ?? [], member]);
        const single: Member[] = [];
        for (const [key, fan] of fans) {
            if (fan.length === 1 && !last) { single.push(fan[0]!); continue; }
            const middle = [...fan].sort((x, y) => yOf(y) - yOf(x))[Math.floor((fan.length - 1) / 2)]!.label;
            placed.push({ hop: fan[0]!.hop, order: fan[0]!.order, label: fan.length === 1 ? middle
                : { ...middle, key: `fan:${key}`, text: `${middle.text} ×${fan.length}` } });
        }
        return single;
    };
    const single = gather(outer, member => `${member.nearId}|${member.label.text}|${Math.sign(member.far.x - member.near.x)}`, member => member.far.y, false);
    gather(single, member => `in:${member.farId}|${member.label.text}|${Math.sign(member.near.x - member.far.x)}`, member => member.near.y, true);
    return placed.sort((x, y) => x.hop - y.hop || x.order - y.order).map(entry => entry.label);
}

const PLACE_EVERY_FRAMES = 3;

/*
 * Ein Schild nur dort, wo die Namen zu lesen sind (Review zu K5, im Browser
 * gesehen): bei zwei Ebenen standen die Namen im eingepassten Bild bei rund
 * 5 px, und siebzig Schilder in festen 10 px deckten es zu. Darunter traegt die
 * Farbe der Linie die Art, wie in der Legende; wer hineinzoomt, bekommt die
 * Schilder an den Linien, die er sieht.
 */
export const EDGE_LABEL_MIN_NAME_PIXELS = 9;

/** Ein freier Platz fuer ein Schild der Hierarchie, sonst keiner: hier liegt kein Schild auf einem Namen, die Farbe der Linie sagt die Art auch. */
export function hierarchyLabelSpot(from: { x: number; y: number }, to: { x: number; y: number }, size: { width: number; height: number },
    blockers: readonly ScreenRect[], placed: readonly ScreenRect[]): { t: number; rect: ScreenRect } | undefined {
    const choice = placeAlongSegment(from, to, size, blockers, placed);
    return choice.overlap > 0 ? undefined : choice;
}
export function edgeLabelVisible(namePixels: number, at: { x: number; y: number }, canvas: ScreenRect): boolean {
    return namePixels >= EDGE_LABEL_MIN_NAME_PIXELS && at.x >= canvas.left && at.x <= canvas.right && at.y >= canvas.top && at.y <= canvas.bottom;
}

export function HierarchyEdgeLabels({ nodes, edges, layout, nameBoxes }: {
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
    /** Ebene und Lage je Knoten: fasst die Faecher draussen zusammen (siehe `hierarchyEdgeLabels`). */
    layout?: ReadonlyMap<number, HierarchySpot>;
    /** Die gezeichneten Namen, in Weltkoordinaten (NodeLabels). */
    nameBoxes: RefObject<LabelBox[]>;
}) {
    const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const labels = useMemo(() => hierarchyEdgeLabels(edges, layout).flatMap((label) => {
        const from = byId.get(label.source), to = byId.get(label.target);
        return from && to ? [{ ...label, from, to }] : [];
    }).slice(0, HIERARCHY_EDGE_LABEL_BUDGET), [edges, layout, byId]);
    const groups = useRef(new Map<string, THREE.Group>());
    const elements = useRef(new Map<string, HTMLElement>());
    const sizes = useRef(new Map<string, { width: number; height: number }>());
    const camera = useThree((state) => state.camera);
    const gl = useThree((state) => state.gl);
    const tick = useRef(0);
    const point = useMemo(() => new THREE.Vector3(), []);
    const ends = useMemo(() => ({ from: new THREE.Vector3(), to: new THREE.Vector3() }), []);
    useFrame(() => {
        tick.current = (tick.current + 1) % PLACE_EVERY_FRAMES;
        if (tick.current !== 0) return;
        const box = gl.domElement.getBoundingClientRect();
        const toScreen = (x: number, y: number, z = 0) => {
            point.set(x, y, z).project(camera);
            return { x: box.left + ((point.x + 1) / 2) * box.width, y: box.top + ((1 - point.y) / 2) * box.height };
        };
        const blockers: ScreenRect[] = (nameBoxes.current ?? []).map((name) => {
            const a = toScreen(name.x - name.width / 2, name.y + name.height / 2), b = toScreen(name.x + name.width / 2, name.y - name.height / 2);
            return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
        });
        const placed: ScreenRect[] = [];
        // So hoch steht ein Name auf dem Schirm: die Schriftgroesse der Hierarchie, durch dieselbe Kamera.
        const anchor = labels[0]?.from;
        const namePixels = anchor ? Math.abs(toScreen(anchor.x, anchor.y + HIERARCHY_LABEL_FONT_SIZE, anchor.z).y - toScreen(anchor.x, anchor.y, anchor.z).y) : 0;
        const canvas = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        for (const { key, from, to } of labels) {
            const group = groups.current.get(key), element = elements.current.get(key);
            if (!group || !element) continue;
            const a = toScreen(from.x, from.y, from.z), b = toScreen(to.x, to.y, to.z);
            // Die Groesse eines Schildes einmal messen: Schreiben und Lesen im Wechsel hiesse ein Layout je Schild und Durchgang.
            let size = sizes.current.get(key);
            if (!size) {
                element.style.display = '';
                size = { width: element.offsetWidth, height: element.offsetHeight };
                if (size.width > 0) sizes.current.set(key, size);
            }
            const choice = size.width > 0 && edgeLabelVisible(namePixels, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, canvas)
                ? hierarchyLabelSpot(a, b, size, blockers, placed) : undefined;
            const display = choice ? '' : 'none';
            if (element.style.display !== display) element.style.display = display;
            if (!choice) continue;
            placed.push(choice.rect);
            group.position.lerpVectors(ends.from.set(from.x, from.y, from.z), ends.to.set(to.x, to.y, to.z), choice.t);
            const onEdge = { x: a.x + (b.x - a.x) * choice.t, y: a.y + (b.y - a.y) * choice.t };
            element.style.transform = `translate(${(choice.rect.left + choice.rect.right) / 2 - onEdge.x}px, ${(choice.rect.top + choice.rect.bottom) / 2 - onEdge.y}px)`;
        }
    });
    return (
        <>
            {labels.map(({ key, text, from, to }) => (
                <group key={key} position={[(from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2]}
                    ref={(group) => { if (group) groups.current.set(key, group); else groups.current.delete(key); }}>
                    <Html center zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
                        <span className="atlas-galaxy-path-label atlas-hierarchy-edge-label" data-testid="atlas-hierarchy-edge-label"
                            ref={(element) => { if (element) elements.current.set(key, element); else elements.current.delete(key); }}>{text}</span>
                    </Html>
                </group>
            ))}
        </>
    );
}
