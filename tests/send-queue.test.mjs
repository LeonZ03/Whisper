import test from 'node:test';
import assert from 'node:assert/strict';
import { SendQueue } from '../src/send-queue.mjs';
const envelope = id => ({ id, ciphertext: 'encrypted-fixture', expiresAt: Date.now() + 60000 });
test('queue serializes encrypted uploads, keeps later messages after failure, and never retries', async () => {
  const gates = [], calls = [], states = [];
  const q = new SendQueue({ send: message => { calls.push(message.id); return new Promise((resolve, reject) => gates.push({ resolve, reject })); }, onState: (m, _, state) => states.push([m.id, state]) });
  const first = q.enqueue(envelope('one'), {}).catch(error => error.message), second = q.enqueue(envelope('two'), {});
  await Promise.resolve(); assert.deepEqual(calls, ['one']); assert.equal(q.size, 2);
  gates[0].reject(Error('unknown')); assert.equal(await first, 'unknown');
  assert.deepEqual(calls, ['one', 'two']); gates[1].resolve(); assert.equal(await second, 'two');
  assert.equal(q.size, 0); assert.deepEqual(states, [['one','queued'],['two','queued'],['one','sending'],['one','failed'],['two','sending'],['two','sent']]);
});
test('queue bounds pending messages, cancels unsent items and suppresses late success', async () => {
  let complete; const calls = [];
  const q = new SendQueue({ limit: 2, send: m => { calls.push(m.id); return new Promise(resolve => { complete = resolve; }); } });
  const first = q.enqueue(envelope('one'), {}).catch(error => error.name), second = q.enqueue(envelope('two'), {}).catch(error => error.name);
  assert.throws(() => q.enqueue(envelope('overflow'), {}), /队列已满/);
  await Promise.resolve(); q.cancel(); assert.equal(await second, 'AbortError'); complete(); assert.equal(await first, 'AbortError');
  assert.deepEqual(calls, ['one']); assert.equal(q.size, 0);
});
test('queued messages keep their absolute expiry and are rejected without upload after expiry', async () => {
  let calls = 0; const q = new SendQueue({ send: () => { calls++; } });
  await assert.rejects(q.enqueue({ ...envelope('expired'), expiresAt: Date.now() - 1 }, {}), error => error.notSent === true);
  assert.equal(calls, 0);
});
