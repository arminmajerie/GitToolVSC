import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ctx } from './ctx';
import { git, GitError, gitOk, gitTry, output } from './git';
import { escapeBre, parseRefs, parseStashList, REF_FORMAT, RefInfo, repoFromUrl, StashEntry } from './parse';
import { repoName, RepoTreeNode } from './repos';
import { nameStatus, openChanges, short } from './uris';
import { withIndexLockRetry } from './indexLockRetry';
import { applyPushPreparation, planPushPreparation } from './pushPreparation';

export type RefKind = RefInfo['kind'] | 'rev';

export interface RefArg {
  kind: RefKind;
  name: string;
}

function firstLines(s: string, n = 6): string {
  return s.split(/\r?\n/).filter(l => l.trim()).slice(0, n).join('\n');
}

export function showGitError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  void vscode.window.showErrorMessage(`Git: ${firstLines(msg)}`, 'Show Output').then(c => {
    if (c) output().show();
  });
}

export interface RunOpts {
  title?: string;
  /** Show a notification progress (for network operations). */
  notify?: boolean;
  /** Return errors to the caller instead of showing them. */
  throwErrors?: boolean;
  input?: string;
  env?: Record<string, string>;
}

const runQueues = new Map<string, Promise<void>>();

/** Runs a git command that changes state: logs it, shows progress and errors and refreshes the views. */
export async function run(repo: string, args: string[], opts: RunOpts = {}): Promise<string | undefined> {
  const title = opts.title ?? `git ${args[0]}`;
  const key = repo.toLowerCase();
  const previous = runQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  runQueues.set(key, tail);
  await previous;
  try {
    return await vscode.window.withProgress(
      { location: opts.notify ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title },
      async () => {
        return withIndexLockRetry(
          () => git(repo, args, { log: true, input: opts.input, env: opts.env }),
          () => vscode.window.setStatusBarMessage(`Git Tool: waiting for another Git operation in ${repoName(repo)}…`),
        );
      }
    );
  } catch (e) {
    if (opts.throwErrors) throw e;
    showGitError(e);
    return undefined;
  } finally {
    ctx.repos.changed(repo);
    release();
    if (runQueues.get(key) === tail) runQueues.delete(key);
  }
}

export async function currentBranch(repo: string): Promise<string | undefined> {
  return (await gitTry(repo, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || undefined;
}

export async function refs(repo: string): Promise<RefInfo[]> {
  return parseRefs(await git(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']));
}

export async function remotes(repo: string): Promise<string[]> {
  return (await git(repo, ['remote'])).split(/\r?\n/).filter(Boolean);
}

/** A parent commit is only publishable when every gitlink it records is reachable remotely. */
async function unpublishedSubmodules(repo: string, knownTree?: RepoTreeNode[]): Promise<string[]> {
  const tree = knownTree ?? await ctx.repos.treeOf(repo);
  const blockers: string[] = [];
  for (const child of tree) {
    if (!child.parent || !child.path) continue;
    const relative = path.relative(repo, child.repo);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const line = await gitTry(child.parent, ['ls-tree', '-z', 'HEAD', '--', child.path]);
    const pointer = line?.match(/^160000 commit ([0-9a-f]+)\t/)?.[1];
    if (!pointer) continue;
    // Test the commit recorded by the parent, even when the child's checkout
    // has since moved. merge-base does not accept --remotes.
    const published = await git(child.repo, ['for-each-ref', `--contains=${pointer}`, '--format=%(refname)', 'refs/remotes/']);
    if (!published.trim()) blockers.push(child.path);
  }
  return blockers;
}

export async function userEmail(repo: string): Promise<string> {
  return ((await gitTry(repo, ['config', 'user.email'])) ?? '').trim();
}

export async function userName(repo: string): Promise<string> {
  return ((await gitTry(repo, ['config', 'user.name'])) ?? '').trim();
}

async function gitPathExists(repo: string, p: string): Promise<boolean> {
  const out = await gitTry(repo, ['rev-parse', '--git-path', p]);
  return !!out && fs.existsSync(path.resolve(repo, out.trim()));
}

function remoteOf(remoteRef: string, remoteNames: string[]): { remote: string; branch: string } {
  const r = remoteNames.filter(n => remoteRef.startsWith(n + '/')).sort((a, b) => b.length - a.length)[0]
    ?? remoteRef.slice(0, remoteRef.indexOf('/'));
  return { remote: r, branch: remoteRef.slice(r.length + 1) };
}

// ---------- favorites ----------

const DEFAULT_FAVORITES = ['local:master', 'local:main', 'remote:origin/master', 'remote:origin/main'];

function favKey(repo: string): string {
  return 'vscgit.favorites:' + repo.toLowerCase();
}

export function favorites(repo: string): Set<string> {
  return new Set(ctx.ext.globalState.get<string[]>(favKey(repo)) ?? DEFAULT_FAVORITES);
}

export async function toggleFavorite(repo: string, ref: RefArg): Promise<void> {
  const f = favorites(repo);
  const k = `${ref.kind}:${ref.name}`;
  if (f.has(k)) f.delete(k);
  else f.add(k);
  await ctx.ext.globalState.update(favKey(repo), [...f]);
  ctx.repos.changed(repo);
}

// ---------- pickers ----------

interface RefItem extends vscode.QuickPickItem {
  ref?: RefArg;
}

export async function pickRef(
  repo: string,
  title: string,
  opts: { local?: boolean; remote?: boolean; tags?: boolean; custom?: boolean } = { local: true, remote: true, tags: true }
): Promise<RefArg | undefined> {
  const all = await refs(repo);
  const cur = await currentBranch(repo);
  const fav = favorites(repo);
  const items: RefItem[] = [];
  const section = (label: string, kind: RefInfo['kind'], icon: string) => {
    const list = all.filter(r => r.kind === kind);
    if (!list.length) return;
    list.sort((a, b) => Number(fav.has(`${kind}:${b.name}`)) - Number(fav.has(`${kind}:${a.name}`)) || (kind === 'tag' ? b.date - a.date : a.name.localeCompare(b.name)));
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    for (const r of list) {
      const star = fav.has(`${kind}:${r.name}`) ? '$(star-full) ' : '';
      items.push({
        label: `${star}$(${r.name === cur && kind === 'local' ? 'check' : icon}) ${r.name}`,
        description: [r.upstream, r.track].filter(Boolean).join(' '),
        ref: { kind, name: r.name }
      });
    }
  };
  if (opts.local) section('Local', 'local', 'git-branch');
  if (opts.remote) section('Remote', 'remote', 'cloud');
  if (opts.tags) section('Tags', 'tag', 'tag');

  const qp = vscode.window.createQuickPick<RefItem>();
  qp.title = title;
  qp.placeholder = opts.custom ? 'Branch, tag or revision (type a hash or expression and press Enter)' : 'Select a branch';
  qp.items = items;
  qp.matchOnDescription = true;
  return new Promise<RefArg | undefined>(resolve => {
    let done = false;
    qp.onDidAccept(async () => {
      const sel = qp.selectedItems[0]?.ref;
      if (sel) {
        done = true;
        resolve(sel);
        qp.hide();
        return;
      }
      const v = qp.value.trim();
      if (opts.custom && v && (await gitOk(repo, ['rev-parse', '--verify', '--quiet', `${v}^{commit}`]))) {
        done = true;
        resolve({ kind: 'rev', name: v });
        qp.hide();
      }
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

async function branchNameInput(repo: string, title: string, value = ''): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    title,
    prompt: 'Branch name',
    value,
    validateInput: async v => {
      const t = v.trim();
      if (!t) return 'Enter a branch name';
      return (await gitOk(repo, ['check-ref-format', '--branch', t])) ? undefined : 'Invalid branch name';
    }
  });
  return name?.trim() || undefined;
}

// ---------- branches ----------

const OVERWRITE = /would be overwritten by checkout|commit your changes or stash them|overwritten by merge/i;

/** Switches branches; offers Smart Checkout (stash/switch/unstash) when local changes block it. */
async function switchSmart(repo: string, args: string[]): Promise<void> {
  try {
    await run(repo, args, { throwErrors: true });
  } catch (e) {
    if (!(e instanceof GitError) || !OVERWRITE.test(e.message)) {
      showGitError(e);
      return;
    }
    const c = await vscode.window.showWarningMessage(
      'Local changes would be overwritten by checkout.',
      { modal: true, detail: firstLines(e.message, 12) + '\n\nSmart Checkout stashes the changes, checks out and unstashes them again.' },
      'Smart Checkout',
      'Force Checkout'
    );
    if (c === 'Smart Checkout') {
      if ((await run(repo, ['stash', 'push', '-m', 'Smart checkout'])) === undefined) return;
      const ok = (await run(repo, args)) !== undefined;
      const popped = await run(repo, ['stash', 'pop']);
      if (popped === undefined) vscode.window.showWarningMessage('The unstash had conflicts. Resolve them; the changes are still in the stash list.');
      else if (ok) vscode.window.setStatusBarMessage('Smart checkout done', 4000);
    } else if (c === 'Force Checkout') {
      const sure = await vscode.window.showWarningMessage('Discard the local changes that block the checkout?', { modal: true }, 'Discard and Checkout');
      if (sure) await run(repo, [...args, '--discard-changes']);
    }
  }
}

export async function checkout(repo: string, ref: RefArg): Promise<void> {
  if (ref.kind === 'remote') {
    const { branch } = remoteOf(ref.name, await remotes(repo));
    if (await gitOk(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) await switchSmart(repo, ['switch', branch]);
    else await switchSmart(repo, ['switch', '--track', ref.name]);
  } else if (ref.kind === 'local') {
    await switchSmart(repo, ['switch', ref.name]);
  } else {
    const c = await vscode.window.showWarningMessage(`Checkout ${short(ref.name)}? HEAD will be detached.`, { modal: true }, 'Checkout');
    if (c) await switchSmart(repo, ['switch', '--detach', ref.name]);
  }
}

export async function newBranch(repo: string, startPoint?: string): Promise<void> {
  const name = await branchNameInput(repo, startPoint ? `New Branch from ${short(startPoint)}` : 'New Branch');
  if (!name) return;
  const args = ['switch', '-c', name];
  if (startPoint) args.push(startPoint);
  await switchSmart(repo, args);
}

export async function renameBranch(repo: string, name: string): Promise<void> {
  const n = await branchNameInput(repo, `Rename Branch ${name}`, name);
  if (n && n !== name) await run(repo, ['branch', '-m', name, n]);
}

export async function deleteRef(repo: string, ref: RefArg): Promise<void> {
  if (ref.kind === 'local') {
    try {
      await run(repo, ['branch', '-d', ref.name], { throwErrors: true });
      vscode.window.setStatusBarMessage(`Deleted branch ${ref.name}`, 4000);
    } catch (e) {
      if (e instanceof GitError && /not fully merged/i.test(e.message)) {
        const c = await vscode.window.showWarningMessage(`Branch "${ref.name}" is not fully merged. Delete it anyway?`, { modal: true }, 'Delete');
        if (c) await run(repo, ['branch', '-D', ref.name]);
      } else showGitError(e);
    }
  } else if (ref.kind === 'remote') {
    const { remote, branch } = remoteOf(ref.name, await remotes(repo));
    const c = await vscode.window.showWarningMessage(`Delete remote branch "${ref.name}" on ${remote}?`, { modal: true }, 'Delete');
    if (c) await run(repo, ['push', remote, '--delete', branch], { notify: true, title: `Deleting ${ref.name}` });
  } else if (ref.kind === 'tag') {
    const c = await vscode.window.showWarningMessage(`Delete tag "${ref.name}"?`, { modal: true }, 'Delete Locally', 'Delete Locally and on origin');
    if (!c) return;
    await run(repo, ['tag', '-d', ref.name]);
    if (c !== 'Delete Locally') await run(repo, ['push', 'origin', '--delete', `refs/tags/${ref.name}`], { notify: true });
  }
}

export async function merge(repo: string, ref?: string): Promise<void> {
  if (await gitPathExists(repo, 'MERGE_HEAD')) {
    const c = await vscode.window.showQuickPick(['Continue Merge (commit)', 'Abort Merge'], { title: 'A merge is in progress' });
    if (c === 'Abort Merge') await run(repo, ['merge', '--abort']);
    else if (c) await run(repo, ['commit', '--no-edit']);
    return;
  }
  if (await gitPathExists(repo, 'CHERRY_PICK_HEAD')) {
    const c = await vscode.window.showQuickPick(['Continue Cherry-Pick', 'Abort Cherry-Pick'], { title: 'A cherry-pick is in progress' });
    if (c) await run(repo, ['cherry-pick', c.startsWith('Abort') ? '--abort' : '--continue']);
    return;
  }
  const target = ref ?? (await pickRef(repo, `Merge into ${(await currentBranch(repo)) ?? 'HEAD'}`, { local: true, remote: true, tags: true, custom: true }))?.name;
  if (!target) return;
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Merge', args: [] as string[], description: 'fast-forward when possible' },
      { label: 'Merge --no-ff', args: ['--no-ff'], description: 'always create a merge commit' },
      { label: 'Merge --ff-only', args: ['--ff-only'], description: 'only fast-forward' },
      { label: 'Squash', args: ['--squash'], description: 'stage the changes without committing' }
    ],
    { title: `Merge ${target} into ${(await currentBranch(repo)) ?? 'HEAD'}` }
  );
  if (!mode) return;
  await run(repo, ['merge', ...mode.args, target], { title: `Merging ${target}` });
}

export async function rebase(repo: string, onto?: string): Promise<void> {
  if ((await gitPathExists(repo, 'rebase-merge')) || (await gitPathExists(repo, 'rebase-apply'))) {
    const c = await vscode.window.showQuickPick(['Continue Rebase', 'Skip Commit', 'Abort Rebase'], { title: 'A rebase is in progress' });
    if (c) await run(repo, ['rebase', c.startsWith('Continue') ? '--continue' : c.startsWith('Skip') ? '--skip' : '--abort']);
    return;
  }
  const target = onto ?? (await pickRef(repo, `Rebase ${(await currentBranch(repo)) ?? 'HEAD'} onto`, { local: true, remote: true, tags: true, custom: true }))?.name;
  if (!target) return;
  await run(repo, ['rebase', target], { title: `Rebasing onto ${target}` });
}

export async function checkoutAndRebase(repo: string, branch: string): Promise<void> {
  const cur = await currentBranch(repo);
  if (!cur) return void vscode.window.showErrorMessage('HEAD is detached.');
  await run(repo, ['rebase', cur, branch], { title: `Rebasing ${branch} onto ${cur}` });
}

export async function updateRef(repo: string, ref: RefArg): Promise<void> {
  const names = await remotes(repo);
  if (ref.kind === 'remote') {
    const { remote, branch } = remoteOf(ref.name, names);
    await run(repo, ['fetch', remote, branch], { notify: true, title: `Fetching ${ref.name}` });
    return;
  }
  if (ref.kind !== 'local') return;
  if (ref.name === (await currentBranch(repo))) return pull(repo);
  const up = (await gitTry(repo, ['rev-parse', '--abbrev-ref', `${ref.name}@{upstream}`]))?.trim();
  if (!up) return void vscode.window.showWarningMessage(`Branch "${ref.name}" has no upstream.`);
  const { remote, branch } = remoteOf(up, names);
  await run(repo, ['fetch', remote, `${branch}:${ref.name}`], { notify: true, title: `Updating ${ref.name}` });
}

export async function compareWithCurrent(repo: string, ref: string): Promise<void> {
  const counts = (await git(repo, ['rev-list', '--left-right', '--count', `HEAD...${ref}`])).trim().split(/\s+/).map(Number);
  const cur = (await currentBranch(repo)) ?? 'HEAD';
  await ctx.log.show(repo, { range: `HEAD..${ref}` });
  const c = await vscode.window.showInformationMessage(
    `"${ref}" has ${counts[1]} commit(s) not in "${cur}"; "${cur}" has ${counts[0]} commit(s) not in "${ref}".`,
    'Show Files Diff',
    `Show Commits Only in ${cur}`
  );
  if (c === 'Show Files Diff') await openChanges(repo, `${cur} \u2194 ${ref}`, await nameStatus(repo, ['HEAD', ref]), 'HEAD', ref);
  else if (c) await ctx.log.show(repo, { range: `${ref}..HEAD` });
}

export async function diffWithWorking(repo: string, ref: string): Promise<void> {
  await openChanges(repo, `${short(ref)} \u2194 Local`, await nameStatus(repo, [ref]), ref, undefined);
}

// ---------- sync ----------

export async function push(repo: string, branch?: string, force = false, confirm = true, notify = true, knownTree?: RepoTreeNode[]): Promise<void> {
  const blockers = await unpublishedSubmodules(repo, knownTree);
  if (blockers.length) {
    if (!confirm) throw new Error(`${repoName(repo)}: push blocked by unpublished submodules: ${blockers.join(', ')}`);
    return void vscode.window.showErrorMessage(`Push blocked: push these submodules first: ${blockers.join(', ')}`);
  }
  let b = branch ?? (await currentBranch(repo));
  if (!b) {
    const root = knownTree?.find(node => !node.parent);
    const preferredBranch = root && root.repo !== repo ? await currentBranch(root.repo) : undefined;
    const plans = await planPushPreparation([{ repo, preferredBranch }], git,
      async (_, branches) => vscode.window.showQuickPick(branches, { title: `Choose a destination branch for ${repoName(repo)}` }));
    await applyPushPreparation(plans, (cwd, args) => git(cwd, args, { log: true }));
    b = await currentBranch(repo);
    // A clean detached commit that is already published needs no push.
    if (!b && plans.length === 0) return;
    if (!b) throw new Error(`${repoName(repo)}: could not attach the prepared branch. Retry Push.`);
  }
  const names = await remotes(repo);
  if (!names.length) { if (!confirm) throw new Error(`${repoName(repo)}: no remote configured.`); return void vscode.window.showErrorMessage('The repository has no remotes. Use Manage Remotes first.'); }
  const up = (await gitTry(repo, ['rev-parse', '--abbrev-ref', `${b}@{upstream}`]))?.trim();
  let remote: string;
  let target: string;
  if (up) ({ remote, branch: target } = remoteOf(up, names));
  else {
    const r = names.length === 1 ? names[0] : await vscode.window.showQuickPick(names, { title: `Push ${b} to remote` });
    if (!r) return;
    remote = r;
    target = b;
  }
  const range = up ? [`${up}..${b}`] : [b, '--not', '--remotes'];
  const commits = confirm ? (await git(repo, ['log', '--format=%h  %s', '-n', '30', ...range])).trim() : '';
  const count = commits ? commits.split('\n').length : 0;
  let c: string | undefined = force ? 'Force Push' : 'Push';
  if (confirm) {
    c = await vscode.window.showInformationMessage(
      `Push ${b} \u2192 ${remote}/${target}${up ? '' : ' (new)'}`,
      { modal: true, detail: count ? `${count >= 30 ? '30+' : count} commit(s):\n\n${commits}` : 'No new commits.' },
      'Push',
      'Force Push (with lease)'
    );
  }
  if (!c) return;
  const args = ['push'];
  if (!up) args.push('-u');
  if (force) args.push('--force');
  else if (c !== 'Push') args.push('--force-with-lease');
  args.push(remote, `${b}:${target}`);
  if ((await run(repo, args, { notify, throwErrors: !confirm, title: `Pushing ${b} (${repoName(repo)})` })) !== undefined) vscode.window.setStatusBarMessage(`Pushed ${b}`, 4000);
}

export async function pull(repo: string): Promise<void> {
  const last = ctx.ext.globalState.get<string>('vscgit.pullMode') ?? '--no-rebase';
  const modes = [
    { label: 'Merge', description: 'git pull --no-rebase', arg: '--no-rebase' },
    { label: 'Rebase', description: 'git pull --rebase', arg: '--rebase' },
    { label: 'Fast-forward only', description: 'git pull --ff-only', arg: '--ff-only' }
  ].sort((a, b) => Number(b.arg === last) - Number(a.arg === last));
  const m = await vscode.window.showQuickPick(modes, { title: `Pull into ${(await currentBranch(repo)) ?? 'HEAD'} (${repoName(repo)})` });
  if (!m) return;
  await ctx.ext.globalState.update('vscgit.pullMode', m.arg);
  if ((await run(repo, ['pull', m.arg], { notify: true, title: 'Pulling' })) !== undefined) vscode.window.setStatusBarMessage('Pulled', 4000);
}

export async function fetch(repo: string): Promise<void> {
  const args = ['fetch', '--all'];
  if (vscode.workspace.getConfiguration('vscgit').get<boolean>('fetchPrune', true)) args.push('--prune');
  if ((await run(repo, args, { notify: true, title: `Fetching ${repoName(repo)}` })) !== undefined) vscode.window.setStatusBarMessage('Fetched all remotes', 4000);
}

// ---------- tags / reset ----------

export async function newTag(repo: string, at?: string): Promise<void> {
  const name = (await vscode.window.showInputBox({
    title: at ? `New Tag on ${short(at)}` : 'New Tag on HEAD',
    prompt: 'Tag name',
    validateInput: async v => (v.trim() && (await gitOk(repo, ['check-ref-format', `refs/tags/${v.trim()}`])) ? undefined : 'Invalid tag name')
  }))?.trim();
  if (!name) return;
  const msg = await vscode.window.showInputBox({ title: `Tag ${name}`, prompt: 'Message (leave empty for a lightweight tag)' });
  if (msg === undefined) return;
  const args = msg.trim() ? ['tag', '-a', name, '-m', msg] : ['tag', name];
  if (at) args.push(at);
  if ((await run(repo, args)) === undefined) return;
  const c = await vscode.window.showInformationMessage(`Created tag ${name}.`, 'Push Tag');
  if (c) await run(repo, ['push', 'origin', `refs/tags/${name}`], { notify: true, title: `Pushing tag ${name}` });
}

export async function resetHead(repo: string, to?: string): Promise<void> {
  const target = to ?? (await vscode.window.showInputBox({ title: 'Reset HEAD', prompt: 'Reset current branch to', value: 'HEAD' }))?.trim();
  if (!target) return;
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Mixed', arg: '--mixed', description: 'keep changes in the working tree, unstage them' },
      { label: 'Soft', arg: '--soft', description: 'keep changes staged' },
      { label: 'Keep', arg: '--keep', description: 'keep local changes, fail if they conflict' },
      { label: 'Hard', arg: '--hard', description: 'DISCARD all local changes' }
    ],
    { title: `Reset ${(await currentBranch(repo)) ?? 'HEAD'} to ${short(target)}` }
  );
  if (!mode) return;
  if (mode.arg === '--hard') {
    const c = await vscode.window.showWarningMessage(`Hard reset to ${short(target)}? All local changes are lost.`, { modal: true }, 'Reset');
    if (!c) return;
  }
  await run(repo, ['reset', mode.arg, target]);
}

// ---------- stash (shelf) ----------

export async function stashList(repo: string): Promise<StashEntry[]> {
  return parseStashList(await git(repo, ['stash', 'list', '--format=%gd%x1f%s%x1f%ct']));
}

export async function stash(repo: string, paths?: string[]): Promise<void> {
  const msg = await vscode.window.showInputBox({ title: 'Stash Changes', prompt: 'Message', placeHolder: paths?.length ? paths.join(', ') : 'WIP' });
  if (msg === undefined) return;
  const opt = await vscode.window.showQuickPick(
    [
      { label: 'Stash', args: [] as string[] },
      { label: 'Stash including untracked files', args: ['--include-untracked'] },
      { label: 'Stash and keep staged changes', args: ['--keep-index'] }
    ],
    { title: 'Stash Changes' }
  );
  if (!opt) return;
  const args = ['stash', 'push', ...opt.args];
  if (msg.trim()) args.push('-m', msg.trim());
  if (paths?.length) args.push('--', ...paths);
  await run(repo, args);
}

export async function stashApply(repo: string, ref: string, pop: boolean, index = false): Promise<void> {
  const args = ['stash', pop ? 'pop' : 'apply'];
  if (index) args.push('--index');
  args.push(ref);
  await run(repo, args);
}

export async function stashDrop(repo: string, ref: string): Promise<void> {
  const c = await vscode.window.showWarningMessage(`Delete ${ref}?`, { modal: true }, 'Delete');
  if (c) await run(repo, ['stash', 'drop', ref]);
}

export async function unstash(repo: string): Promise<void> {
  const list = await stashList(repo);
  if (!list.length) return void vscode.window.showInformationMessage('There are no stashes.');
  const s = await vscode.window.showQuickPick(
    list.map(e => ({ label: e.ref, description: e.message, detail: new Date(e.date * 1000).toLocaleString(), e })),
    { title: 'Unstash Changes', matchOnDescription: true }
  );
  if (!s) return;
  const a = await vscode.window.showQuickPick(['Apply', 'Pop', 'Pop and restore index', 'Create branch from stash...', 'Drop'], { title: s.e.ref });
  if (a === 'Apply') await stashApply(repo, s.e.ref, false);
  else if (a === 'Pop') await stashApply(repo, s.e.ref, true);
  else if (a === 'Pop and restore index') await stashApply(repo, s.e.ref, true, true);
  else if (a === 'Drop') await stashDrop(repo, s.e.ref);
  else if (a) {
    const n = await branchNameInput(repo, `Branch from ${s.e.ref}`);
    if (n) await run(repo, ['stash', 'branch', n, s.e.ref]);
  }
}

// ---------- remotes / clone ----------

export async function manageRemotes(repo: string): Promise<void> {
  const out = await git(repo, ['remote', '-v']);
  const list = new Map<string, string>();
  for (const l of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(l);
    if (m) list.set(m[1], m[2]);
  }
  const items: (vscode.QuickPickItem & { remote?: string })[] = [...list].map(([n, u]) => ({ label: `$(cloud) ${n}`, description: u, remote: n }));
  items.push({ label: '$(add) Add Remote...' });
  const s = await vscode.window.showQuickPick(items, { title: `Remotes of ${repoName(repo)}` });
  if (!s) return;
  if (!s.remote) {
    const name = (await vscode.window.showInputBox({ title: 'Add Remote', prompt: 'Name', value: list.size ? '' : 'origin' }))?.trim();
    if (!name) return;
    const url = (await vscode.window.showInputBox({ title: `Add Remote ${name}`, prompt: 'URL' }))?.trim();
    if (url) await run(repo, ['remote', 'add', name, url]);
    return;
  }
  const r = s.remote;
  const a = await vscode.window.showQuickPick(['Change URL...', 'Rename...', 'Copy URL', 'Remove'], { title: r });
  if (a === 'Change URL...') {
    const url = (await vscode.window.showInputBox({ title: `URL of ${r}`, value: list.get(r) }))?.trim();
    if (url) await run(repo, ['remote', 'set-url', r, url]);
  } else if (a === 'Rename...') {
    const n = (await vscode.window.showInputBox({ title: `Rename ${r}`, value: r }))?.trim();
    if (n && n !== r) await run(repo, ['remote', 'rename', r, n]);
  } else if (a === 'Copy URL') {
    await vscode.env.clipboard.writeText(list.get(r) ?? '');
  } else if (a === 'Remove') {
    const c = await vscode.window.showWarningMessage(`Remove remote "${r}"?`, { modal: true }, 'Remove');
    if (c) await run(repo, ['remote', 'remove', r]);
  }
}

export async function clone(): Promise<void> {
  const url = (await vscode.window.showInputBox({ title: 'Clone Repository', prompt: 'Repository URL', ignoreFocusOut: true }))?.trim();
  if (!url) return;
  const parent = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: 'Clone into this folder',
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
  });
  if (!parent?.length) return;
  const name = (await vscode.window.showInputBox({ title: 'Directory name', value: repoFromUrl(url) }))?.trim();
  if (!name) return;
  const dest = path.join(parent[0].fsPath, name);
  if (fs.existsSync(dest)) return void vscode.window.showErrorMessage(`${dest} already exists.`);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cloning ${url}` }, () =>
      git(parent[0].fsPath, ['clone', url, name], { log: true })
    );
  } catch (e) {
    return showGitError(e);
  }
  const c = await vscode.window.showInformationMessage(`Cloned into ${dest}.`, 'Open', 'Open in New Window', 'Add to Workspace');
  const uri = vscode.Uri.file(dest);
  if (c === 'Open') await vscode.commands.executeCommand('vscode.openFolder', uri);
  else if (c === 'Open in New Window') await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  else if (c === 'Add to Workspace') vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri });
}

// ---------- commits ----------

async function isMerge(repo: string, hash: string): Promise<boolean> {
  return (await git(repo, ['show', '-s', '--format=%P', hash])).trim().split(' ').length > 1;
}

export async function cherryPick(repo: string, hash: string): Promise<void> {
  const args = ['cherry-pick'];
  if (await isMerge(repo, hash)) args.push('-m', '1');
  args.push(hash);
  await run(repo, args, { title: `Cherry-picking ${short(hash)}` });
}

/** Cherry-picks commits given in log order (newest first), applying the oldest first. */
export async function cherryPickMany(repo: string, hashes: string[]): Promise<void> {
  if (!hashes.length) return;
  if (hashes.length === 1) return cherryPick(repo, hashes[0]);
  if ((await git(repo, ['rev-list', '--no-walk', '--merges', ...hashes])).trim()) {
    return void vscode.window.showErrorMessage('Cherry-pick merge commits one at a time.');
  }
  await run(repo, ['cherry-pick', ...[...hashes].reverse()], { title: `Cherry-picking ${hashes.length} commits` });
}

export async function revert(repo: string, hash: string): Promise<void> {
  const args = ['revert', '--no-edit'];
  if (await isMerge(repo, hash)) args.push('-m', '1');
  args.push(hash);
  await run(repo, args, { title: `Reverting ${short(hash)}` });
}

export async function undoCommit(repo: string): Promise<void> {
  const pushed = (await gitTry(repo, ['branch', '-r', '--contains', 'HEAD']))?.trim();
  const c = await vscode.window.showWarningMessage(
    'Undo the last commit? Its changes stay staged.',
    { modal: true, detail: pushed ? `The commit is already pushed to: ${pushed.split(/\s+/).join(', ')}` : undefined },
    'Undo Commit'
  );
  if (c) await run(repo, ['reset', '--soft', 'HEAD~1']);
}

export async function editHeadMessage(repo: string): Promise<void> {
  const msg = await git(repo, ['log', '-1', '--format=%B']);
  const [subject, ...rest] = msg.replace(/\s+$/, '').split('\n');
  const s = await vscode.window.showInputBox({ title: 'Edit Commit Message', value: subject });
  if (s === undefined || !s.trim()) return;
  await run(repo, ['commit', '--amend', '--only', '-m', [s, ...rest].join('\n')]);
}

export async function createPatch(repo: string, hash: string): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(repo, `${short(hash)}.patch`)),
    filters: { Patch: ['patch', 'diff'] }
  });
  if (!uri) return;
  const patch = await git(repo, ['format-patch', '-1', '--stdout', hash]);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, 'utf8'));
  vscode.window.setStatusBarMessage(`Saved ${uri.fsPath}`, 4000);
}

/** Author filter value for "me". */
export async function meAuthor(repo: string): Promise<string> {
  const e = await userEmail(repo);
  return e ? escapeBre(e) : escapeBre(await userName(repo));
}

// ---------- branch popup and dispatch ----------

export type BranchAction =
  | 'checkout' | 'newFrom' | 'checkoutRebase' | 'compare' | 'diffWorking' | 'rebaseOnto' | 'merge'
  | 'update' | 'push' | 'rename' | 'delete' | 'favorite' | 'showLog' | 'copyName';

export async function branchAction(repo: string, action: BranchAction, ref: RefArg): Promise<void> {
  switch (action) {
    case 'checkout': return checkout(repo, ref);
    case 'newFrom': return newBranch(repo, ref.name);
    case 'checkoutRebase': return checkoutAndRebase(repo, ref.name);
    case 'compare': return compareWithCurrent(repo, ref.name);
    case 'diffWorking': return diffWithWorking(repo, ref.name);
    case 'rebaseOnto': return rebase(repo, ref.name);
    case 'merge': return merge(repo, ref.name);
    case 'update': return updateRef(repo, ref);
    case 'push': return push(repo, ref.name);
    case 'rename': return renameBranch(repo, ref.name);
    case 'delete': return deleteRef(repo, ref);
    case 'favorite': return toggleFavorite(repo, ref);
    case 'showLog': return ctx.log.show(repo, { branch: ref.name });
    case 'copyName': return vscode.env.clipboard.writeText(ref.name);
  }
}

/** Branches popup (status bar). */
export async function branchesPopup(repo: string): Promise<void> {
  const cur = await currentBranch(repo);
  const NEW = { kind: 'rev', name: '\0new' } as RefArg;
  const qp = vscode.window.createQuickPick<RefItem>();
  const all = await refs(repo);
  const fav = favorites(repo);
  const items: RefItem[] = [
    { label: '$(add) New Branch...', ref: NEW },
    { label: '$(tag) Checkout Tag or Revision...', ref: { kind: 'rev', name: '\0rev' } }
  ];
  for (const [label, kind] of [['Local', 'local'], ['Remote', 'remote']] as const) {
    const list = all.filter(r => r.kind === kind)
      .sort((a, b) => Number(fav.has(`${kind}:${b.name}`)) - Number(fav.has(`${kind}:${a.name}`)) || a.name.localeCompare(b.name));
    if (!list.length) continue;
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    for (const r of list) {
      const icon = kind === 'local' && r.name === cur ? 'check' : fav.has(`${kind}:${r.name}`) ? 'star-full' : 'git-branch';
      items.push({ label: `$(${icon}) ${r.name}`, description: [r.track, r.upstream].filter(Boolean).join(' '), ref: { kind, name: r.name } });
    }
  }
  qp.title = `Branches of ${repoName(repo)} \u2014 current: ${cur ?? 'detached HEAD'}`;
  qp.placeholder = 'Search branches';
  qp.items = items;
  qp.matchOnDescription = true;
  const picked = await new Promise<RefArg | undefined>(resolve => {
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems[0]?.ref);
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
  if (!picked) return;
  if (picked.name === '\0new') return newBranch(repo);
  if (picked.name === '\0rev') {
    const r = await pickRef(repo, 'Checkout Tag or Revision', { tags: true, custom: true });
    if (r) await checkout(repo, r.kind === 'tag' ? { kind: 'rev', name: r.name } : r);
    return;
  }
  const isCur = picked.kind === 'local' && picked.name === cur;
  const acts: { label: string; a: BranchAction }[] = [];
  if (!isCur) acts.push({ label: 'Checkout', a: 'checkout' });
  acts.push({ label: `New Branch from '${picked.name}'...`, a: 'newFrom' });
  if (!isCur && picked.kind === 'local') acts.push({ label: `Checkout and Rebase onto '${cur}'`, a: 'checkoutRebase' });
  if (!isCur) acts.push({ label: `Compare with '${cur ?? 'HEAD'}'`, a: 'compare' });
  acts.push({ label: 'Show Diff with Working Tree', a: 'diffWorking' }, { label: 'Show in Log', a: 'showLog' });
  if (!isCur) acts.push({ label: `Rebase '${cur}' onto '${picked.name}'`, a: 'rebaseOnto' }, { label: `Merge '${picked.name}' into '${cur}'`, a: 'merge' });
  acts.push({ label: 'Update', a: 'update' });
  if (picked.kind === 'local') acts.push({ label: 'Push...', a: 'push' }, { label: 'Rename...', a: 'rename' });
  if (!isCur) acts.push({ label: 'Delete', a: 'delete' });
  acts.push({ label: fav.has(`${picked.kind}:${picked.name}`) ? 'Unmark as Favorite' : 'Mark as Favorite', a: 'favorite' });
  const act = await vscode.window.showQuickPick(acts, { title: picked.name });
  if (act) await branchAction(repo, act.a, picked);
}
