import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ctx } from './ctx';
import { git } from './git';
import { webviewHtml } from './html';
import * as ops from './ops';
import { repoName } from './repos';
import { confirmRewrite, plan, posix, runTodo, tempDir } from './rewrite';
import { short } from './uris';

const ACTIONS = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);

interface Entry {
  hash: string;
  action: string;
  message?: string;
}

/** "Interactively Rebase from Here...": edit the todo list in a panel, then run the rebase. */
export async function interactiveRebase(repo: string, from: string): Promise<void> {
  const p = await plan(repo, from, [from]);
  const out = await git(repo, ['log', '--reverse', '--format=%H%x1f%an%x1f%at%x1f%B%x1e', p.base ? `${p.base}..HEAD` : 'HEAD']);
  const commits = out.split('\x1e').map(r => r.replace(/^\s+/, '')).filter(Boolean).map(r => {
    const [hash, author, at, ...msg] = r.split('\x1f');
    const message = msg.join('\x1f').trimEnd();
    return { hash, author, at: Number(at), message, subject: message.split('\n')[0] };
  });
  const branch = await ops.currentBranch(repo);
  const panel = vscode.window.createWebviewPanel('vscgit.rebase', `Rebase ${branch ?? 'HEAD'} from ${short(from)}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.ext.extensionUri, 'media')]
  });
  panel.iconPath = vscode.Uri.joinPath(ctx.ext.extensionUri, 'media', 'git-tool.svg');
  panel.webview.html = webviewHtml(panel.webview, ctx.ext.extensionUri, 'rebase');
  panel.webview.onDidReceiveMessage(async m => {
    try {
      if (m.type === 'ready') {
        void panel.webview.postMessage({ type: 'init', repoName: repoName(repo), branch, base: p.base ? short(p.base) : '(root)', commits });
      } else if (m.type === 'cancel') {
        panel.dispose();
      } else if (m.type === 'start') {
        const entries = (m.entries as Entry[]).filter(e => ACTIONS.has(e.action) && commits.some(c => c.hash === e.hash));
        if (entries.length !== commits.length) throw new Error('The commit list is incomplete.');
        const firstKept = entries.find(e => e.action !== 'drop');
        if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
          return void vscode.window.showErrorMessage('The first remaining commit cannot be squashed or fixed up; there is no commit before it in the list.');
        }
        const changed = entries.some((e, i) => e.action !== 'pick' || e.hash !== commits[i].hash);
        if (!changed) return void vscode.window.showInformationMessage('Nothing to change.');
        const summary = entries.map(e => `${e.action.padEnd(6)} ${short(e.hash)}  ${commits.find(c => c.hash === e.hash)?.subject ?? ''}`).join('\n');
        if (!(await confirmRewrite(repo, from, 'Start rebasing?', summary))) return;
        const tmp = tempDir();
        const lines: string[] = [];
        entries.forEach((e, i) => {
          const subject = commits.find(c => c.hash === e.hash)?.subject ?? '';
          if (e.action === 'reword') {
            const msgFile = path.join(tmp, `message${i}`);
            fs.writeFileSync(msgFile, (e.message ?? subject).trim() + '\n', 'utf8');
            lines.push(`pick ${e.hash} ${subject}`, `exec git commit --amend --only -F '${posix(msgFile)}'`);
          } else lines.push(`${e.action} ${e.hash} ${subject}`);
        });
        panel.dispose();
        await runTodo(repo, p.base, lines, tmp, 'Interactive rebase');
        if (entries.some(e => e.action === 'edit')) {
          vscode.window.showInformationMessage('The rebase stops at commits marked "edit". Amend them, then use Git > Rebase... > Continue Rebase.');
        }
      }
    } catch (e) {
      ops.showGitError(e);
    }
  });
}
