# Raising the oldest git the engine works with

Status: deferred by decision, 2026-11-17. `GIT_FLOOR` stays at 2.35.0. Nothing here is designed in detail; this
records what a higher floor would buy, what it would cost, and what would justify taking it up.

Surveyed at `cd73da3` on `feat/checkout-at-and-remotes`.

## Where the floor is, and what holds it there

`GIT_FLOOR` (`src/git-check.ts`) is 2.35.0: the first git whose `status --porcelain=v2 --show-stash` counts the
stashes. CI's `git` jobs (`.github/workflows/ci.yml`) hold it: the suite runs against 2.35.0 built from its source,
against Debian 12's own git and against macOS's own, both 2.39.5 when this was written.

## What each step up would buy

Every version below the newest that the engine has to ask about is a branch in the code, an answer that says "this
git cannot tell", and a case that runs on only some of CI's jobs.

| Floor | What goes away | Where it is today |
|---|---|---|
| 2.36 | Nothing is removed, and `git cat-file --batch-command` becomes usable: one git kept open that answers "is it there", "what is it" and "its content" on request. `git remote rename` also takes `--` from here | `src/objects.ts` keeps `cat-file --batch` open, which can only hand back content. `GitRepository.remoteCommand` refuses option-like names instead of using `--` |
| 2.37 | The check for whether git has a file monitor of its own, and the case-insensitive match for "a branch named … already exists" | `FILE_MONITOR_FROM` in `src/repository.ts`; the `branch-exists` sign in `src/errors.ts` |
| 2.38 | `unknown` from `previewMerge`: every supported git has `merge-tree --write-tree` | `MERGE_TREE_FROM` in `src/merge-preview.ts`; the `it.runIf(!mergeTree)` case in `tests/merge-preview.spec.ts` |
| 2.40 | `unknown` from the cherry-pick and rebase previews, which need `merge-tree --merge-base` | Planned in [goal-what-git-would-do-and-undo](../../goals/goal-what-git-would-do-and-undo.md), Phase 8 |
| 2.46 | The table of which patch releases can be told not to fetch, and the reads that wait in the network lane on a git that cannot | `NO_LAZY_FETCH_FROM`, `refusesLazyFetch` and `readLane` in `src/runner.ts` |

The 2.36 and 2.40 rows are from memory of git's release notes. Confirm each against the notes before acting on it.
The 2.40 row is consistent with what was observed here: git 2.38.1 refuses `--merge-base` as an unknown option.

## What it would cost

- **2.36 to 2.39 costs no supported system.** Debian 12 and macOS both ship 2.39.5. Ubuntu 22.04's 2.34.1 is
  already below the floor.
- **2.40 and above drops Debian 12's git and macOS's own.** A user on either would be refused by name
  (`GitUnusableError`, `git-too-old`) until they installed a newer git. That is the real cost, and the reason the
  two previews in the goal answer `unknown` instead.
- The CI job that builds the floor from source builds a different version. Nothing else in CI changes.

## What would justify taking it up

Any one of these:

1. The process counts the goal's Phase 6 adds to `npm run budgets` show that starting gits is a real share of an
   operation's time on some platform, and `cat-file --batch-command` is what would remove it. That argues for 2.36.
2. Debian 12 leaves support, or macOS ships a git of 2.40 or later. Then 2.40 costs nothing either.
3. The version checks keep multiplying. There are three today (`MERGE_TREE_FROM`, `FILE_MONITOR_FROM`,
   `NO_LAZY_FETCH_FROM`) and the goal adds a fourth. A fifth is a reason to look again.

## The work, when it is taken up

1. Change `GIT_FLOOR` and the comment above it, which says what holds the floor where it is.
2. Change the version the `floor` job builds in `.github/workflows/ci.yml`.
3. For each check at or below the new floor: remove the check, the `unknown` answer it guards, and the spec case
   that runs only on a git without the feature. Nothing is kept for compatibility (`CLAUDE.md`).
4. Update "What is supported" in `README.md`, and run `npm run reference:update`.
5. Done when CI's `suite` and `git` jobs pass, and no source file compares git's version with a release at or below
   the floor.
