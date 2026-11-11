import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, gitOk, gitTry } from './git';
import * as ops from './ops';
import { nameStatus, openChanges, revUri, short } from './uris';

// Operations on one or more commits selected in the log. `hashes` are in log order (newest first).

export interface Plan {
  base: string | undefined;
  list: { hash: string; subject: string }[];
}

async function oldestFirst(repo: string, hashes: string[]): Promise<string[]> {
  const counts = await Promise.all(hashes.map(async h => Number((await git(repo, ['rev-list', '--count', h])).trim())));
  return hashes.map((h, i) => ({ h, c: counts[i] })).sort((a, b) => a.c - b.c).map(x => x.h);
}

/** Validates that the commits can be rewritten and returns the todo range (base..HEAD). */
export async function plan(repo: string, oldest: string, selected: string[]): Promise<Plan> {
  const cur = await ops.currentBranch(repo);
  if (!cur) throw new Error('HEAD is detached. Check out a branch first.');
  for (const h of selected) {
    if (!(await gitOk(repo, ['merge-base', '--is-ancestor', h, 'HEAD']))) throw new Error(`${short(h)} is not on the current branch "${cur}".`);
  }
  const base = (await gitTry(repo, ['rev-parse', '--verify', '--quiet', `${oldest}^`]))?.trim() || undefined;
  const range = base ? `${base}..HEAD` : 'HEAD';
  if ((await git(repo, ['rev-list', '--merges', range])).trim()) {
    throw new Error('There are merge commits between the selected commits and HEAD; history with merges cannot be rewritten here.');
  }
  const list = (await git(repo, ['log', '--reverse', '--format=%H%x1f%s', range])).split('\n').filter(Boolean).map(l => {
    const [hash, subject] = l.split('\x1f');
    return { hash, subject };
  });
  return { base, list };
}

export async function confirmRewrite(repo: string, oldest: string, title: string, detail: string): Promise<boolean> {
  const up = (await gitTry(repo, ['rev-parse', '--verify', '--quiet', '@{upstream}']))?.trim();
  const pushed = !!up && (await gitOk(repo, ['merge-base', '--is-ancestor', oldest, up]));
  const c = await vscode.window.showWarningMessage(
    title,
    { modal: true, detail: detail + (pushed ? '\n\nThese commits are already pushed; the branch will need a force push afterwards.' : '') },
    'Continue'
  );
  return !!c;
}

export const posix = (p: string) => p.replace(/\\/g, '/');

/** Runs `git rebase -i` with a prepared todo list instead of an editor. */
export async function runTodo(repo: string, base: string | undefined, lines: string[], tmp: string, title: string): Promise<void> {
  const todo = path.join(tmp, 'todo');
  fs.writeFileSync(todo, lines.join('\n') + '\n', 'utf8');
  await ops.run(repo, ['rebase', '-i', '--autostash', ...(base ? [base] : ['--root'])], {
    title,
    env: { GIT_SEQUENCE_EDITOR: `cp '${posix(todo)}'` }
  });
  const stillRebasing = await gitTry(repo, ['rev-parse', '--git-path', 'rebase-merge']);
  // Keep the message files while a stopped rebase may still need them.
  if (!stillRebasing || !fs.existsSync(path.resolve(repo, stillRebasing.trim()))) fs.rmSync(tmp, { recursive: true, force: true });
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vscgit-'));
}

function subjectList(hashes: string[], list: Plan['list']): string {
  const m = new Map(list.map(c => [c.hash, c.subject]));
  return hashes.map(h => `${short(h)}  ${m.get(h) ?? ''}`).join('\n');
}

export async function dropCommits(repo: string, hashes: string[]): Promise<void> {
  const sorted = await oldestFirst(repo, hashes);
  const p = await plan(repo, sorted[0], sorted);
  if (!(await confirmRewrite(repo, sorted[0], `Drop ${hashes.length} commit(s)?`, subjectList(sorted, p.list)))) return;
  const drop = new Set(sorted);
  await runTodo(repo, p.base, p.list.map(c => `${drop.has(c.hash) ? 'drop' : 'pick'} ${c.hash} ${c.subject}`), tempDir(), 'Dropping commits');
}

export async function squashCommits(repo: string, hashes: string[]): Promise<void> {
  if (hashes.length < 2) return;
  const sorted = await oldestFirst(repo, hashes);
  const p = await plan(repo, sorted[0], sorted);
  const subjects = sorted.map(h => p.list.find(c => c.hash === h)?.subject ?? '');
  const msg = await vscode.window.showInputBox({ title: `Squash ${sorted.length} commits`, prompt: 'Commit message of the squashed commit', value: subjects.join('; ') });
  if (!msg?.trim()) return;
  if (!(await confirmRewrite(repo, sorted[0], `Squash ${sorted.length} commits into one?`, subjectList(sorted, p.list)))) return;
  const tmp = tempDir();
  const msgFile = path.join(tmp, 'message');
  fs.writeFileSync(msgFile, msg.trim() + '\n', 'utf8');
  const others = new Set(sorted.slice(1));
  const lines: string[] = [];
  for (const c of p.list) {
    if (others.has(c.hash)) continue;
    lines.push(`pick ${c.hash} ${c.subject}`);
    if (c.hash === sorted[0]) {
      for (const h of sorted.slice(1)) lines.push(`fixup ${h}`);
      lines.push(`exec git commit --amend --only -F '${posix(msgFile)}'`);
    }
  }
  await runTodo(repo, p.base, lines, tmp, 'Squashing commits');
}

export async function editMessage(repo: string, hash: string): Promise<void> {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  if (hash === head) return ops.editHeadMessage(repo);
  const old = (await git(repo, ['log', '-1', '--format=%B', hash])).replace(/\s+$/, '');
  const [subject, ...rest] = old.split('\n');
  const s = await vscode.window.showInputBox({ title: `Edit Commit Message of ${short(hash)}`, value: subject });
  if (!s?.trim() || s === subject) return;
  const p = await plan(repo, hash, [hash]);
  if (!(await confirmRewrite(repo, hash, `Reword ${short(hash)}?`, `${subject}\n\u2192 ${s}`))) return;
  const tmp = tempDir();
  const msgFile = path.join(tmp, 'message');
  fs.writeFileSync(msgFile, [s, ...rest].join('\n') + '\n', 'utf8');
  const lines: string[] = [];
  for (const c of p.list) {
    lines.push(`pick ${c.hash} ${c.subject}`);
    if (c.hash === hash) lines.push(`exec git commit --amend --only -F '${posix(msgFile)}'`);
  }
  await runTodo(repo, p.base, lines, tmp, 'Editing commit message');
}

/** "Fixup...": commits the staged changes as a fixup of the commit and autosquashes it. */
export async function fixup(repo: string, hash: string): Promise<void> {
  if (!(await gitTry(repo, ['diff', '--cached', '--name-only']))?.trim()) {
    return void vscode.window.showWarningMessage('Stage the changes that should be folded into this commit first.');
  }
  const p = await plan(repo, hash, [hash]);
  if (!(await confirmRewrite(repo, hash, `Fold the staged changes into ${short(hash)}?`, p.list.find(c => c.hash === hash)?.subject ?? ''))) return;
  if ((await ops.run(repo, ['commit', '--fixup', hash])) === undefined) return;
  await ops.run(repo, ['rebase', '-i', '--autosquash', '--autostash', ...(p.base ? [p.base] : ['--root'])], {
    title: 'Fixup',
    env: { GIT_SEQUENCE_EDITOR: 'true' }
  });
}

/** "Squash Into...": folds the staged changes into the commit and lets the user edit its message. */
export async function squashInto(repo: string, hash: string): Promise<void> {
  if (!(await gitTry(repo, ['diff', '--cached', '--name-only']))?.trim()) {
    return void vscode.window.showWarningMessage('Stage the changes that should be squashed into this commit first.');
  }
  const p = await plan(repo, hash, [hash]);
  const old = (await git(repo, ['log', '-1', '--format=%B', hash])).replace(/\s+$/, '');
  const [subject, ...rest] = old.split('\n');
  const s = await vscode.window.showInputBox({ title: `Squash staged changes into ${short(hash)}`, prompt: 'Commit message', value: subject });
  if (!s?.trim()) return;
  if (!(await confirmRewrite(repo, hash, `Squash the staged changes into ${short(hash)}?`, `${subject}${s !== subject ? `\n\u2192 ${s}` : ''}`))) return;
  if ((await ops.run(repo, ['commit', '--fixup', hash])) === undefined) return;
  const added = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const tmp = tempDir();
  const msgFile = path.join(tmp, 'message');
  fs.writeFileSync(msgFile, [s, ...rest].join('\n') + '\n', 'utf8');
  const lines: string[] = [];
  for (const c of p.list) {
    lines.push(`pick ${c.hash} ${c.subject}`);
    if (c.hash === hash) lines.push(`fixup ${added}`, `exec git commit --amend --only -F '${posix(msgFile)}'`);
  }
  await runTodo(repo, p.base, lines, tmp, 'Squashing into commit');
}

export async function pushUpTo(repo: string, hash: string): Promise<void> {
  const cur = await ops.currentBranch(repo);
  if (!cur) return void vscode.window.showErrorMessage('HEAD is detached.');
  const up = (await gitTry(repo, ['rev-parse', '--abbrev-ref', `${cur}@{upstream}`]))?.trim();
  const remotes = await ops.remotes(repo);
  let remote = up ? remotes.filter(r => up.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] : undefined;
  let branch = up && remote ? up.slice(remote.length + 1) : cur;
  if (!remote) {
    remote = remotes.length === 1 ? remotes[0] : await vscode.window.showQuickPick(remotes, { title: 'Push to remote' });
    if (!remote) return;
    branch = cur;
  }
  const range = up ? `${up}..${hash}` : `${hash}`;
  const commits = (await git(repo, ['log', '--format=%h  %s', '-n', '30', range, ...(up ? [] : ['--not', '--remotes'])])).trim();
  const c = await vscode.window.showInformationMessage(
    `Push commits up to ${short(hash)} \u2192 ${remote}/${branch}`,
    { modal: true, detail: commits || 'No new commits.' },
    'Push'
  );
  if (c) await ops.run(repo, ['push', remote, `${hash}:refs/heads/${branch}`], { notify: true, title: `Pushing up to ${short(hash)}` });
}

export async function showRepositoryAt(repo: string, hash: string): Promise<void> {
  const files = (await git(repo, ['ls-tree', '-r', '--name-only', '-z', hash])).split('\0').filter(Boolean);
  const p = await vscode.window.showQuickPick(files, { title: `Repository at ${short(hash)} (${files.length} files)`, matchOnDescription: true });
  if (!p) return;
  const doc = await vscode.workspace.openTextDocument(revUri(repo, p, hash));
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function compareVersions(repo: string, hashes: string[]): Promise<void> {
  const [newer, older] = [hashes[0], hashes[hashes.length - 1]];
  await openChanges(repo, `${short(older)} \u2194 ${short(newer)}`, await nameStatus(repo, [older, newer]), older, newer);
}

export async function createPatches(repo: string, hashes: string[]): Promise<void> {
  const sorted = await oldestFirst(repo, hashes);
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(repo, `${short(sorted[sorted.length - 1])}.patch`)),
    filters: { Patch: ['patch', 'diff'] }
  });
  if (!uri) return;
  const parts: string[] = [];
  for (const h of sorted) parts.push(await git(repo, ['format-patch', '-1', '--stdout', h]));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(parts.join(''), 'utf8'));
  vscode.window.setStatusBarMessage(`Saved ${uri.fsPath}`, 4000);
}

export async function revertMany(repo: string, hashes: string[]): Promise<void> {
  if (hashes.length === 1) return ops.revert(repo, hashes[0]);
  const merges = (await git(repo, ['rev-list', '--no-walk', '--merges', ...hashes])).trim();
  if (merges) return void vscode.window.showErrorMessage('Revert merge commits one at a time.');
  // Newest first, so later changes are undone before the ones they build on.
  await ops.run(repo, ['revert', '--no-edit', ...hashes], { title: `Reverting ${hashes.length} commits` });
}
