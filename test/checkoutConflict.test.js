const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

let receive, close, panel, diffArgs;
const load = Module._load;
Module._load = function(id, parent, main) {
  if (id === 'vscode') return { ViewColumn: { Active: 1, Beside: 2 }, window: {
    createWebviewPanel: () => (panel = {
      webview: { onDidReceiveMessage: handler => { receive = handler; return { dispose() {} }; } },
      onDidDispose: handler => { close = handler; }, dispose: () => close()
    })
  } };
  if (id === './uris' && parent?.filename.endsWith(`${path.sep}checkoutConflict.js`)) return {
    revUri: (...args) => args, workUri: (...args) => args, openDiff: async (...args) => { diffArgs = args; }
  };
  return load.call(this, id, parent, main);
};
let checkout;
try { checkout = require('../out/checkoutConflict'); } finally { Module._load = load; }

test('checkout conflict tree preserves full paths and safely renders Git output', () => {
  const file = 'Application/source/deeply/nested/folder/a very long filename.ts';
  const message = `error: local changes would be overwritten by checkout:\n\t${file}\n\t${file}\n\t../outside\n\tC:/outside\n\t<script>.txt\nAborting`;
  const files = checkout.checkoutConflictPaths(message);
  assert.deepEqual(files, [file, '<script>.txt']);
  const html = checkout.checkoutConflictHtml('C:/repo', 'feature/<unsafe>', files, message);
  assert.ok(html.includes(file));
  assert.ok(html.includes('<summary>Application/source/deeply/nested/folder</summary>'));
  assert.ok(html.includes('feature/&lt;unsafe&gt;'));
  assert.ok(html.includes('&lt;script&gt;.txt'));
  assert.ok(!html.includes('<script>.txt'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.includes('overflow-wrap:anywhere'));
  assert.ok(checkout.checkoutConflictHtml('repo', 'main', [], 'error').includes('Git did not provide a file list'));
});

test('checkout conflict view validates diff requests and resolves only explicit actions', async () => {
  const message = 'error: would be overwritten by checkout:\n\tdir/file.ts';
  diffArgs = undefined;
  const cancelled = checkout.showCheckoutConflict('repo', 'main', message);
  await receive({ type: 'diff', index: -1 });
  assert.equal(diffArgs, undefined);
  await receive({ type: 'diff', index: 0 });
  assert.deepEqual(diffArgs, [['repo', 'dir/file.ts', 'HEAD'], ['repo', 'dir/file.ts'], 'dir/file.ts (HEAD - Local)', 2]);
  panel.dispose();
  assert.equal(await cancelled, undefined);
  for (const action of ['stash', 'discard']) {
    const result = checkout.showCheckoutConflict('repo', 'main', message);
    await receive({ type: action });
    assert.equal(await result, action);
  }
  const result = checkout.showCheckoutConflict('repo', 'main', message);
  await receive({ type: 'cancel' });
  assert.equal(await result, undefined);
});