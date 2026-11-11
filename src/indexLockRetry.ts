/** Retry temporary contention without deleting a lock owned by another process. */
export async function withIndexLockRetry<T>(
  action: () => Promise<T>,
  waiting: (attempt: number) => void,
  pause: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/index\.lock.*File exists|File exists.*index\.lock/is.test(message) || attempt >= 12) throw error;
      waiting(attempt + 1);
      await pause(Math.min(250 * 2 ** attempt, 2000));
    }
  }
}
