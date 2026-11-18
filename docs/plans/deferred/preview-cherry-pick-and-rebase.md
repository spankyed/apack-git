# Previews of a cherry-pick and a rebase

Status: deferred, 2026-11-18. It was Phase 8 of
[goal-what-git-would-do-and-undo](../../archive/goals/goal-what-git-would-do-and-undo.md) and section 8 of
[its plan](../../archive/plans/what-git-would-do-and-undo.md), and was taken out before any of it was built. The design below is as
drafted on 2026-11-17 and has not been run.

## What it is

Two reads beside `previewMerge`: what cherry-picking some commits, or rebasing onto a branch, would do before it
is done. Each names the commit it would stop at and the files in conflict there, and moves nothing.

## Why it is deferred

- **Nothing in it has been run.** It needs `git merge-tree --write-tree --merge-base`, and the gits on the machine
  it was designed on are 2.38.1 and 2.39.5, which refuse that option. That the option arrived in 2.40 is from
  memory of git's release notes.
- **It imitates what git does, where the merge preview asks git.** A rebase decides which commits to replay, drops
  the ones already upstream and treats merges by its settings. The design follows the common path and answers
  `unknown` for the rest it knows of. Where it does not know, it would answer wrongly without failing.
- **Its cases would be skipped where it is built.** They run only on CI's newest gits, so whoever builds it could
  not see it pass.
- **No host has asked for it.** The consumer previews a pull with `previewMerge`; nothing in it was found asking
  what a rebase or a cherry-pick would do.

## What would justify taking it up

All of these, in this order:

1. A host that will use it: a place in the panel that warns before a rebase or a cherry-pick.
2. The commands below tried by hand on a git of 2.40 or later, and what was observed written here in place of what
   was assumed: the first version that takes `--merge-base`, that a commit made with `commit-tree` can carry the
   next pick, and that the files named match what a real rebase then stops on.
3. A git of 2.40 or later where it is built, or agreement that it is proven on CI alone.

`git replay` answers a similar question in one command from git 2.44, but as remembered it exits without naming
the files in conflict. If it names them, it is the better base: git doing the replay, not the engine imitating it.

## The design as drafted

Decisions it rested on:

- **`MergePreview` gains one optional field** instead of a second preview type, so a host has one shape to
  show.
- **A cherry-pick of a commit whose change is already there previews as `unknown`.** Git stops on it for a
  reason that is not a conflict, and the preview has no word for that. A rebase drops such a commit and carries on,
  so there it previews as clean.
- **A rebase whose range holds a merge commit, or more than 100 commits, previews as `unknown`.** What a
  rebase does with a merge depends on settings the preview does not follow, and each commit previewed is three gits.

Two previews beside `previewMerge`, in `src/merge-preview.ts`.

In `src/types.ts`, `MergePreview`'s conflicts gain one field, and its doc comment says the three previews answer
in it:

```ts
| { kind: 'conflicts'; files: string[]; /** The commit a cherry-pick or a rebase would stop at */ commit?: string }
```

In `src/repository.ts`:

```ts
/**
 * What cherry-picking these commits onto what is checked out would do, oldest first, before it is done: a clean
 * pick, or the commit it would stop at and the files in conflict there. Nothing moves. `unknown` on a git older
 * than 2.40, for a merge commit, and for a commit whose change is already here, which git stops on as empty.
 */
previewCherryPick(commits: string[]): Promise<MergePreview>

/**
 * What rebasing what is checked out onto `target` would do: nothing, a fast-forward, a clean rebase, or the commit
 * it would stop at and the files in conflict there. Nothing moves. `unknown` on a git older than 2.40, and for a
 * range that holds a merge commit or more than 100 commits.
 */
previewRebase(target: string): Promise<MergePreview>
```

How it works. `REPLAY_FROM = '2.40.0'` is the first git whose `merge-tree --write-tree` takes `--merge-base`.

- **One commit onto a tip.** A cherry-pick of commit `C` onto `T` is a three-way merge of `T` and `C` with `C`'s
  parent as the base:

  ```text
  git merge-tree --write-tree --name-only --no-messages --merge-base=<C^1> <T> <C>
  ```

  Read its answer as `previewMerge` does: on success the first line is the tree it made; on exit 1 with a first
  line that is an object name, the remaining lines are the files in conflict.
- **Several commits.** After a clean pick, the next commit is picked onto the result, so the result has to be a
  commit. Make one that nothing refers to:
  `git commit-tree <tree> -p <T> -m preview`, with the author and committer set in the command's environment the
  way `IDENTITY` is in `src/checkpoints.ts`. Its output is the new `T`. Add `'commit-tree'` to `READS` in
  `src/runner.ts`, and change that set's comment to say its commands take no lock and write at most objects nothing
  refers to (`merge-tree` already does).
- **A commit that comes out empty.** When the tree a pick made is the tree `T` already has
  (`rev-parse <T>^{tree}`), the commit's change is already there. For a cherry-pick, answer `unknown` (the second decision above). For a
  rebase, leave `T` as it is and carry on.
- **`previewCherryPick(commits)`.** Check each with `commitArgument`, as `cherryPick` does. None is
  `{ kind: 'up-to-date' }`. On a git older than `REPLAY_FROM`, `unknown`. A commit with a second parent
  (`rev-parse --verify --quiet <C>^2` succeeds) or with no parent is `unknown`. Otherwise pick each in turn from
  `T = HEAD`; the first that conflicts answers `{ kind: 'conflicts', files, commit: <its full hash> }`, and none
  conflicting answers `{ kind: 'clean' }`.
- **`previewRebase(target)`.** Check `target` as `previewMerge` checks its own. Then, in this order:
  1. `target` is an ancestor of `HEAD`: `{ kind: 'up-to-date' }`.
  2. `HEAD` is an ancestor of `target`: `{ kind: 'fast-forward' }`.
  3. A git older than `REPLAY_FROM`: `unknown`.
  4. `git rev-list --count --merges <target>..HEAD` is not `0`: `unknown` (the third decision above).
  5. The commits a rebase replays, oldest first, leaving out those whose change `target` already has:
     `git rev-list --reverse --no-merges --cherry-pick --right-only <target>...HEAD` (three dots). More than 100:
     `unknown`.
  6. Pick each in turn from `T = <target>`, as above.

**Cases**, in a new `tests/replay-preview.spec.ts`. Copy `tests/merge-preview.spec.ts`: its repository, its way of
holding `HEAD`, the status and the index's bytes to what they were, and its gate, here
`const replay = !olderThan(gitVersionOf(...)!, '2.40.0')`.

- Not gated: `previewRebase` says `up-to-date` and `fast-forward`; `previewCherryPick([])` says `up-to-date`.
- `it.runIf(replay)`: a cherry-pick that is clean, and one that conflicts. For the conflict, expect nothing moved,
  then run a real `git cherry-pick <commit>` and expect `files` to equal
  `git diff --name-only --diff-filter=U`, and `commit` to equal the commit's full hash.
- `it.runIf(replay)`: a rebase that is clean, and one that conflicts. For the conflict, run a real
  `git rebase <target>` after the preview and expect `files` to equal `git diff --name-only --diff-filter=U` and
  `commit` to equal `git rev-parse REBASE_HEAD`.
- `it.runIf(replay)`: of two commits, the first is clean and the second conflicts, and `commit` names the second.
- `it.runIf(replay)`: a commit whose change is already on the target. The rebase previews `clean`; the
  cherry-pick of it previews `unknown`.
- `it.runIf(replay)`: a range with a merge commit previews `unknown` for a rebase.
- `it.runIf(!replay)`: both say `unknown` where a merge-tree would be needed.
