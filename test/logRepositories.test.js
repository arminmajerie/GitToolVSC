const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('log defaults to every repository, inline controls reach Git options, details retain ownership and filters preempt blocked reads', async () => {
  const tree = [{ repo: 'E:/workspace' }, { repo: 'E:/workspace/child', parent: 'E:/workspace', path: 'child' }];
  const calls = [], messages = [];
  let choice, picker;
  let slowRoot, rootEntered;
  const git = async (repo, args) => {
    calls.push({ repo, args });
    if (args[0] === 'show') return 'childhash\x1fparent\x1fAnn\x1fa@b\x1f200\x1fAnn\x1fa@b\x1f200\x1f\x1fchild message';
    if (args[0] === 'log') {
      if (repo === tree[0].repo && slowRoot) { rootEntered(); await slowRoot; }
      const child = repo.endsWith('child');
      return `${child ? 'childhash' : 'roothash'}\x1f\x1fAnn\x1fa@b\x1f${child ? 200 : 100}\x1f\x1f${child ? 'child' : 'root'}\x1e`;
    }
    return 'roothash';
  };
  const load = Module._load;
  Module._load = function(id, parent, main) {
    if (id === 'vscode') return {
      workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }) },
      window: { showQuickPick: async (items, options) => { picker = { items, options }; return choice === 'all' ? items : choice === 'none' ? [] : [items[1]]; } }
    };
    if (parent?.filename.endsWith(`${path.sep}logView.js`)) {
      if (id === './ctx') return { ctx: { repos: { treeOf: async () => tree, onDidChange: () => ({}), onDidChangeMeta: () => ({}), onDidChangeCurrent: () => ({}) } } };
      if (id === './git') return { git, gitTry: git };
      if (id === './ops') return { refs: async () => [], currentBranch: async () => 'main', favorites: () => new Set(), userEmail: async () => 'a@b' };
      if (id === './repos') return { repoName: path.basename, samePath: (a,b) => a === b };
      if (id === './html') return {};
      if (id === './uris') return { commitChanges: async () => [], EMPTY: 'empty' };
    }
    return load.call(this, id, parent, main);
  };
  let LogController;
  try { ({ LogController } = require('../out/logView')); } finally { Module._load = load; }
  const controller = new LogController('main', tree[0].repo);
  controller.ready = true;
  controller.post = msg => messages.push(msg);
  await controller.refresh(true);
  assert.equal(messages.find(m => m.type === 'log').graph, true, 'All repositories must retain the branch flow');
  assert.equal(controller.filterState().paths, 'All repositories');
  assert.deepEqual(messages.find(m => m.type === 'log').commits.map(c => c.repo), [tree[1].repo, tree[0].repo]);
  await controller.sendDetails(['childhash']);
  assert.equal(calls.find(c => c.args[0] === 'show').repo, tree[1].repo);
  await controller.refresh(true);
  assert.equal(calls.filter(c => c.args[0] === 'log').length, 4, 'this storage-disabled mock reads fresh data; durable reuse is exercised with real repositories in logPersistent.test.js');

  choice = 'one';
  await controller.pick(tree[0].repo, 'paths');
  assert.equal(picker.options.canPickMany, true);
  assert.ok(picker.items.every(item => item.picked), 'all roots checked on first open');
  await controller.refresh(true);
  assert.equal(messages.filter(m => m.type === 'log').at(-1).commits.length, 1);
  choice = 'none'; await controller.pick(tree[0].repo, 'paths'); await controller.refresh(true);
  assert.equal(messages.filter(m => m.type === 'log').at(-1).commits.length, 0);
  choice = 'all'; await controller.pick(tree[0].repo, 'paths'); await controller.refresh(true);
  assert.equal(controller.filterState().paths, 'All repositories');
  assert.equal(messages.filter(m => m.type === 'log').at(-1).commits.length, 2);

  const menuMessages = [];
  const webview = { postMessage: msg => menuMessages.push(msg) };
  await controller.onMessage({ type: 'menu', what: 'paths' }, webview, 'commits');
  assert.equal(menuMessages.at(-1).type, 'menuData');
  assert.ok(menuMessages.at(-1).items.every(i => i.checked));
  await controller.onMessage({ type: 'setLogOptions', order: 'topo', firstParent: true, noMerges: true, graphLayout: 'lanes' }, webview, 'commits');
  assert.ok(calls.filter(c => c.args[0] === 'log').at(-1).args.includes('--topo-order'));
  assert.ok(calls.filter(c => c.args[0] === 'log').at(-1).args.includes('--first-parent'));
  assert.ok(calls.filter(c => c.args[0] === 'log').at(-1).args.includes('--no-merges'));
  assert.equal(messages.filter(m => m.type === 'log').at(-1).graphLayout, 'lanes');
  await controller.onMessage({ type: 'setRepositories', repositories: [tree[1].repo, '/outside'] }, webview, 'commits');
  assert.deepEqual(messages.filter(m => m.type === 'log').at(-1).commits.map(c => c.repo), [tree[1].repo]);
  await controller.onMessage({ type: 'focusRepository', repo: tree[0].repo }, webview, 'commits');
  assert.deepEqual(messages.filter(m => m.type === 'log').at(-1).commits.map(c => c.repo), [tree[0].repo]);
  await controller.onMessage({ type: 'clear', what: 'paths' }, webview, 'commits');
  assert.equal(messages.filter(m => m.type === 'log').at(-1).commits.length, 2);
  await controller.onMessage({ type: 'branchFilter', ref: 'armin-dev' }, webview, 'commits');
  assert.ok(calls.filter(c => c.args[0] === 'log').at(-1).args.includes('armin-dev'));
  assert.equal(controller.filterState().branch, 'armin-dev');
  let releaseRoot, entered;
  slowRoot = new Promise(resolve => { releaseRoot = resolve; });
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  rootEntered = entered;
  const background = controller.refresh(true);
  await enteredPromise;
  try {
    const changed = controller.onMessage({ type: 'setRepositories', repositories: [tree[1].repo] }, webview, 'commits');
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('repository selection waits behind unrelated background Git work')), 200))]);
    assert.deepEqual(messages.filter(m => m.type === 'log').at(-1).commits.map(c => c.repo), [tree[1].repo]);
  } finally { releaseRoot(); slowRoot = undefined; await background; }
  assert.deepEqual(messages.filter(m => m.type === 'log').at(-1).commits.map(c => c.repo), [tree[1].repo], 'a late background result must not overwrite the selected repository');
});
