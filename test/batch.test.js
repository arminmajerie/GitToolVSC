'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('Commit & Push batches refreshes, skips outgoing previews and reports each repository', async () => {
  const queries = [];
  const pushes = [];
  const messages = [];
  let refreshes = 0;
  let conflictRepo;
  let view;
  const tree = Array.from({ length: 40 }, (_, i) => ({ repo: `E:/fixture/repo-${i}` }));
  const load = Module._load;
  Module._load = function(id, parent, main) {
    if (id === 'vscode') return { window: { setStatusBarMessage() {} } };
    if (parent?.filename.endsWith(`${path.sep}commitView.js`)) {
      if (id === './ctx') return { ctx: {
        repos: { onDidChange: () => ({}), onDidChangeMeta: () => ({}), onDidChangeCurrent: () => ({}), ready: Promise.resolve() },
        ext: { globalState: { get: () => [], update: async () => {} } }
      } };
      if (id === './git') return {
        git: async (repo, args) => {
          if (args[0] === 'ls-files') return repo === conflictRepo ? 'unmerged file' : '';
          if (args[0] === 'rev-parse') return 'main\n';
          queries.push({ repo, args }); return 'M  file.txt\0';
        },
        gitTry: async () => { throw new Error('unexpected outgoing or gitlink query'); }
      };
      if (id === './ops') return {
        currentBranch: async () => 'main',
        run: async () => { await view.refresh(); await view.refresh(); return 'committed'; },
        push: async (...args) => { pushes.push(args); await view.refresh(); }
      };
      if (id === './repos') return { samePath: (a, b) => a === b, repoName: path.basename };
      if (['./html', './resourceCommands', './uris'].includes(id)) return {};
    }
    return load.call(this, id, parent, main);
  };
  let CommitView;
  try { ({ CommitView } = require('../out/commitView.js')); } finally { Module._load = load; }
  view = new CommitView();
  view.repo = tree[0].repo;
  view.repoTree = tree;
  view.checkedRepos = new Set(tree.map(node => node.repo.toLowerCase()));
  view.refreshNow = async () => { refreshes++; };
  view.view = { webview: { postMessage: message => { messages.push(message); return Promise.resolve(true); } } };
  await view.commitChecked('same message', false, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 1, '120 mutation events must produce only one batch-end refresh');
  assert.equal(queries.length, 40, 'only one status query per staged leaf');
  assert.equal(pushes.length, 40);
  assert.ok(pushes.every(args => args[5].length === 40), 'every push reuses the batch tree');
  for (const { repo } of tree) {
    assert.ok(messages.some(m => m.type === 'batchProgress' && m.message === `Pushing ${path.basename(repo)}`));
  }
  pushes.length = 0;
  queries.length = 0;
  conflictRepo = tree[39].repo;
  await assert.rejects(view.commitChecked('next batch', false, true), /resolve merge conflicts/);
  assert.equal(pushes.length, 0, 'a blocker in the last repository must stop before any push');
  assert.equal(queries.length, 0, 'a blocker must stop before any commit status or stage operation');
});
