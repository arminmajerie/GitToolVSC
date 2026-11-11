import * as path from 'node:path';

export interface TargetPath {
  repo: string;
  rel: string;
  isDir: boolean;
}

export interface GroupedTarget {
  repo: string;
  rels: string[];
  isDir: boolean;
}

export function dependencyOrder(nodes: { repo: string; parent?: string }[], selected: string[]): string[] {
  const chosen = new Set(selected.map(r => r.toLowerCase()));
  const depth = (repo: string): number => {
    let n = nodes.find(x => x.repo.toLowerCase() === repo.toLowerCase());
    let d = 0;
    while (n?.parent) {
      d++;
      n = nodes.find(x => x.repo.toLowerCase() === n!.parent!.toLowerCase());
    }
    return d;
  };
  return nodes.filter(n => chosen.has(n.repo.toLowerCase())).sort((a, b) => depth(b.repo) - depth(a.repo)).map(n => n.repo);
}

export function repositoryScopes(root: string, repos: { repo: string }[], rels: string[]): Map<string, string[]> {
  const absoluteSelections = rels.length ? rels.map(r => path.resolve(root, r || '.')) : [path.resolve(root)];
  const result = new Map<string, string[]>();
  for (const node of repos) {
    const scoped = absoluteSelections
      .filter(abs => same(abs, node.repo) || within(abs, node.repo) || within(node.repo, abs))
      .map(abs => within(node.repo, abs) ? '' : path.relative(node.repo, abs).split(path.sep).join('/'));
    if (scoped.length) result.set(node.repo, [...new Set(scoped)]);
  }
  return result;
}

function same(a: string, b: string): boolean {
  const aa = path.resolve(a);
  const bb = path.resolve(b);
  return process.platform === 'win32' ? aa.toLowerCase() === bb.toLowerCase() : aa === bb;
}

function within(child: string, parent: string): boolean {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c.startsWith(p + path.sep);
}

/** Groups Explorer selections by their owning repository before Git is invoked. */
export function groupTargetPaths(items: TargetPath[]): GroupedTarget[] {
  const groups = new Map<string, GroupedTarget>();
  for (const item of items) {
    const key = process.platform === 'win32' ? item.repo.toLowerCase() : path.normalize(item.repo);
    let group = groups.get(key);
    if (!group) {
      group = { repo: item.repo, rels: [], isDir: false };
      groups.set(key, group);
    }
    if (!group.rels.includes(item.rel)) group.rels.push(item.rel);
    group.isDir ||= item.isDir;
  }
  return [...groups.values()];
}
