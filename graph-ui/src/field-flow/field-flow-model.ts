import type { SystemGraphEntity } from '../architecture/system-graph-source';
import type { FieldSelector, FieldValue } from './field-flow-source';

export function parseFieldSelector(file: string, symbol: string, fields: string, byte: string): FieldSelector {
    if (!file.trim()) throw new Error('Choose an indexed source file.');
    let access: string[] | undefined;
    if (fields.trim()) {
        try { access = JSON.parse(fields); } catch { throw new Error('Enter a JSON array of exact field segments, such as ["user","email"].'); }
        if (!Array.isArray(access) || access.length > 32 || !access.every(part => typeof part === 'string' && part.length > 0 && part.length <= 512))
            throw new Error('Use at most 32 nonempty field segments.');
    }
    const start = byte.trim() ? Number(byte) : undefined;
    if (start !== undefined && (!/^\d+$/.test(byte.trim()) || !Number.isSafeInteger(start) || start > 2147483647))
        throw new Error('Source byte offset must be a nonnegative integer.');
    return { file_path: file.trim(), ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
        ...(access !== undefined ? { access_path: access } : {}), ...(start !== undefined ? { start_byte: start } : {}) };
}
export function anchoredEntities(value: FieldValue, entities: readonly SystemGraphEntity[]): SystemGraphEntity[] {
    return value.symbol_ref ? entities.filter(entity => entity.ref.project === value.symbol_ref!.project
        && entity.ref.generation === value.symbol_ref!.generation && entity.ref.node_id === value.symbol_ref!.node_id) : [];
}
export const fieldLabel = (value: FieldValue): string => {
    if (value.access_path.length) return `Field${value.access_path.map(field => `[${JSON.stringify(field)}]`).join('')}`;
    if (value.kind === 'parameter' && value.parameter_index >= 0) return `Parameter ${value.parameter_index + 1}`;
    const kind = value.kind.replaceAll('_', ' ');
    return kind.charAt(0).toUpperCase() + kind.slice(1);
};
