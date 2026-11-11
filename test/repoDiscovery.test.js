const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const load = Module._load;
Module._load = function(id, parent, main) { return id === 'vscode' ? {} : load.call(this, id, parent, main); };
let Repos;
try { ({ Repos } = require('../out/repos')); } finally { Module._load = load; }

test('cold submodule discovery overlaps reads with a global bound and preserves depth-first repository order', async () => {
  const repos = Object.create(Repos.prototype);
  const root = path.resolve('/fixture');
  const children = Array.from({ length: 12 }, (_, i) => `child${i}`);
  let active = 0, peak = 0;
  repos.graphRoot = async () => root;
  repos.rootOf = async dir => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 3)); active--; return dir;
  };
  repos.moduleConfig = async dir => dir === root
    ? children.map(child => `submodule.${child}.path ${child}`).join('\n')
    : dir === path.join(root, 'child0') ? 'submodule.nested.path nested' : '';
  const rows = await repos.discoverTree(root);
  assert.ok(peak > 1, 'one-at-a-time discovery is the reported cold-load bottleneck');
  assert.ok(peak <= 4, 'large workspaces must not spawn unbounded Git processes');
  assert.deepEqual(rows.map(n => path.relative(root, n.repo)), ['', 'child0', path.join('child0', 'nested'), ...children.slice(1)]);
  assert.equal(rows[2].parent, path.join(root, 'child0'));
});
