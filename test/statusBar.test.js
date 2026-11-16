const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('Git status-bar entry remains visible without a repository and is disposed', async () => {
  const items = [];
  const load = Module._load;
  Module._load = function(id, parent, main) {
    if (id === 'vscode') return { StatusBarAlignment: { Left: 1 }, window: {
      createStatusBarItem: id => {
        const item = { id, visible: false, disposed: false,
          show() { this.visible = true; }, hide() { this.visible = false; }, dispose() { this.disposed = true; } };
        items.push(item);
        return item;
      }
    } };
    if (parent?.filename.endsWith(`${path.sep}statusBar.js`)) {
      if (id === './ctx') return { ctx: { repos: {
        onDidChangeCurrent: () => ({ dispose() {} }), onDidChangeMeta: () => ({ dispose() {} })
      } } };
      if (id === './git' || id === './ops' || id === './repos') return {};
    }
    return load.call(this, id, parent, main);
  };
  let StatusBar;
  try { ({ StatusBar } = require('../out/statusBar')); } finally { Module._load = load; }
  const bar = new StatusBar();
  await bar.update();
  const git = items.find(item => item.id === 'vscgit.openGit');
  assert.equal(git.text, '$(source-control) Git');
  assert.equal(git.command, 'vscgit.openLog');
  assert.equal(git.visible, true);
  assert.equal(items.find(item => item.id === 'vscgit.branch').visible, false);
  bar.dispose();
  assert.ok(items.every(item => item.disposed));
});