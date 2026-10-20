import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from './runtime.mjs';

const meta = { file_path: 'src/app.ts', source_hash: 'hash-of-original-bytes', symbol: 'copy', function_id: 'f:1', line: 1 };
describe('observed JavaScript value identities', () => {
    it('keeps equal primitive values distinct and binds only explicit copies', async () => {
        const events = [], runtime = createRuntime({ sink: batch => events.push(...batch) });
        const frame = runtime.frame(meta, []);
        frame.observe('a', 2, 7, [], 'value'); frame.assign('wa', 2, 'binding:a', 'a', 7, 'a');
        frame.observe('b', 3, 7, [], 'value'); frame.assign('wb', 3, 'binding:b', 'b', 7, 'b');
        frame.read('ra', 4, 'binding:a', 7, 'a'); frame.assign('copy', 4, 'binding:c', 'ra', 7, 'c');
        await runtime.flush();
        const a = events.find(event => event.access_path === 'a' && event.operation === 'copy');
        const b = events.find(event => event.access_path === 'b' && event.operation === 'copy');
        const copy = events.find(event => event.access_path === 'c');
        assert.notEqual(a.value_id, b.value_id);
        assert.equal(events.find(event => event.value_id === copy.inputs[0]).inputs[0], a.value_id);
        assert(events.every(event => !('preview' in event)));
    });
    it('links arguments and returns only for the actual registered function invocation', async () => {
        const events = [], runtime = createRuntime({ sink: batch => events.push(...batch) });
        function actual(input) {
            const frame = runtime.frame(meta, [['param:0', 'input', input]]);
            frame.read('read', 2, 'param:0', input, 'input');
            return frame.returning('ret', 2, input, 'read');
        }
        runtime.track(actual, 'f:1');
        const caller = runtime.frame({ ...meta, function_id: 'caller' }, []);
        caller.observe('arg', 5, 3, [], 'value');
        assert.equal(caller.invoke('call', 5, actual, [3], ['arg']), 3);
        assert.equal(caller.invoke('opaque', 6, value => value, [3], ['arg']), 3);
        await runtime.flush();
        const parameter = events.find(event => event.access_path === 'input' && event.operation === 'value');
        const returning = events.find(event => event.operation === 'return');
        const calls = events.filter(event => event.operation === 'call');
        assert(parameter.inputs.length === 1);
        assert.deepEqual(calls[0].inputs, [returning.value_id]);
        assert.deepEqual(calls[1].inputs, []);
        assert(events.some(event => event.operation === 'gap'));
    });
    it('never inspects objects for opt-in previews and preserves thrown application errors', async () => {
        const events = [], runtime = createRuntime({ sink: batch => events.push(...batch), valuesEnabled: true, allowedFields: ['test.email'] });
        const frame = runtime.frame(meta, []);
        let inspected = 0;
        const object = { toJSON() { inspected++; throw Error('Do not serialize app objects'); } };
        frame.observe('one', 2, object, [], 'value', 'test.email');
        frame.observe('two', 3, 'sample@example.test', [], 'value', 'test.email');
        frame.observe('private', 4, 'hidden', [], 'value', 'private.email');
        const original = new Error('application failure');
        assert.throws(() => frame.invoke('bad', 5, () => { throw original; }, [], []), error => error === original);
        await runtime.flush();
        assert.equal(inspected, 0);
        assert.equal(events.filter(event => 'preview' in event).length, 1);
        assert.equal(events.find(event => 'preview' in event).preview, 'sample@example.test');
        assert(!JSON.stringify(events).includes('hidden'));
    });
});
