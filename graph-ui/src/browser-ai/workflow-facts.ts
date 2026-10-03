import { isGithubWorkflow } from './file-kind';
import { workflowWords as words } from './strings';

/** A GitHub Actions workflow as facts counted from its keys. The small model answered
 * "Es gibt 3 Jobs" for a file with one, and read the trigger type "opened" as a branch
 * name (K12): jobs, triggers and actions are counted here, not by the model. No YAML
 * library: only the plain block layout workflows are written in. */
export interface WorkflowFacts {
    name?: string;
    triggers: { event: string; types?: string[] }[];
    jobs: { id: string; name?: string; runsOn?: string; steps: number }[];
    uses: string[];
}

/** One line of the file: where it starts, where its key starts (after "- "), key and value. */
interface Line { indent: number; keyIndent: number; dash: boolean; key?: string; value: string }

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, '$2');
/** A plain value without its trailing comment or quotes. */
const plain = (value: string) => unquote(value.replace(/\s+#.*$/, '').trim());
/** "[push, pull_request]" or "push"; "{}" and "[]" are empty. */
const flow = (value: string): string[] => {
    const list = /^\[(.*)\]$/.exec(value);
    if (!list) return value && value !== '{}' ? [value] : [];
    return list[1].split(',').map(plain).filter(Boolean);
};

function linesOf(text: string): Line[] {
    const lines: Line[] = [];
    // The lines of a block value ("key: |") are text, not keys.
    let block: number | undefined;
    for (const raw of text.split(/\r?\n/)) {
        const content = raw.trimStart();
        const indent = raw.length - content.length;
        if (block !== undefined) {
            if (!content || indent > block) continue;
            block = undefined;
        }
        if (!content || content.startsWith('#')) continue;
        const dash = /^-(?:\s|$)/.test(content);
        const item = dash ? content.slice(1).trimStart() : content;
        const keyIndent = dash ? indent + content.length - item.length : indent;
        const match = /^("[^"]*"|'[^']*'|[^\s"'#][^:#]*?)\s*:(?:\s+(.*))?$/.exec(item);
        const value = match ? match[2] ?? '' : item;
        if (/^[|>][-+0-9]*(?:\s+#.*)?$/.test(value.trim())) block = keyIndent;
        lines.push({ indent, keyIndent, dash, key: match ? unquote(match[1].trim()) : undefined, value: plain(value) });
    }
    return lines;
}

/** Every line inside the value of line `at`; a list may start at its key's own indent. */
function inside(lines: readonly Line[], at: number): number[] {
    const parent = lines[at], found: number[] = [];
    for (let index = at + 1; index < lines.length; index++) {
        const line = lines[index];
        if (line.keyIndent <= parent.keyIndent || (line.dash && line.indent < parent.keyIndent)) break;
        found.push(index);
    }
    return found;
}
/** The direct children of line `at`: the lines inside it at their smallest key indent. */
function children(lines: readonly Line[], at: number): number[] {
    const found = inside(lines, at);
    const level = Math.min(...found.map(index => lines[index].keyIndent));
    return found.filter(index => lines[index].keyIndent === level);
}

/** The top-level keys of a YAML file in block layout, each with the keys right below it or
 * the length of the list it holds (K12). Keys inside block values are text, not keys. */
export function yamlOutline(text: string): { key: string; keys: string[]; items: number }[] {
    const lines = linesOf(text);
    if (!lines.length) return [];
    const level = Math.min(...lines.map(line => line.keyIndent));
    return lines.flatMap((line, index) => {
        if (line.keyIndent !== level || line.dash || !line.key) return [];
        const below = line.value ? [] : children(lines, index);
        return [{ key: line.key, keys: below.flatMap(child => !lines[child].dash && lines[child].key ? [lines[child].key!] : []),
            items: below.filter(child => lines[child].dash).length }];
    });
}

export function workflowFacts(text: string): WorkflowFacts | undefined {
    const lines = linesOf(text);
    if (!lines.length) return undefined;
    const level = Math.min(...lines.map(line => line.keyIndent));
    const top = (key: string) => lines.findIndex(line => line.keyIndent === level && !line.dash && line.key === key);
    const on = top('on'), jobs = top('jobs'), name = top('name');
    if (on < 0 || jobs < 0) return undefined;
    const triggers = lines[on].value ? flow(lines[on].value).map(event => ({ event })) : children(lines, on).flatMap(index => {
        const event = lines[index].key ?? lines[index].value;
        const at = children(lines, index).find(child => lines[child].key === 'types');
        const types = at === undefined ? [] : lines[at].value ? flow(lines[at].value) : children(lines, at).map(child => lines[child].value).filter(Boolean);
        return event ? [{ event, ...types.length ? { types } : {} }] : [];
    });
    const jobList = children(lines, jobs).filter(index => lines[index].key).map(index => {
        const own = children(lines, index);
        const field = (key: string) => { const at = own.find(child => lines[child].key === key); return at === undefined ? undefined : lines[at].value || undefined; };
        const stepsAt = own.find(child => lines[child].key === 'steps');
        const items = stepsAt === undefined ? [] : inside(lines, stepsAt).filter(child => lines[child].dash);
        const first = Math.min(...items.map(child => lines[child].indent));
        const jobName = field('name'), runsOn = field('runs-on');
        return { id: lines[index].key!, ...jobName ? { name: jobName } : {}, ...runsOn ? { runsOn } : {}, steps: items.filter(child => lines[child].indent === first).length };
    });
    const uses = [...new Set(inside(lines, jobs).filter(index => lines[index].key === 'uses' && lines[index].value).map(index => lines[index].value))];
    return { ...name >= 0 && lines[name].value ? { name: lines[name].value } : {}, triggers, jobs: jobList, uses };
}

const quote = (value: string) => `\`${value.replace(/`/g, "'").slice(0, 120)}\``;
const LISTED = 8;

/** The facts of a workflow file as sentences; nothing for other files. */
export function workflowFactLines(path: string, text: string): string[] {
    const facts = isGithubWorkflow(path) ? workflowFacts(text) : undefined;
    if (!facts) return [];
    const lines: string[] = [];
    if (facts.name) lines.push(words.name(quote(facts.name)));
    if (facts.triggers.length) lines.push(words.triggers(facts.triggers.slice(0, LISTED).map(item => words.trigger(quote(item.event), item.types ?? []))));
    lines.push(words.jobs(facts.jobs.length, facts.jobs.slice(0, LISTED).map(job => words.job(quote(job.id), job.name?.slice(0, 120), job.runsOn?.slice(0, 60), job.steps))));
    if (facts.uses.length) lines.push(words.uses(facts.uses.slice(0, LISTED).map(quote)));
    return lines;
}
