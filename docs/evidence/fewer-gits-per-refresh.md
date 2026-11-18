# Evidence: a refresh asks git only what may have changed

Checkpoint logs and findings for [the goal](../goals/goal-fewer-gits-per-refresh.md), dated, newest last. Each names
the commit and the command. This is history: the goal and the plan say what is current.

## 2026-11-18, Phase 1

On `feat/fewer-gits-per-refresh` from `28bf609`, macOS (Apple M1 Pro), git 2.38.1 first on `PATH` for the specs and
the budgets' own git 2.39.5 (Apple).

- `npx vitest run tests/gits-started.spec.ts`: 5 passed, on today's counts.
- `npm run build && npm run budgets -- 1000 100000`, load 27 to 15, after the noted-path fix:

  ```text
  1,000 files: open 417 ms (7 gits), whole status 136 ms (3 gits), one noted path 49 ms (1 gits), checkpoint 271 ms (7 gits), conflict sides 72 ms (2 gits) (generated in 233 ms)
  100,000 files: open 438 ms (7 gits), whole status 259 ms (3 gits), one noted path 33 ms (1 gits), checkpoint 762 ms (7 gits), conflict sides 57 ms (2 gits) (generated in 17200 ms)
  ```

  Before the fix the same reading was three gits, a whole status. Opening is seven here because the budgets' git,
  Apple's 2.39.5, refuses lazy fetch and is not asked whether the clone is partial.

## 2026-11-18, Phase 1 (`187e5da`) and Phase 2

- Phase 2: `npx vitest run tests/gits-started.spec.ts tests/trust.spec.ts tests/partial-clone.spec.ts tests/snapshot.spec.ts tests/git-check.spec.ts`
  passed (96, 1 skipped), and `tests/settings-held.spec.ts` 5 passed.
- **Blind hold.** With `HeldSettings`' signature made constant, `tests/settings-held.spec.ts` failed its four
  staleness cases: the repository's own configuration, an included file, the user's file made for the first time,
  and the environment naming another file. The fifth, a look again, passed, as it should. Restored after.
- **Finding: the order of opening differed by git.** On a git that cannot be told not to fetch (2.38.1 here), the
  first read asks whether the clone is partial before the trust gate runs, and with the settings held that read
  came before the trust gate's `rev-parse`. `readLane` now reads the trust gate before that question, and
  `loadSnapshot` passes the usable-git and trust gates before it reads the settings, as every command does. Opening
  is then `--version`, `rev-parse`, `config`, `status`, `for-each-ref`, `rev-parse` on every git.
- **Choice: the trust gate asks where the repository is once it is found.** The plan has Phase 2 keep the trust
  gate's `rev-parse`. Asked again whenever the settings' reading changed, it would have added a git to
  `refreshSnapshot('everything')`, which the plan holds to `config`, `status`, `for-each-ref`. It is asked until a
  repository is found and then held, which Phase 3 makes the rule for everyone.
- **Choice: `config.worktree` is known by where the local settings came from.** Until Phase 3 gives the reading the
  git directories, the repository's own files are found from the origin of a `local` setting, which git always
  writes: its `config`, and `config.worktree` beside it. For a linked worktree, whose `config.worktree` is in its own
  git directory, Phase 3 corrects this.
- `npm test` on Phase 2: 570 passed, 6 skipped, and `tests/rig-loss.spec.ts` failed seed 20261111, with
  `fseventsd` at 100% of a core and the machine at load 15 to 17. Run alone just after, it passed both seeds. Its
  last step waits for the platform to deliver the files made in every directory, and unlike the churn cases it has no
  watch of its own to tell the platform's silence from the engine's. Left for CI, which runs it where nothing else
  floods file events; a failure there is a failure.
