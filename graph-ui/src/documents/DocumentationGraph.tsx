import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DocumentDetail, DocumentNode, DocumentRelationship } from './documents-source';

const identity = (node: DocumentNode) => `${node.project}:${node.id}`;
const short = (text: string, length = 23) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
/** A bounded neighborhood of actual edges. The complete returned list remains below it. */
export default function DocumentationGraph({ detail, onOpen, onEvidence }: {
    detail: DocumentDetail; onOpen: (node: DocumentNode) => void; onEvidence: (edge: DocumentRelationship) => void;
}) {
    const marker = useId().replaceAll(':', '');
    const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
    const [highlightedEdge, setHighlightedEdge] = useState<number>();
    const surface = useRef<SVGSVGElement>(null);
    const dragging = useRef<{ x: number; y: number; originX: number; originY: number } | undefined>(undefined);
    const graph = useMemo(() => {
        const center = identity(detail.document);
        const neighbors = [...new Map(detail.relationships.filter(edge => identity(edge.target) !== center)
            .map(edge => [identity(edge.target), edge.target])).values()].slice(0, 4);
        const positions = new Map<string, { x: number; y: number }>([[center, { x: 150, y: 32 }]]);
        neighbors.forEach((node, index) => positions.set(identity(node), { x: 150, y: 132 + index * 88 }));
        const edges = detail.relationships.filter(edge => positions.has(identity(edge.target)) && identity(edge.target) !== center).slice(0, 12);
        return { neighbors, positions, edges, height: Math.max(100, 176 + (neighbors.length - 1) * 88) };
    }, [detail]);
    const zoom = (factor: number) => setCamera(value => ({ ...value, zoom: Math.max(.6, Math.min(2.5, value.zoom * factor)) }));
    useEffect(() => {
        const svg = surface.current;
        if (!svg) return;
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            setCamera(value => ({ ...value, zoom: Math.max(.6, Math.min(2.5, value.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12))) }));
        };
        svg.addEventListener('wheel', wheel, { passive: false });
        return () => svg.removeEventListener('wheel', wheel);
    }, []);
    return <section className="docs-graph" aria-label="Documentation graph">
        <div className="docs-graph-controls"><span>Graph neighborhood</span><div>
            <button type="button" aria-label="Zoom document graph out" onClick={() => zoom(1 / 1.2)}>−</button>
            <button type="button" aria-label="Zoom document graph in" onClick={() => zoom(1.2)}>+</button>
            <button type="button" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>Fit</button>
        </div></div>
        <p className="docs-graph-edge-caption">{highlightedEdge === undefined ? 'Hover or focus an arrow to read its relationship.' : <>
            <strong>{graph.edges[highlightedEdge].type.replaceAll('_', ' ')}</strong>
            <span>{graph.edges[highlightedEdge].direction === 'outgoing' ? 'To' : 'From'} {graph.edges[highlightedEdge].target.name}</span>
        </>}</p>
        <svg ref={surface} viewBox={`0 0 300 ${graph.height}`} role="group" aria-label="Recorded document connections"
            onPointerDown={event => {
                if ((event.target as Element).closest('[data-graph-node], [data-document-edge]')) return;
                dragging.current = { x: event.clientX, y: event.clientY, originX: camera.x, originY: camera.y };
                event.currentTarget.setPointerCapture?.(event.pointerId);
            }} onPointerMove={event => {
                if (!dragging.current) return;
                const width = event.currentTarget.getBoundingClientRect().width || 300;
                setCamera(value => ({ ...value, x: dragging.current!.originX + (event.clientX - dragging.current!.x) * 300 / width,
                    y: dragging.current!.originY + (event.clientY - dragging.current!.y) * 300 / width }));
            }} onPointerUp={() => { dragging.current = undefined; }} onPointerCancel={() => { dragging.current = undefined; }}>
            <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
            <g transform={`translate(${150 + camera.x} ${camera.y}) scale(${camera.zoom}) translate(-150 0)`}>
                {graph.edges.map((edge, index) => {
                    const target = graph.positions.get(identity(edge.target))!;
                    const outgoing = edge.direction === 'outgoing';
                    // Every control point stays outside the node column. A long
                    // connection can never cross another card and imply a chain.
                    const left = index % 2 === 0, x = left ? 58 : 242;
                    const lane = left ? 14 + Math.floor(index / 2) * 8 : 286 - Math.floor(index / 2) * 8;
                    const y1 = outgoing ? 32 : target.y, y2 = outgoing ? target.y : 32;
                    const path = `M${x},${y1} C${lane},${y1} ${lane},${y2} ${x},${y2}`;
                    return <g key={`${edge.id}:${index}`} data-document-edge={edge.id} role="button" tabIndex={0}
                        data-highlighted={highlightedEdge === index}
                        aria-label={`Inspect ${edge.direction} ${edge.type} connection with ${edge.target.name}`}
                        onMouseEnter={() => setHighlightedEdge(index)} onMouseLeave={() => setHighlightedEdge(undefined)}
                        onFocus={() => setHighlightedEdge(index)} onBlur={() => setHighlightedEdge(undefined)}
                        onClick={() => onEvidence(edge)} onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEvidence(edge); }
                        }}>
                        <title>{edge.direction} {edge.type}: {edge.target.name}</title>
                        <path className="docs-graph-hit" d={path} />
                        <path className="docs-graph-edge" markerEnd={`url(#${marker})`} d={path} />
                    </g>;
                })}
                {[detail.document, ...graph.neighbors].map(node => {
                    const position = graph.positions.get(identity(node))!, current = identity(node) === identity(detail.document);
                    return <g key={identity(node)} data-graph-node={node.id} transform={`translate(${position.x},${position.y})`}
                        className="docs-graph-node" data-current={current} role="button" tabIndex={0} aria-label={`Open graph node ${node.name}`}
                        onClick={() => onOpen(node)} onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(node); }
                        }}>
                        <title>{node.name} · {node.label} · {node.file_path}</title>
                        <rect x="-92" y="-26" width="184" height="52" rx="5" />
                        <text textAnchor="middle" y="-2">{short(node.name)}</text>
                        <text className="docs-graph-node-kind" textAnchor="middle" y="15">{node.label}</text>
                    </g>;
                })}
            </g>
        </svg>
        <p>{graph.edges.length} of {detail.relationships.length} recorded relationships drawn. Drag to pan; select an arrow for its evidence. All returned relationships are listed below.</p>
    </section>;
}
