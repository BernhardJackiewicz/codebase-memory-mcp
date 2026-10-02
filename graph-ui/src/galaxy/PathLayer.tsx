/*
 * Der Pfad in der Szene (Review-Befund G5).
 *
 * Die Kanten des Pfades liegen als eigene Linien UEBER der Kantenebene, in der
 * Farbe ihrer Art und ohne Tiefentest, damit sie im abgedunkelten Rest nicht
 * verschwinden. Ihre Art steht als Beschriftung daneben, und nur an ihnen:
 * eine Beschriftung an jeder Kante waere bei hundert Kanten kein Text mehr.
 * Der Schritt, auf dem der Leser steht, ist heller und traegt einen Ring samt
 * Namen an seinem Ziel. Gezeichnet wird an den Positionen, die die Szene wirklich
 * zeichnet, also nach der Trennung auf dem Schirm.
 */
import { useEffect, useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { edgeColor } from '../graph/edge-style';
import type { ScopePathStep } from './scope-path';
import type { GraphNode } from './types';

export interface ScenePath {
    steps: readonly ScopePathStep[];
    active: number;
    /** `all` beschriftet jede Kante des Pfades, `active` nur den aktuellen Schritt. */
    labels: 'all' | 'active';
}

export function PathLayer({ nodes, path }: { nodes: readonly GraphNode[]; path: ScenePath }) {
    const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    const segments = useMemo(() => path.steps.flatMap((step, index) => {
        const from = byId.get(step.from), to = byId.get(step.to);
        return from && to ? [{ step, index, from, to }] : [];
    }), [path.steps, byId]);
    const geometry = useMemo(() => {
        const positions = new Float32Array(segments.length * 6), colors = new Float32Array(segments.length * 6);
        const white = new THREE.Color('#ffffff');
        segments.forEach(({ step, index, from, to }, at) => {
            positions.set([from.x, from.y, from.z, to.x, to.y, to.z], at * 6);
            const color = new THREE.Color(edgeColor(step.edge.type));
            if (index === path.active) color.lerp(white, 0.55);
            colors.set([color.r, color.g, color.b, color.r, color.g, color.b], at * 6);
        });
        const result = new THREE.BufferGeometry();
        result.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        result.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        return result;
    }, [segments, path.active]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    const goal = segments.find((segment) => segment.index === path.active);
    return (
        <>
            <lineSegments geometry={geometry} renderOrder={18}>
                <lineBasicMaterial vertexColors transparent depthTest={false} depthWrite={false} toneMapped={false} />
            </lineSegments>
            {segments.filter(({ index }) => path.labels === 'all' || index === path.active).map(({ step, index, from, to }) => (
                <Html key={index} position={[(from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2]} center
                    zIndexRange={[9, 0]} style={{ pointerEvents: 'none' }}>
                    <span className="atlas-galaxy-path-label" data-active={index === path.active}>{step.edge.type}</span>
                </Html>
            ))}
            {goal && (
                <Html position={[goal.to.x, goal.to.y, goal.to.z]} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
                    <span className="atlas-galaxy-path-step" data-testid="atlas-galaxy-path-step" data-node={goal.to.id}>
                        <i aria-hidden="true" />
                        <b>{goal.to.name}</b>
                    </span>
                </Html>
            )}
        </>
    );
}
