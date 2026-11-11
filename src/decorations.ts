import * as path from 'node:path';
import * as vscode from 'vscode';
import { ctx } from './ctx';
import { gitTry } from './git';
import { mapBounded } from './asyncCache';
import { parseNameStatus } from './parse';

const MODIFIED = new vscode.FileDecoration('S', 'Staged (modified)', new vscode.ThemeColor('vscgit.stagedModifiedForeground'));
const ADDED = new vscode.FileDecoration('S', 'Staged (new file)', new vscode.ThemeColor('vscgit.stagedAddedForeground'));

/** Marks staged files with an "S" badge in the Explorer and editor tabs. */
export class StagedDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly files = new Map<string, vscode.FileDecoration>();
  private readonly byRepo = new Map<string, Map<string, string>>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(ctx.repos.onDidChangeMeta(r => void this.update(r)));
    void ctx.repos.ready.then(() => mapBounded(ctx.repos.all, 4, r => this.update(r)));
  }

  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();

  /** At most one running and one queued update per repository. */
  private async update(repo: string): Promise<void> {
    const key = repo.toLowerCase();
    const current = this.running.get(key);
    if (current) { this.again.add(key); return current; }
    const task = this.updateNow(repo);
    this.running.set(key, task);
    try { await task; }
    finally {
      this.running.delete(key);
      if (this.again.delete(key)) void this.update(repo);
    }
  }

  private async updateNow(repo: string): Promise<void> {
    const out = await gitTry(repo, ['diff', '--cached', '--name-status', '-z', '--no-renames']);
    const next = new Map<string, string>();
    const changed: vscode.Uri[] = [];
    for (const c of out ? parseNameStatus(out) : []) {
      if (c.status === 'D') continue;
      const abs = path.join(repo, c.path);
      const key = abs.toLowerCase();
      const deco = c.status === 'A' || c.status === 'C' ? ADDED : MODIFIED;
      next.set(key, abs);
      if (this.files.get(key) !== deco) {
        this.files.set(key, deco);
        changed.push(vscode.Uri.file(abs));
      }
    }
    const repoKey = repo.toLowerCase();
    for (const [key, abs] of this.byRepo.get(repoKey) ?? []) {
      if (!next.has(key)) {
        this.files.delete(key);
        changed.push(vscode.Uri.file(abs));
      }
    }
    this.byRepo.set(repoKey, next);
    if (changed.length) this.emitter.fire(changed);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === 'file' ? this.files.get(uri.fsPath.toLowerCase()) : undefined;
  }

  dispose(): void {
    this.emitter.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
