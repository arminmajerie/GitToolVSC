import { mapBounded } from './asyncCache';
export type GitQuery = (repo: string, args: string[]) => Promise<string>;
export interface PushPreparationTarget { repo: string; preferredBranch?: string }
export interface PushPreparation { repo: string; branch: string; head: string; previous: string }

export async function planPushPreparation(
  targets: PushPreparationTarget[], git: GitQuery,
  chooseBranch?: (repo: string, branches: string[]) => Promise<string | undefined>,
): Promise<PushPreparation[]> {
  let branchPickerQueue: Promise<unknown> = Promise.resolve();
  const plans = await mapBounded(targets, 4, async (target): Promise<PushPreparation | undefined> => {
    const conflicts = await git(target.repo, ['ls-files', '--unmerged', '-z']);
    if (conflicts) throw new Error(`${target.repo}: resolve merge conflicts before Commit & Push. No batch commits have been made.`);
    const branch = (await git(target.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch !== 'HEAD') return undefined;
    const status = await git(target.repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=dirty']);
    const unpublished = await git(target.repo, ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes']);
    if (!status && !unpublished.trim()) return undefined;
    const head = (await git(target.repo, ['rev-parse', 'HEAD'])).trim();
    const branches = (await git(target.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])).trim().split(/\r?\n/).filter(Boolean);
    let selected = target.preferredBranch && branches.includes(target.preferredBranch)
      ? target.preferredBranch : branches.length === 1 ? branches[0] : undefined;
    if (!selected && chooseBranch) {
      const pick = branchPickerQueue.then(() => chooseBranch(target.repo, branches));
      branchPickerQueue = pick.catch(() => undefined);
      selected = await pick;
    }
    if (selected && !branches.includes(selected)) throw new Error(`${target.repo}: selected branch is no longer available. Retry Commit & Push.`);
    if (!selected) throw new Error(`${target.repo}: detached commit ${head.slice(0, 8)} has no unambiguous destination branch. Choose a branch in Git Tool before retrying. No batch commits have been made.`);
    const worktrees = await git(target.repo, ['worktree', 'list', '--porcelain']);
    if (worktrees.split(/\r?\n/).includes(`branch refs/heads/${selected}`)) {
      throw new Error(`${target.repo}: ${selected} is checked out in another worktree. Choose a different branch in Git Tool before retrying.`);
    }
    const previous = (await git(target.repo, ['rev-parse', `refs/heads/${selected}`])).trim();
    const base = (await git(target.repo, ['merge-base', previous, head])).trim();
    if (base !== previous) {
      throw new Error(`${target.repo}: cannot fast-forward ${selected} to detached commit ${head.slice(0, 8)}. Reconcile the divergent commits in Git Tool before retrying. No batch commits have been made.`);
    }
    if (!(await git(target.repo, ['remote'])).trim()) throw new Error(`${target.repo}: configure a remote in Git Tool before pushing.`);
    return { repo: target.repo, branch: selected, head, previous };
  });
  return plans.filter((plan): plan is PushPreparation => plan !== undefined);
}

export async function applyPushPreparation(plans: PushPreparation[], git: GitQuery): Promise<void> {
  for (const plan of plans) {
    const head = (await git(plan.repo, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(plan.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (head !== plan.head || branch !== 'HEAD') throw new Error(`${plan.repo}: repository changed during push preparation. Retry Commit & Push.`);
    // Compare-and-swap prevents overwriting a branch moved by another process.
    // Attaching HEAD changes neither the working tree nor the index.
    await git(plan.repo, ['update-ref', '-m', 'Git Tool: recover detached work for push', `refs/heads/${plan.branch}`, plan.head, plan.previous]);
    await git(plan.repo, ['symbolic-ref', '-m', 'Git Tool: attach recovered work', 'HEAD', `refs/heads/${plan.branch}`]);
  }
}
