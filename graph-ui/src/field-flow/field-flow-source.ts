import { callToolJson } from '../provider/rpc-transport';
import type { SystemEntityRef } from '../architecture/system-graph-source';

export interface SourceSpan {
    file_path: string; source_hash: string; start_byte: number; end_byte: number; start_line: number; end_line: number;
}
export interface FieldPackage { id: string; version: string; manifest_hash: string }
interface ResolutionBase {
    project: string; generation: string; caller_file: string; callee_file: string; source_hash: string; callee_hash: string;
    strategy: string; certainty: 'proven' | 'may'; start_byte: number; end_byte: number;
}
export interface GraphFieldResolution extends ResolutionBase {
    proof_kind?: undefined; caller_qn: string; callee_qn: string; caller_node_id: number; callee_node_id: number;
}
export interface PackageFieldResolution extends ResolutionBase {
    proof_kind: 'package_export'; caller_symbol: string; callee_symbol: string; certainty: 'proven';
    package: FieldPackage & { manifest_path: string };
    import: { specifier: string; imported_name: string; local_name: string; start_byte: number; end_byte: number };
    export: { name: string; start_byte: number; end_byte: number };
}
export type FieldResolution = GraphFieldResolution | PackageFieldResolution;
export interface FieldValue {
    id: string; file_path: string; symbol: string; binding: string; access_path: string[]; kind: string;
    version: number; parameter_index: number; analysis_status: 'ready' | 'stale'; source: SourceSpan;
    ref: { project: string; generation: string; value_id: string }; symbol_ref?: SystemEntityRef;
    package?: FieldPackage;
}
export interface FieldOperation {
    id: string; file_path: string; symbol: string; kind: string; operator_name: string; source: SourceSpan;
    ref: { project: string; generation: string; operation_id: string };
}
export type FieldCertainty = 'proven' | 'may' | 'derived' | 'control' | 'unknown';
export interface FieldLink {
    id: string; source: string; target: string; operation_id: string; kind: string; certainty: FieldCertainty; callsite_id: string;
    ref: { project: string; generation: string; link_id: string };
    resolution?: FieldResolution;
}
export type FlowDirection = 'forward' | 'backward';
export interface FieldPath { values: string[]; links: string[]; direction: FlowDirection; semantics: 'context_matched_static_value_dependence' }
export interface FieldGap {
    code: string; message: string; file_path: string; value_id?: string; symbol?: string;
    source?: Omit<SourceSpan, 'end_line'> & { end_line?: number };
    ref?: { project: string; generation: string; file_path: string; gap_ordinal: number };
}
export interface FieldFlowResult {
    schema_version: 1; analysis_kind: 'static_field_flow'; completeness_scope: 'indexed_flow_ir_slice';
    project: string; generation: string; status: 'ready' | 'limited' | 'selection_required'; complete: boolean;
    values: FieldValue[]; links: FieldLink[]; operations: FieldOperation[]; paths: FieldPath[]; gaps: FieldGap[];
    limits: { max_depth: number; max_paths: number; max_states: number; max_call_depth: number; visited_states: number };
}
export type FieldSelector = { value_id: string } | { file_path: string; symbol?: string; access_path?: string[]; start_byte?: number };
export interface FieldFlowRequest {
    project: string; generation: string; source: FieldSelector; direction: FlowDirection;
    max_depth?: number; max_paths?: number; max_states?: number; max_call_depth?: number;
}
export type FieldFlowLoader = (request: FieldFlowRequest, signal: AbortSignal) => Promise<FieldFlowResult>;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
const sourceSpan = (value: unknown, gap = false): boolean => record(value) && nonempty(value.file_path) && nonempty(value.source_hash)
    && integer(value.start_byte) && integer(value.end_byte) && value.end_byte >= value.start_byte
    && integer(value.start_line) && (gap || value.start_line > 0)
    && ((gap && value.end_line === undefined) || (integer(value.end_line) && value.end_line >= value.start_line));
const reference = (value: unknown, key: string): boolean => record(value) && nonempty(value.project) && nonempty(value.generation) && nonempty(value[key]);
const fieldPackage = (value: unknown): boolean => record(value) && ['id', 'version', 'manifest_hash'].every(key => nonempty(value[key]));
const byteRange = (value: Record<string, unknown>): boolean => integer(value.start_byte) && integer(value.end_byte) && value.end_byte > value.start_byte;
const resolution = (value: unknown): boolean => {
    if (!record(value) || !['project', 'generation', 'caller_file', 'callee_file', 'source_hash', 'callee_hash', 'strategy'].every(key => nonempty(value[key]))
        || !['proven', 'may'].includes(String(value.certainty)) || !byteRange(value)) return false;
    if (value.proof_kind === undefined) return nonempty(value.caller_qn) && nonempty(value.callee_qn)
        && integer(value.caller_node_id) && value.caller_node_id > 0 && integer(value.callee_node_id) && value.callee_node_id > 0;
    return value.proof_kind === 'package_export' && value.certainty === 'proven' && nonempty(value.caller_symbol) && nonempty(value.callee_symbol)
        && fieldPackage(value.package) && record(value.package) && nonempty(value.package.manifest_path)
        && record(value.import) && ['specifier', 'imported_name', 'local_name'].every(key => nonempty(value.import && (value.import as Record<string, unknown>)[key]))
        && byteRange(value.import) && record(value.export) && nonempty(value.export.name) && byteRange(value.export);
};
const fieldValue = (value: unknown): boolean => record(value) && nonempty(value.id) && nonempty(value.file_path)
    && text(value.symbol) && text(value.binding) && strings(value.access_path) && nonempty(value.kind) && integer(value.version)
    && Number.isSafeInteger(value.parameter_index) && Number(value.parameter_index) >= -1 && ['ready', 'stale'].includes(String(value.analysis_status))
    && sourceSpan(value.source) && reference(value.ref, 'value_id')
    && (value.package === undefined || fieldPackage(value.package))
    && (value.symbol_ref === undefined || (record(value.symbol_ref) && nonempty(value.symbol_ref.project) && nonempty(value.symbol_ref.generation)
        && integer(value.symbol_ref.node_id) && value.symbol_ref.node_id > 0));
const operation = (value: unknown): boolean => record(value) && nonempty(value.id) && nonempty(value.file_path)
    && text(value.symbol) && nonempty(value.kind) && text(value.operator_name) && sourceSpan(value.source) && reference(value.ref, 'operation_id');
const link = (value: unknown): boolean => record(value) && ['id', 'source', 'target', 'operation_id', 'kind'].every(key => nonempty(value[key]))
    && ['proven', 'may', 'derived', 'control', 'unknown'].includes(String(value.certainty)) && text(value.callsite_id) && reference(value.ref, 'link_id')
    && (value.resolution === undefined || resolution(value.resolution));
const path = (value: unknown): boolean => record(value) && strings(value.values) && value.values.length > 0 && strings(value.links)
    && ['forward', 'backward'].includes(String(value.direction)) && value.semantics === 'context_matched_static_value_dependence';
const gap = (value: unknown): boolean => record(value) && nonempty(value.code) && text(value.message) && text(value.file_path)
    && (value.value_id === undefined || text(value.value_id)) && (value.symbol === undefined || text(value.symbol))
    && (value.source === undefined || sourceSpan(value.source, true))
    && (value.ref === undefined || (record(value.ref) && nonempty(value.ref.project) && nonempty(value.ref.generation)
        && text(value.ref.file_path) && integer(value.ref.gap_ordinal)));

export function readFieldFlow(value: unknown): FieldFlowResult {
    if (!record(value) || value.schema_version !== 1 || value.analysis_kind !== 'static_field_flow'
        || value.completeness_scope !== 'indexed_flow_ir_slice' || !nonempty(value.project) || !nonempty(value.generation)
        || !['ready', 'limited', 'selection_required'].includes(String(value.status)) || typeof value.complete !== 'boolean'
        || !Array.isArray(value.values) || !value.values.every(fieldValue) || !Array.isArray(value.operations) || !value.operations.every(operation)
        || !Array.isArray(value.links) || !value.links.every(link) || !Array.isArray(value.paths) || !value.paths.every(path)
        || !Array.isArray(value.gaps) || !value.gaps.every(gap) || !record(value.limits)
        || !['max_depth', 'max_paths', 'max_states', 'max_call_depth', 'visited_states'].every(key => integer((value.limits as Record<string, unknown>)[key])))
        throw new Error('Unsupported field-flow response shape.');
    const result = value as unknown as FieldFlowResult;
    const same = (ref: { project: string; generation: string }) => ref.project === result.project && ref.generation === result.generation;
    const values = new Map(result.values.map(item => [item.id, item]));
    const operations = new Map(result.operations.map(item => [item.id, item]));
    const links = new Map(result.links.map(item => [item.id, item]));
    if (values.size !== result.values.length || operations.size !== result.operations.length || links.size !== result.links.length
        || result.values.some(item => !same(item.ref) || item.ref.value_id !== item.id || item.file_path !== item.source.file_path
            || (item.symbol_ref !== undefined && !same(item.symbol_ref)))
        || result.operations.some(item => !same(item.ref) || item.ref.operation_id !== item.id || item.file_path !== item.source.file_path)
        || result.links.some(item => !same(item.ref) || item.ref.link_id !== item.id || !values.has(item.source)
            || !values.has(item.target) || !operations.has(item.operation_id))
        || result.gaps.some(item => item.ref && (!same(item.ref) || item.ref.file_path !== item.file_path)))
        throw new Error('Field-flow evidence has inconsistent identity or missing endpoints.');
    for (const edge of result.links) {
        const proof = edge.resolution;
        if (!proof) continue;
        const operation = operations.get(edge.operation_id)!;
        const caller = values.get(edge.kind === 'return' ? edge.target : edge.source)!;
        const callee = values.get(edge.kind === 'return' ? edge.source : edge.target)!;
        if (!same(proof) || !['argument', 'return'].includes(edge.kind) || proof.certainty !== edge.certainty
            || operation.kind !== 'call' || operation.source.file_path !== proof.caller_file || operation.source.source_hash !== proof.source_hash
            || operation.source.start_byte !== proof.start_byte || operation.source.end_byte !== proof.end_byte
            || caller.file_path !== proof.caller_file || caller.source.source_hash !== proof.source_hash
            || callee.file_path !== proof.callee_file || callee.source.source_hash !== proof.callee_hash
            || (proof.proof_kind === 'package_export' && (operation.symbol !== proof.caller_symbol || callee.symbol !== proof.callee_symbol
                || !callee.package || callee.package.id !== proof.package.id || callee.package.version !== proof.package.version
                || callee.package.manifest_hash !== proof.package.manifest_hash)))
            throw new Error('Field-flow resolver evidence has inconsistent source or generation identity.');
    }
    if (result.paths.some(item => item.values.length !== item.links.length + 1 || item.values.some(id => !values.has(id))
        || item.links.some((id, index) => {
            const edge = links.get(id);
            return !edge || (item.direction === 'forward'
                ? edge.source !== item.values[index] || edge.target !== item.values[index + 1]
                : edge.target !== item.values[index] || edge.source !== item.values[index + 1]);
        })) || (result.status === 'selection_required' && (result.paths.length || result.links.length)))
        throw new Error('Field-flow paths do not match the returned directional evidence.');
    return result;
}
export const loadFieldFlow: FieldFlowLoader = async (request, signal) => {
    const { generation, ...args } = request;
    const result = readFieldFlow(await callToolJson('trace_field', { ...args, expected_generation: generation }, { signal }));
    if (result.project !== request.project || result.generation !== request.generation)
        throw new Error('Field-flow project or generation changed. Reload source occurrences.');
    return result;
};
