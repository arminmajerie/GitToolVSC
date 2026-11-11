import type { Commit } from './parse';

export interface RepositoryCommit extends Commit { repo: string; repositories: string[] }

/** Shared Git commits have identical objects; keep one row and retain every owner. */
export function mergeRepositoryLogs(logs: { repo: string; commits: Commit[] }[], max: number, order: 'date' | 'topo' = 'date'): RepositoryCommit[] {
  const rows = new Map<string, RepositoryCommit>();
  for (const log of logs) for (const commit of log.commits) {
    const row = rows.get(commit.h);
    if (row) { if (!row.repositories.includes(log.repo)) row.repositories.push(log.repo); }
    else rows.set(commit.h, { ...commit, repo: log.repo, repositories: [log.repo] });
  }
  // Timestamp sorting alone can put a parent above its child (clock skew is
  // legal in Git), which produces dangling/reversed graph lanes. Only choose
  // commits whose loaded children have already been emitted.
  const children = new Map<string, number>();
  for (const row of rows.values()) for (const parent of row.p) {
    if (rows.has(parent)) children.set(parent, (children.get(parent) ?? 0) + 1);
  }
  const ready: RepositoryCommit[] = [];
  const repoDates = new Map<string, number>();
  for (const row of rows.values()) repoDates.set(row.repo, Math.max(repoDates.get(row.repo) ?? -Infinity, row.at));
  const repos = [...repoDates].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rank = new Map(repos.map(([repo], i) => [repo, i]));
  const commitRank = new Map([...rows.keys()].map((hash, i) => [hash, i]));
  const earlier = (a: RepositoryCommit, b: RepositoryCommit) => {
    // Git already orders each repository topologically. At the aggregate level,
    // keep independent repository threads together when the user chooses topo.
    if (order === 'topo' && a.repo !== b.repo) return rank.get(a.repo)! < rank.get(b.repo)!;
    if (order === 'topo') return commitRank.get(a.h)! < commitRank.get(b.h)!;
    return a.at > b.at || (a.at === b.at && a.h < b.h);
  };
  const push = (row: RepositoryCommit) => {
    ready.push(row);
    let index = ready.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!earlier(ready[index], ready[parent])) break;
      [ready[index], ready[parent]] = [ready[parent], ready[index]];
      index = parent;
    }
  };
  const pop = () => {
    const result = ready[0];
    const last = ready.pop()!;
    if (ready.length) {
      ready[0] = last;
      let index = 0;
      for (;;) {
        let best = index;
        for (const child of [index * 2 + 1, index * 2 + 2]) {
          if (child < ready.length && earlier(ready[child], ready[best])) best = child;
        }
        if (best === index) break;
        [ready[index], ready[best]] = [ready[best], ready[index]];
        index = best;
      }
    }
    return result;
  };
  for (const row of rows.values()) if (!children.get(row.h)) push(row);
  const result: RepositoryCommit[] = [];
  while (ready.length && result.length < max) {
    const row = pop();
    result.push(row);
    for (const parent of row.p) if (rows.has(parent)) {
      const remaining = children.get(parent)! - 1;
      children.set(parent, remaining);
      if (remaining === 0) push(rows.get(parent)!);
    }
  }
  return result;
}
