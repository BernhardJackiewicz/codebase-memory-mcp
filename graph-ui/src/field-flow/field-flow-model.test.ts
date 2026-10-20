import { describe, expect, it } from 'vitest';
import { systemGraphResponse } from '../architecture/system-graph-fixture';
import { value } from './field-flow-fixture';
import { anchoredEntities, fieldLabel, parseFieldSelector } from './field-flow-model';

describe('field source selection', () => {
    it('preserves explicit field segments and byte zero, rejecting ambiguous dotted notation', () => {
        expect(parseFieldSelector('src/users.ts', 'users.createUser', '["user.email","name"]', '0')).toEqual({
            file_path: 'src/users.ts', symbol: 'users.createUser', access_path: ['user.email', 'name'], start_byte: 0 });
        expect(() => parseFieldSelector('src/users.ts', '', 'user.email', '')).toThrow(/JSON/i);
        expect(() => parseFieldSelector('src/users.ts', '', '[""]', '')).toThrow(/field/i);
    });
    it('associates only an explicit snapshot-matching symbol ref, never matching names or IDs', () => {
        const entities = systemGraphResponse().result!.entities;
        const candidate = value(entities[0].id);
        candidate.symbol_ref = { ...entities[0].ref };
        expect(anchoredEntities(candidate, entities).map(entity => entity.id)).toEqual([entities[0].id]);
        candidate.symbol_ref = undefined;
        expect(anchoredEntities(candidate, entities)).toEqual([]);
        candidate.symbol_ref = { ...entities[0].ref, generation: 'stale' };
        expect(anchoredEntities(candidate, entities)).toEqual([]);
    });
    it('labels fields and occurrences without presenting opaque binding IDs as variable names', () => {
        const candidate = value('opaque:value');
        candidate.binding = 'flow:deadbeef:param:0:0';
        expect(fieldLabel(candidate)).toBe('Field["email"]');
        candidate.access_path = []; candidate.kind = 'parameter'; candidate.parameter_index = 0;
        expect(fieldLabel(candidate)).toBe('Parameter 1');
    });
});
