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
