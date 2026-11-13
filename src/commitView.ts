import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { ctx } from './ctx';
import { git, gitTry } from './git';
import { webviewHtml } from './html';
import * as ops from './ops';
import { FileChange, groupStatus, parseNameStatus, parseStatus, StatusGroups, StashEntry } from './parse';
import { repoName, samePath, RepoTreeNode } from './repos';
import { pathspec, rollback } from './resourceCommands';
import { dependencyOrder } from './targetGrouping';
import { applyPushPreparation, planPushPreparation } from './pushPreparation';
import { mapBounded } from './asyncCache';
import { diffFile, EMPTY, existsAt, INDEX, openChanges, openDiff, revUri, workUri } from './uris';

export type Group = 'staged' | 'unstaged' | 'untracked' | 'conflicts';

export async function stagePaths(repo: string, paths: string[]): Promise<void> {
  const ps = pathspec(paths);
  await ops.run(repo, ['add', '-A', '-f', ...ps.args], { input: ps.input });
}

export async function unstagePaths(repo: string, paths: string[]): Promise<void> {
  const ps = pathspec(paths);
  const hasHead = !!(await gitTry(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']));
  if (hasHead) await ops.run(repo, ['reset', '-q', 'HEAD', ...ps.args], { input: ps.input });
  else await ops.run(repo, ['rm', '--cached', '-q', '-r', ...ps.args], { input: ps.input });
}

/** Opens the diff of one entry of the commit view. */
export async function openChangeDiff(repo: string, group: Group, f: FileChange): Promise<void> {
  const name = path.basename(f.path);
  if (group === 'untracked' || group === 'conflicts') {
    await vscode.window.showTextDocument(workUri(repo, f.path), { preview: true });
    return;
  }
  if (group === 'staged') {
    const left = f.status === 'A' ? revUri(repo, f.path, EMPTY) : revUri(repo, f.oldPath ?? f.path, 'HEAD');
    const right = f.status === 'D' ? revUri(repo, f.path, EMPTY) : revUri(repo, f.path, INDEX);
    await openDiff(left, right, `${name} (HEAD \u2194 Staged)`);
    return;
  }
  const right = f.status === 'D' ? revUri(repo, f.path, EMPTY) : workUri(repo, f.path);
  await openDiff(revUri(repo, f.path, INDEX), right, `${name} (Staged \u2194 Local)`);
}

export async function addToGitignore(repo: string, paths: string[]): Promise<void> {
  const file = vscode.Uri.file(path.join(repo, '.gitignore'));
  let text = '';
  try {
    text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
  } catch {
    // new file
  }
  const lines = paths.map(p => '/' + p.replace(/^\/+/, ''));
  const add = lines.filter(l => !text.split(/\r?\n/).includes(l));
  if (!add.length) return;
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  await vscode.workspace.fs.writeFile(file, Buffer.from(text + sep + add.join('\n') + '\n', 'utf8'));
  ctx.repos.changed(repo);
}

export async function deleteUntracked(repo: string, paths: string[]): Promise<void> {
  const c = await vscode.window.showWarningMessage(`Delete ${paths.length} unversioned file(s)?`, { modal: true, detail: paths.slice(0, 20).join('\n') }, 'Move to Recycle Bin');
  if (!c) return;
  for (const p of paths) await vscode.workspace.fs.delete(workUri(repo, p), { useTrash: true, recursive: true });
  ctx.repos.changed(repo);
}

async function stashFiles(repo: string, ref: string): Promise<FileChange[]> {
  try {
    return parseNameStatus(await git(repo, ['stash', 'show', '--name-status', '-z', '-M', '--include-untracked', ref]));
  } catch {
    return parseNameStatus(await git(repo, ['stash', 'show', '--name-status', '-z', '-M', ref]));
  }
}

/** Right-hand revision of a stash file: untracked files live in the third parent. */
async function stashRight(repo: string, ref: string, f: FileChange): Promise<string> {
  if (f.status === 'A' && !(await existsAt(repo, ref, f.path))) return `${ref}^3`;
  return ref;
}

export async function showStashChanges(repo: string, ref: string): Promise<void> {
  const files = await stashFiles(repo, ref);
  const tracked = [];
  for (const f of files) if ((await stashRight(repo, ref, f)) === ref) tracked.push(f);
  await openChanges(repo, `Shelf ${ref}`, tracked.length ? tracked : files, `${ref}^1`, tracked.length ? ref : `${ref}^3`);
}

const MESSAGES_KEY = 'vscgit.messages';

export interface SyncState { ahead: number; behind: number; upstream: boolean }

/** Commits to push (ahead) and remote commits not in HEAD (behind); both > 0 means only a force push can publish. */
export async function syncState(repo: string): Promise<SyncState> {
  const counts = await gitTry(repo, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts !== undefined) {
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
    return { ahead: ahead || 0, behind: behind || 0, upstream: true };
  }
  const local = await gitTry(repo, ['rev-list', '--count', 'HEAD', '--not', '--remotes']);
  return { ahead: Number(local?.trim() || 0), behind: 0, upstream: false };
}

function describeSync(s: SyncState): string {
  if (!s.upstream) return `${s.ahead} unpublished commit(s), no remote branch yet`;
  return s.behind ? `${s.ahead} local / ${s.behind} remote commit(s) differ (diverged)` : `${s.ahead} commit(s) ahead`;
}

/** "Commit" activity bar view with Commit and Shelf tabs. */
export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private repo: string | undefined;
  private groups: StatusGroups = { staged: [], unstaged: [], untracked: [], conflicts: [] };
  private groupsByRepo = new Map<string, StatusGroups>();
  private repoTree: RepoTreeNode[] = [];
  private checkedRepos = new Set<string>();
  private checkedInitialized = false;
  private readonly disposables: vscode.Disposable[] = [];
  private seq = 0;
  private refreshing = false;
  private refreshQueued = false;
  private batchRunning = false;
  private dirtyRepos = new Set<string>();
  private metaDirtyRepos = new Set<string>();
  private lastStatus = '';
  private statusLoadedAt = new Map<string, number>();
  private statusCache = new Map<string, RepoTreeNode & StatusGroups & {
    repoName: string; branch?: string; state: string; stashes: StashEntry[]; childPaths: string[]; checked: boolean; sync: SyncState;
  }>();

  constructor() {
    this.disposables.push(
      ctx.repos.onDidChangeMeta(r => this.metaDirtyRepos.add(r.toLowerCase())),
      ctx.repos.onDidChange(r => {
        this.dirtyRepos.add(r.toLowerCase());
        if (this.repo && this.repoTree.some(node => samePath(r, node.repo))) void this.refresh();
      }),
      ctx.repos.onDidChangeCurrent(r => {
        this.repo = r;
        void this.refresh();
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.repo = ctx.repos.current;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.ext.extensionUri, 'media')] };
    view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(ops.showGitError), undefined, this.disposables);
    view.webview.html = webviewHtml(view.webview, ctx.ext.extensionUri, 'commit');
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh();
    }, undefined, this.disposables);
    view.onDidDispose(() => (this.view = undefined));
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand('vscgit.commit.focus');
  }

  private post(m: unknown): void {
    void this.view?.webview.postMessage(m);
  }

  /** Identical status messages would only make the webview rebuild its DOM. */
  private postStatus(m: { type: 'status'; [k: string]: unknown }): void {
    const json = JSON.stringify(m);
    if (json === this.lastStatus) return;
    this.lastStatus = json;
    this.post(m);
  }

  private reportProgress(message: string): void {
    vscode.window.setStatusBarMessage(`Git Tool: ${message}`);
    this.post({ type: 'batchProgress', message });
  }

  async refresh(): Promise<void> {
    if (this.batchRunning) {
      this.refreshQueued = true;
      return;
    }
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    this.refreshQueued = false;
    try {
      await ctx.repos.ready;
      this.repo ??= ctx.repos.current ?? ctx.repos.all[0];
      await this.refreshNow();
    } catch (error) {
      ops.showGitError(error);
      this.post({ type: 'loadError', message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  private async refreshNow(): Promise<void> {
    const repo = this.repo;
    if (!this.view?.visible) return;
    if (!repo) return this.postStatus({ type: 'status', repo: '', repoName: '' });
    const seq = ++this.seq;
    // Render the active repository immediately while recursive discovery runs.
    // A slow descendant must not hide the commit editor and all local changes.
    if (!this.repoTree.length) {
      const initial = groupStatus(parseStatus(await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty'])));
      const branch = await ops.currentBranch(repo);
      this.groupsByRepo.set(repo.toLowerCase(), initial);
      this.postStatus({ type: 'status', repo, repoName: repoName(repo), branch, ...initial, repositories: [{ repo, repoName: repoName(repo), branch, checked: true, ...initial }] });
    }
    const tree = await ctx.repos.treeOf(repo);
    const missing = await ctx.repos.missingSubmodules(repo);
    // Bound repository fan-out: large workspaces otherwise spawn hundreds of
    // simultaneous Git processes during startup and stall the extension host.
    const loadStatus = async (node: RepoTreeNode) => {
      const key = node.repo.toLowerCase();
      const cached = this.statusCache.get(key);
      if (!this.dirtyRepos.has(key) && cached && Date.now() - (this.statusLoadedAt.get(key) ?? 0) < 5000) return structuredClone(cached);
      // Saving a working tree file cannot change branch, stashes or rebase state: only re-run status.
      const metaFresh = cached && this.dirtyRepos.has(key) && !this.metaDirtyRepos.has(key);
      this.metaDirtyRepos.delete(key);
      const [st, branch, stashes, state, sync] = await Promise.all([
        git(node.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty']),
        metaFresh ? cached.branch : ops.currentBranch(node.repo),
        metaFresh ? cached.stashes : ops.stashList(node.repo).catch(() => []),
        metaFresh ? cached.state : this.state(node.repo),
        metaFresh ? cached.sync : syncState(node.repo)
      ]);
      const groups = groupStatus(parseStatus(st));
      const status = { ...node, repoName: repoName(node.repo), branch, state, stashes, sync, childPaths: tree.filter(child => samePath(child.parent ?? '', node.repo) && child.path).map(child => child.path!), checked: this.checkedRepos.has(node.repo.toLowerCase()), ...groups };
      this.statusCache.set(key, structuredClone(status));
      this.statusLoadedAt.set(key, Date.now());
      this.dirtyRepos.delete(key);
      return status;
    };
    const statuses: Awaited<ReturnType<typeof loadStatus>>[] = new Array(tree.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, tree.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= tree.length) return;
        statuses[index] = await loadStatus(tree[index]);
      }
    }));
    if (seq !== this.seq) return;
    // Child repositories are queried independently. Reuse those results for
    // dirty gitlinks instead of recursively rescanning every child per parent.
    for (const child of [...statuses].reverse()) {
      if (!child.parent || !child.path) continue;
      if (!child.staged.length && !child.unstaged.length && !child.untracked.length && !child.conflicts.length) continue;
      const parent = statuses.find(s => samePath(s.repo, child.parent!));
      if (parent && !parent.unstaged.some(f => f.path === child.path)) parent.unstaged.push({ path: child.path, status: 'M' });
    }
    this.repoTree = tree;
    if (!this.checkedInitialized) {
      this.checkedRepos = new Set(tree.map(node => node.repo.toLowerCase()));
      this.checkedInitialized = true;
    }
    for (const status of statuses) status.checked = this.checkedRepos.has(status.repo.toLowerCase());
    this.groupsByRepo = new Map(statuses.map(s => [s.repo.toLowerCase(), { staged: s.staged, unstaged: s.unstaged, untracked: s.untracked, conflicts: s.conflicts }]));
    this.groups = this.groupsByRepo.get(repo.toLowerCase()) ?? { staged: [], unstaged: [], untracked: [], conflicts: [] };
    const root = statuses[0] ?? { repo, repoName: repoName(repo), branch: undefined, state: '', stashes: [], ...this.groups };
    this.postStatus({ type: 'status', rootRepo: root.repo, repositories: statuses, uninitialized: missing, checked: [...this.checkedRepos], repo, repoName: repoName(repo), branch: statuses.find(s => samePath(s.repo, repo))?.branch, state: statuses.find(s => samePath(s.repo, repo))?.state, ...this.groups, stashes: statuses.find(s => samePath(s.repo, repo))?.stashes ?? [] });
  }

  private async state(repo: string): Promise<string> {
    const marker = path.join(repo, '.git');
    let gitDir = marker;
    try {
      const stat = await fs.stat(marker);
      if (stat.isFile()) {
        const text = await fs.readFile(marker, 'utf8');
        const dir = /^gitdir:\s*(.+)/m.exec(text)?.[1]?.trim();
        if (!dir) return '';
        gitDir = path.resolve(repo, dir);
      }
    } catch { return ''; }
    const p = async (n: string) => {
      try {
        await fs.stat(path.join(gitDir, n));
        return true;
      } catch {
        return false;
      }
    };
    if ((await p('rebase-merge')) || (await p('rebase-apply'))) return 'Rebasing';
    if (await p('MERGE_HEAD')) return 'Merging';
    if (await p('CHERRY_PICK_HEAD')) return 'Cherry-picking';
    if (await p('REVERT_HEAD')) return 'Reverting';
    return '';
  }

  private async onMessage(m: any): Promise<void> {
    if (m.type === 'ready') {
      this.lastStatus = '';
      this.post({ type: 'init', opts: ctx.ext.globalState.get('vscgit.commitUi') ?? {} });
      if (!this.repo) {
        await ctx.repos.ready;
        this.repo = ctx.repos.current ?? (await ctx.repos.require());
      }
      return this.refresh();
    }
    if (m.type === 'saveUi') return void ctx.ext.globalState.update('vscgit.commitUi', m.opts);
    if (m.type === 'setChecked') {
      this.checkedRepos = new Set((m.repos ?? []).filter((r: unknown): r is string => typeof r === 'string').map((r: string) => r.toLowerCase()));
      this.checkedInitialized = true;
      return this.refresh();
    }
    if (m.type === 'selectRepo') {
      const r = await ctx.repos.pick();
      if (r) ctx.repos.setCurrent(r);
      return;
    }
    if (m.type === 'pushChecked') {
      if (this.batchRunning) return;
      this.batchRunning = true;
      const tree = [...this.repoTree];
      try {
        const ordered = await this.reposWithOutgoing(this.orderedCheckedRepos());
        if (!ordered.length) {
          void vscode.window.showInformationMessage('Nothing to push: every checked repository already matches its remote branch.');
          return;
        }
        if (m.force) {
          const lines = ordered.map(node => `${repoName(node.repo)}: ${describeSync(node.sync)}`);
          const ok = await vscode.window.showWarningMessage(`Force push ${ordered.length} repositor${ordered.length === 1 ? 'y' : 'ies'}?`,
            { modal: true, detail: `The remote branches are overwritten with your local branches (git push --force).\n\n${lines.join('\n')}` }, 'Force Push');
          if (!ok) return;
        }
        await this.preparePushBatch(ordered, tree);
        for (const [index, node] of ordered.entries()) {
          this.reportProgress(`Pushing ${index + 1}/${ordered.length}: ${repoName(node.repo)}`);
          await ops.push(node.repo, undefined, !!m.force, false, false, tree);
        }
      } finally {
        this.batchRunning = false;
        this.reportProgress('Push batch finished. Refreshing repositories…');
        void this.refresh();
      }
      return;
    }
    if (m.type === 'groupOperation') {
      for (const node of this.orderedCheckedRepos()) {
        const groups = this.groupsByRepo.get(node.repo.toLowerCase());
        const files = groups?.[m.group as Group] ?? [];
        if (!files.length) continue;
        const paths = files.map(f => f.path);
        if (m.operation === 'stage') await stagePaths(node.repo, paths);
        else if (m.operation === 'unstage') await unstagePaths(node.repo, paths);
        else if (m.operation === 'rollback') await rollback(node.repo, paths);
      }
      return;
    }
    const repo = this.targetRepo(m.repo) ?? this.repo;
    if (!repo) return;
    const paths: string[] = m.paths ?? [];
    if (['stage', 'unstage', 'stageAll', 'unstageAll', 'rollback', 'delete'].includes(m.type) && !this.checkedRepos.has(repo.toLowerCase())) return;
    const groups = this.groupsByRepo.get(repo.toLowerCase()) ?? { staged: [], unstaged: [], untracked: [], conflicts: [] };
    switch (m.type) {
      case 'refresh': this.statusCache.clear(); this.lastStatus = ''; return this.refresh();
      case 'stage': return stagePaths(repo, paths);
      case 'unstage': return unstagePaths(repo, paths);
      case 'stageAll':
        if (m.group === 'unstaged') await ops.run(repo, ['add', '-u']);
        else if (m.group === 'untracked') await stagePaths(repo, groups.untracked.map(f => f.path));
        else await stagePaths(repo, groups.unstaged.concat(groups.untracked).concat(groups.conflicts).map(f => f.path));
        return;
      case 'unstageAll': return unstagePaths(repo, groups.staged.map(f => f.path));
      case 'rollback': return rollback(repo, paths);
      case 'delete': return deleteUntracked(repo, paths);
      case 'diff': return openChangeDiff(repo, m.group, m.file);
      case 'open': {
        await vscode.window.showTextDocument(workUri(repo, m.path), { preview: false });
        return;
      }
      case 'update': return ops.pull(repo);
      case 'shelve': return ops.stash(repo, paths.length ? paths : undefined);
      case 'amend':
        if (m.checked && !String(m.message ?? '').trim()) {
          this.post({ type: 'setMessage', text: (await git(repo, ['log', '-1', '--format=%B'])).trimEnd() });
        }
        return;
      case 'history': return this.pickMessage(repo);
      case 'commit': return void this.commit(repo, String(m.message ?? ''), !!m.amend, !!m.push);
      case 'commitChecked': return this.commitChecked(String(m.message ?? ''), !!m.amend, !!m.push);
      case 'push': return ops.push(repo, undefined, false, false, false);
      case 'forcePush': return ops.push(repo, undefined, true, false, false);
      case 'stash':
        if (m.action === 'apply') return ops.stashApply(repo, m.ref, false);
        if (m.action === 'pop') return ops.stashApply(repo, m.ref, true);
        if (m.action === 'drop') return ops.stashDrop(repo, m.ref);
        if (m.action === 'changes') return showStashChanges(repo, m.ref);
        return;
      case 'stashFiles':
        this.post({ type: 'stashFiles', ref: m.ref, files: await stashFiles(repo, m.ref) });
        return;
      case 'stashDiff': {
        const f = m.file as FileChange;
        await diffFile(repo, f, `${m.ref}^1`, await stashRight(repo, m.ref, f));
        return;
      }
    }
  }

  private targetRepo(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return this.repoTree.find(r => samePath(r.repo, value))?.repo;
  }

  private orderedCheckedRepos(): RepoTreeNode[] {
    const order = dependencyOrder(this.repoTree, [...this.checkedRepos]);
    return order.map(repo => this.repoTree.find(r => samePath(r.repo, repo))!).filter(Boolean);
  }

  /** Repositories whose HEAD has commits the remote branch does not (ahead or diverged after rewriting history). */
  private async reposWithOutgoing(nodes: RepoTreeNode[]): Promise<(RepoTreeNode & { sync: SyncState })[]> {
    const states = await mapBounded(nodes, 4, async node => ({ ...node, sync: await syncState(node.repo) }));
    return states.filter(node => node.sync.ahead > 0);
  }

  private async preparePushBatch(ordered: RepoTreeNode[], tree: RepoTreeNode[]): Promise<void> {
    this.reportProgress('Checking branches and conflicts before pushing…');
    const root = tree.find(node => !node.parent);
    const preferredBranch = root ? await ops.currentBranch(root.repo) : undefined;
    const plans = await planPushPreparation(ordered.map(node => ({ repo: node.repo, preferredBranch })), git,
      async (repo, branches) => vscode.window.showQuickPick(branches, {
        title: `Choose the destination branch for detached work in ${repoName(repo)}`,
        placeHolder: 'Git Tool will verify that this branch can fast-forward without changing staged files.',
      }));
    for (const plan of plans) this.reportProgress(`Recovering ${repoName(plan.repo)} on ${plan.branch}`);
    await applyPushPreparation(plans, (repo, args) => git(repo, args, { log: true }));
  }

  private async commitChecked(message: string, amend: boolean, push: boolean): Promise<void> {
    if (!message.trim()) return void vscode.window.showWarningMessage('Enter a commit message.');
    if (this.batchRunning) return;
    this.batchRunning = true;
    try {
    const ordered = this.orderedCheckedRepos();
    const tree = [...this.repoTree];
    if (push) await this.preparePushBatch(ordered, tree);
    const selected = new Set(ordered.map(node => node.repo.toLowerCase()));
    for (const node of ordered) {
      for (const child of this.repoTree.filter(candidate => samePath(candidate.parent ?? '', node.repo))) {
        if (!selected.has(child.repo.toLowerCase()) && await this.parentNeedsChild(node.repo, child.repo, child.path)) {
          return void vscode.window.showWarningMessage(`Cannot process ${repoName(node.repo)}: check its submodule ${child.path || repoName(child.repo)} first.`);
        }
      }
    }
    // Inspect repositories concurrently before the dependency-ordered writes.
    // A single remaining file must not wait for serial branch/log/status calls
    // across every already-clean sibling in the workspace.
    const work = new Map(await mapBounded(ordered, 4, async node => {
      const groups = groupStatus(parseStatus(await git(node.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty'])));
      const outgoing = push && groups.staged.length === 0 && await this.hasOutgoing(node.repo);
      return [node.repo.toLowerCase(), { groups, outgoing }] as const;
    }));
    for (const [index, node] of ordered.entries()) {
      this.reportProgress(`${index + 1}/${ordered.length}: ${repoName(node.repo)} — checking staged changes`);
      // A child commit changes the parent's gitlink. Before processing a
      // checked parent, stage only those direct child gitlinks whose child
      // repository was part of this explicit operation.
      const checkedChildren = this.repoTree.filter(child =>
        samePath(child.parent ?? '', node.repo) && selected.has(child.repo.toLowerCase()) && child.path
      );
      if (checkedChildren.length) await stagePaths(node.repo, checkedChildren.map(child => child.path!));

      // Refresh the target repository after child work and gitlink staging;
      // the initial status snapshot is intentionally not reused across the
      // dependency sequence.
      const groups = checkedChildren.length
        ? groupStatus(parseStatus(await git(node.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty'])))
        : work.get(node.repo.toLowerCase())!.groups;
      this.groupsByRepo.set(node.repo.toLowerCase(), groups);
      const hasChanges = groups.staged.length > 0;
      const outgoing = !hasChanges && work.get(node.repo.toLowerCase())!.outgoing;
      if (!hasChanges && !outgoing) continue;
      if (groups?.conflicts.length) return void vscode.window.showWarningMessage(`Cannot commit ${repoName(node.repo)}: resolve its conflicts first.`);
      if (hasChanges) {
        if (!(await this.commit(node.repo, message, amend, push, tree))) return;
      } else if (push) {
        await ops.push(node.repo, undefined, false, false, false, tree);
      }
    }
    } finally {
      this.batchRunning = false;
      this.reportProgress('Batch ended. Refreshing repositories…');
      void this.refresh();
    }
  }

  private async hasOutgoing(repo: string): Promise<boolean> {
    const outgoing = await gitTry(repo, ['rev-list', '--max-count=1', '@{upstream}..HEAD']);
    if (outgoing !== undefined) return !!outgoing.trim();
    return !!(await gitTry(repo, ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes']))?.trim();
  }

  private async parentNeedsChild(parent: string, child: string, childPath?: string): Promise<boolean> {
    if (!childPath) return false;
    const childHead = (await gitTry(child, ['rev-parse', 'HEAD']))?.trim();
    if (!childHead) return false;
    const indexPointer = (await gitTry(parent, ['ls-files', '-s', '--', childPath]))?.match(/160000\s+([0-9a-f]+)/)?.[1];
    const committedPointer = (await gitTry(parent, ['ls-tree', 'HEAD', '--', childPath]))?.match(/160000\s+commit\s+([0-9a-f]+)/)?.[1];
    if (!indexPointer || indexPointer !== childHead || indexPointer === committedPointer) return false;
    const remoteContainsHead = (await gitTry(child, ['branch', '-r', '--contains', childHead]))?.trim();
    return !remoteContainsHead;
  }

  private async pickMessage(repo: string): Promise<void> {
    const saved = ctx.ext.globalState.get<string[]>(MESSAGES_KEY) ?? [];
    const recent = ((await gitTry(repo, ['log', '-n', '30', '--format=%B%x1e'])) ?? '').split('\x1e').map(s => s.trim()).filter(Boolean);
    const all = [...new Set([...saved, ...recent])];
    if (!all.length) return void vscode.window.showInformationMessage('No commit message history.');
    const p = await vscode.window.showQuickPick(all.map(t => ({ label: t.split('\n')[0], detail: t.includes('\n') ? t.split('\n').slice(1).join(' ').trim() : undefined, t })), {
      title: 'Commit Message History',
      matchOnDetail: true
    });
    if (p) this.post({ type: 'setMessage', text: p.t });
  }

  private async commit(repo: string, message: string, amend: boolean, push: boolean, knownTree?: RepoTreeNode[]): Promise<boolean> {
    if (!message.trim()) { void vscode.window.showWarningMessage('Enter a commit message.'); return false; }
    if (push && !knownTree) await this.preparePushBatch([{ repo }], this.repoTree);
    const groups = this.groupsByRepo.get(repo.toLowerCase()) ?? { staged: [], unstaged: [], untracked: [], conflicts: [] };
    if (groups.conflicts.length) { void vscode.window.showWarningMessage('Resolve the conflicts before committing.'); return false; }
    const args = ['commit', '-m', message];
    if (amend) args.push('--amend');
    if (!groups.staged.length && !amend) {
      if (!groups.unstaged.length) { void vscode.window.showWarningMessage('Nothing to commit. Stage unversioned files first.'); return false; }
      args.push('-a');
    }
    this.reportProgress(`Committing ${repoName(repo)}`);
    const out = await ops.run(repo, args, { title: `${amend ? 'Amending' : 'Committing'} ${repoName(repo)}` });
    if (out === undefined) return false;
    const saved = ctx.ext.globalState.get<string[]>(MESSAGES_KEY) ?? [];
    await ctx.ext.globalState.update(MESSAGES_KEY, [message, ...saved.filter(s => s !== message)].slice(0, 30));
    this.post({ type: 'committed' });
    vscode.window.setStatusBarMessage(`Git Tool: committed ${repoName(repo)}${push ? ' — pushing' : ''}`, 5000);
    if (push) {
      this.reportProgress(`Pushing ${repoName(repo)}`);
      await ops.push(repo, undefined, false, false, false, knownTree);
    }
    return true;
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
