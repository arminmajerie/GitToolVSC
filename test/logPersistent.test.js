const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

test('fresh controller restores saved UI before Git and reopens a week later with zero Git history or branch loads', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gittool-reopen-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), storage = path.join(dir, 'cache');
  await fs.mkdir(repo);
  const nativeGit = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  nativeGit(['init', '-b', 'main']); nativeGit(['config', 'user.name', 'Cache Test']); nativeGit(['config', 'user.email', 'cache@test.invalid']);
  await fs.writeFile(path.join(repo, 'file'), 'one'); nativeGit(['add', '.']); nativeGit(['commit', '-qm', 'first cached commit']);
  let gitCalls = 0;
  const logs = [];
  const git = async (_, args) => { gitCalls++; return nativeGit(args); };
  const ctx = { ext: { globalStorageUri: { fsPath: storage }, globalState: { get: () => ({}) } }, repos: {
    treeOf: async () => [{ repo }], onDidChange: () => ({}), onDidChangeMeta: () => ({}), onDidChangeCurrent: () => ({})
  } };
  const load = Module._load;
  Module._load = function(id, parent, main) {
    if (id === 'vscode') return { workspace: { workspaceFolders: [{ uri: { fsPath: repo } }], getConfiguration: () => ({ get: (_, fallback) => fallback }) } };
    if (parent?.filename.endsWith(`${path.sep}logView.js`)) {
      if (id === './ctx') return { ctx };
      if (id === './git') return { git, gitTry: git, output: () => ({ appendLine: text => logs.push(text) }) };
      if (id === './ops') return {
        refs: async () => { gitCalls++; return []; },
        currentBranch: async () => { gitCalls++; return 'main'; },
        userEmail: async () => { gitCalls++; return 'cache@test.invalid'; }, favorites: () => new Set(), showGitError: e => { throw e; }
      };
      if (id === './repos') return { repoName: path.basename, samePath: (a, b) => a === b };
      if (id === './html' || id === './uris') return {};
    }
    return load.call(this, id, parent, main);
  };
  let LogController;
  try { ({ LogController } = require('../out/logView')); } finally { Module._load = load; }
  const controller = () => {
    const result = new LogController('main', repo), messages = [];
    result.ready = true;
    const post = result.post.bind(result);
    result.post = message => { messages.push(message); post(message); };
    return { result, messages };
  };
  const first = controller();
  await first.result.refresh(true);
  assert.equal(first.messages.find(m => m.type === 'log').commits[0].s, 'first cached commit');
  assert.ok(gitCalls > 0);
  gitCalls = 0;
  const now = Date.now;
  Date.now = () => now() + 7 * 24 * 60 * 60 * 1000;
  try {
    const reopened = controller();
    await reopened.result.restoreSnapshot();
    assert.equal(gitCalls, 0, 'restoring the visible history must precede every Git command');
    assert.equal(reopened.messages.find(m => m.type === 'log').commits[0].s, 'first cached commit');
    const earlyMessages = [], lateMessages = [];
    const early = { postMessage: message => earlyMessages.push(message) }, late = { postMessage: message => lateMessages.push(message) };
    reopened.result.views.set(early, 'branches'); reopened.result.views.set(late, 'commits');
    await reopened.result.onMessage({ type: 'ready' }, early, 'branches');
    await reopened.result.restoreSnapshot();
    assert.equal(lateMessages.length, 0, 'cached data must not reach a webview before its initialization');
    await reopened.result.onMessage({ type: 'ready' }, late, 'commits');
    assert.equal(lateMessages[0].type, 'init');
    assert.ok(lateMessages.some(m => m.type === 'log'), 'a late webview gets cached history immediately after init');
    await reopened.result.refresh(true);
    assert.equal(gitCalls, 0, 'background validation of an unchanged reopened project must not launch Git');
    assert.ok(logs.some(l => l.includes('0 Git history loads')));
    await fs.writeFile(path.join(repo, 'file'), 'two'); nativeGit(['add', '.']); nativeGit(['commit', '-qm', 'new commit after cached reopen']);
    await reopened.result.refresh(true);
    assert.ok(gitCalls > 0);
    assert.equal(reopened.messages.filter(m => m.type === 'log').at(-1).commits[0].s, 'new commit after cached reopen');
  } finally { Date.now = now; }
});
