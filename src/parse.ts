// Pure parsers for git output; no vscode dependency so they can be unit tested.

export interface FileChange {
  status: string;
  path: string;
  oldPath?: string;
}

export interface StatusEntry {
  x: string;
  y: string;
  path: string;
  oldPath?: string;
}

export interface Commit {
  h: string;
  p: string[];
  an: string;
  ae: string;
  at: number;
  refs: string;
  s: string;
}

export interface RefInfo {
  kind: 'local' | 'remote' | 'tag';
  name: string;
  hash: string;
  upstream?: string;
  track?: string;
  date: number;
}

export interface StashEntry {
  ref: string;
  message: string;
  date: number;
}

export interface BlameLine {
  hash: string;
  author: string;
  authorMail: string;
  time: number;
  summary: string;
}

export const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e';

export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const rec of out.split('\x1e')) {
    const r = rec.replace(/^\s+/, '');
    if (!r) continue;
    const f = r.split('\x1f');
    if (f.length < 7) continue;
    commits.push({
      h: f[0],
      p: f[1] ? f[1].split(' ') : [],
      an: f[2],
      ae: f[3],
      at: Number(f[4]),
      refs: f[5],
      s: f[6]
    });
  }
  return commits;
}

/** Parses `--name-status -z` output (git diff / diff-tree / stash show). */
export function parseNameStatus(out: string): FileChange[] {
  const t = out.split('\0');
  const res: FileChange[] = [];
  let i = 0;
  while (i < t.length) {
    const st = t[i++];
    if (!st) continue;
    const code = st[0];
    if (code === 'R' || code === 'C') {
      const oldPath = t[i++];
      const path = t[i++];
      res.push({ status: code, path, oldPath });
    } else {
      res.push({ status: code, path: t[i++] });
    }
  }
  return res;
}

/** Parses `git status --porcelain=v1 -z`. */
export function parseStatus(out: string): StatusEntry[] {
  const t = out.split('\0');
  const res: StatusEntry[] = [];
  let i = 0;
  while (i < t.length) {
    const e = t[i++];
    if (!e || e.length < 4) continue;
    const x = e[0];
    const y = e[1];
    const path = e.slice(3);
    if (x === 'R' || x === 'C') {
      res.push({ x, y, path, oldPath: t[i++] });
    } else {
      res.push({ x, y, path });
    }
  }
  return res;
}

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export interface StatusGroups {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: FileChange[];
  conflicts: FileChange[];
}

export function groupStatus(entries: StatusEntry[]): StatusGroups {
  const g: StatusGroups = { staged: [], unstaged: [], untracked: [], conflicts: [] };
  for (const e of entries) {
    const xy = e.x + e.y;
    if (xy === '??') g.untracked.push({ status: '?', path: e.path });
    else if (xy === '!!') continue;
    else if (CONFLICT.has(xy)) g.conflicts.push({ status: 'U', path: e.path });
    else {
      if (e.x !== ' ') g.staged.push({ status: e.x, path: e.path, oldPath: e.oldPath });
      if (e.y !== ' ') g.unstaged.push({ status: e.y, path: e.path });
    }
  }
  return g;
}

export const REF_FORMAT = '%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:unix)';

export function parseRefs(out: string): RefInfo[] {
  const res: RefInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, hash, upstream, track, date] = line.split('\0');
    let kind: RefInfo['kind'];
    let name: string;
    if (ref.startsWith('refs/heads/')) { kind = 'local'; name = ref.slice(11); }
    else if (ref.startsWith('refs/remotes/')) { kind = 'remote'; name = ref.slice(13); if (name.endsWith('/HEAD')) continue; }
    else if (ref.startsWith('refs/tags/')) { kind = 'tag'; name = ref.slice(10); }
    else continue;
    res.push({ kind, name, hash, upstream: upstream || undefined, track: track || undefined, date: Number(date) || 0 });
  }
  return res;
}

export function parseStashList(out: string): StashEntry[] {
  return out.split('\n').filter(Boolean).map(l => {
    const [ref, message, date] = l.split('\x1f');
    return { ref, message, date: Number(date) };
  });
}

/** Parses `git blame --porcelain`, returns one entry per final line (0-based). */
export function parseBlame(out: string): BlameLine[] {
  const lines = out.split('\n');
  const commits = new Map<string, BlameLine>();
  const res: BlameLine[] = [];
  let cur: BlameLine | undefined;
  let finalLine = 0;
  for (const line of lines) {
    if (line.startsWith('\t')) {
      if (cur) res[finalLine - 1] = cur;
      continue;
    }
    const m = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(line);
    if (m) {
      finalLine = Number(m[2]);
      cur = commits.get(m[1]);
      if (!cur) {
        cur = { hash: m[1], author: '', authorMail: '', time: 0, summary: '' };
        commits.set(m[1], cur);
      }
      continue;
    }
    if (!cur) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'author') cur.author = val;
    else if (key === 'author-mail') cur.authorMail = val.replace(/^<|>$/g, '');
    else if (key === 'author-time') cur.time = Number(val);
    else if (key === 'summary') cur.summary = val;
  }
  return res;
}

/** Escapes a literal for git's basic regular expressions (--author). */
export function escapeBre(s: string): string {
  return s.replace(/[\\.[\]*^$]/g, '\\$&');
}

export function repoFromUrl(url: string): string {
  const m = /([^/\\:]+?)(\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : 'repo';
}
