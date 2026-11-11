import * as vscode from 'vscode';
import { ctx } from './ctx';
import { gitTry } from './git';
import * as ops from './ops';
import { repoName, samePath } from './repos';

/** Branch widget in the status bar (opens the branches popup). */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('vscgit.branch', vscode.StatusBarAlignment.Left, 99);
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.item.name = 'Git Tool Branch';
    this.item.command = 'vscgit.branches';
    this.disposables.push(
      ctx.repos.onDidChangeCurrent(() => void this.update()),
      ctx.repos.onDidChangeMeta(r => {
        if (ctx.repos.current && samePath(r, ctx.repos.current)) void this.update();
      })
    );
  }

  private updating?: Promise<void>;
  private updateAgain = false;

  /** Coalesces bursts of requests into at most one running and one queued update. */
  async update(): Promise<void> {
    if (this.updating) { this.updateAgain = true; return this.updating; }
    this.updating = this.updateNow();
    try { await this.updating; }
    finally {
      this.updating = undefined;
      if (this.updateAgain) { this.updateAgain = false; void this.update(); }
    }
  }

  private async updateNow(): Promise<void> {
    const repo = ctx.repos.current;
    if (!repo) {
      this.item.hide();
      return;
    }
    const [symbolic, counts] = await Promise.all([
      ops.currentBranch(repo),
      gitTry(repo, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']).then(o => o?.trim().split(/\s+/).map(Number))
    ]);
    const branch = symbolic ?? (await gitTry(repo, ['rev-parse', '--short', 'HEAD']))?.trim() ?? '?';
    let sync = '';
    if (counts && counts.length === 2) {
      if (counts[1]) sync += ` \u2191${counts[1]}`;
      if (counts[0]) sync += ` \u2193${counts[0]}`;
    }
    this.item.text = `$(git-branch) ${repoName(repo)}: ${branch}${sync}`;
    this.item.tooltip = `${repo}\nBranch ${branch}${sync ? ` (${sync.trim()})` : ''}\nClick for branches`;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
