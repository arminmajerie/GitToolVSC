/** Small in-memory cache: concurrent readers share work; failures are never cached. */
export class AsyncCache<T> {
  private entries = new Map<string, { expires: number; value: Promise<T> }>();
  constructor(private ttl = 30000) {}
  get(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.value;
    const value = load();
    const entry = { expires: Infinity, value };
    this.entries.set(key, entry);
    void value.then(
      () => { entry.expires = Date.now() + this.ttl; },
      () => { if (this.entries.get(key) === entry) this.entries.delete(key); }
    );
    return value;
  }
  clear(): void { this.entries.clear(); }
  deletePrefix(prefix: string): void { for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key); }
}

export async function mapBounded<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; results[index] = await work(items[index]); }
  }));
  return results;
}
