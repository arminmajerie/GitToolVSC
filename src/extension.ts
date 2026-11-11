import * as vscode from 'vscode';
import { Blame } from './blame';
import { addToGitignore, CommitView, deleteUntracked, Group, openChangeDiff, stagePaths, unstagePaths } from './commitView';
import { ctx } from './ctx';
import { output } from './git';
import { LogViews } from './logView';
import * as ops from './ops';
import { FileChange } from './parse';
import { Repos } from './repos';
import { registerResourceCommands, rollback } from './resourceCommands';
import * as rewrite from './rewrite';
import { interactiveRebase } from './rebaseEditor';
import { showStashChanges } from './commitView';
import { StatusBar } from './statusBar';
import { StagedDecorations } from './decorations';
import { commitChanges, diffFile, EMPTY, nameStatus, openChanges, parentsOf, revUri, RevisionProvider, SCHEME, short, workUri } from './uris';

interface BranchCtx { repo: string; refName: string; branchKind: ops.RefKind }
interface CommitCtx { repo: string; hash: string; hashes?: string[] }
interface FileCtx { repo: string; left: string; right: string; path: string; oldPath: string; status: string }
interface ChangeCtx { repo: string; changeGroup: Group; path: string; oldPath: string; status: string; paths?: string[] }
interface StashCtx { repo: string; ref: string }

function cmd<T extends { repo: string }>(id: string, fn: (a: T) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, async (a?: T) => {
    if (!a?.repo) return;
    try {
      await fn(a);
    } catch (e) {
      ops.showGitError(e);
    }
  });
}

function webviewCommands(): vscode.Disposable[] {
  const br = (id: string, action: ops.BranchAction) =>
    cmd<BranchCtx>(`vscgit.br.${id}`, a => ops.branchAction(a.repo, action, { kind: a.branchKind, name: a.refName }));
  const fileChange = (a: FileCtx): FileChange => ({ status: a.status, path: a.path, oldPath: a.oldPath || undefined });
  const changePaths = (a: ChangeCtx) => (a.paths?.length ? a.paths : [a.path]);
  const hs = (a: CommitCtx) => (a.hashes?.length ? a.hashes : [a.hash]);
  return [
    br('checkout', 'checkout'),
    br('newBranchFrom', 'newFrom'),
    br('checkoutRebase', 'checkoutRebase'),
    br('compare', 'compare'),
    br('diffWorking', 'diffWorking'),
    br('rebaseOnto', 'rebaseOnto'),
    br('merge', 'merge'),
    br('update', 'update'),
    br('push', 'push'),
    br('rename', 'rename'),
    br('delete', 'delete'),
    br('favorite', 'favorite'),
    br('showLog', 'showLog'),
    br('copyName', 'copyName'),

    cmd<CommitCtx>('vscgit.c.copyHash', a => vscode.env.clipboard.writeText(hs(a).join(' '))),
    cmd<CommitCtx>('vscgit.c.showChanges', async a => {
      const parents = await parentsOf(a.repo, a.hash);
      await openChanges(a.repo, `Changes in ${short(a.hash)}`, await commitChanges(a.repo, a.hash, parents), parents[0] ?? EMPTY, a.hash);
    }),
    cmd<CommitCtx>('vscgit.c.compareWithLocal', async a => openChanges(a.repo, `${short(a.hash)} \u2194 Local`, await nameStatus(a.repo, [a.hash]), a.hash, undefined)),
    cmd<CommitCtx>('vscgit.c.compareVersions', a => rewrite.compareVersions(a.repo, hs(a))),
    cmd<CommitCtx>('vscgit.c.showRepository', a => rewrite.showRepositoryAt(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.checkout', a => ops.checkout(a.repo, { kind: 'rev', name: a.hash })),
    cmd<CommitCtx>('vscgit.c.newBranch', a => ops.newBranch(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.newTag', a => ops.newTag(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.cherryPick', a => ops.cherryPickMany(a.repo, hs(a))),
    cmd<CommitCtx>('vscgit.c.revert', a => rewrite.revertMany(a.repo, hs(a))),
    cmd<CommitCtx>('vscgit.c.reset', a => ops.resetHead(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.undo', a => ops.undoCommit(a.repo)),
    cmd<CommitCtx>('vscgit.c.editMessage', a => rewrite.editMessage(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.fixup', a => rewrite.fixup(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.squashInto', a => rewrite.squashInto(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.interactiveRebase', a => interactiveRebase(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.drop', a => rewrite.dropCommits(a.repo, hs(a))),
    cmd<CommitCtx>('vscgit.c.squash', a => rewrite.squashCommits(a.repo, hs(a))),
    cmd<CommitCtx>('vscgit.c.pushUpTo', a => rewrite.pushUpTo(a.repo, a.hash)),
    cmd<CommitCtx>('vscgit.c.createPatch', a => rewrite.createPatches(a.repo, hs(a))),
    cmd<CommitCtx>('vscgit.c.goParent', a => ctx.log.nav(a.hash, 1)),
    cmd<CommitCtx>('vscgit.c.goChild', a => ctx.log.nav(a.hash, -1)),

    cmd<FileCtx>('vscgit.f.showDiff', a => diffFile(a.repo, fileChange(a), a.left, a.right)),
    cmd<FileCtx>('vscgit.f.compareWithLocal', a =>
      a.status === 'D'
        ? diffFile(a.repo, { status: 'M', path: a.path }, a.left, undefined)
        : diffFile(a.repo, { status: 'M', path: a.path }, a.right, undefined)),
    cmd<FileCtx>('vscgit.f.openRevision', async a => {
      const doc = await vscode.workspace.openTextDocument(revUri(a.repo, a.status === 'D' ? a.oldPath || a.path : a.path, a.status === 'D' ? a.left : a.right));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    cmd<FileCtx>('vscgit.f.openFile', a => vscode.window.showTextDocument(workUri(a.repo, a.path))),
    cmd<FileCtx>('vscgit.f.history', a => ctx.log.show(a.repo, { paths: [a.path] })),
    cmd<FileCtx>('vscgit.f.getFromRevision', async a => {
      const c = await vscode.window.showWarningMessage(`Replace the local ${a.path} with the version from ${short(a.right)}?`, { modal: true }, 'Get');
      if (!c) return;
      if (a.status === 'D') await ops.run(a.repo, ['rm', '-q', '--ignore-unmatch', '--', a.path]);
      else await ops.run(a.repo, ['checkout', a.right, '--', a.path]);
    }),

    cmd<ChangeCtx>('vscgit.ch.diff', a => openChangeDiff(a.repo, a.changeGroup, { status: a.status, path: a.path, oldPath: a.oldPath || undefined })),
    cmd<ChangeCtx>('vscgit.ch.open', a => vscode.window.showTextDocument(workUri(a.repo, a.path))),
    cmd<ChangeCtx>('vscgit.ch.stage', a => stagePaths(a.repo, changePaths(a))),
    cmd<ChangeCtx>('vscgit.ch.unstage', a => unstagePaths(a.repo, changePaths(a))),
    cmd<ChangeCtx>('vscgit.ch.rollback', a => rollback(a.repo, changePaths(a))),
    cmd<ChangeCtx>('vscgit.ch.delete', a => deleteUntracked(a.repo, changePaths(a))),
    cmd<ChangeCtx>('vscgit.ch.ignore', a => addToGitignore(a.repo, changePaths(a))),
    cmd<ChangeCtx>('vscgit.ch.shelve', a => ops.stash(a.repo, changePaths(a))),
    cmd<ChangeCtx>('vscgit.ch.history', a => ctx.log.show(a.repo, { paths: [a.path] })),

    cmd<StashCtx>('vscgit.st.apply', a => ops.stashApply(a.repo, a.ref, false)),
    cmd<StashCtx>('vscgit.st.pop', a => ops.stashApply(a.repo, a.ref, true)),
    cmd<StashCtx>('vscgit.st.drop', a => ops.stashDrop(a.repo, a.ref)),
    cmd<StashCtx>('vscgit.st.showChanges', a => showStashChanges(a.repo, a.ref))
  ];
}

export function activate(context: vscode.ExtensionContext): void {
  ctx.ext = context;
  const repos = new Repos(context.workspaceState, context.globalStorageUri.fsPath);
  ctx.repos = repos;
  repos.ready = repos.init();
  const logViews = new LogViews();
  ctx.log = logViews;
  const commitView = new CommitView();
  const blame = new Blame();
  const statusBar = new StatusBar();
  const decorations = new StagedDecorations();

  context.subscriptions.push(
    repos,
    logViews,
    commitView,
    blame,
    statusBar,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
    output(),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider()),
    vscode.window.registerWebviewViewProvider('vscgit.branches', logViews.provider('branches'), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('vscgit.log', logViews.provider('commits'), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('vscgit.changes', logViews.provider('details'), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('vscgit.commit', commitView, { webviewOptions: { retainContextWhenHidden: true } }),
    ...registerResourceCommands(blame),
    ...webviewCommands(),
    vscode.commands.registerCommand('vscgit.openLog', async () => {
      await repos.ready;
      if (repos.current) await logViews.show(repos.current);
      else await vscode.commands.executeCommand('vscgit.log.focus');
    }),
    vscode.commands.registerCommand('vscgit.openCommit', () => vscode.commands.executeCommand('vscgit.commit.focus')),
    vscode.commands.registerCommand('vscgit.tour', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', `${context.extension.id}#tour`, false)),
    // The extension page only loads https images; the markdown preview shows the local GIFs.
    vscode.commands.registerCommand('vscgit.readme', () =>
      vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'README.md'))),
    vscode.commands.registerCommand('vscgit.selectRepository', async () => {
      const r = await repos.pick();
      if (r) repos.setCurrent(r);
    }),
    vscode.commands.registerCommand('vscgit.revealCommit', async (hash: string, fsPath: string) => {
      const repo = fsPath ? await repos.rootOf(fsPath) : repos.current;
      if (repo && hash) await logViews.show(repo, { select: hash });
    })
  );

  void repos.ready.then(() => statusBar.update());
}

export function deactivate(): void {
  // Disposables are released through context.subscriptions.
}
