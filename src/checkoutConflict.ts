import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { openDiff, revUri, workUri } from './uris';

export function checkoutConflictPaths(message: string): string[] {
  return [...new Set(message.split(/\r?\n/).filter(line => /^\t/.test(line))
    .map(line => line.slice(1)).filter(file => file && !path.isAbsolute(file)
      && !file.split(/[\\/]/).includes('..')))];
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

export function checkoutConflictHtml(repo: string, target: string, files: string[], message: string): string {
  const nonce = randomBytes(18).toString('hex');
  interface Tree { folders: Map<string, Tree>; files: { name: string; index: number }[] }
  const root: Tree = { folders: new Map(), files: [] };
  files.forEach((file, index) => {
    const parts = file.split('/');
    let node = root;
    for (const folder of parts.slice(0, -1)) {
      if (!node.folders.has(folder)) node.folders.set(folder, { folders: new Map(), files: [] });
      node = node.folders.get(folder)!;
    }
    node.files.push({ name: parts[parts.length - 1], index });
  });
  const render = (node: Tree): string => [...node.folders].sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) => {
      while (!child.files.length && child.folders.size === 1) {
        const [nextName, nextChild] = [...child.folders][0];
        name += `/${nextName}`;
        child = nextChild;
      }
      return `<details open><summary>${escape(name)}</summary><div class="children">${render(child)}</div></details>`;
    }).join('')
    + node.files.map(file => `<div class="file"><button class="file-link" data-file="${file.index}" title="${escape(files[file.index])}">${escape(file.name)}</button><span class="path">${escape(files[file.index])}</span></div>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Checkout blocked</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px;line-height:1.5}
h1{font-size:20px;margin:0 0 8px}p{overflow-wrap:anywhere}.repo{color:var(--vscode-descriptionForeground)}
.tree{border-top:1px solid var(--vscode-panel-border);padding:12px 0;margin:20px 0}.children{padding-left:20px}summary{cursor:pointer;padding:3px 0;overflow-wrap:anywhere}
.file{padding:4px 0}.file-link{background:none;color:var(--vscode-textLink-foreground);padding:0;text-align:left;overflow-wrap:anywhere;white-space:normal;user-select:text}
.path{display:block;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere;user-select:text}
button{font:inherit;border:1px solid transparent;border-radius:2px;cursor:pointer;padding:6px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{filter:brightness(1.15)}button:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
.actions{display:flex;flex-wrap:wrap;gap:10px;padding:12px 0}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.danger{color:var(--vscode-errorForeground);background:none;border-color:var(--vscode-errorForeground)}pre{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
</style></head><body><h1>Checkout blocked</h1><p class="repo">${escape(repo)}</p>
<p>Local changes conflict with checkout to <strong>${escape(target)}</strong>.</p>
<div class="tree" aria-label="Files blocking checkout">${files.length ? `<p>${files.length} affected file${files.length === 1 ? '' : 's'}</p>${render(root)}` : '<p>Git did not provide a file list.</p>'}</div>
<details><summary>Git details</summary><pre>${escape(message)}</pre></details>
<div class="actions"><button data-action="stash">Stash &amp; Checkout</button><button class="danger" data-action="discard">Discard Changes &amp; Checkout</button><button class="secondary" data-action="cancel">Cancel</button></div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.dataset.file!==undefined)vscode.postMessage({type:'diff',index:Number(button.dataset.file)});else if(button.dataset.action)vscode.postMessage({type:button.dataset.action});});</script></body></html>`;
}

export async function showCheckoutConflict(repo: string, target: string, message: string): Promise<'stash' | 'discard' | undefined> {
  const files = checkoutConflictPaths(message);
  const panel = vscode.window.createWebviewPanel('vscgit.checkoutConflict', 'Checkout blocked', vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [] });
  panel.webview.html = checkoutConflictHtml(repo, target, files, message);
  return new Promise(resolve => {
    const messages = panel.webview.onDidReceiveMessage(async event => {
      if (event.type === 'diff' && Number.isInteger(event.index) && files[event.index] !== undefined) {
        const file = files[event.index];
        try {
          await openDiff(revUri(repo, file, 'HEAD'), workUri(repo, file), `${file} (HEAD - Local)`, vscode.ViewColumn.Beside);
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      } else if (event.type === 'stash' || event.type === 'discard') {
        resolve(event.type);
        panel.dispose();
      } else if (event.type === 'cancel') panel.dispose();
    });
    panel.onDidDispose(() => { messages.dispose(); resolve(undefined); });
  });
}