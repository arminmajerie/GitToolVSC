import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** Builds the HTML shell of a webview: shared CSS/JS plus one page script. */
export function webviewHtml(webview: vscode.Webview, extUri: vscode.Uri, page: 'log' | 'commit' | 'rebase'): string {
  const nonce = randomBytes(16).toString('base64');
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', f)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('common.css')}">
<link rel="stylesheet" href="${media(page + '.css')}">
</head>
<body class="page-${page}">
<div id="app"></div>
<script nonce="${nonce}" src="${media('common.js')}"></script>
${page === 'log' ? `<script nonce="${nonce}" src="${media('graph.js')}"></script>` : ''}
${page === 'commit' ? `<script nonce="${nonce}">window.vscgitAssets={push:${JSON.stringify(media('push.png'))},forcePush:${JSON.stringify(media('force-push.png'))}};</script>` : ''}
<script nonce="${nonce}" src="${media(page + '.js')}"></script>
</body>
</html>`;
}
