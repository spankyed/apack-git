# Ideas for the engine, declined

Status: declined, 2026-11-17. Each idea below was weighed for the engine and declined, with its reason and what
would reopen it. What was accepted is in [goal-what-git-would-do-and-undo](../../archive/goals/goal-what-git-would-do-and-undo.md),
and the one deferral is [raise-git-floor](../deferred/raise-git-floor.md).

Most of them come back to one choice. The engine runs the user's git and keeps a picture of what it did, so it
behaves as their git does: hooks, filters, credential helpers, sparse checkouts and every storage format git gains.
An idea that would have the engine answer in git's place gives that up.

## A git object reader written in JavaScript

**The idea.** Read loose objects, pack files and the commit graph directly, without a process, for history, blame
and a file as a commit has it. A second idea followed from it: an entry that imports nothing of Node's, so a window
could read history itself.

**Why not.**

- Every answer the engine gives comes from git. A reader of its own is a second implementation of git's storage,
  and each spec would have to run twice and compare.
- Storage keeps changing: SHA-256 repositories, reftable, multi-pack indexes, alternates, replace refs, and partial
  clones where a missing object is fetched by git when asked for. Each is a way to answer wrongly, without failing,
  on a repository git reads correctly.
- The window entry had nothing under it. A window has no file system, so the host would hand it the bytes anyway.

**What would reopen it.** Process counts (the goal's Phase 6) showing that reads from commits dominate some
operation even through the git kept open, on a platform where starting a process is expensive, with no git command
that batches the read.

## Rebasing, cherry-picking or pulling in the object store

**The idea.** Use `git replay` to perform a rebase or a cherry-pick without touching the working tree.

**Why not.**

- `git replay` arrived in git 2.44 and git called it experimental when this was written. The floor is 2.35.
- It runs none of the hooks a real rebase runs, so the result can differ from what the user's git would have done.
- It moves refs under a working tree that has not moved.

Previewing is a different matter: saying what a rebase or a cherry-pick would do, and moving nothing, is
[deferred](../deferred/preview-cherry-pick-and-rebase.md), not declined.

**What would reopen it.** Git declaring `git replay` stable, and a host that needs to rewrite a branch that is not
checked out.

## A tie that answers git's credential prompt

**The idea.** A host-supplied function that git's askpass request is routed to, so a host could ask the user for a
password and let the command carry on.

**Why not.**

- `GIT_TERMINAL_PROMPT=0` (`gitEnvironment`, `src/runner.ts`) is a decision: nobody is at a terminal. Reversing it
  means a git that waits on a person, holding its lane and any lock for as long as they take.
- `GIT_ASKPASS` has to name a program on disk. The engine would ship a helper and a channel back to itself, on three
  platforms, and secrets would pass through an engine that today names no user.
- What a host needs is already there. A failed sign-in carries the code `authentication`, `readRemoteUrl()` and
  `readRemote()` say which remote and address, and the host runs its own sign-in and calls again.
  `tests/failures.spec.ts` has the case.

**What would reopen it.** A host that cannot sign the user in outside git, for a remote that only takes a password
typed at a prompt.

## One file row with three columns

**The idea.** One row per path, with its state in the last commit, the index and the working tree side by side.
The proposal was to reshape `GitStatusFile` that way, so that `src/staging.ts` predicts from one row.

**Why not.** This was accepted and then dropped when the code was read.

- A snapshot already lists a path once for what is staged of it and once for what is not. That is the shape a source
  control panel shows, and `src/staging.ts` already pairs the two rows of a path before it predicts.
- The cases staging cannot predict (a file put back over a staged deletion, a copy, a conflict being settled) need
  the file's content hashed, which no status carries in any shape.
- The consumer holds its own copy of the row to the engine's with a type check. Reshaping the row is churn on both
  sides for a prediction that would be no better.

**What would reopen it.** A host that needs a file's mode or object id in each place, which `git status
--porcelain=v2` prints and the snapshot does not keep.

## Smaller ideas

- **An undo that claims to undo everything.** A push, a deleted remote branch and a pushed tag cannot be taken back
  from here, and a copy of the working tree is dropped after 14 days. The goal's Phases 3 and 4 do the honest version:
  every entry says whether it can be undone now, and why not.
- **A `git update-index --stdin` kept open.** It holds `index.lock` for as long as it is open, which refuses the
  user's own git.
- **Predicted snapshots for a commit, a checkout or a stash.** Hooks and filters change what those leave behind, so
  only git can say. Staging and unstaging are predictable, which is why `apack-git/staging` exists and stops there.
- **`git check-ignore --stdin` and `git diff-tree --stdin` kept open.** Nothing in the engine asks either question
  once per path, so there is no process to save.
- **Naming the remote on a failed push or fetch.** The caller either named the remote or reads it with
  `readRemote()`. Nothing to build.
