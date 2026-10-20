import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { instrument } from './instrument.mjs';
import { configure, flush } from './runtime.mjs';
const runtimeUrl = new URL('./runtime.mjs', import.meta.url).href;

async function execute(source, calls = '') {
    const events = [];
    configure({ sink: batch => events.push(...batch), producerId: `test-${Math.random()}` });
    const output = instrument(source, { filePath: 'src/app.ts', runtimeUrl });
    const code = output.code + '\n' + calls;
    const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`);
    await flush();
    return { events, module, output };
}
describe('scoped AST probes', () => {
    it('observes real scalar assignments, transformations and call-return flow without changing results', async () => {
        const source = `export function decorate(input: string) { const output = input + "!"; return output; }
export function run(input: string) { const result = decorate(input); return result; }`;
        const { events, module } = await execute(source, 'export const result = run("same");');
        assert.equal(module.result, 'same!');
        assert(events.some(event => event.operation === 'transform' && event.inputs.length > 0));
        assert(events.some(event => event.operation === 'call' && event.inputs.length > 0));
        assert(events.every(event => event.source.source_hash === createHash('sha256').update(source).digest('hex')));
        assert(events.every(event => !('preview' in event)));
    });
    it('evaluates getters and opaque methods once and reports the untracked heap boundary', async () => {
        const source = `export function read(input: {email: string}) { const email = input.email; return email; }`;
        const { events, module } = await execute(source, `let reads=0; const input={get email(){ reads++; return "a"; }};
export const result=read(input); export const getterCount=reads;`);
        assert.equal(module.result, 'a'); assert.equal(module.getterCount, 1);
        assert(events.some(event => event.operation === 'gap'));
        assert(events.some(event => event.access_path === 'input.email' && event.operation === 'field'));
    });
    it('keeps block-shadowed bindings and separate invocations distinct', async () => {
        const source = `export function run(input: number) { let result=input; { let result=7; result=result+1; } return result; }`;
        const { events, module } = await execute(source, 'export const result=[run(2),run(3)];');
        assert.deepEqual(module.result, [2, 3]);
        const returns = events.filter(event => event.operation === 'return');
        assert.equal(returns.length, 2);
        assert.notEqual(returns[0].invocation_id, returns[1].invocation_id);
        assert.notEqual(returns[0].inputs[0], returns[1].inputs[0]);
    });
    it('preserves async functions and reports their unsupported suspended flow explicitly', async () => {
        const source = `export async function run(input: number) { const result = await Promise.resolve(input); return result; }`;
        const { events, module } = await execute(source, 'export const result=await run(5);');
        assert.equal(module.result, 5);
        assert(events.some(event => event.operation === 'gap' && /suspend|async/i.test(event.detail)));
        assert(!events.some(event => event.operation === 'call' && event.inputs.length > 0));
    });
    it('preserves inferred arrow names and their lexical this while observing calls', async () => {
        const source = `export const decorate = (input: string) => input + "!";
export function run(input: string) { return decorate(input); }`;
        const { events, module } = await execute(source, 'export const result=run("a"); export const functionName=decorate.name;');
        assert.equal(module.result, 'a!'); assert.equal(module.functionName, 'decorate');
        assert(events.some(event => event.operation === 'call' && event.inputs.length === 1));
    });
    it('does not reuse a stale caller binding after a callback mutates a closure', async () => {
        const source = `export function run() { let value=1; function change(){ value=2; } change(); return value; }`;
        const { events, module } = await execute(source, 'export const result=run();');
        assert.equal(module.result, 2);
        const returned = events.find(event => event.operation === 'return');
        const read = events.find(event => event.value_id === returned.inputs[0]);
        assert.deepEqual(read.inputs, []);
    });
    it('invalidates scalar versions when object coercion can mutate a captured binding', async () => {
        const source = `export function run(input: number) {
 const box={valueOf(){value=0;return 1;}}; let value=input; const output=value+box; return value; }`;
        const { events, module } = await execute(source, 'export const result=run(8);');
        assert.equal(module.result, 0);
        const returned = events.find(event => event.operation === 'return');
        const read = events.find(event => event.value_id === returned.inputs[0]);
        assert.deepEqual(read.inputs, []);
        assert(events.some(event => event.operation === 'gap' && /primitive|coercion/.test(event.detail)));
    });
});
