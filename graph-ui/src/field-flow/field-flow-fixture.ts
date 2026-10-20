import type { FieldFlowResult, FieldValue, SourceSpan } from './field-flow-source';

export const span = (start = 0): SourceSpan => ({ file_path: 'src/users.ts', source_hash: 'abc123',
    start_byte: start, end_byte: start + 4, start_line: start ? 3 : 1, end_line: start ? 3 : 1 });
export const value = (id: string, start = 0): FieldValue => ({ id, file_path: 'src/users.ts', symbol: 'users.createUser',
    binding: 'input', access_path: ['email'], kind: 'field', version: start ? 1 : 0, parameter_index: -1,
    analysis_status: 'ready', source: span(start), ref: { project: 'sample', generation: 'g1', value_id: id },
    symbol_ref: { project: 'sample', generation: 'g1', node_id: 3 } });
export function fieldFlowFixture(ambiguous = false): FieldFlowResult {
    return { schema_version: 1, analysis_kind: 'static_field_flow', completeness_scope: 'indexed_flow_ir_slice',
        project: 'sample', generation: 'g1', status: ambiguous ? 'selection_required' : 'limited', complete: false,
        values: [value('v:old'), value('v:new', 10)],
        operations: ambiguous ? [] : [{ id: 'op:1', file_path: 'src/users.ts', symbol: 'users.createUser',
            kind: 'transform', operator_name: 'normalize', source: span(10),
            ref: { project: 'sample', generation: 'g1', operation_id: 'op:1' } }],
        links: ambiguous ? [] : [{ id: 'link:1', source: 'v:old', target: 'v:new', operation_id: 'op:1',
            kind: 'transform', certainty: 'derived', callsite_id: '',
            ref: { project: 'sample', generation: 'g1', link_id: 'link:1' } }],
        paths: ambiguous ? [] : [{ values: ['v:old', 'v:new'], links: ['link:1'], direction: 'forward',
            semantics: 'context_matched_static_value_dependence' }],
        gaps: [{ code: ambiguous ? 'ambiguous_source' : 'external_call', file_path: 'src/users.ts',
            message: ambiguous ? 'Select one returned value_id.' : 'External call transport is not resolved.' }],
        limits: { max_depth: 32, max_paths: 32, max_states: 4096, max_call_depth: 4, visited_states: ambiguous ? 0 : 2 } };
}
export function fieldFlowProvenanceFixture() {
    const base = fieldFlowFixture();
    const dependency = Object.assign(base.values[1], {
        file_path: 'node_modules/example/index.js', symbol: 'normalize@0', kind: 'parameter', parameter_index: 0,
        source: { ...span(0), file_path: 'node_modules/example/index.js', source_hash: 'dependency-body-hash' },
        package: { id: 'npm:example', version: '1.2.3', manifest_hash: 'dependency-manifest-hash' },
    });
    base.operations[0].kind = 'call';
    base.operations[0].source = { ...span(20), end_byte: 31 };
    const edge = Object.assign(base.links[0], { kind: 'argument', certainty: 'proven' as const, callsite_id: 'callsite:1',
        resolution: { project: 'sample', generation: 'g1', caller_file: 'src/users.ts', callee_file: dependency.file_path,
            source_hash: 'abc123', callee_hash: 'dependency-body-hash', caller_qn: 'users.createUser',
            callee_qn: 'example.normalize', strategy: 'lsp_ts_import', certainty: 'proven' as const,
            caller_node_id: 3, callee_node_id: 9, start_byte: 20, end_byte: 31 } });
    return { ...base, values: [base.values[0], dependency], links: [edge] };
}
export function fieldFlowPackageResolutionFixture() {
    const base = fieldFlowProvenanceFixture(), dependency = base.values[1];
    return { ...base, links: [{ ...base.links[0], resolution: {
        proof_kind: 'package_export' as const, project: 'sample', generation: 'g1',
        caller_file: 'src/users.ts', callee_file: dependency.file_path,
        source_hash: 'abc123', callee_hash: 'dependency-body-hash',
        caller_symbol: 'users.createUser', callee_symbol: 'normalize@0',
        strategy: 'npm_esm_named_export', certainty: 'proven' as const, start_byte: 20, end_byte: 31,
        package: { id: 'npm:example', version: '1.2.3', manifest_hash: 'dependency-manifest-hash',
            manifest_path: 'node_modules/example/package.json' },
        import: { specifier: 'example', imported_name: 'normalize', local_name: 'normalizeEmail', start_byte: 0, end_byte: 19 },
        export: { name: 'normalize', start_byte: 7, end_byte: 80 },
    } }] };
}
