import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitTry, output } from './git';
import { AsyncCache, mapBounded } from './asyncCache';
import { PersistentTopology } from './persistentHistory';

export function norm(p: string): string {
  return path.normalize(p).replace(/[\\/]+$/, '');
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function relPath(repo: string, abs: string): string {
  return path.relative(repo, abs).split(path.sep).join('/');
}

export function repoName(repo: string): string {
  return path.basename(repo);
}

export interface RepoTreeNode {
  repo: string;
  parent?: string;
  /** Path from the parent repository to this submodule, when applicable. */
  path?: string;
}

export interface MissingSubmodule {
  parent: string;
  path: string;
  url?: string;
}

export class Repos implements vscode.Disposable {
  private readonly persistentTopology: PersistentTopology;
  private readonly trees = new AsyncCache<RepoTreeNode[]>(300000);
  private readonly missing = new AsyncCache<MissingSubmodule[]>();
  private readonly moduleConfigs = new AsyncCache<string>(300000);

  private moduleConfig(repo: string): Promise<string> {
    return this.moduleConfigs.get(repo.toLowerCase(), async () => {
      // Almost every submodule is a leaf. Avoid starting Git just to discover
      // that its .gitmodules file does not exist.
      try { await fs.promises.access(path.join(repo, '.gitmodules')); } catch { return ''; }
      return await gitTry(repo, ['config', '--file', '.gitmodules', '--get-regexp', '\\.(path|url)$']) ?? '';
    });
  }
  private readonly rootCache = new Map<string, string | null>();
  private known: string[] = [];
  private _current: string | undefined;
  /** Resolves when the initial repository discovery has finished. */
  ready: Promise<void> = Promise.resolve();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pendingMeta = new Set<string>();
  private readonly metaWatched = new Map<string, boolean>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeCurrent = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeCurrent = this._onDidChangeCurrent.event;
  private readonly _onDidChange = new vscode.EventEmitter<string>();
  /** Fired (debounced) when the working tree, index or refs of a repository may have changed. */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidChangeMeta = new vscode.EventEmitter<string>();
  /** Fired (debounced, before onDidChange) when Git metadata (HEAD, refs, index, config, stash) may have changed. */
  readonly onDidChangeMeta = this._onDidChangeMeta.event;

  constructor(private readonly state: vscode.Memento, storage?: string) {
    this.persistentTopology = new PersistentTopology(storage);
    const w = vscode.workspace.createFileSystemWatcher('**/*');
    const on = (u: vscode.Uri) => this.onFsEvent(u.fsPath);
    this.disposables.push(w, w.onDidChange(on), w.onDidCreate(on), w.onDidDelete(on));
    this.disposables.push(vscode.workspace.onDidSaveTextDocument(d => this.onFsEvent(d.uri.fsPath)));
    this.disposables.push(vscode.window.onDidChangeWindowState(s => {
      if (s.focused && this._current) this.changed(this._current);
    }));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(e => this.followEditor(e)));
  }

  get current(): string | undefined {
    return this._current;
  }

  async init(): Promise<void> {
    await this.discover();
    const saved = this.state.get<string>('vscgit.currentRepo');
    if (saved && this.known.some(k => samePath(k, saved))) this.setCurrent(saved);
    await this.followEditor(vscode.window.activeTextEditor);
    if (!this._current && this.known.length) this.setCurrent(this.known[0]);
  }

  setCurrent(repo: string | undefined): void {
    if (repo && this._current && samePath(repo, this._current)) return;
    this._current = repo;
    if (repo && !this.known.some(k => samePath(k, repo))) this.known.push(repo);
    void this.state.update('vscgit.currentRepo', repo);
    this._onDidChangeCurrent.fire(repo);
  }

  private async followEditor(e: vscode.TextEditor | undefined): Promise<void> {
    if (!e || e.document.uri.scheme !== 'file') return;
    if (!vscode.workspace.getConfiguration('vscgit').get<boolean>('followActiveEditor', true)) return;
    const root = await this.rootOf(e.document.uri.fsPath);
    if (root) this.setCurrent(root);
  }

  /** Returns the repository root that contains the given file or folder. */
  async rootOf(fsPath: string): Promise<string | undefined> {
    let dir = fsPath;
    try {
      if (!(await fs.promises.stat(fsPath)).isDirectory()) dir = path.dirname(fsPath);
    } catch {
      dir = path.dirname(fsPath);
    }
    dir = norm(dir);
    const key = dir.toLowerCase();
    if (this.rootCache.has(key)) return this.rootCache.get(key) ?? undefined;
    const out = await gitTry(dir, ['rev-parse', '--show-toplevel']);
    const root = out?.trim() ? norm(out.trim()) : null;
    this.rootCache.set(key, root);
    if (root && !this.known.some(k => samePath(k, root))) this.known.push(root);
    return root ?? undefined;
  }

  async discover(): Promise<string[]> {
    const depth = vscode.workspace.getConfiguration('vscgit').get<number>('repositoryScanDepth', 1);
    const found: string[] = [];
    const visit = async (dir: string, level: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some(e => e.name === '.git')) found.push(norm(dir));
      if (level >= depth) return;
      const dirs = entries.filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'));
      await mapBounded(dirs, 8, e => visit(path.join(dir, e.name), level + 1));
    };
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      const root = await this.rootOf(f.uri.fsPath);
      if (root) found.push(root);
      await visit(f.uri.fsPath, 0);
    }
    for (const r of found) if (!this.known.some(k => samePath(k, r))) this.known.push(r);
    this.known.sort((a, b) => repoName(a).localeCompare(repoName(b)));
    return this.known;
  }

  get all(): string[] {
    return this.known;
  }

  /** Finds the outermost superproject that declares the repository as a submodule. */
  private async graphRoot(repo: string): Promise<string> {
    let current = norm(repo);
    for (;;) {
      let found: string | undefined;
      let ancestor = path.dirname(current);
      while (ancestor && !samePath(ancestor, path.dirname(ancestor))) {
        const ancestorRepo = await this.rootOf(ancestor);
        if (ancestorRepo && samePath(ancestorRepo, ancestor) && await this.declaresChild(ancestor, current)) {
          found = ancestor;
          break;
        }
        ancestor = path.dirname(ancestor);
      }
      if (!found) return current;
      current = found;
    }
  }

  private async declaresChild(parent: string, nested: string): Promise<boolean> {
    const text = await gitTry(parent, ['config', '--file', '.gitmodules', '--get-regexp', '\\.(path)$']) ?? '';
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const i = line.indexOf(' ');
      if (i < 0) continue;
      const childDir = norm(path.resolve(parent, line.slice(i + 1).trim()));
      const relative = path.relative(childDir, nested);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const childRepo = await this.rootOf(childDir);
      if (childRepo && samePath(childRepo, childDir)) return true;
    }
    return false;
  }

  /** Returns a superproject and all initialized Git submodules below it. */
  async treeOf(root: string): Promise<RepoTreeNode[]> {
    return this.trees.get(root.toLowerCase(), async () => {
      const saved = await this.persistentTopology.read(root);
      if (saved) {
        for (const node of saved) {
          this.rootCache.set(norm(node.repo).toLowerCase(), node.repo);
          if (!this.known.some(k => samePath(k, node.repo))) this.known.push(node.repo);
        }
        return saved;
      }
      const nodes = await this.discoverTree(root);
      const probes = new Set(nodes.map(node => node.repo));
      await mapBounded(nodes, 4, async node => {
        for (const line of (await this.moduleConfig(node.repo)).split(/\r?\n/)) {
          if (/^submodule\..*\.path\s/.test(line)) probes.add(path.resolve(node.repo, line.slice(line.search(/\s/) + 1).trim()));
        }
      });
      try {
        await this.persistentTopology.write(root, nodes, [...probes]);
        if (nodes[0] && !samePath(root, nodes[0].repo)) await this.persistentTopology.write(nodes[0].repo, nodes, [...probes]);
      } catch (e) { output().appendLine(`Repository discovery cache could not be saved: ${String(e)}`); }
      return nodes;
    });
  }

  private async discoverTree(root: string): Promise<RepoTreeNode[]> {
    const graphRoot = await this.graphRoot(root);
    const discovered = new Map<string, RepoTreeNode[]>();
    const seen = new Set<string>();
    const positions = new Map<string, number>();
    let pending: RepoTreeNode[] = [{ repo: graphRoot }];
    while (pending.length) {
      const wave = pending.filter(node => {
        const key = node.repo.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key); positions.set(key, positions.size); return true;
      });
      const children = await mapBounded(wave, 4, async node => {
        if (node.parent) {
          const resolved = await this.rootOf(node.repo);
          if (!resolved || !samePath(resolved, node.repo)) return [];
          const siblings = discovered.get(node.parent.toLowerCase()) ?? [];
          siblings.push(node); discovered.set(node.parent.toLowerCase(), siblings);
        }
        let text = '';
        try { text = await this.moduleConfig(node.repo); } catch { /* unreadable leaves have no children */ }
        return text.split(/\r?\n/).filter(line => /^submodule\..*\.path\s/.test(line)).flatMap(line => {
          const childPath = line.slice(line.search(/\s/) + 1).trim();
          return childPath ? [{ repo: path.resolve(node.repo, childPath), parent: node.repo, path: childPath.replace(/\\/g, '/') }] : [];
        });
      });
      pending = children.flat();
    }
    // Concurrent completion must not change the established depth-first order.
    const result: RepoTreeNode[] = [];
    const append = (node: RepoTreeNode): void => {
      result.push(node);
      const children = discovered.get(node.repo.toLowerCase()) ?? [];
      children.sort((a, b) => positions.get(a.repo.toLowerCase())! - positions.get(b.repo.toLowerCase())!);
      for (const child of children) append(child);
    };
    append({ repo: graphRoot });
    return result;
  }

  /** Returns declared submodules whose working trees are not initialized. */
  async missingSubmodules(root: string): Promise<MissingSubmodule[]> {
    return this.missing.get(root.toLowerCase(), () => this.discoverMissing(root));
  }

  private async discoverMissing(root: string): Promise<MissingSubmodule[]> {
    const missing: MissingSubmodule[] = [];
    const seen = new Set<string>();
    const visited = new Set<string>();
    const visit = async (repo: string): Promise<void> => {
      if (visited.has(repo.toLowerCase())) return;
      visited.add(repo.toLowerCase());
      const text = await this.moduleConfig(repo);
      const entries = new Map<string, { path?: string; url?: string }>();
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        const m = /^submodule\.(.+)\.(path|url)\s+(.+)$/.exec(line);
        if (!m) continue;
        const entry = entries.get(m[1]) ?? {};
        entry[m[2] as 'path' | 'url'] = m[3].trim();
        entries.set(m[1], entry);
      }
      for (const entry of entries.values()) {
        if (!entry.path) continue;
        const childDir = path.resolve(repo, entry.path);
        const childRepo = await this.rootOf(childDir);
        if (!childRepo || !samePath(childRepo, childDir)) {
          const key = `${repo}\0${entry.path}`;
          if (!seen.has(key)) {
            seen.add(key);
            missing.push({ parent: repo, path: entry.path, url: entry.url });
          }
        } else await visit(childRepo);
      }
    };
    await visit(await this.graphRoot(root));
    return missing;
  }

  async pick(placeHolder = 'Select a Git repository'): Promise<string | undefined> {
    const list = await this.discover();
    if (list.length === 1) return list[0];
    const picked = await vscode.window.showQuickPick(
      list.map(r => ({ label: repoName(r), description: r, repo: r, picked: this._current ? samePath(r, this._current) : false })),
      { placeHolder, matchOnDescription: true }
    );
    return picked?.repo;
  }

  /** Current repository, asking the user when none is known. */
  async require(): Promise<string | undefined> {
    if (this._current) return this._current;
    const r = await this.pick();
    if (r) this.setCurrent(r);
    return r;
  }

  private onFsEvent(fsPath: string): void {
    if (/[\\/]\.gitmodules$|[\\/]\.git$/i.test(fsPath)) {
      this.trees.clear(); this.missing.clear(); this.moduleConfigs.clear(); this.rootCache.clear();
    }
    if (/[\\/]\.git[\\/](?:modules[\\/].+[\\/])?(objects|logs)[\\/]/i.test(fsPath) || /\.lock$/i.test(fsPath)) return;
    const inGitDir = /[\\/]\.git([\\/]|$)/i.test(fsPath);
    // Ignored dependency folders produce no status change but generate event storms during installs/builds.
    if (!inGitDir && /[\\/]node_modules([\\/]|$)/i.test(fsPath)) return;
    const lower = fsPath.toLowerCase();
    let best: string | undefined;
    for (const r of this.known) {
      const rl = r.toLowerCase();
      if ((lower === rl || lower.startsWith(rl + path.sep)) && (!best || r.length > best.length)) best = r;
    }
    if (best) this.changed(this.submoduleOf(fsPath) ?? best, inGitDir || !this.isMetaWatched(best));
  }

  /** Maps `<super>/.git/modules/<a>/modules/<b>/...` to the known submodule `<super>/<a>/<b>`. */
  private submoduleOf(fsPath: string): string | undefined {
    const m = /^(.*?)[\\/]\.git[\\/]modules[\\/](.+)$/i.exec(fsPath);
    if (!m) return undefined;
    const parts = m[2].split(/[\\/]/);
    const segments: string[] = [];
    let candidate: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      segments.push(parts[i]);
      const repo = this.known.find(k => samePath(k, path.join(m[1], ...segments)));
      if (!repo) continue;
      candidate = repo;
      if (parts[i + 1] === 'modules') i++;
    }
    return candidate;
  }

  /** Whether events from the repository's .git folder reach the workspace watcher. */
  private isMetaWatched(repo: string): boolean {
    const key = repo.toLowerCase();
    let watched = this.metaWatched.get(key);
    if (watched === undefined) {
      const gitDir = path.join(repo, '.git');
      watched = (vscode.workspace.workspaceFolders ?? []).some(f => {
        const relative = path.relative(f.uri.fsPath, gitDir);
        return !relative.startsWith('..') && !path.isAbsolute(relative);
      });
      this.metaWatched.set(key, watched);
    }
    return watched;
  }

  /**
   * Notify listeners that a repository changed (debounced).
   * `meta` = HEAD, refs, index or stash may have changed, not only working tree files.
   */
  changed(repo: string, meta = true): void {
    const key = repo.toLowerCase();
    if (meta) this.pendingMeta.add(key);
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      if (this.pendingMeta.delete(key)) this._onDidChangeMeta.fire(repo);
      this._onDidChange.fire(repo);
    }, 400));
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
    this._onDidChangeMeta.dispose();
    this._onDidChangeCurrent.dispose();
  }
}
