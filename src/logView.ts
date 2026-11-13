import * as path from 'node:path';
import * as vscode from 'vscode';
import { ctx, LogHost } from './ctx';
import { git, gitTry, output } from './git';
import { webviewHtml } from './html';
import * as ops from './ops';
import { Commit, escapeBre, FileChange, LOG_FORMAT, parseLog, RefInfo } from './parse';
import { repoName, samePath } from './repos';
import { mapBounded } from './asyncCache';
import { mergeRepositoryLogs, RepositoryCommit } from './repositoryLog';
import { PersistentHistory, SnapshotStore } from './persistentHistory';
import { commitChanges, diffFile, EMPTY, nameStatus, openChanges, short } from './uris';

export interface LogFilter {
  text: string;
  regex: boolean;
  matchCase: boolean;
  branch?: string;
  range?: string;
  authors: { label: string; pattern: string }[];
  since?: string;
  until?: string;
  dateLabel?: string;
  paths: string[];
  order: 'date' | 'topo';
  firstParent: boolean;
  noMerges: boolean;
}

function defaultFilter(): LogFilter {
  return { text: '', regex: false, matchCase: false, authors: [], paths: [], order: 'date', firstParent: false, noMerges: false };
}

interface Details {
  left: string;
  right: string;
  files: FileChange[];
}

export type Part = 'branches' | 'commits' | 'details' | 'all';

const CACHED = new Set(['filter', 'branches', 'log', 'details', 'containing']);

/** State shared by the Branches, Log and Changes views (or one file "History" tab showing all parts). */
export class LogController implements vscode.Disposable {
  private readonly history = new PersistentHistory(ctx.ext?.globalStorageUri?.fsPath, message => output().appendLine(message));
  private readonly snapshots = new SnapshotStore(ctx.ext?.globalStorageUri?.fsPath);
  private readonly workspaceKey: string;
  private userEmail: string | undefined;
  private rebuildHistory = false;
  private selectedRepositories: string[] | undefined;
  private repositoryRoots: string[] = [];
  private logRepositories = new Set<string>();
  private logSequence = 0;
  private refreshPending?: Promise<boolean>;
  private refreshAgain = false;
  private refreshAgainForce = false;
  private lastLog = '';
  private detailRepo?: string;
  private graphLayout: 'compact' | 'lanes' = 'compact';
  repo: string | undefined;
  filter = defaultFilter();
  private max: number;
  private commits: Commit[] = [];
  private sig = '';
  private detailSeq = 0;
  private details: Details | undefined;
  private pendingSelect: string | undefined;
  private ready = false;
  private readonly views = new Map<vscode.Webview, Part>();
  private readonly readyViews = new Set<vscode.Webview>();
  private readonly cache = new Map<string, unknown>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly mode: 'main' | 'history', repo: string | undefined) {
    this.repo = repo;
    this.workspaceKey = 'log-view:' + JSON.stringify(vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath).sort() ?? [repo ?? '']);
    this.max = vscode.workspace.getConfiguration('vscgit').get<number>('logMaxCount', 1000);
    this.disposables.push(
      ctx.repos.onDidChangeMeta(r => {
        if (this.repo && (samePath(r, this.repo) || this.logRepositories.has(r.toLowerCase()))) {
          void this.history.unchanged(r).then(unchanged => this.refresh(!unchanged)).catch(ops.showGitError);
        }
      })
    );
    if (mode === 'main') {
      this.disposables.push(ctx.repos.onDidChangeCurrent(r => {
        if (r && (!this.repo || !samePath(r, this.repo))) {
          this.repo = r;
          this.filter = defaultFilter();
          void this.refresh(true);
        }
      }));
    }
  }

  attach(webview: vscode.Webview, part: Part): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.ext.extensionUri, 'media')] };
    webview.html = webviewHtml(webview, ctx.ext.extensionUri, 'log');
    this.views.set(webview, part);
    const sub = webview.onDidReceiveMessage(m => this.onMessage(m, webview, part).catch(ops.showGitError));
    return { dispose: () => { sub.dispose(); this.views.delete(webview); this.readyViews.delete(webview); } };
  }

  get hasViews(): boolean {
    return this.views.size > 0;
  }

  post(msg: { type: string; [k: string]: unknown }): void {
    if (CACHED.has(msg.type)) this.cache.set(msg.type, msg);
    for (const w of this.views.keys()) if (this.readyViews.has(w)) void w.postMessage(msg);
  }

  /** Applies an external request (branch/range/select). */
  async apply(repo: string, opts: { branch?: string; range?: string; select?: string }): Promise<void> {
    this.repo = repo;
    if (opts.branch !== undefined || opts.range !== undefined) this.filter = { ...defaultFilter(), branch: opts.branch, range: opts.range };
    this.pendingSelect = opts.select;
    if (!this.ready) return;
    await this.refresh(true);
    if (opts.select && !this.commits.some(c => c.h === opts.select)) {
      // Not among the loaded commits: show the history starting at that commit.
      this.filter = { ...defaultFilter(), branch: opts.select };
      this.pendingSelect = opts.select;
      await this.refresh(true);
    }
  }

  private async onMessage(m: any, webview: vscode.Webview, part: Part): Promise<void> {
    const repo = this.repo;
    switch (m.type) {
      case 'ready':
        this.readyViews.add(webview);
        void webview.postMessage({ type: 'init', opts: ctx.ext.globalState.get('vscgit.logUi') ?? {}, mode: this.mode, part });
        if (this.ready) {
          for (const t of CACHED) {
            const c = this.cache.get(t) as Record<string, unknown> | undefined;
            if (c) void webview.postMessage(t === 'log' ? { ...c, select: undefined, keepScroll: false } : c);
          }
          return;
        }
        this.ready = true;
        await this.restoreSnapshot();
        if (!this.repo && this.mode === 'main') {
          await ctx.repos.ready;
          this.repo = ctx.repos.current ?? (await ctx.repos.require());
        }
        void this.refresh(true).catch(ops.showGitError);
        return;
      case 'locate':
        this.post({ type: 'reveal', hash: m.hash, name: m.name });
        return;
      case 'saveUi':
        await ctx.ext.globalState.update('vscgit.logUi', m.opts);
        return;
      case 'selectRepo': {
        const r = await ctx.repos.pick();
        if (!r) return;
        if (this.mode === 'main') ctx.repos.setCurrent(r);
        this.repo = r;
        if (this.mode === 'main') this.selectedRepositories = [r];
        this.filter = defaultFilter();
        await this.refresh(true);
        return;
      }
    }
    if (!repo) return;
    switch (m.type) {
      case 'menu': {
        if (m.what !== 'paths' && m.what !== 'repositories') break;
        const tree = await ctx.repos.treeOf(repo);
        void webview.postMessage({ type: 'menuData', what: m.what, items: tree.map(node => ({
          label: repoName(node.repo), value: node.repo, description: node.repo,
          checked: this.selectedRepositories === undefined || this.selectedRepositories.some(r => samePath(r, node.repo))
        })) });
        break;
      }
      case 'setRepositories': {
        if (!Array.isArray(m.repositories)) break;
        const tree = await ctx.repos.treeOf(repo);
        this.selectedRepositories = tree.filter(n => m.repositories.some((r: unknown) => typeof r === 'string' && samePath(r, n.repo))).map(n => n.repo);
        if (this.selectedRepositories.length === tree.length) this.selectedRepositories = undefined;
        await this.reloadLog();
        break;
      }
      case 'focusRepository': {
        const selected = this.repositoryRoots.find(r => typeof m.repo === 'string' && samePath(r, m.repo));
        if (!selected) break;
        this.selectedRepositories = [selected];
        await this.reloadLog();
        break;
      }
      case 'setLogOptions':
        if (m.order === 'date' || m.order === 'topo') this.filter.order = m.order;
        if (typeof m.firstParent === 'boolean') this.filter.firstParent = m.firstParent;
        if (typeof m.noMerges === 'boolean') this.filter.noMerges = m.noMerges;
        if (m.graphLayout === 'compact' || m.graphLayout === 'lanes') this.graphLayout = m.graphLayout;
        await this.reloadLog();
        break;
      case 'setAuthors':
        if (!Array.isArray(m.authors)) break;
        this.filter.authors = m.authors.filter((a: any) => typeof a.label === 'string' && typeof a.pattern === 'string');
        await this.reloadLog();
        break;
      case 'setDate':
        this.filter.since = typeof m.since === 'string' && m.since ? m.since : undefined;
        this.filter.until = typeof m.until === 'string' && m.until ? m.until + ' 23:59:59' : undefined;
        this.filter.dateLabel = typeof m.label === 'string' ? m.label : undefined;
        await this.reloadLog();
        break;
      case 'refresh':
        await this.refresh(true);
        break;
      case 'rebuildHistory':
        this.rebuildHistory = true;
        await this.refresh(true);
        break;
      case 'select':
        await this.sendDetails(m.hashes as string[]);
        break;
      case 'openFile': {
        const d = this.details;
        if (d) await diffFile(this.detailRepo ?? repo, m.file as FileChange, d.left, d.right);
        break;
      }
      case 'showAllChanges': {
        const d = this.details;
        if (d) await openChanges(this.detailRepo ?? repo, `${short(d.left)} \u2194 ${short(d.right)}`, d.files, d.left, d.right);
        break;
      }
      case 'openCommit': {
        const commit = this.commits.find(c => c.h === m.hash) as RepositoryCommit | undefined;
        if (!commit) break;
        const owner = commit.repo ?? repo;
        const left = commit.p[0] ?? EMPTY;
        const files = await commitChanges(owner, commit.h, commit.p);
        if (files.length === 1) await diffFile(owner, files[0], left, commit.h);
        else await openChanges(owner, `Changes in ${short(commit.h)}`, files, left, commit.h);
        break;
      }
      case 'commitStats': {
        const commit = this.commits.find(c => c.h === m.hash) as RepositoryCommit | undefined;
        if (!commit) break;
        const owner = commit.repo ?? repo;
        const args = commit.p.length ? ['diff', '--shortstat', commit.p[0], commit.h] : ['show', '--shortstat', '--format=', commit.h];
        const out = await this.history.read(owner, args, async () => await gitTry(owner, args) ?? '');
        void webview.postMessage({ type: 'commitStats', hash: commit.h, text: out.trim() || 'No file changes' });
        break;
      }
      case 'text':
        this.filter.text = String(m.text ?? '').trim();
        this.filter.regex = !!m.regex;
        this.filter.matchCase = !!m.matchCase;
        await this.reloadLog();
        break;
      case 'clear':
        if (m.what === 'branch') { this.filter.branch = undefined; this.filter.range = undefined; }
        if (m.what === 'user') this.filter.authors = [];
        if (m.what === 'date') { this.filter.since = this.filter.until = this.filter.dateLabel = undefined; }
        if (m.what === 'paths') { this.filter.paths = []; this.selectedRepositories = undefined; }
        await this.reloadLog();
        break;
      case 'pick':
        if (await this.pick(repo, m.what)) await this.reloadLog();
        break;
      case 'branchFilter':
        this.filter.branch = m.ref || undefined;
        this.filter.range = undefined;
        await this.reloadLog();
        break;
      case 'branchAction':
        if (m.action === 'new') await ops.newBranch(repo, m.name || undefined);
        else if (m.action === 'fetch') await ops.fetch(repo);
        else await ops.branchAction(repo, m.action, { kind: m.kind, name: m.name });
        break;
      case 'commitAction':
        if (m.action === 'cherryPick') {
          const selected = (m.hashes as string[]).map(hash => this.commits.find(c => c.h === hash) as RepositoryCommit | undefined);
          const sources = new Set(selected.map(commit => commit?.repo ?? repo));
          if (sources.size > 1) return void vscode.window.showWarningMessage('Choose commits from one repository for Cherry-Pick.');
          await ops.cherryPickMany([...sources][0] ?? repo, m.hashes as string[]);
        }
        break;
      case 'loadMore':
        this.max *= 2;
        await this.reloadLog(true);
        break;
    }
  }

  private async pick(repo: string, what: string): Promise<boolean> {
    const f = this.filter;
    if (what === 'branch') {
      const all = await ops.refs(repo);
      type It = vscode.QuickPickItem & { v?: string };
      const items: It[] = [{ label: 'All', description: 'all branches and tags' }, { label: 'HEAD', description: 'current branch', v: 'HEAD' }];
      for (const [label, kind] of [['Local', 'local'], ['Remote', 'remote'], ['Tags', 'tag']] as const) {
        const list = all.filter(r => r.kind === kind);
        if (!list.length) continue;
        items.push({ label, kind: vscode.QuickPickItemKind.Separator });
        items.push(...list.map(r => ({ label: r.name, v: r.name })));
      }
      const p = await vscode.window.showQuickPick(items, { title: 'Filter by branch' });
      if (!p) return false;
      f.branch = p.v;
      f.range = undefined;
      return true;
    }
    if (what === 'user') {
      const me = await ops.meAuthor(repo);
      const out = (await gitTry(repo, ['shortlog', '-sne', '--branches', '--remotes', 'HEAD'])) ?? '';
      type It = vscode.QuickPickItem & { a: { label: string; pattern: string } };
      const seen = new Set<string>();
      const items: It[] = [{ label: 'me', description: me.replace(/\\/g, ''), a: { label: 'me', pattern: me }, picked: f.authors.some(a => a.pattern === me) }];
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(.*?)\s+<([^>]*)>\s*$/.exec(line);
        if (!m || seen.has(m[3].toLowerCase())) continue;
        seen.add(m[3].toLowerCase());
        const pattern = escapeBre(m[3] || m[2]);
        items.push({ label: m[2], description: `${m[3]}  (${m[1]})`, a: { label: m[2], pattern }, picked: f.authors.some(a => a.pattern === pattern) });
      }
      const p = await vscode.window.showQuickPick(items, { title: 'Filter by user (select none for all users)', canPickMany: true, matchOnDescription: true });
      if (!p) return false;
      f.authors = p.map(i => i.a);
      return true;
    }
    if (what === 'date') {
      const p = await vscode.window.showQuickPick(
        [
          { label: 'All' },
          { label: 'Last 24 hours', since: '24 hours ago' },
          { label: 'Last 7 days', since: '7 days ago' },
          { label: 'Last 30 days', since: '30 days ago' },
          { label: 'Last year', since: '1 year ago' },
          { label: 'Select...', custom: true }
        ] as (vscode.QuickPickItem & { since?: string; custom?: boolean })[],
        { title: 'Filter by date' }
      );
      if (!p) return false;
      if (p.custom) {
        const re = /^(\d{4}-\d{2}-\d{2})?$/;
        const v = (s: string) => (re.test(s.trim()) ? undefined : 'Use YYYY-MM-DD');
        const since = await vscode.window.showInputBox({ title: 'Since (YYYY-MM-DD, empty = no limit)', value: f.since && re.test(f.since) ? f.since : '', validateInput: v });
        if (since === undefined) return false;
        const until = await vscode.window.showInputBox({ title: 'Until (YYYY-MM-DD, empty = no limit)', validateInput: v });
        if (until === undefined) return false;
        f.since = since.trim() || undefined;
        f.until = until.trim() ? `${until.trim()} 23:59:59` : undefined;
        f.dateLabel = [since.trim() || '...', until.trim() || '...'].join(' \u2013 ');
      } else {
        f.since = p.since;
        f.until = undefined;
        f.dateLabel = p.since ? p.label : undefined;
      }
      return true;
    }
    if (what === 'paths') {
      const tree = await ctx.repos.treeOf(repo);
      const items = tree.map(node => ({ label: repoName(node.repo), description: node.repo, repo: node.repo,
        picked: this.selectedRepositories === undefined || this.selectedRepositories.some(r => samePath(r, node.repo)) }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Paths — repositories', canPickMany: true, matchOnDescription: true,
        placeHolder: 'All repositories are selected by default. Use the top checkbox to select or clear all.',
      });
      if (!picked) return false;
      this.selectedRepositories = picked.length === items.length ? undefined : picked.map(item => item.repo);
      return true;
    }
    if (what === 'options') {
      const items: (vscode.QuickPickItem & { k: string })[] = [
        { label: 'Topological order', description: 'keep branches together instead of sorting by date', k: 'topo', picked: f.order === 'topo' },
        { label: 'First parent only', description: '--first-parent', k: 'fp', picked: f.firstParent },
        { label: 'Hide merge commits', description: '--no-merges', k: 'nm', picked: f.noMerges }
      ];
      const p = await vscode.window.showQuickPick(items, { title: 'Log options', canPickMany: true });
      if (!p) return false;
      const ks = new Set(p.map(i => i.k));
      f.order = ks.has('topo') ? 'topo' : 'date';
      f.firstParent = ks.has('fp');
      f.noMerges = ks.has('nm');
      return true;
    }
    return false;
  }

  private filterState(): { type: string; [k: string]: unknown } {
    const f = this.filter;
    return {
      type: 'filter',
      repo: this.repo,
      repoName: this.mode === 'main' && this.selectedRepositories?.length !== 1 ? 'All repositories' : repoName(this.selectedRepositories?.[0] ?? this.repo ?? ''),
      text: f.text,
      regex: f.regex,
      matchCase: f.matchCase,
      branch: f.range ? f.range : f.branch,
      user: f.authors.map(a => a.label).join(', '),
      date: f.dateLabel,
      paths: this.mode === 'main' ? this.selectedRepositories === undefined ? 'All repositories' : `${this.selectedRepositories.length} repositories` : f.paths.join(', '),
      options: [f.order === 'topo' ? 'topo' : '', f.firstParent ? 'first parent' : '', f.noMerges ? 'no merges' : ''].filter(Boolean).join(', '),
      order: f.order, firstParent: f.firstParent, noMerges: f.noMerges, graphLayout: this.graphLayout,
      authors: f.authors, since: f.since, until: f.until
    };
  }

  /** Reloads branches and log; skipped when refs did not change unless forced. Returns false when skipped. */
  async refresh(force: boolean, keepScroll = false): Promise<boolean> {
    if (this.refreshPending) {
      this.refreshAgain = true;
      this.refreshAgainForce ||= force;
      return this.refreshPending;
    }
    this.refreshPending = this.refreshNow(force, keepScroll);
    try { return await this.refreshPending; }
    finally {
      this.refreshPending = undefined;
      if (this.refreshAgain) {
        const again = this.refreshAgainForce;
        this.refreshAgain = this.refreshAgainForce = false;
        void this.refresh(again, true);
      }
    }
  }

  private async refreshNow(force: boolean, keepScroll: boolean): Promise<boolean> {
    const repo = this.repo;
    if (!repo || !this.ready) {
      if (this.ready) this.post({ type: 'empty' });
      return false;
    }
    const state = JSON.parse(await this.history.read(repo, ['branch-state-v1'], async () => {
      const [allRefs, head, cur, me] = await Promise.all([ops.refs(repo), gitTry(repo, ['rev-parse', 'HEAD']), ops.currentBranch(repo), ops.userEmail(repo)]);
      return JSON.stringify({ allRefs, head, cur, me });
    }, this.rebuildHistory)) as { allRefs: RefInfo[]; head?: string; cur?: string; me: string };
    const { allRefs, head, cur } = state;
    this.userEmail = state.me;
    const headHash = head?.trim() ?? '';
    const sig = headHash + '|' + (cur ?? '') + '|' + allRefs.map(r => r.kind + r.name + r.hash + (r.track ?? '')).join('|') + '|' + [...ops.favorites(repo)].join(',');
    if (!force && sig === this.sig) return false;
    this.sig = sig;
    this.post(this.filterState());
    this.sendBranches(repo, allRefs, headHash, cur);
    await this.sendLog(repo, headHash, keepScroll);
    return true;
  }

  private sendBranches(repo: string, all: RefInfo[], head: string, cur: string | undefined): void {
    const fav = ops.favorites(repo);
    const map = (r: RefInfo) => ({ name: r.name, hash: r.hash, upstream: r.upstream, track: r.track, favorite: fav.has(`${r.kind}:${r.name}`) });
    this.post({
      type: 'branches',
      repo,
      current: cur,
      head,
      local: all.filter(r => r.kind === 'local').map(map),
      remote: all.filter(r => r.kind === 'remote').map(map),
      tags: all.filter(r => r.kind === 'tag').sort((a, b) => b.date - a.date).map(map)
    });
  }

  /** Filters must not wait behind an unrelated workspace scan or refs refresh. */
  private async reloadLog(keepScroll = false): Promise<void> {
    if (!this.repo || !this.ready) return;
    ++this.logSequence;
    this.post(this.filterState());
    const cached = this.cache.get('branches') as { head?: string } | undefined;
    const head = cached?.head ?? (await gitTry(this.repo, ['rev-parse', 'HEAD']))?.trim() ?? '';
    await this.sendLog(this.repo, head, keepScroll);
  }

  private async sendLog(repo: string, head: string, keepScroll: boolean): Promise<void> {
    const started = Date.now();
    let gitLogLoads = 0;
    const sequence = ++this.logSequence;
    if (!keepScroll) this.post({ type: 'loading', text: 'Loading repository histories…' });
    const f = { ...this.filter, authors: [...this.filter.authors], paths: [...this.filter.paths] };
    const repositoryScope = this.selectedRepositories?.slice();
    const rebuild = this.rebuildHistory;
    this.rebuildHistory = false;
    const a = ['log', `--format=${LOG_FORMAT}`, `-n${this.max + 1}`, f.order === 'topo' ? '--topo-order' : '--date-order'];
    if (f.firstParent) a.push('--first-parent');
    if (f.noMerges) a.push('--no-merges');
    for (const au of f.authors) a.push(`--author=${au.pattern}`);
    if (f.since) a.push(`--since=${f.since}`);
    if (f.until) a.push(`--until=${f.until}`);
    let hashHit: string | undefined;
    if (f.text) {
      if (/^[0-9a-f]{4,64}$/i.test(f.text)) hashHit = (await gitTry(repo, ['rev-parse', '--verify', '--quiet', `${f.text}^{commit}`]))?.trim();
      a.push(`--grep=${f.text}`, f.regex ? '-E' : '-F');
      if (!f.matchCase) a.push('-i');
    }
    if (f.range) a.push(f.range);
    else if (f.branch) a.push(f.branch);
    else a.push('--branches', '--remotes', '--tags', 'HEAD');
    if (this.mode === 'history' && f.paths.length === 1 && !f.text && !(await isDir(repo, f.paths[0]))) a.push('--follow');
    a.push('--', ...f.paths);
    let commits: Commit[];
    let error: string | undefined;
    try {
      if (this.mode === 'main') {
        const tree = repositoryScope === undefined ? await ctx.repos.treeOf(repo) : repositoryScope.map(repo => ({ repo }));
        if (sequence !== this.logSequence) return;
        if (repositoryScope === undefined) this.repositoryRoots = tree.map(n => n.repo);
        const selected = tree.filter(node => repositoryScope === undefined || repositoryScope.some(r => samePath(r, node.repo)));
        this.logRepositories = new Set(selected.map(node => node.repo.toLowerCase()));
        const logs = await mapBounded(selected, 4, async node => {
          if (sequence !== this.logSequence) return { repo: node.repo, commits: [] };
          try {
            return { repo: node.repo, commits: parseLog(await this.history.read(node.repo, a, () => { gitLogLoads++; return git(node.repo, a); }, rebuild)) };
          } catch (e) {
            error = `${error ? error + '\n' : ''}${repoName(node.repo)}: ${e instanceof Error ? e.message : String(e)}`;
            return { repo: node.repo, commits: [] };
          }
        });
        if (sequence !== this.logSequence) return;
        commits = mergeRepositoryLogs(logs, this.max + 1, f.order);
      } else commits = parseLog(await this.history.read(repo, a, () => git(repo, a), rebuild));
    } catch (e) {
      commits = [];
      error = e instanceof Error ? e.message : String(e);
    }
    const hasMore = commits.length > this.max;
    if (hasMore) commits.length = this.max;
    if (hashHit && !commits.some(c => c.h === hashHit)) {
      const extra = parseLog(await git(repo, ['log', '-1', `--format=${LOG_FORMAT}`, hashHit]));
      commits = [...extra, ...commits];
      this.pendingSelect ??= hashHit;
    }
    const me = (this.userEmail ?? await ops.userEmail(repo)).toLowerCase();
    if (sequence !== this.logSequence) return;
    this.commits = commits;
    const graph = !f.text && !f.authors.length && !f.since && !f.until && !f.paths.length;
    const select = this.pendingSelect;
    this.pendingSelect = undefined;
    const message = {
      type: 'log',
      commits,
      head,
      me,
      hasMore,
      graph,
      graphLayout: this.graphLayout,
      select,
      keepScroll,
      highlight: f.paths,
      error
    };
    // A background refresh that found nothing new must not rebuild the webview list.
    const json = JSON.stringify({ ...message, keepScroll: true });
    if (keepScroll && !select && json === this.lastLog) {
      this.post({ type: 'loaded' });
      return;
    }
    this.lastLog = json;
    this.post(message);
    if (!error) await this.saveSnapshot();
    if (ctx.ext?.globalStorageUri) output().appendLine(`[History cache] ${this.logRepositories.size} repositories, ${gitLogLoads} Git history loads, ${Date.now() - started}ms. Unchanged histories remain on disk across restarts.`);
  }

  private async saveSnapshot(): Promise<void> {
    if (this.mode !== 'main' || !this.repo || !ctx.ext?.globalStorageUri) return;
    const messages = [...this.cache.values()].filter((m: any) => ['filter', 'branches', 'log', 'details'].includes(m.type));
    try {
      await this.snapshots.write(this.workspaceKey, { repo: this.repo, roots: this.repositoryRoots, filter: this.filter,
        selectedRepositories: this.selectedRepositories, graphLayout: this.graphLayout, messages });
    } catch (e) { output().appendLine(`Workspace view cache could not be saved: ${String(e)}`); }
  }

  private async restoreSnapshot(): Promise<void> {
    const started = Date.now();
    if (this.mode !== 'main' || !ctx.ext?.globalStorageUri) return;
    const saved = await this.snapshots.read<any>(this.workspaceKey);
    if (!saved || typeof saved.repo !== 'string' || !Array.isArray(saved.roots) || !Array.isArray(saved.messages) || !saved.filter) return;
    if (this.repo && !samePath(this.repo, saved.repo)) return;
    const log = saved.messages.find((m: any) => m.type === 'log');
    if (!log || !Array.isArray(log.commits) || !log.commits.every((c: any) => typeof c.h === 'string' && Array.isArray(c.p) && typeof c.ae === 'string')) return;
    this.repo = saved.repo;
    this.repositoryRoots = saved.roots;
    this.filter = { ...defaultFilter(), ...saved.filter };
    this.selectedRepositories = saved.selectedRepositories;
    this.graphLayout = saved.graphLayout === 'lanes' ? 'lanes' : 'compact';
    this.commits = log.commits;
    this.userEmail = log.me;
    this.logRepositories = new Set(this.repositoryRoots.map(r => r.toLowerCase()));
    for (const message of saved.messages) if (CACHED.has(message.type)) this.post({ ...message, keepScroll: true, select: undefined });
    this.post({ type: 'loading', text: 'Saved history restored · checking for new commits…' });
    output().appendLine(`[History cache] Restored ${log.commits.length} commits from disk in ${Date.now() - started}ms before checking Git.`);
  }

  private async sendDetails(hashes: string[]): Promise<void> {
    const selected = hashes.map(hash => this.commits.find(commit => commit.h === hash) as RepositoryCommit | undefined);
    const repo = selected[0]?.repo ?? this.repo;
    this.detailRepo = repo;
    if (selected.some(commit => commit?.repo && !samePath(commit.repo, repo ?? ''))) {
      this.post({ type: 'details', none: true });
      return;
    }
    const seq = ++this.detailSeq;
    if (!repo || !hashes.length) {
      this.details = undefined;
      this.post({ type: 'details', none: true });
      return;
    }
    if (hashes.length === 1) {
      const h = hashes[0];
      const args = ['show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B', h];
      const out = await this.history.read(repo, args, () => git(repo, args));
      const [hash, parents, an, ae, at, cn, ce, ct, refs, ...body] = out.split('\x1f');
      const ps = parents ? parents.split(' ') : [];
      const files = JSON.parse(await this.history.read(repo, ['commit-changes-v1', hash, ...ps], async () => JSON.stringify(await commitChanges(repo, hash, ps)))) as FileChange[];
      if (seq !== this.detailSeq) return;
      this.details = { left: ps[0] ?? EMPTY, right: hash, files };
      this.post({
        type: 'details', repo, left: this.details.left, right: hash, files,
        info: { hash, parents: ps, an, ae, at: Number(at), cn, ce, ct: Number(ct), refs, message: body.join('\x1f').trimEnd() },
        highlight: this.filter.paths
      });
      const containsArgs = ['branch', '-a', '--contains', hash, '--format=%(refname:short)'];
      const contains = await this.history.read(repo, containsArgs, async () => await gitTry(repo, containsArgs) ?? '');
      if (seq === this.detailSeq && contains !== undefined) {
        this.post({ type: 'containing', hash, branches: contains.split('\n').filter(b => b && !b.endsWith('/HEAD')) });
      }
      return;
    }
    // Several commits: combined changes from the parent of the oldest to the newest.
    const right = hashes[0];
    const oldest = hashes[hashes.length - 1];
    const left = (await gitTry(repo, ['rev-parse', '--verify', '--quiet', `${oldest}^`]))?.trim() || EMPTY;
    const files = left === EMPTY ? await commitChanges(repo, right, []) : await nameStatus(repo, [left, right]);
    if (seq !== this.detailSeq) return;
    this.details = { left, right, files };
    this.post({ type: 'details', repo, left, right, files, compare: true, count: hashes.length, range: true, highlight: this.filter.paths });
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}

async function isDir(repo: string, rel: string): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(vscode.Uri.file(path.join(repo, rel)))).type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

/** Hosts the Branches / Log / Changes panel views (one shared state) and file history editor tabs. */
export class LogViews implements LogHost, vscode.Disposable {
  private readonly main = new LogController('main', undefined);
  private readonly histories = new Set<LogController>();

  provider(part: Part): vscode.WebviewViewProvider {
    return {
      resolveWebviewView: (view: vscode.WebviewView) => {
        const d = this.main.attach(view.webview, part);
        view.onDidDispose(() => d.dispose());
      }
    };
  }

  /** Moves the selection of the log showing `hash` to its parent (1) or child (-1). */
  nav(hash: string, dir: number): void {
    for (const c of [this.main, ...this.histories]) c.post({ type: 'nav', hash, dir });
  }

  async show(repo: string, opts: { branch?: string; range?: string; paths?: string[]; select?: string; title?: string } = {}): Promise<void> {
    if (opts.paths?.length) {
      const panel = vscode.window.createWebviewPanel('vscgit.history', `History: ${opts.title ?? path.basename(opts.paths[0])}`, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true
      });
      panel.iconPath = vscode.Uri.joinPath(ctx.ext.extensionUri, 'media', 'git-tool.svg');
      const c = new LogController('history', repo);
      c.filter = { ...defaultFilter(), paths: opts.paths };
      c.attach(panel.webview, 'all');
      this.histories.add(c);
      panel.onDidDispose(() => {
        c.dispose();
        this.histories.delete(c);
      });
      return;
    }
    ctx.repos.setCurrent(repo);
    await vscode.commands.executeCommand('vscgit.log.focus');
    await this.main.apply(repo, opts);
  }

  dispose(): void {
    this.main.dispose();
    this.histories.forEach(h => h.dispose());
  }
}
