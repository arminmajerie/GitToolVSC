import * as vscode from 'vscode';
import { ctx } from './ctx';
import { git } from './git';
import { BlameLine, parseBlame } from './parse';
import { relPath } from './repos';
import { short } from './uris';

const ZERO = /^0+$/;

/** Toggleable "Annotate with Git Blame" gutter for text editors. */
export class Blame implements vscode.Disposable {
  private readonly type = vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor('editorLineNumber.foreground'),
      margin: '0 1.5em 0 0',
      width: '30ch'
    }
  });
  private readonly active = new Map<string, BlameLine[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(eds => eds.forEach(e => this.paint(e))),
      vscode.workspace.onDidChangeTextDocument(e => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument(d => this.active.delete(d.uri.toString()))
    );
  }

  async toggle(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (this.active.has(key)) {
      this.active.delete(key);
      for (const e of vscode.window.visibleTextEditors) if (e.document.uri.toString() === key) e.setDecorations(this.type, []);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await this.load(doc);
    this.paint(editor);
  }

  private schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (!this.active.has(key)) return;
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(async () => {
      this.timers.delete(key);
      await this.load(doc);
      vscode.window.visibleTextEditors.filter(e => e.document === doc).forEach(e => this.paint(e));
    }, 600));
  }

  private async load(doc: vscode.TextDocument): Promise<void> {
    const repo = await ctx.repos.rootOf(doc.uri.fsPath);
    if (!repo) throw new Error('The file is not in a Git repository.');
    const out = await git(repo, ['blame', '--porcelain', '--contents', '-', '--', relPath(repo, doc.uri.fsPath)], { input: doc.getText() });
    this.active.set(doc.uri.toString(), parseBlame(out));
  }

  private paint(editor: vscode.TextEditor): void {
    const lines = this.active.get(editor.document.uri.toString());
    if (!lines) return;
    const opts: vscode.DecorationOptions[] = [];
    let prev = '';
    const now = Date.now() / 1000;
    for (let i = 0; i < editor.document.lineCount; i++) {
      const b = lines[i];
      if (!b) continue;
      const uncommitted = ZERO.test(b.hash);
      const date = uncommitted ? '' : new Date(b.time * 1000).toISOString().slice(0, 10);
      const author = uncommitted ? 'Not Committed Yet' : b.author;
      const text = b.hash === prev ? '' : `${date} ${author}`.trim();
      prev = b.hash;
      // Newer commits are brighter.
      const age = Math.min(1, (now - b.time) / (365 * 24 * 3600));
      const md = new vscode.MarkdownString(undefined, true);
      if (uncommitted) md.appendText('Not committed yet');
      else {
        const args = encodeURIComponent(JSON.stringify([b.hash, editor.document.uri.fsPath]));
        md.appendMarkdown(`**${short(b.hash)}** `);
        md.appendText(`${b.author} <${b.authorMail}>, ${new Date(b.time * 1000).toLocaleString()}\n\n${b.summary}\n\n`);
        md.appendMarkdown(`[Show in Git Log](command:vscgit.revealCommit?${args})`);
        md.isTrusted = { enabledCommands: ['vscgit.revealCommit'] };
      }
      opts.push({
        range: new vscode.Range(i, 0, i, 0),
        hoverMessage: md,
        renderOptions: {
          before: {
            contentText: text.length > 29 ? text.slice(0, 28) + '\u2026' : text || '\u00a0',
            fontWeight: uncommitted ? 'bold' : undefined,
            textDecoration: `none; opacity: ${(1 - age * 0.55).toFixed(2)}`
          }
        }
      });
    }
    editor.setDecorations(this.type, opts);
  }

  dispose(): void {
    this.type.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
