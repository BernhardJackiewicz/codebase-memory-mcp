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
import type { GraphEdge, GraphNode } from './types';

/** Mehr Schilder waeren kein Text mehr, sondern eine Flaeche. */
export const HIERARCHY_EDGE_LABEL_BUDGET = 80;

export interface HierarchyEdgeLabel { key: string; source: number; target: number; text: string }

/** Ein Schild je Knotenpaar, die Arten ohne Doppelte, CALLS zuerst. */
export function hierarchyEdgeLabels(edges: readonly GraphEdge[]): HierarchyEdgeLabel[] {
    const pairs = new Map<string, { source: number; target: number; types: Set<string> }>();
    for (const edge of edges) {
        if (edge.source === edge.target) continue;
        const [a, b] = edge.source < edge.target ? [edge.source, edge.target] : [edge.target, edge.source];
        const key = `${a}:${b}`;
        const pair = pairs.get(key) ?? { source: edge.source, target: edge.target, types: new Set<string>() };
        pair.types.add(edge.type); pairs.set(key, pair);
    }
    return [...pairs].map(([key, pair]) => ({ key, source: pair.source, target: pair.target,
        text: [...pair.types].sort((x, y) => Number(y === 'CALLS') - Number(x === 'CALLS') || x.localeCompare(y)).join(' · ') }));
}

const PLACE_EVERY_FRAMES = 3;

export function HierarchyEdgeLabels({ nodes, edges, nameBoxes }: {
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
    /** Die gezeichneten Namen, in Weltkoordinaten (NodeLabels). */
    nameBoxes: RefObject<LabelBox[]>;
}) {
    const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const labels = useMemo(() => hierarchyEdgeLabels(edges).flatMap((label) => {
        const from = byId.get(label.source), to = byId.get(label.target);
        return from && to ? [{ ...label, from, to }] : [];
    }).slice(0, HIERARCHY_EDGE_LABEL_BUDGET), [edges, byId]);
    const groups = useRef(new Map<string, THREE.Group>());
    const elements = useRef(new Map<string, HTMLElement>());
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
        for (const { key, from, to } of labels) {
            const group = groups.current.get(key), element = elements.current.get(key);
            if (!group || !element || element.offsetWidth === 0) continue;
            const a = toScreen(from.x, from.y, from.z), b = toScreen(to.x, to.y, to.z);
            const choice = placeAlongSegment(a, b, { width: element.offsetWidth, height: element.offsetHeight }, blockers, placed);
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
