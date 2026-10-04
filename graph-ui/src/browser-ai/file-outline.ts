import { isGithubWorkflow } from './file-kind';
import { fileOutlineWords, germanWorkflowWords, workflowWords } from './strings';
import { workflowFactLines, yamlTree, type YamlValue } from './workflow-facts';

/** "What does this file do?" about a configuration file, answered from the file (C7). The
 * small model wrote "YAML-Konfiguration für den Black-Commit-Tool" for django's pre-commit
 * file and, asked for detail, hung `additional_dependencies` on the wrong hooks. The outline
 * names what the file holds: every key, a list of mappings item by item with its fields, a
 * workflow by its counted facts. It is bounded, and says what it left out. */

const ENTRIES = 12;
const ITEMS = 10;
const FIELDS = 8;
const VALUE = 80;
const BUDGET = 3600;
/** The field that names an item of a nested list: "hooks (1): `black` (exclude ...)". */
const NAMING = ['id', 'name', 'key', 'uses', 'run', 'repo'];

type Words = typeof fileOutlineWords.en;
const code = (value: string) => `\`${(value.length > VALUE ? `${value.slice(0, VALUE - 1)}…` : value).replace(/`/g, "'")}\``;
const lineCount = (text: string) => text ? text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0) : 0;
const extension = (path: string) => (path.split('/').pop() ?? path).split('.').slice(1).pop()?.toLowerCase() ?? '';

/** JSON as the same values as YAML. */
function jsonValue(value: unknown): YamlValue {
    if (Array.isArray(value)) return { kind: 'list', items: value.map(jsonValue) };
    if (value !== null && typeof value === 'object') return { kind: 'map', entries: Object.entries(value).map(([key, item]): [string, YamlValue] => [key, jsonValue(item)]) };
    return { kind: 'scalar', value: String(value) };
}

/** TOML: the keys before the first table, each `[table]` with its keys, each `[[table]]` as a list item. */
function tomlTree(text: string): YamlValue | undefined {
    const root: [string, YamlValue][] = [];
    let current = root, quoted: string | undefined;
    const value = (raw: string): YamlValue => {
        const plain = raw.replace(/\s+#[^"']*$/, '').trim();
        if (/^\[.*\]$/.test(plain)) return { kind: 'list', items: plain.slice(1, -1).split(',').map(item => item.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean).map(item => ({ kind: 'scalar', value: item })) };
        return { kind: 'scalar', value: plain.replace(/^(["'])(.*)\1$/, '$2') };
    };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (quoted) { if (line.split(quoted).length % 2 === 0) quoted = undefined; continue; }
        if (!line || line.startsWith('#')) continue;
        const table = /^(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
        if (table) {
            const entries: [string, YamlValue][] = [];
            if (table[1] === '[[') {
                const name = `[[${table[2]}]]`;
                const list = root.find(([key]) => key === name)?.[1];
                if (list?.kind === 'list') list.items.push({ kind: 'map', entries }); else root.push([name, { kind: 'list', items: [{ kind: 'map', entries }] }]);
            } else root.push([`[${table[2]}]`, { kind: 'map', entries }]);
            current = entries;
            continue;
        }
        const key = /^([A-Za-z0-9_\-."']+)\s*=\s*(.*)$/.exec(line);
        if (!key) continue;
        const delimiter = ['"""', "'''"].find(mark => line.split(mark).length === 2);
        if (delimiter) quoted = delimiter;
        current.push([key[1], delimiter ? { kind: 'scalar', value: '' } : value(key[2])]);
    }
    return root.length ? { kind: 'map', entries: root } : undefined;
}

function treeOf(path: string, text: string): YamlValue | undefined {
    switch (extension(path)) {
        case 'yml': case 'yaml': return yamlTree(text);
        case 'json': try { return jsonValue(JSON.parse(text)); } catch { return undefined; }
        case 'toml': return tomlTree(text);
        default: return undefined;
    }
}

const isMap = (value: YamlValue): value is Extract<YamlValue, { kind: 'map' }> => value.kind === 'map';
const scalarText = (value: YamlValue, words: Words) => value.kind === 'scalar' ? value.value === '' ? words.empty : /^[|>][-+0-9]*$/.test(value.value) ? words.text : code(value.value) : '';
const more = (total: number, shown: number, words: Words, separator = '; ') => total > shown ? `${separator}${words.more(total - shown)}` : '';

/** A mapping on one line: "repo `x`; rev `y`; hooks (1): `black` (exclude `z`)". */
function inlineMap(value: Extract<YamlValue, { kind: 'map' }>, depth: number, words: Words): string {
    if (!value.entries.length) return words.empty;
    return value.entries.slice(0, FIELDS).map(([key, item]) => field(key, item, depth, words)).join('; ') + more(value.entries.length, FIELDS, words);
}
function field(key: string, value: YamlValue, depth: number, words: Words): string {
    if (value.kind === 'scalar') return `${key} ${scalarText(value, words)}`;
    if (value.kind === 'map') return depth < 2 ? `${key}: ${inlineMap(value, depth + 1, words)}` : `${key} (${words.keys(value.entries.length)})`;
    if (!value.items.some(isMap)) return `${key}: ${value.items.slice(0, ITEMS).map(item => scalarText(item, words) || words.list(0)).join(', ')}${more(value.items.length, ITEMS, words, ', ')}`;
    // A single item without a naming field needs no parentheses to stand apart from the next.
    const [only] = value.items;
    if (value.items.length === 1 && isMap(only) && !namingOf(only)) return `${key} (1): ${inlineMap(only, depth + 1, words)}`;
    return `${key} (${value.items.length}): ${value.items.slice(0, ITEMS).map(item => named(item, depth + 1, words)).join('; ')}${more(value.items.length, ITEMS, words)}`;
}
const namingOf = (value: Extract<YamlValue, { kind: 'map' }>) => NAMING.map(key => value.entries.find(([name, item]) => name === key && item.kind === 'scalar')).find(Boolean);
/** An item of a nested list by its naming field, the others in parentheses. */
function named(value: YamlValue, depth: number, words: Words): string {
    if (!isMap(value)) return scalarText(value, words) || words.list(value.kind === 'list' ? value.items.length : 0);
    const naming = namingOf(value);
    if (!naming) return depth < 3 ? `(${inlineMap(value, depth, words)})` : `(${words.keys(value.entries.length)})`;
    const rest = value.entries.filter(entry => entry !== naming);
    const details = rest.length && depth < 3 ? ` (${inlineMap({ kind: 'map', entries: rest }, depth, words)})` : '';
    return `${scalarText(naming[1], words)}${details}`;
}

/** One top-level key as bullet lines. */
function entryLines(key: string, value: YamlValue, words: Words): string[] {
    if (value.kind === 'scalar') return [`- ${code(key)}: ${scalarText(value, words)}`];
    if (value.kind === 'map') return [`- ${code(key)}: ${inlineMap(value, 1, words)}`];
    if (!value.items.some(isMap)) return [`- ${code(key)} (${words.list(value.items.length)}): ${value.items.slice(0, ITEMS).map(item => scalarText(item, words) || words.list(0)).join(', ')}${more(value.items.length, ITEMS, words, ', ')}`];
    return [`- ${code(key)} (${words.list(value.items.length)}):`, ...value.items.slice(0, ITEMS).map((item, at) => `  ${at + 1}. ${isMap(item) ? inlineMap(item, 1, words) : named(item, 1, words)}`),
        ...value.items.length > ITEMS ? [`  ${words.more(value.items.length - ITEMS)}`] : []];
}

/** The outline of a YAML, JSON or TOML file in the language of the question, or undefined
 * for any other file and for text that does not parse. */
export function fileOutline(path: string, text: string, language: 'en' | 'de'): string | undefined {
    const words = fileOutlineWords[language];
    const name = code(path.split('/').pop() ?? path);
    if (isGithubWorkflow(path)) {
        const facts = workflowFactLines(path, text, language === 'de' ? germanWorkflowWords : workflowWords);
        if (facts.length) return [words.heading(name, words.kinds.workflow, lineCount(text)), facts.map(line => `- ${line}`).join('\n'), `_${words.note}_`].join('\n\n');
    }
    const tree = treeOf(path, text);
    if (!tree) return undefined;
    const kind = extension(path) === 'json' ? words.kinds.json : extension(path) === 'toml' ? words.kinds.toml : words.kinds.yaml;
    const entries: [string, YamlValue][] = tree.kind === 'map' ? tree.entries : [['', tree]];
    const lines: string[] = [];
    let used = 0, shown = 0;
    for (const [key, value] of entries.slice(0, ENTRIES)) {
        const next = key ? entryLines(key, value, words) : value.kind === 'list' ? entryLines(name.slice(1, -1), value, words) : [`- ${scalarText(value, words)}`];
        const size = next.join('\n').length;
        if (used + size > BUDGET && lines.length) { lines.push(words.cut); break; }
        lines.push(...next); used += size; shown++;
    }
    if (shown === Math.min(entries.length, ENTRIES) && entries.length > ENTRIES) lines.push(words.more(entries.length - ENTRIES));
    return [words.heading(name, kind, lineCount(text)), lines.join('\n'), `_${words.note}_`].join('\n\n');
}
