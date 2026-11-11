'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

test('push checks only descendants and accepts remotely published gitlinks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gittool-push-'));
  const child = path.join(root, 'child');
  const sibling = path.join(root, 'sibling');
  const remote = path.join(root, 'remote.git');
  const calls = [];
  let treeScans = 0;
  const git = async (cwd, args) => {
    calls.push({ cwd, args });
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'
    } });
  };
  const gitTry = async (cwd, args) => { try { return await git(cwd, args); } catch { return undefined; } };
  for (const dir of [child, sibling]) {
    fs.mkdirSync(dir);
    await git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-qm', 'initial']);
  }
  await git(root, ['init', '--bare', remote]);
  await git(child, ['remote', 'add', 'origin', remote]);
  await git(child, ['push', '-u', 'origin', 'main']);
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['-c', 'advice.addEmbeddedRepo=false', 'add', 'child', 'sibling']);
  await git(root, ['commit', '-qm', 'children']);
  const tree = [{ repo: root }, { repo: child, parent: root, path: 'child' }, { repo: sibling, parent: root, path: 'sibling' }];
  const load = Module._load;
  Module._load = function(id, parent, main) {
    if (id === 'vscode') return { ProgressLocation: {}, window: { setStatusBarMessage() {}, withProgress: async (_, task) => task() } };
    if (parent?.filename.endsWith(`${path.sep}ops.js`)) {
      if (id === './git') return { git, gitTry, gitOk: async (cwd, args) => (await gitTry(cwd, args)) !== undefined };
      if (id === './ctx') return { ctx: { repos: { treeOf: async () => { treeScans++; return tree; }, changed() {} } } };
      if (id === './repos') return { repoName: path.basename };
      if (id === './uris') return {};
    }
    return load.call(this, id, parent, main);
  };
  const ops = require('../out/ops.js');
  Module._load = load;
  try {
    calls.length = 0;
    await ops.push(child, undefined, false, false, false);
    assert.equal(calls.some(c => c.cwd === sibling), false, 'a sibling must not block a child push');
    assert.equal(calls.some(c => c.args.includes('--remotes') && c.args[0] === 'merge-base'), false);
    treeScans = 0;
    calls.length = 0;
    await ops.push(child, undefined, false, false, false, tree);
    assert.equal(treeScans, 0, 'a batch push must reuse its discovered repository tree');
    assert.equal(calls.some(c => c.args[0] === 'log'), false, 'an unconfirmed batch push must not load commit previews');
    // The parent must still reject the genuinely unpublished sibling.
    await assert.rejects(ops.push(root, undefined, false, false, false), /unpublished submodules: sibling$/);
  } finally {
    Module._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
