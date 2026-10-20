import type { FieldPackage, FieldResolution } from './field-flow-source';

export function PackageProvenance({ value }: { value: FieldPackage }) {
    return <dl className="field-flow-provenance" data-field-package>
        <dt>Package identity</dt><dd><code>{value.id}</code></dd>
        <dt>Package version</dt><dd>{value.version}</dd>
        <dt>Indexed manifest hash</dt><dd><code>{value.manifest_hash}</code></dd>
    </dl>;
}
export function ResolverProvenance({ proof }: { proof: FieldResolution }) {
    const isPackage = proof.proof_kind === 'package_export';
    return <section className="field-flow-resolution" data-field-resolution aria-label="Indexed resolver evidence">
        <strong>{isPackage ? 'Package import/export evidence' : 'Indexed resolver evidence'}</strong>
        <dl className="field-flow-provenance">
            <dt>Strategy</dt><dd><code>{proof.strategy}</code> · {proof.certainty}</dd>
            <dt>Caller</dt><dd>{isPackage ? proof.caller_symbol : proof.caller_qn}<br />{proof.caller_file} · bytes {proof.start_byte}–{proof.end_byte}</dd>
            <dt>Caller source hash</dt><dd><code>{proof.source_hash}</code></dd>
            <dt>Callee</dt><dd>{isPackage ? proof.callee_symbol : proof.callee_qn}<br />{proof.callee_file}</dd>
            <dt>Callee source hash</dt><dd><code>{proof.callee_hash}</code></dd>
            {!isPackage && <><dt>Graph nodes</dt><dd>Caller {proof.caller_node_id} · callee {proof.callee_node_id}</dd></>}
            <dt>Index identity</dt><dd>{proof.project} · {proof.generation}</dd>
        </dl>
        {isPackage && <>
            <PackageProvenance value={proof.package} />
            <dl className="field-flow-provenance">
                <dt>Manifest path</dt><dd><code>{proof.package.manifest_path}</code></dd>
                <dt>Import</dt><dd><code>{proof.import.imported_name}</code> from <code>{proof.import.specifier}</code> as <code>{proof.import.local_name}</code>
                    {' '}· bytes {proof.import.start_byte}–{proof.import.end_byte}</dd>
                <dt>Export</dt><dd><code>{proof.export.name}</code> · bytes {proof.export.start_byte}–{proof.export.end_byte}</dd>
            </dl>
        </>}
        <p>These are the resolver records returned by this index. Verify the source bytes before treating the current file as matching evidence.</p>
    </section>;
}
