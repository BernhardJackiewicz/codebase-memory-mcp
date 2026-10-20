import { callToolJson } from '../provider/rpc-transport';

export interface SystemEntityRef { project: string; generation: string; node_id: number }
export interface SystemEdgeRef { project: string; generation: string; edge_id: number }
export interface SystemGraphEntity {
    id: string; kind: string; label: string; name: string; qualified_name: string;
    file_path?: string; start_line?: number; end_line?: number;
    properties: Record<string, unknown>; ref: SystemEntityRef;
}
export interface SystemGraphWitness {
    ref: SystemEdgeRef; source: SystemEntityRef; target: SystemEntityRef;
    location?: { file_path: string; line?: number; page?: number; position_kind?: 'relationship' | 'source_context' };
    properties: Record<string, unknown>;
}
export interface SystemGraphRelation {
    id: string; source: string; target: string; type: string; layer: string;
    evidence: 'indexed'; witnesses: SystemGraphWitness[];
}
export interface SystemGraphProjection {
    schema_version: 1; project: string; generation: string; status: 'ready' | 'limited'; complete: boolean;
    entities: SystemGraphEntity[]; relations: SystemGraphRelation[];
    totals: Record<string, number>;
    limits: { max_entities: number; max_relations: number; omitted_entities: number; omitted_relations: number };
    capabilities: { static_system_graph: boolean; field_value_flow: boolean; live_capture: boolean };
    gaps: { code: string; message: string; count?: number }[];
    groups: { kind: string; count: number }[];
}
export interface SystemGraphResponse {
    status: 'pending' | 'ready' | 'failed'; generation: string; retry_after_ms?: number;
    result?: SystemGraphProjection; error?: string;
}
export interface SystemGraphRequest { project: string; expectedGeneration?: string }
export type SystemGraphLoader = (request: SystemGraphRequest, signal: AbortSignal) => Promise<SystemGraphResponse>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const list = (value: unknown): value is unknown[] => Array.isArray(value);
const location = (value: unknown): boolean => record(value) && string(value.file_path)
    && (value.position_kind === undefined || value.position_kind === 'relationship'
        || (value.position_kind === 'source_context' && integer(value.page) && value.page > 0))
    && (value.line === undefined || (integer(value.line) && value.line > 0))
    && (value.page === undefined || (integer(value.page) && value.page > 0));
const nodeRef = (value: unknown): value is SystemEntityRef => record(value) && string(value.project)
    && string(value.generation) && integer(value.node_id) && value.node_id > 0;
const edgeRef = (value: unknown): value is SystemEdgeRef => record(value) && string(value.project)
    && string(value.generation) && integer(value.edge_id) && value.edge_id > 0;
const entity = (value: unknown): value is SystemGraphEntity => record(value) && string(value.id) && string(value.kind)
    && typeof value.label === 'string' && typeof value.name === 'string' && typeof value.qualified_name === 'string'
    && (value.file_path === undefined || typeof value.file_path === 'string')
    && (value.start_line === undefined || integer(value.start_line))
    && (value.end_line === undefined || integer(value.end_line)) && record(value.properties) && nodeRef(value.ref);
const witness = (value: unknown): value is SystemGraphWitness => record(value) && edgeRef(value.ref)
    && nodeRef(value.source) && nodeRef(value.target) && record(value.properties)
    && (value.location === undefined || location(value.location));
const relation = (value: unknown): value is SystemGraphRelation => record(value) && string(value.id)
    && string(value.source) && string(value.target) && string(value.type) && string(value.layer)
    && value.evidence === 'indexed' && list(value.witnesses) && value.witnesses.every(witness);

/** Validate identity as well as shape: graph IDs only mean something in their named snapshot. */
export function readSystemGraph(value: unknown): SystemGraphResponse {
    if (!record(value) || !['ready', 'pending', 'failed'].includes(String(value.status))
        || (value.status === 'failed' ? typeof value.generation !== 'string' : !string(value.generation))
        || (value.error !== undefined && typeof value.error !== 'string')
        || (value.retry_after_ms !== undefined && !integer(value.retry_after_ms))) throw new Error('Unsupported system graph response shape.');
    if (value.status !== 'ready') return value as unknown as SystemGraphResponse;
    const data = value.result;
    if (!record(data) || data.schema_version !== 1 || !string(data.project) || !string(data.generation)
        || !['ready', 'limited'].includes(String(data.status)) || typeof data.complete !== 'boolean'
        || !list(data.entities) || !data.entities.every(entity) || !list(data.relations) || !data.relations.every(relation)
        || !record(data.totals) || !Object.values(data.totals).every(integer)
        || !record(data.limits) || !['max_entities', 'max_relations', 'omitted_entities', 'omitted_relations'].every(key => integer((data.limits as Record<string, unknown>)[key]))
        || !record(data.capabilities) || !['static_system_graph', 'field_value_flow', 'live_capture'].every(key => typeof (data.capabilities as Record<string, unknown>)[key] === 'boolean')
        || !list(data.gaps) || !data.gaps.every(gap => record(gap) && string(gap.code) && typeof gap.message === 'string' && (gap.count === undefined || integer(gap.count)))
        || !list(data.groups) || !data.groups.every(group => record(group) && string(group.kind) && integer(group.count))) {
        throw new Error('System graph evidence has an invalid shape.');
    }
    const projection = data as unknown as SystemGraphProjection;
    const sameSnapshot = (ref: SystemEntityRef | SystemEdgeRef) => ref.project === projection.project && ref.generation === projection.generation;
    const entities = new Map(projection.entities.map(item => [item.id, item]));
    if (projection.generation !== value.generation || entities.size !== projection.entities.length
        || new Set(projection.entities.map(item => item.ref.node_id)).size !== entities.size
        || new Set(projection.relations.map(item => item.id)).size !== projection.relations.length
        || projection.entities.some(item => !sameSnapshot(item.ref))
        || projection.relations.some(item => {
            const source = entities.get(item.source), target = entities.get(item.target);
            return !source || !target || item.witnesses.some(proof => !sameSnapshot(proof.ref)
                || !sameSnapshot(proof.source) || !sameSnapshot(proof.target)
                || proof.source.node_id !== source.ref.node_id || proof.target.node_id !== target.ref.node_id);
        })) throw new Error('System graph evidence has an inconsistent project, generation or endpoint identity.');
    return value as unknown as SystemGraphResponse;
}

export async function loadSystemGraph(request: SystemGraphRequest, signal: AbortSignal): Promise<SystemGraphResponse> {
    const response = readSystemGraph(await callToolJson('get_architecture', {
        project: request.project, aspects: ['system_graph'], format: 'json',
        ...(request.expectedGeneration === undefined ? {} : { expected_generation: request.expectedGeneration }),
    }, { signal }));
    if (response.result && response.result.project !== request.project) throw new Error('System graph belongs to another project.');
    if (response.status !== 'failed' && request.expectedGeneration !== undefined && response.generation !== request.expectedGeneration) throw new Error('System graph generation changed. Refresh the project to load the current index.');
    return response;
}
