import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Blame } from './blame';
import { ctx } from './ctx';
import { git, gitTry } from './git';
import * as ops from './ops';
import { parseStatus } from './parse';
import { relPath } from './repos';
import { groupTargetPaths, repositoryScopes } from './targetGrouping';
import { diffFile, existsAt, INDEX, nameStatus, openChanges, openDiff, revUri, short, workUri } from './uris';

export interface Target {
  repo: string;
  /** Repository-relative paths ('' = repository root). */
  rels: string[];
  isDir: boolean;
}

function toFileUri(u: vscode.Uri): vscode.Uri {
  return u.scheme === 'file' ? u : vscode.Uri.file(u.fsPath);
}

/** Resolves the explorer/editor selection to one repository and its relative paths. */
export async function resolveTargets(uri?: vscode.Uri, uris?: vscode.Uri[], needPath = true): Promise<Target[]> {
  let list = (uris?.length ? uris : uri ? [uri] : []).filter(u => u instanceof vscode.Uri);
  if (!list.length && vscode.window.activeTextEditor && needPath) list = [vscode.window.activeTextEditor.document.uri];
  list = list.map(toFileUri);
  if (!list.length) {
    const repo = await ctx.repos.require();
    return repo ? [{ repo, rels: [], isDir: true }] : [];
  }
  const resolved = [];
  for (const u of list) {
    const repo = await ctx.repos.rootOf(u.fsPath);
    if (!repo) {
      void vscode.window.showWarningMessage(`${u.fsPath} is not in a Git repository.`);
      continue;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(u.fsPath).isDirectory();
    } catch {
      // deleted file
    }
    resolved.push({ repo, rel: relPath(repo, u.fsPath), isDir });
  }
  return groupTargetPaths(resolved);
}

export function pathspec(paths: string[]): { args: string[]; input: string } {
  return { args: ['--pathspec-from-file=-', '--pathspec-file-nul'], input: paths.map(p => p || '.').join('\0') };
}

/** Stages only files Git considers addable, so ignored descendants never make the command fail. */
async function addSelection(repo: string, rels: string[]): Promise<void> {
  const scope = rels.length ? rels.map(p => p || '.') : ['.'];
  const listed = await git(repo, ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', ...scope]);
  const files = listed.split('\0').filter(Boolean);
  if (!files.length) return;
  const ps = pathspec(files);
  // The list is already filtered by ls-files --exclude-standard. -f is safe here:
  // it only force-adds exact paths from that filtered list, including tracked files
  // located below an ignored directory.
  await ops.run(repo, ['add', '-A', '-f', ...ps.args], { input: ps.input });
}

/** Expands a superproject selection so each initialized submodule receives its own add. */
async function addSelectionTree(repo: string, rels: string[]): Promise<void> {
  const nodes = await ctx.repos.treeOf(repo);
  for (const node of nodes) {
    const scoped = repositoryScopes(repo, nodes, rels).get(node.repo);
    if (scoped?.length) await addSelection(node.repo, scoped);
  }
}

/** Rolls back a selection in the superproject and every initialized submodule it contains. */
export async function rollbackTree(repo: string, rels: string[]): Promise<void> {
  const nodes = await ctx.repos.treeOf(repo);
  const scopes = repositoryScopes(repo, nodes, rels);
  for (const node of nodes) {
    const scoped = scopes.get(node.repo);
    if (scoped?.length) await rollback(node.repo, scoped);
  }
}

interface Revision {
  hash: string;
  author: string;
  date: string;
  subject: string;
  path?: string;
}

async function revisions(repo: string, rel: string, follow: boolean): Promise<Revision[]> {
  const args = ['log', '-n', '500', '--format=%x1e%H%x1f%an%x1f%ad%x1f%s', '--date=format:%Y-%m-%d %H:%M'];
  if (follow) args.push('--follow', '--name-only');
  args.push('--', rel || '.');
  const out = await git(repo, args);
  return out.split('\x1e').filter(r => r.trim()).map(r => {
    const [header, ...rest] = r.split('\n');
    const [hash, author, date, subject] = header.split('\x1f');
    return { hash, author, date, subject, path: rest.find(l => l.trim())?.trim() };
  });
}

async function pickRevision(repo: string, rel: string, follow: boolean, title: string): Promise<Revision | undefined> {
  const revs = await revisions(repo, rel, follow);
  if (!revs.length) {
    vscode.window.showInformationMessage('No history.');
    return undefined;
  }
  const p = await vscode.window.showQuickPick(
    revs.map(r => ({ label: r.subject, description: `${short(r.hash)}  ${r.author}  ${r.date}`, detail: r.path && r.path !== rel ? r.path : undefined, r })),
    { title, matchOnDescription: true, matchOnDetail: true }
  );
  return p?.r;
}

function title(t: Target): string {
  return t.rels.length === 1 ? path.basename(t.rels[0]) || path.basename(t.repo) : `${t.rels.length} items`;
}

export function registerResourceCommands(blame: Blame): vscode.Disposable[] {
  const reg = (id: string, fn: (t: Target) => Promise<unknown>, needPath = true) =>
    vscode.commands.registerCommand(id, async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      try {
        const targets = await resolveTargets(uri, uris, needPath);
        for (const t of targets) await fn(t);
      } catch (e) {
        ops.showGitError(e);
      }
    });
  const one = (t: Target) => t.rels[0] ?? '';

  return [
    reg('vscgit.add', async t => {
      await addSelectionTree(t.repo, t.rels);
    }),
    reg('vscgit.annotate', async t => {
      if (t.isDir) return;
      await blame.toggle(workUri(t.repo, one(t)));
    }),
    reg('vscgit.showDiff', async t => {
      const rel = one(t);
      if (t.isDir) return openChanges(t.repo, `${title(t)}: HEAD \u2194 Local`, await nameStatus(t.repo, ['HEAD', '--', ...t.rels.map(r => r || '.')]), 'HEAD', undefined);
      if (!(await existsAt(t.repo, 'HEAD', rel))) return void vscode.window.showInformationMessage(`${rel} is not in HEAD.`);
      await diffFile(t.repo, { status: 'M', path: rel }, 'HEAD', undefined);
    }),
    reg('vscgit.compareWithRevision', async t => {
      const rel = one(t);
      const r = await pickRevision(t.repo, rel, !t.isDir, `Compare ${title(t)} with Revision`);
      if (!r) return;
      if (t.isDir) return openChanges(t.repo, `${title(t)}: ${short(r.hash)} \u2194 Local`, await nameStatus(t.repo, [r.hash, '--', rel || '.']), r.hash, undefined);
      await diffFile(t.repo, { status: 'M', path: rel, oldPath: r.path }, r.hash, undefined);
    }),
    reg('vscgit.compareWithBranch', async t => {
      const ref = await ops.pickRef(t.repo, `Compare ${title(t)} with Branch or Tag`, { local: true, remote: true, tags: true, custom: true });
      if (!ref) return;
      const rel = one(t);
      if (t.isDir) return openChanges(t.repo, `${title(t)}: ${ref.name} \u2194 Local`, await nameStatus(t.repo, [ref.name, '--', rel || '.']), ref.name, undefined);
      const status = (await existsAt(t.repo, ref.name, rel)) ? 'M' : 'A';
      await diffFile(t.repo, { status, path: rel }, ref.name, undefined);
    }),
    reg('vscgit.showHistory', async t => ctx.log.show(t.repo, { paths: t.rels.filter(r => r), title: title(t) })),
    reg('vscgit.showHistoryForSelection', async t => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const rel = relPath(t.repo, ed.document.uri.fsPath);
      const a = ed.selection.start.line + 1;
      const b = Math.max(a, ed.selection.end.character === 0 && ed.selection.end.line > ed.selection.start.line ? ed.selection.end.line : ed.selection.end.line + 1);
      const out = await git(t.repo, ['log', `-L${a},${b}:${rel}`, '--format=%x1e%H%x1f%P%x1f%an%x1f%ad%x1f%s', '--date=format:%Y-%m-%d %H:%M']);
      const revs = out.split('\x1e').filter(r => r.trim()).map(r => {
        const [hash, parents, author, date, subject] = r.split('\n')[0].split('\x1f');
        return { hash, parent: parents.split(' ')[0], author, date, subject };
      });
      const p = await vscode.window.showQuickPick(
        revs.map(r => ({ label: r.subject, description: `${short(r.hash)}  ${r.author}  ${r.date}`, r })),
        { title: `History of ${path.basename(rel)} lines ${a}-${b}`, matchOnDescription: true }
      );
      if (!p) return;
      await diffFile(t.repo, { status: p.r.parent ? 'M' : 'A', path: rel }, p.r.parent || p.r.hash, p.r.hash);
    }),
    reg('vscgit.showCurrentRevision', async t => {
      const hash = (await git(t.repo, ['log', '-1', '--format=%H', '--', one(t) || '.'])).trim();
      if (!hash) return void vscode.window.showInformationMessage('No committed revision.');
      await ctx.log.show(t.repo, { select: hash });
    }),
    reg('vscgit.rollback', async t => rollbackTree(t.repo, t.rels.length ? t.rels : ['.'])),
    reg('vscgit.showStagedVersion', async t => {
      const doc = await vscode.workspace.openTextDocument(revUri(t.repo, one(t), INDEX));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    reg('vscgit.compareWithStaged', async t => {
      const rel = one(t);
      await openDiff(revUri(t.repo, rel, INDEX), workUri(t.repo, rel), `${path.basename(rel)} (Staged \u2194 Local)`);
    }),
    reg('vscgit.compareHeadStagedLocal', async t => {
      const rel = one(t);
      const name = path.basename(rel);
      await openDiff(revUri(t.repo, rel, 'HEAD'), revUri(t.repo, rel, INDEX), `${name} (HEAD \u2194 Staged)`, vscode.ViewColumn.Active);
      await openDiff(revUri(t.repo, rel, INDEX), workUri(t.repo, rel), `${name} (Staged \u2194 Local)`, vscode.ViewColumn.Beside);
    }),
    reg('vscgit.push', t => ops.push(t.repo), false),
    reg('vscgit.pull', t => ops.pull(t.repo), false),
    reg('vscgit.fetch', t => ops.fetch(t.repo), false),
    reg('vscgit.merge', t => ops.merge(t.repo), false),
    reg('vscgit.rebase', t => ops.rebase(t.repo), false),
    reg('vscgit.branches', t => ops.branchesPopup(t.repo), false),
    reg('vscgit.newBranch', t => ops.newBranch(t.repo), false),
    reg('vscgit.newTag', t => ops.newTag(t.repo), false),
    reg('vscgit.resetHead', t => ops.resetHead(t.repo), false),
    reg('vscgit.stash', t => ops.stash(t.repo, t.rels.filter(r => r))),
    reg('vscgit.unstash', t => ops.unstash(t.repo), false),
    reg('vscgit.manageRemotes', t => ops.manageRemotes(t.repo), false),
    vscode.commands.registerCommand('vscgit.clone', () => ops.clone().catch(ops.showGitError))
  ];
}

/** "Rollback": revert tracked changes to HEAD; added files become unversioned (kept on disk). */
export async function rollback(repo: string, rels: string[]): Promise<void> {
  const entries = parseStatus(await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...rels.map(r => r || '.')]));
  if (!entries.length) return;

  // Rollback discards the selected changes completely. Staged additions and
  // untracked files are moved to the Recycle Bin instead of being left as new
  // unversioned changes. Ignored files are not reported by status and remain untouched.
  const tracked = entries.filter(e => e.x !== '?' && e.y !== '?');
  const resetPaths = [...new Set(tracked.map(e => e.path).filter(Boolean))];
  const restorePaths = [...new Set(tracked.flatMap(e => [e.path, e.oldPath ?? '']).filter(Boolean))];
  const removePaths = [...new Set(entries.filter(e => e.x === '?' || e.x === 'A' || e.x === 'C' || e.x === 'R').map(e => e.path))];
  const hasHead = !!(await gitTry(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']));

  if (resetPaths.length && hasHead) {
    const reset = pathspec(resetPaths);
    if ((await ops.run(repo, ['reset', '-q', 'HEAD', ...reset.args], { input: reset.input })) === undefined) return;
    const restore = pathspec(restorePaths);
    if ((await ops.run(repo, ['restore', '--source=HEAD', '--worktree', '--ignore-unmatch', ...restore.args], { input: restore.input })) === undefined) return;
  } else if (resetPaths.length) {
    const reset = pathspec(resetPaths);
    if ((await ops.run(repo, ['rm', '--cached', '--quiet', '-r', '--ignore-unmatch', ...reset.args], { input: reset.input })) === undefined) return;
  }

  for (const rel of removePaths) {
    try {
      await vscode.workspace.fs.delete(workUri(repo, rel), { useTrash: true, recursive: true });
    } catch {
      // The path may already be gone (for example a deleted tracked file).
    }
  }
  ctx.repos.changed(repo);
  vscode.window.setStatusBarMessage(`Rolled back ${entries.length} change${entries.length === 1 ? '' : 's'}.`, 4000);
}
