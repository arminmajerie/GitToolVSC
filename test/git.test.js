'use strict';
// Runs the parsers against real git output in a temporary repository.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const p = require('../out/parse.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscgit-test-'));
const git = (...args) => execFileSync('git', ['-c', 'core.quotepath=false', '-c', `core.hooksPath=${path.join(dir, '.git', 'no-hooks')}`, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x' } });
const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
const gitAt = (cwd, ...args) => execFileSync('git', ['-c', 'core.quotepath=false', '-c', 'advice.addEmbeddedRepo=false', ...args], {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x' }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('submodule staging is independent from the parent gitlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vscgit-submodule-test-'));
  const child = path.join(root, 'ib-server');
  fs.mkdirSync(child, { recursive: true });
  gitAt(root, 'init', '-q', '-b', 'main');
  gitAt(child, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(child, 'server.txt'), 'one\n');
  gitAt(child, 'add', '-A');
  gitAt(child, 'commit', '-q', '-m', 'initial child');
  gitAt(root, 'add', '-A', 'ib-server');
  gitAt(root, 'commit', '-q', '-m', 'record child');

  fs.writeFileSync(path.join(child, 'server.txt'), 'two\n');
  gitAt(child, 'add', 'server.txt');
  assert.match(gitAt(child, 'status', '--porcelain=v1'), /^M  server\.txt/m);
  assert.match(gitAt(root, 'status', '--porcelain=v1', '--', 'ib-server'), /[ mM] ib-server/);

  gitAt(child, 'commit', '-q', '-m', 'child change');
  gitAt(root, 'add', 'ib-server');
  assert.match(gitAt(root, 'status', '--porcelain=v1', '--', 'ib-server'), /^M  ib-server/m);
  fs.rmSync(root, { recursive: true, force: true });
});

test('real git output', () => {
  git('init', '-q', '-b', 'main');
  write('a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
  write('dir/b.txt', 'b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  git('switch', '-q', '-c', 'feature');
  write('dir/c.txt', 'c\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feature work');
  git('switch', '-q', 'main');
  write('a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n');
  git('commit', '-q', '-am', 'second');
  git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
  git('tag', 'v1');

  const commits = p.parseLog(git('log', `--format=${p.LOG_FORMAT}`, '--date-order', '--branches', '--tags', 'HEAD'));
  assert.strictEqual(commits.length, 4);
  assert.strictEqual(commits[0].s, 'merge feature');
  assert.strictEqual(commits[0].p.length, 2);
  assert.match(commits[0].refs, /HEAD -> main/);
  assert.match(commits[0].refs, /tag: v1/);

  const refs = p.parseRefs(git('for-each-ref', `--format=${p.REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'));
  assert.deepStrictEqual(refs.map(r => `${r.kind}:${r.name}`).sort(), ['local:feature', 'local:main', 'tag:v1']);
  assert.ok(refs.every(r => /^[0-9a-f]{40}$/.test(r.hash) && r.date > 0));

  // rename + modification + untracked
  git('mv', 'dir/b.txt', 'dir/renamed.txt');
  write('a.txt', 'changed\n');
  write('new/u.txt', 'u\n');
  const g = p.groupStatus(p.parseStatus(git('status', '--porcelain=v1', '-z', '--untracked-files=all')));
  assert.deepStrictEqual(g.staged, [{ status: 'R', path: 'dir/renamed.txt', oldPath: 'dir/b.txt' }]);
  assert.deepStrictEqual(g.unstaged, [{ status: 'M', path: 'a.txt' }]);
  assert.deepStrictEqual(g.untracked, [{ status: '?', path: 'new/u.txt' }]);

  const ns = p.parseNameStatus(git('diff', '--cached', '--name-status', '-z', '-M'));
  assert.deepStrictEqual(ns, [{ status: 'R', path: 'dir/renamed.txt', oldPath: 'dir/b.txt' }]);

  const blame = p.parseBlame(git('blame', '--porcelain', '--', 'dir/c.txt'));
  assert.strictEqual(blame.length, 1);
  assert.strictEqual(blame[0].author, 'Ann');
  assert.strictEqual(blame[0].summary, 'feature work');

  git('stash', 'push', '-q', '-u', '-m', 'wip');
  const stashes = p.parseStashList(git('stash', 'list', '--format=%gd%x1f%s%x1f%ct'));
  assert.strictEqual(stashes.length, 1);
  assert.strictEqual(stashes[0].ref, 'stash@{0}');
  assert.match(stashes[0].message, /wip/);
});

test('scripted interactive rebase (drop + squash with message file)', () => {
  git('stash', 'drop', '-q');
  git('checkout', '-q', '-f', 'main');
  git('switch', '-q', '-c', 'rw');
  for (const n of ['x1', 'x2', 'x3', 'x4']) {
    write(`${n}.txt`, n + '\n');
    git('add', '-A');
    git('commit', '-q', '-m', n);
  }
  const list = git('log', '--reverse', '--format=%H%x1f%s', 'HEAD~4..HEAD').trim().split('\n').map(l => l.split('\x1f'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscgit-todo-'));
  const msg = path.join(tmp, 'message');
  fs.writeFileSync(msg, 'squashed x1+x3\n');
  const posix = (p) => p.replace(/\\/g, '/');
  // squash x3 into x1, drop x2, keep x4
  const lines = [
    `pick ${list[0][0]} x1`, `fixup ${list[2][0]}`, `exec git commit --amend --only -F '${posix(msg)}'`,
    `drop ${list[1][0]} x2`, `pick ${list[3][0]} x4`
  ];
  const todo = path.join(tmp, 'todo');
  fs.writeFileSync(todo, lines.join('\n') + '\n');
  execFileSync('git', ['-c', `core.hooksPath=${path.join(dir, '.git', 'no-hooks')}`, 'rebase', '-i', '--autostash', 'HEAD~4'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_SEQUENCE_EDITOR: `cp '${posix(todo)}'`, GIT_EDITOR: 'true', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x' }
  });
  assert.deepStrictEqual(git('log', '--format=%s', '-n', '2').trim().split('\n'), ['x4', 'squashed x1+x3']);
  assert.ok(!fs.existsSync(path.join(dir, 'x2.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'x3.txt')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('squash into commit + reorder/squash todo like the rebase editor', () => {
  const env = { ...process.env, GIT_EDITOR: 'true', GIT_COMMITTER_NAME: 'Ann', GIT_COMMITTER_EMAIL: 'ann@x', GIT_AUTHOR_NAME: 'Ann', GIT_AUTHOR_EMAIL: 'ann@x' };
  const hooks = ['-c', `core.hooksPath=${path.join(dir, '.git', 'no-hooks')}`];
  const posix = (p) => p.replace(/\\/g, '/');
  const rebase = (base, lines) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscgit-todo-'));
    const todo = path.join(tmp, 'todo');
    fs.writeFileSync(todo, lines.join('\n') + '\n');
    execFileSync('git', [...hooks, 'rebase', '-i', '--autostash', base], { cwd: dir, encoding: 'utf8', env: { ...env, GIT_SEQUENCE_EDITOR: `cp '${posix(todo)}'` } });
    return tmp;
  };
  for (const n of ['y1', 'y2']) { write(`${n}.txt`, n + '\n'); git('add', '-A'); git('commit', '-q', '-m', n); }
  const [y1, y2] = git('log', '--reverse', '--format=%H', 'HEAD~2..HEAD').trim().split('\n');
  // Squash Into: staged change folded into y1 with a new message
  write('y1.txt', 'y1 changed\n');
  git('add', '-A');
  git('commit', '-q', '--fixup', y1);
  const added = git('rev-parse', 'HEAD').trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscgit-msg-'));
  fs.writeFileSync(path.join(tmp, 'm'), 'y1 renamed\n');
  rebase(`${y1}^`, [`pick ${y1}`, `fixup ${added}`, `exec git commit --amend --only -F '${posix(path.join(tmp, 'm'))}'`, `pick ${y2}`]);
  assert.deepStrictEqual(git('log', '--format=%s', '-n', '2').trim().split('\n'), ['y2', 'y1 renamed']);
  assert.strictEqual(git('show', 'HEAD~1:y1.txt').trim(), 'y1 changed');
  // Editor: move y2 before y1 and squash y1 into it (combined message, no editor)
  const [a, b] = git('log', '--reverse', '--format=%H', 'HEAD~2..HEAD').trim().split('\n');
  rebase('HEAD~2', [`pick ${b}`, `squash ${a}`]);
  assert.match(git('log', '-1', '--format=%B'), /y2[\s\S]*y1 renamed/);
  assert.strictEqual(git('show', 'HEAD:y1.txt').trim(), 'y1 changed');
  fs.rmSync(tmp, { recursive: true, force: true });
});
