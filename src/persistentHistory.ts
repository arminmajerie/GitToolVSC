import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { mapBounded } from './asyncCache';

const VERSION = 1;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const identity = (repo: string) => process.platform === 'win32' ? path.resolve(repo).toLowerCase() : path.resolve(repo);

async function optionalFile(file: string): Promise<string> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return ''; throw e; }
}

export async function gitDirectories(repo: string): Promise<{ git: string; common: string }> {
  const marker = path.join(repo, '.git');
  const stat = await fs.stat(marker);
  const git = stat.isDirectory() ? marker : path.resolve(repo, (await fs.readFile(marker, 'utf8')).replace(/^gitdir:\s*/i, '').trim());
  const commonPath = (await optionalFile(path.join(git, 'commondir'))).trim();
  return { git, common: commonPath ? path.resolve(git, commonPath) : git };
}

/** Read only small Git metadata files. Never walk objects or the working tree. */
export async function repositoryFingerprint(repo: string): Promise<string> {
  const dirs = await gitDirectories(repo);
  const hash = createHash('sha256');
  type Content = { name: string; value: string };
  const file = async (name: string): Promise<Content> => ({ name, value: await optionalFile(name) });
  const refs = async (dir: string): Promise<Content[]> => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const contents = await mapBounded(entries.filter(e => !e.name.endsWith('.lock')).sort((a, b) => a.name.localeCompare(b.name)), 4, async entry => {
      const name = path.join(dir, entry.name);
      return entry.isDirectory() ? refs(name) : [await file(name)];
    });
    return contents.flat();
  };
  for (const dir of new Set([dirs.git, dirs.common])) {
    hash.update(dir).update('\0');
    const [metadata, references] = await Promise.all([
      Promise.all(['HEAD', 'packed-refs', 'config', 'config.worktree', 'shallow', 'info/grafts', 'objects/info/alternates'].map(name => file(path.join(dir, name)))),
      refs(path.join(dir, 'refs'))
    ]);
    for (const content of [...metadata, ...references]) hash.update(content.name).update('\0').update(content.value).update('\0');
  }
  return hash.digest('hex');
}

export class SnapshotStore {
  constructor(private readonly storage: string | undefined) {}
  private filename(key: string): string | undefined { return this.storage && path.join(this.storage, 'snapshots', digest(key) + '.json'); }
  async read<T>(key: string): Promise<T | undefined> {
    const filename = this.filename(key);
    if (!filename) return undefined;
    try {
      if ((await fs.stat(filename)).size > 32 * 1024 * 1024) return undefined;
      const entry = JSON.parse(await fs.readFile(filename, 'utf8'));
      return entry.version === VERSION && entry.key === key ? entry.value as T : undefined;
    } catch { return undefined; }
  }
  async write(key: string, value: unknown): Promise<void> {
    const filename = this.filename(key);
    if (!filename) return;
    await atomicWrite(filename, JSON.stringify({ version: VERSION, key, value }));
  }
}

async function atomicWrite(filename: string, value: string): Promise<void> {
  const temporary = filename + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(temporary, value, 'utf8');
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

interface HistoryRecord { version: number; repo: string; args: string[]; fingerprint: string; timeBucket?: number; value: string }
function queryTimeBucket(args: string[]): number {
  // Relative date filters change meaning as time passes even if refs do not.
  return args.some(a => /^--(?:since|until)=/.test(a) && !/^--(?:since|until)=\d{4}-\d\d-\d\d(?:[T ]|$)/.test(a)) ? Math.floor(Date.now() / 60000) : 0;
}

interface TreeNode { repo: string; parent?: string; path?: string }
interface TreeRecord { nodes: TreeNode[]; probes: string[]; fingerprint: string }

export class PersistentTopology {
  private readonly snapshots: SnapshotStore;
  constructor(storage: string | undefined) { this.snapshots = new SnapshotStore(storage); }
  private async fingerprint(nodes: TreeNode[], probes: string[]): Promise<string> {
    const hash = createHash('sha256');
    const manifests = await mapBounded(nodes, 8, node => optionalFile(path.join(node.repo, '.gitmodules')));
    nodes.forEach((node, i) => hash.update(node.repo).update('\0').update(manifests[i]).update('\0'));
    const markers = await mapBounded(probes, 8, async probe => {
      try {
        const dirs = await gitDirectories(probe);
        await fs.access(path.join(dirs.git, 'HEAD'));
        return dirs.git + '\0' + dirs.common;
      } catch { return 'uninitialized'; }
    });
    probes.forEach((probe, i) => hash.update(probe).update('\0').update(markers[i]));
    return hash.digest('hex');
  }
  async read(root: string): Promise<TreeNode[] | undefined> {
    const saved = await this.snapshots.read<TreeRecord>('topology:' + identity(root));
    if (!saved || !Array.isArray(saved.nodes) || !Array.isArray(saved.probes)) return undefined;
    try { return await this.fingerprint(saved.nodes, saved.probes) === saved.fingerprint ? saved.nodes : undefined; }
    catch { return undefined; }
  }
  async write(root: string, nodes: TreeNode[], probes: string[]): Promise<void> {
    await this.snapshots.write('topology:' + identity(root), { nodes, probes, fingerprint: await this.fingerprint(nodes, probes) });
  }
}

/** Permanent query cache. Age never invalidates history; changed refs do. */
export class PersistentHistory {
  private readonly running = new Map<string, Promise<string>>();
  private readonly memory = new Map<string, HistoryRecord>();
  private readonly fingerprints = new Map<string, string>();
  private readonly fingerprintPaths = new Map<string, string>();
  readonly stats = { hits: 0, misses: 0 };
  constructor(private readonly storage: string | undefined, private readonly warning: (message: string) => void = () => {}) {}

  async unchanged(repo: string): Promise<boolean> {
    const before = this.fingerprints.get(identity(repo));
    if (!before) return false;
    try { return before === await repositoryFingerprint(this.fingerprintPaths.get(identity(repo)) ?? repo); } catch { return false; }
  }

  async read(repo: string, args: string[], load: () => Promise<string>, rebuild = false): Promise<string> {
    if (!this.storage) return load();
    let fingerprint: string;
    try { fingerprint = await repositoryFingerprint(repo); }
    catch { return load(); }
    const key = digest(identity(repo)) + '/' + digest(JSON.stringify(args));
    const timeBucket = queryTimeBucket(args);
    const runningKey = key + '/' + fingerprint + '/' + timeBucket + '/' + rebuild;
    const existing = this.running.get(runningKey);
    if (existing) return existing;
    const task = this.readOrLoad(repo, args, key, fingerprint, timeBucket, load, rebuild);
    this.running.set(runningKey, task);
    try { return await task; } finally { this.running.delete(runningKey); }
  }

  private async readOrLoad(repo: string, args: string[], key: string, fingerprint: string, timeBucket: number, load: () => Promise<string>, rebuild: boolean): Promise<string> {
    const filename = path.join(this.storage!, 'histories', key + '.json');
    if (!rebuild) {
      let record = this.memory.get(key);
      if (!record) {
        try {
          if ((await fs.stat(filename)).size <= 32 * 1024 * 1024) record = JSON.parse(await fs.readFile(filename, 'utf8')) as HistoryRecord;
        } catch { /* corrupt or missing cache is a miss, never a Git failure */ }
      }
      if (record?.version === VERSION && record.repo === identity(repo) && record.fingerprint === fingerprint && (record.timeBucket ?? 0) === timeBucket && JSON.stringify(record.args) === JSON.stringify(args) && typeof record.value === 'string') {
        this.memory.set(key, record); this.fingerprints.set(identity(repo), fingerprint); this.fingerprintPaths.set(identity(repo), repo); this.stats.hits++; return record.value;
      }
    }
    this.stats.misses++;
    const value = await load();
    // A ref move during Git's read must not be saved under the old fingerprint.
    try {
      if (await repositoryFingerprint(repo) === fingerprint && timeBucket === queryTimeBucket(args)) {
        const record: HistoryRecord = { version: VERSION, repo: identity(repo), args, fingerprint, timeBucket, value };
        this.memory.set(key, record);
        this.fingerprints.set(identity(repo), fingerprint);
        this.fingerprintPaths.set(identity(repo), repo);
        await atomicWrite(filename, JSON.stringify(record));
      }
    } catch (e) { this.warning(`History cache could not be saved for ${repo}: ${e instanceof Error ? e.message : String(e)}`); }
    return value;
  }
}
