const test = require('node:test');
const assert = require('node:assert/strict');
const { withIndexLockRetry } = require('../out/indexLockRetry');

test('a temporary index lock can outlast the old retry window and still complete', async () => {
  let calls = 0;
  const waiting = [];
  const value = await withIndexLockRetry(async () => {
    if (++calls <= 6) throw new Error("Unable to create 'index.lock': File exists");
    return 'committed';
  }, attempt => waiting.push(attempt), async () => {});
  assert.equal(value, 'committed');
  assert.equal(waiting.length, 6);
});

test('persistent lock contention reports the original failure and terminates', async () => {
  const error = new Error("Unable to create 'index.lock': File exists");
  await assert.rejects(withIndexLockRetry(async () => { throw error; }, () => {}, async () => {}), e => e === error);
});

test('unrelated Git errors are not retried', async () => {
  let calls = 0;
  await assert.rejects(withIndexLockRetry(async () => { calls++; throw new Error('permission denied'); }, () => {}, async () => {}), /permission denied/);
  assert.equal(calls, 1);
});
