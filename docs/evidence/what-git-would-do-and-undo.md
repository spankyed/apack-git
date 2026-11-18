# Evidence: an undo that takes what it was shown, and failures that name their files

Checkpoint logs and findings for [the goal](../goals/goal-what-git-would-do-and-undo.md), dated, newest last. Each
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
