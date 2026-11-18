# Evidence: an undo that takes what it was shown, and failures that name their files

Checkpoint logs and findings for [the goal](../archive/goals/goal-what-git-would-do-and-undo.md), dated, newest last. Each
names the commit and the command. This is history: the goal and the plan say what is current.

## 2026-11-18, Phase 3 (`add9bb5`)

macOS, git 2.38.1, on `feat/undo-list-and-named-failures` from `master` at `bb24b4e`.

- `npx vitest run tests/undo.spec.ts tests/rewrite.spec.ts tests/start-operations.spec.ts tests/checkpoints.spec.ts`:
  27 passed. `npm run typecheck`, `npm run build` and `npm run reference:update` clean.
- Mutation: `standingOf` made to record no moved ref. `tests/undo.spec.ts` then failed its two `moved-since`
  cases, "refuses to take back a commit its branch has moved past since" and "refuses an entry written with no
  branch checked out, once a branch is"; restored after.

## 2026-11-18, Phase 4: a finding

The plan said an entry whose restore left any file stays in the journal until a restore leaves nothing. Observed in
`tests/discards.spec.ts`, "leaves alone what was changed or made again since": after a first restore put `src/a.ts`
back, a second restore answered it as left. A file put back differs from git's copy, so the status read that
decides what was changed since counted it, and the entry could never leave the list.

Changed in `DiscardStore.restore` (`src/discards.ts`): a changed file is compared with the checkpoint
(`changedSince`), and only one that differs from it is left; one already as the discard kept it is answered as
restored. The plan's section 4 records it. Requirement served: the goal's Phase 4, "an entry that left files stays
until a restore leaves none".

## 2026-11-18, Phase 4: a choice where the plan was silent

`restoreDiscarded` ran inside `GitWrites.withWriteFlag`, so a watcher's report waited for it. A discard is now put
back through `undo`, so `GitRepository.undo` runs inside the same flag, and with it every undo, which before ran
outside it. That is the nearest existing pattern: every other write of the engine runs inside it.

## 2026-11-18, Phase 4 (`ceb2abb`)

- `npx vitest run tests/discards.spec.ts tests/undo.spec.ts tests/names-not-text.spec.ts tests/untracked-folders.spec.ts tests/checkpoints.spec.ts`:
  45 passed, 1 skipped (a case that runs only on Linux). The plan named `names-not-text.spec.ts` and
  `untracked-folders.spec.ts` as callers of `restoreDiscarded`; on `bb24b4e` neither called it, so neither changed.

## 2026-11-18, Phase 5

- `npx vitest run tests/failures.spec.ts tests/named-failures.spec.ts tests/start-operations.spec.ts tests/checkout-and-publish.spec.ts`:
  42 passed.
- Mutation: `filesInTheWay` made to answer no files. The three cases that expect them failed: the existing checkout
  case, "names the files a merge would overwrite" and "names the files in the way from the top of the checkout, as
  they are spelled"; restored after.
- `checkoutBranch` built its own error in two places, so the five methods the plan names are six call sites, all
  through `gitErrorOf` now.

## 2026-11-18, Phase 5 (`5e47156`) and Phase 6

- Phase 5: `npm run reference:check` first failed on `LocalChangesError.files` and `HostRefusedError.rule`, which
  the cases matched by key inside `toMatchObject`, where the checker does not see a use. The cases now read each by
  name; folded into `5e47156`.
- Phase 6, `npm run build && npm run budgets -- 1000`, on macOS (Apple M1 Pro, load 22 to 28), git 2.39.5 (Apple):

  ```text
  1,000 files: open 213 ms (7 gits), whole status 85 ms (3 gits), one noted path 94 ms (3 gits), checkpoint 187 ms (7 gits), conflict sides 45 ms (4 gits) (generated in 211 ms)
  ```

  A conflict's sides start four gits: `ls-files --unmerged`, then a `cat-file blob` for each of the three sides.

## 2026-11-18, Phase 7

- `npx vitest run tests/trust.spec.ts tests/conflict-sides.spec.ts tests/objects.spec.ts`: 77 passed.
- Mutations, each restored after: without closing the git kept open on a trust refusal, "ends the git kept open for
  reading files once the repository is no longer trusted" failed; with the sides read by `cat-file blob` again, "reads
  the three sides without a git of their own" failed.
- The trust case checks the process at once, where the plan said to wait for it with `settles`: the git kept open
  ends by itself five seconds after its last read, so a wait would pass whether or not the refusal ended it, and the
  mutation above would not have failed it.
- `tests/conflict-sides.spec.ts` now closes each repository before removing its directory: reading a side starts the
  git kept open, which is a process in the directory, and Windows deletes none with a process in it.
- `npm run build && npm run budgets -- 1000`, macOS, git 2.39.5 (Apple):

  ```text
  1,000 files: open 183 ms (7 gits), whole status 83 ms (3 gits), one noted path 95 ms (3 gits), checkpoint 234 ms (7 gits), conflict sides 223 ms (2 gits) (generated in 209 ms)
  ```

- **Finding.** The goal held this reading to four gits falling by three; it fell by two. The gits each read
  started, listed through the `run` tie on a small conflicted repository after a snapshot was read:

  ```text
  first read:  ls-files --unmerged, config --get-regexp ^(extensions\.partialclone|remote\..*\.promisor)$
  second read: ls-files --unmerged
  ```

  The second is `GitRunner.isPartialClone`, asked once per repository before the first file is read from a commit,
  and in the script the sides are that first read. The three `cat-file blob` gits are gone. Put to the user, who
  accepted it as it is; the goal's Phase 7 condition and the plan's section 7 now say so.

## 2026-11-18, final validation on this machine (`4fbf892`)

macOS, git 2.38.1 first on `PATH` for the suite, load 18 to 26.

- `npm run typecheck`, `npm run reference:check` (215 exports and members) and `npm run build`: clean.
- `npm test`: 59 files, 560 passed and 6 skipped, the skips being the cases that run only on another platform.
- Not shown here, and left to CI: Linux, Windows, and gits 2.35.0, Debian 12's and Apple's.

## 2026-11-18, CI (`6b6c54d`)

- The first run on the pushed branch (`1dff438`) failed its Linux and Windows budgets jobs: `GitError: d0/f0.txt has
  no conflict`. A runner has no git identity of its own, and unlike macOS cannot make one up from the user and host
  names, so the merge the script makes refused before it started. Fixed in `6b6c54d` by telling the merge who it is
  by, as the script's commits already were.
- [Run 44302131547](https://github.com/spankyed/apack-git/actions/runs/44302131547) on `6b6c54d`: all ten jobs passed,
  `suite` on ubuntu-24.04, macos-15 and windows-2025, `git` on Debian 12, Apple git and the 2.35.0 floor, `budgets`
  on all three, and `ci-pass`.
