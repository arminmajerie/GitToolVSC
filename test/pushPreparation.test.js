'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('batch preflight recovers detached child commits without changing staged files', async () => {
  const { planPushPreparation, applyPushPreparation } = require('../out/pushPreparation.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gittool-detached-'));
  const git = async (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@local', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@local' } });
  try {
    await git(dir, ['init', '-q', '-b', 'armin-dev']);
    fs.writeFileSync(path.join(dir, 'file'), 'initial');
    await git(dir, ['add', '.']); await git(dir, ['commit', '-qm', 'initial']);
    await git(dir, ['remote', 'add', 'origin', 'ssh://example.invalid/project.git']);
    await git(dir, ['checkout', '--detach', '-q']);
    fs.writeFileSync(path.join(dir, 'file'), 'detached');
    await git(dir, ['commit', '-qam', 'detached work']);
    const detached = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    fs.writeFileSync(path.join(dir, 'file'), 'staged work');
    await git(dir, ['add', '.']);
    const index = await git(dir, ['write-tree']);
    const plan = await planPushPreparation([{ repo: dir, preferredBranch: 'armin-dev' }], git);
    assert.equal((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'HEAD', 'planning is read only');
    await git(dir, ['update-ref', 'refs/heads/armin-dev', detached]);
    await assert.rejects(applyPushPreparation(plan, git), /./, 'a concurrent branch update must not be overwritten');
    assert.equal((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'HEAD');
    await git(dir, ['update-ref', 'refs/heads/armin-dev', plan[0].previous]);
    await applyPushPreparation(plan, git);
    assert.equal((await git(dir, ['symbolic-ref', '--short', 'HEAD'])).trim(), 'armin-dev');
    assert.equal((await git(dir, ['rev-parse', 'HEAD'])).trim(), detached);
    assert.equal(await git(dir, ['write-tree']), index);

    // Divergent intended branch must stop preflight without moving any refs.
    await git(dir, ['reset', '--hard', '-q']);
    await git(dir, ['checkout', '--detach', '-q', 'HEAD~1']);
    fs.writeFileSync(path.join(dir, 'file'), 'other history');
    await git(dir, ['commit', '-qam', 'divergent']);
    await assert.rejects(planPushPreparation([{ repo: dir, preferredBranch: 'armin-dev' }], git), /cannot fast-forward/i);
    assert.equal((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'HEAD');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
