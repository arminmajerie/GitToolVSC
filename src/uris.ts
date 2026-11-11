import * as path from 'node:path';
import * as vscode from 'vscode';
import { git, gitOk } from './git';
import { FileChange, parseNameStatus } from './parse';

export const SCHEME = 'vscgit';
/** Pseudo revision for "file does not exist on this side". */
export const EMPTY = '~empty';
/** Revision value meaning "the index" (`git show :path`). */
export const INDEX = '';

interface RevQuery {
  repo: string;
  rel: string;
  ref: string;
}

export function revUri(repo: string, rel: string, ref: string): vscode.Uri {
  const q: RevQuery = { repo, rel, ref };
  return vscode.Uri.file(path.join(repo, rel)).with({ scheme: SCHEME, query: JSON.stringify(q) });
}

export function workUri(repo: string, rel: string): vscode.Uri {
  return vscode.Uri.file(path.join(repo, rel));
}

export function short(hash: string): string {
  return /^[0-9a-f]{40,64}$/i.test(hash) ? hash.slice(0, 8) : hash;
}

export function refLabel(ref: string): string {
  if (ref === INDEX) return 'Staged';
  if (ref === EMPTY) return 'None';
  return short(ref);
}

export class RevisionProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query) as RevQuery;
    if (q.ref === EMPTY) return '';
    try {
      return await git(q.repo, ['show', `${q.ref}:${q.rel}`]);
    } catch {
      return '';
    }
  }
}

export async function openDiff(left: vscode.Uri, right: vscode.Uri, title: string, column?: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, viewColumn: column });
}

/** Diff of one file between two revisions; `right` undefined means the working tree. */
export async function diffFile(repo: string, change: FileChange, left: string, right: string | undefined): Promise<void> {
  const name = path.basename(change.path);
  const l = change.status === 'A' ? revUri(repo, change.path, EMPTY) : revUri(repo, change.oldPath ?? change.path, left);
  const r = change.status === 'D'
    ? revUri(repo, change.path, EMPTY)
    : right === undefined ? workUri(repo, change.path) : revUri(repo, change.path, right);
  const rightLabel = right === undefined ? 'Local' : refLabel(right);
  await openDiff(l, r, `${name} (${refLabel(left)} \u2194 ${rightLabel})`);
}

/** Opens several file diffs in one multi-diff editor. */
export async function openChanges(repo: string, title: string, changes: FileChange[], left: string, right: string | undefined): Promise<void> {
  if (!changes.length) {
    vscode.window.showInformationMessage('No differences.');
    return;
  }
  const entries = changes.map(c => {
    const l = c.status === 'A' ? undefined : revUri(repo, c.oldPath ?? c.path, left);
    const r = c.status === 'D' ? undefined : right === undefined ? workUri(repo, c.path) : revUri(repo, c.path, right);
    return [workUri(repo, c.path), l, r];
  });
  await vscode.commands.executeCommand('vscode.changes', title, entries);
}

export async function nameStatus(repo: string, args: string[]): Promise<FileChange[]> {
  return parseNameStatus(await git(repo, ['diff', '--name-status', '-z', '-M', ...args]));
}

/** Files changed by a commit, compared with its first parent. */
export async function commitChanges(repo: string, hash: string, parents: string[]): Promise<FileChange[]> {
  if (parents.length) return nameStatus(repo, [parents[0], hash]);
  return parseNameStatus(await git(repo, ['diff-tree', '--root', '-r', '-z', '-M', '--no-commit-id', '--name-status', hash]));
}

export async function parentsOf(repo: string, hash: string): Promise<string[]> {
  const out = await git(repo, ['show', '-s', '--format=%P', hash]);
  return out.trim() ? out.trim().split(' ') : [];
}

/** Left-hand revision for a commit diff (first parent, or empty for root commits). */
export async function parentRef(repo: string, hash: string): Promise<string> {
  const p = await parentsOf(repo, hash);
  return p[0] ?? EMPTY;
}

export async function existsAt(repo: string, ref: string, rel: string): Promise<boolean> {
  return gitOk(repo, ['cat-file', '-e', `${ref}:${rel}`]);
}
