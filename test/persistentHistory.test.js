const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PersistentHistory, repositoryFingerprint, SnapshotStore, PersistentTopology } = require('../out/persistentHistory');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gittool-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), storage = path.join(dir, 'storage');
  await fs.mkdir(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Cache Test'); git(repo, 'config', 'user.email', 'cache@test.invalid');
  await fs.writeFile(path.join(repo, 'file'), 'one');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'one');
  return { dir, repo, storage };
}

test('reopening a week later reuses persistent history without any Git history command', async t => {
  const { repo, storage } = await fixture(t);
  let calls = 0;
  const args = ['log', '--format=%H', '-n1000'];
  const load = async () => { calls++; return git(repo, ...args); };
  const first = new PersistentHistory(storage);
  const result = await first.read(repo, args, load);
  const now = Date.now;
  Date.now = () => now() + 7 * 24 * 60 * 60 * 1000;
  try {
    const reopened = new PersistentHistory(storage);
    assert.equal(await reopened.read(repo, args, load), result);
    assert.equal(calls, 1, 'a reopened extension host must not rebuild unchanged history');
  } finally { Date.now = now; }
});

test('new commits, changed branches and packed refs invalidate history; ordinary file edits do not', async t => {
  const { repo, storage } = await fixture(t);
  let calls = 0;
  const cache = new PersistentHistory(storage), args = ['log', '--format=%H', 'HEAD'];
  const load = async () => { calls++; return git(repo, ...args); };
  const old = await cache.read(repo, args, load);
  await fs.writeFile(path.join(repo, 'file'), 'unstaged');
  assert.equal(await cache.read(repo, args, load), old);
  assert.equal(calls, 1);
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'two');
  assert.notEqual(await cache.read(repo, args, load), old);
  assert.equal(calls, 2);
  git(repo, 'checkout', '-qb', 'other');
  await cache.read(repo, args, load); assert.equal(calls, 3);
  git(repo, 'pack-refs', '--all');
  await cache.read(repo, args, load); assert.equal(calls, 4);
  await new PersistentHistory(storage).read(repo, args, load); assert.equal(calls, 4);
});

test('linked worktrees fingerprint their own HEAD and the shared refs', async t => {
  const { dir, repo } = await fixture(t);
  const worktree = path.join(dir, 'worktree');
  git(repo, 'worktree', 'add', '--detach', worktree);
  const before = await repositoryFingerprint(worktree);
  git(repo, 'tag', 'new-tag');
  assert.notEqual(await repositoryFingerprint(worktree), before);
  const sameRefs = await repositoryFingerprint(worktree);
  git(worktree, 'checkout', '-qb', 'worktree-branch');
  assert.notEqual(await repositoryFingerprint(worktree), sameRefs);
});

test('corrupt cached data is rebuilt and a failed Git load is never cached', async t => {
  const { repo, storage } = await fixture(t);
  const args = ['log', '--format=%H'];
  const cache = new PersistentHistory(storage);
  await assert.rejects(cache.read(repo, args, async () => { throw new Error('Git failed'); }));
  assert.equal(await cache.read(repo, args, async () => 'recovered'), 'recovered');
  const files = await fs.readdir(storage, { recursive: true });
  for (const file of files.filter(f => f.endsWith('.json'))) await fs.writeFile(path.join(storage, file), '{broken');
  assert.equal(await new PersistentHistory(storage).read(repo, args, async () => 'rebuilt'), 'rebuilt');
});

test('saved workspace view survives a new extension host and broken snapshots are ignored', async t => {
  const { storage } = await fixture(t);
  const state = { repo: '/repo', roots: ['/repo'], log: { type: 'log', commits: [{ h: 'abc' }] } };
  await new SnapshotStore(storage).write('workspace', state);
  assert.deepEqual(await new SnapshotStore(storage).read('workspace'), state);
  assert.equal(await new SnapshotStore(storage).read('other-workspace'), undefined);
});

test('persisted topology survives reopen, detects newly initialized submodules and manifest changes', async t => {
  const { repo, storage } = await fixture(t);
  const missing = path.join(repo, 'child');
  await fs.mkdir(missing);
  await fs.writeFile(path.join(repo, '.gitmodules'), '[submodule "child"]\n path = child\n url = invalid://fixture\n');
  const nodes = [{ repo }];
  await new PersistentTopology(storage).write(repo, nodes, [repo, missing]);
  assert.deepEqual(await new PersistentTopology(storage).read(repo), nodes);
  git(repo, 'tag', 'irrelevant-to-topology');
  assert.deepEqual(await new PersistentTopology(storage).read(repo), nodes, 'new commits and refs do not rediscover repository paths');
  git(missing, 'init', '-b', 'main');
  assert.equal(await new PersistentTopology(storage).read(repo), undefined);
  await new PersistentTopology(storage).write(repo, nodes, [repo, missing]);
  await fs.appendFile(path.join(repo, '.gitmodules'), '\n# changed configuration\n');
  assert.equal(await new PersistentTopology(storage).read(repo), undefined);
});

test('changed refs in one repository do not rebuild the other repository and concurrent readers share one miss', async t => {
  const { dir, repo, storage } = await fixture(t);
  const other = path.join(dir, 'other');
  git(dir, 'clone', '-q', repo, other);
  const cache = new PersistentHistory(storage), args = ['log', '--format=%H'];
  let first = 0, second = 0;
  const loadFirst = async () => { first++; await new Promise(r => setTimeout(r, 10)); return git(repo, ...args); };
  const loadSecond = async () => { second++; return git(other, ...args); };
  await Promise.all(Array.from({ length: 10 }, () => cache.read(repo, args, loadFirst)));
  await cache.read(other, args, loadSecond);
  assert.equal(first, 1);
  assert.equal(await cache.unchanged(repo), true);
  git(repo, 'tag', 'new-ref');
  assert.equal(await cache.unchanged(repo), false);
  await cache.read(repo, args, loadFirst); await cache.read(other, args, loadSecond);
  assert.equal(first, 2); assert.equal(second, 1);
});

test('relative date filters re-evaluate next week while ordinary history never expires by age', async t => {
  const { repo, storage } = await fixture(t);
  let calls = 0;
  const load = async () => String(++calls), args = ['log', '--since=7 days ago'];
  await new PersistentHistory(storage).read(repo, args, load);
  const now = Date.now;
  Date.now = () => now() + 7 * 86400000;
  try {
    assert.equal(await new PersistentHistory(storage).read(repo, args, load), '2');
  } finally { Date.now = now; }
});

test('Windows path casing in filesystem events does not report unchanged refs as changed', { skip: process.platform !== 'win32' }, async t => {
  const { repo, storage } = await fixture(t);
  const cache = new PersistentHistory(storage);
  await cache.read(repo, ['log', '--format=%H'], async () => git(repo, 'log', '--format=%H'));
  assert.equal(await cache.unchanged(repo.toLowerCase()), true, 'Explorer and Git may report different casing for the same Windows path');
});
