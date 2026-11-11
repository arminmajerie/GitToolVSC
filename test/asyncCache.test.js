const test = require('node:test');
const assert = require('node:assert/strict');
const { AsyncCache, mapBounded } = require('../out/asyncCache');
test('simultaneous topology readers perform discovery once and invalidation reloads it', async () => {
  const cache = new AsyncCache(); let calls = 0;
  const load = async () => { calls++; return ['root', 'child']; };
  await Promise.all(Array.from({ length: 100 }, () => cache.get('workspace', load)));
  assert.equal(calls, 1);
  cache.clear(); await cache.get('workspace', load); assert.equal(calls, 2);
});
test('bounded work makes progress concurrently while preserving order', async () => {
  let active = 0, peak = 0;
  const result = await mapBounded([1,2,3,4,5,6], 3, async n => {
    active++; peak = Math.max(active, peak); await new Promise(r => setImmediate(r)); active--; return n * 2;
  });
  assert.equal(peak, 3); assert.deepEqual(result, [2,4,6,8,10,12]);
});
test('a failed discovery is not retained in the cache', async () => {
  const cache = new AsyncCache();
  await assert.rejects(cache.get('root', async () => { throw new Error('temporarily unavailable'); }));
  assert.deepEqual(await cache.get('root', async () => ['recovered']), ['recovered']);
});

test('a slow in-flight discovery never expires and starts its TTL only after completion', async () => {
  const now = Date.now;
  let time = 100, calls = 0, finish;
  Date.now = () => time;
  try {
    const cache = new AsyncCache(30);
    const read = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    const first = cache.get('workspace', read);
    time = 1000;
    const second = cache.get('workspace', read);
    assert.equal(calls, 1, 'cold scans that exceed the TTL must still share the same running work');
    finish(['root']); await Promise.all([first, second]);
    time = 1020;
    assert.deepEqual(await cache.get('workspace', read), ['root']);
    assert.equal(calls, 1);
  } finally { Date.now = now; }
});
