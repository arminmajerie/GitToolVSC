'use strict';
const test = require('node:test');
const assert = require('node:assert');
const p = require('../out/parse.js');
const { groupTargetPaths, repositoryScopes, dependencyOrder } = require('../out/targetGrouping.js');
const { computeGraph } = require('../media/graph.js');

test('parseLog splits records and parents', () => {
  const out = 'a1\x1fb1 c1\x1fAnn\x1fann@x\x1f100\x1fHEAD -> main, origin/main\x1fMerge\x1e\nb1\x1f\x1fBob\x1fbob@x\x1f90\x1f\x1fInit\x1e\n';
  const c = p.parseLog(out);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c[0].p, ['b1', 'c1']);
  assert.strictEqual(c[0].refs, 'HEAD -> main, origin/main');
  assert.deepStrictEqual(c[1].p, []);
  assert.strictEqual(c[1].s, 'Init');
});

test('Explorer selections are grouped by repository', () => {
  const groups = groupTargetPaths([
    { repo: 'E:/repo-a', rel: 'one', isDir: true },
    { repo: 'E:/repo-b', rel: 'two', isDir: true },
    { repo: 'E:/repo-a', rel: 'three', isDir: false }
  ]);
  assert.deepStrictEqual(groups, [
    { repo: 'E:/repo-a', rels: ['one', 'three'], isDir: true },
    { repo: 'E:/repo-b', rels: ['two'], isDir: true }
  ]);
});

test('Adding a superproject scope also stages each initialized submodule scope', () => {
  const scopes = repositoryScopes('E:/workspace', [
    { repo: 'E:/workspace' },
    { repo: 'E:/workspace/component-api' },
    { repo: 'E:/workspace/component-api/nested' }
  ], ['.']);
  assert.deepStrictEqual([...scopes.entries()], [
    ['E:/workspace', ['']],
    ['E:/workspace/component-api', ['']],
    ['E:/workspace/component-api/nested', ['']]
  ]);
});

test('checked repository operations run deepest submodules first and skip unchecked repos', () => {
  const nodes = [
    { repo: 'root', parent: undefined },
    { repo: 'root/security-patches', parent: 'root' },
    { repo: 'root/security-patches/winauth', parent: 'root/security-patches' },
    { repo: 'root/ib-server', parent: 'root' }
  ];
  assert.deepStrictEqual(dependencyOrder(nodes, ['root', 'root/security-patches/winauth', 'root/ib-server']), [
    'root/security-patches/winauth', 'root/ib-server', 'root'
  ]);
});

test('parseNameStatus handles renames', () => {
  const r = p.parseNameStatus('M\0a.txt\0R087\0old/b.txt\0new/b.txt\0D\0c.txt\0');
  assert.deepStrictEqual(r, [
    { status: 'M', path: 'a.txt' },
    { status: 'R', path: 'new/b.txt', oldPath: 'old/b.txt' },
    { status: 'D', path: 'c.txt' }
  ]);
});

test('parseStatus + groupStatus', () => {
  const out = 'M  staged.txt\0 M work.txt\0MM both.txt\0R  new.txt\0old.txt\0?? new/u.txt\0UU conflict.txt\0';
  const g = p.groupStatus(p.parseStatus(out));
  assert.deepStrictEqual(g.staged.map(f => f.path), ['staged.txt', 'both.txt', 'new.txt']);
  assert.strictEqual(g.staged[2].oldPath, 'old.txt');
  assert.deepStrictEqual(g.unstaged.map(f => f.path), ['work.txt', 'both.txt']);
  assert.deepStrictEqual(g.untracked.map(f => f.path), ['new/u.txt']);
  assert.deepStrictEqual(g.conflicts.map(f => f.path), ['conflict.txt']);
});

test('parseRefs skips remote HEAD', () => {
  const out = [
    'refs/heads/main\0aaa\0origin/main\0[ahead 1]\x00100',
    'refs/remotes/origin/HEAD\0aaa\0\0\x00100',
    'refs/remotes/origin/main\0bbb\0\0\x0090',
    'refs/tags/v1\0ccc\0\0\x0080'
  ].join('\n');
  const r = p.parseRefs(out);
  assert.deepStrictEqual(r.map(x => `${x.kind}:${x.name}`), ['local:main', 'remote:origin/main', 'tag:v1']);
  assert.strictEqual(r[0].track, '[ahead 1]');
});

test('parseBlame maps lines to commits', () => {
  const h1 = '1'.repeat(40);
  const h2 = '2'.repeat(40);
  const out = [
    `${h1} 1 1 2`, 'author Ann', 'author-mail <ann@x>', 'author-time 100', 'summary First', 'filename f', '\tline1',
    `${h1} 2 2`, '\tline2',
    `${h2} 3 3 1`, 'author Bob', 'author-mail <bob@x>', 'author-time 200', 'summary Second', 'filename f', '\tline3', ''
  ].join('\n');
  const b = p.parseBlame(out);
  assert.strictEqual(b.length, 3);
  assert.strictEqual(b[0].author, 'Ann');
  assert.strictEqual(b[1].hash, h1);
  assert.strictEqual(b[2].summary, 'Second');
  assert.strictEqual(b[2].authorMail, 'bob@x');
});

test('escapeBre and repoFromUrl', () => {
  assert.strictEqual(p.escapeBre('a.b*[c]'), 'a\\.b\\*\\[c\\]');
  assert.strictEqual(p.repoFromUrl('https://git.example.com/team/_git/demo-service'), 'demo-service');
  assert.strictEqual(p.repoFromUrl('git@github.com:org/repo.git'), 'repo');
});

test('computeGraph: linear history stays in one lane', () => {
  const rows = computeGraph([{ h: 'c', p: ['b'] }, { h: 'b', p: ['a'] }, { h: 'a', p: [] }]);
  assert.deepStrictEqual(rows.map(r => r.col), [0, 0, 0]);
  assert.ok(rows.every(r => r.width === 1));
});

test('computeGraph: merge opens and closes a second lane', () => {
  // m merges x into b; x and b both come from a.
  const rows = computeGraph([
    { h: 'm', p: ['b', 'x'] },
    { h: 'x', p: ['a'] },
    { h: 'b', p: ['a'] },
    { h: 'a', p: [] }
  ]);
  assert.strictEqual(rows[0].col, 0);
  assert.strictEqual(rows[1].col, 1);
  assert.strictEqual(rows[2].col, 0);
  assert.strictEqual(rows[3].col, 0);
  // a closes lane 1 (converging top segment from lane 1 to lane 0)
  assert.ok(rows[3].segs.some(s => s.kind === 'top' && s.from === 1 && s.to === 0));
});
