# Goal: a refresh asks git only what may have changed

Status: active, 2026-11-18. Not started. The design is [the plan](../plans/fewer-gits-per-refresh.md).

```text
# Goal: a refresh asks git only what may have changed

Implement docs/goals/goal-fewer-gits-per-refresh.md. Follow CLAUDE.md and docs/AGENTS.md.
Read the plan it links, then Scope, Current handoff, Decisions, Phases and Constraints before continuing.
The survey was made at ad3f0f1 on master; inspect current code before relying on it.
Follow the current checkout arrangement and preserve unrelated work.

Finished when:
- Every phase's Done when holds on current source, with its commit recorded in Phases.
- The final validation under Constraints has passed, on CI for what this machine cannot show.
- README.md, REFERENCE.md and CLAUDE.md describe the resulting contract.
- Outcome is written, the goal and the plan are archived, links are repaired and the closure is committed.

Commit each phase as its own checkpoint. Do not expand or reduce scope without user authorization.
```

## Scope

Every whole status starts three gits, and two of them ask what rarely changes: the settings and the refs. Staging
one file and seeing it listed costs six gits, of which two were needed. Opening a repository asks where its git
directory is twice and reads its settings three times. On Windows, where starting a process costs most, that is
most of what a small repository's refresh costs.

In:

1. The count of gits each common operation starts is asserted in a spec, so a process added to a common path fails
   a case.
2. The settings are read once and held until a file they came from looks different.
3. Opening asks where the repository is once.
4. A change to the index alone, made here or reported by the watcher, reads the status and not the refs.
5. What starting a git costs on Windows, by the `PATH` and directly, is measured and recorded.

The plan's last table says what it comes to: opening from 8 gits to 5, a whole status after a write from 3 to 2,
and the read after staging from 3 to 1.

Out:

- The plan's own "Out of scope, on purpose" list: working out from git's files whether a ref moved, more gits kept
  open, a newer git floor, and choosing a host's `git.exe`.
- Everything in [declined-engine-ideas](../plans/wont-do/declined-engine-ideas.md) and the
  [deferred plans](../plans/deferred/).
- The consumer. The apack monorepo is not edited from here. Phase 4 widens a type it is handed; the plan's section
  4 says why it need not change, and is kept correct for what is built.

## Current handoff

- **Source:** `master` at `ad3f0f1`. This goal and its plan are on `feat/fewer-gits-per-refresh`, made from it.
- **Next:** Phase 1.
- **Proven:** the counts in the plan's Background, observed on macOS with git 2.38.1 on 2026-11-18.
- **Unresolved:** nothing failing.
- **Choices made where the plan did not say:** none yet.

## Decisions

The design decisions are the plan's, D1 to D6, and are settled: change one only with the user, and in the plan.
These are the goal's own.

- **Phases land in order, each as one commit**, on `feat/fewer-gits-per-refresh`. Phase 5 depends on nothing and
  may be taken at any point.
- **The count comes before each change.** Phase 1 asserts today's counts. Each later phase changes the
  expectations in the same commit as the code, so every commit's diff shows which process it removed.
- **Where the plan gives a shape, build that.** Where it is silent, do what the nearest existing code does and
  record the choice in the handoff. Where it cannot be built as written, that is a finding: record what was
  observed in the evidence, decide by the requirement it serves, and carry on.
- **A held answer is proven stale-safe before it is relied on.** Each of Phases 2 and 4 lands with the cases in
  which something changes behind the engine, and each of those cases is shown to fail with the hold made blind:
  the signature made constant, the index report treated as nothing. Record that in the evidence.

## Phases

"Done when" is what must be observed. The cases that show it are in the plan's section of the same number. Record
the commit in the last column as each phase lands.

| # | Deliverable | Depends on | Done when | Landed |
|---|---|---|---|---|
| 1 | `tests/gits-started.spec.ts` asserts the commands each common operation starts, and `npm run budgets` takes its noted-path reading with a snapshot held (plan 1) | Nothing | The spec passes with today's counts; `npm run build && npm run budgets -- 1000 100000` prints a noted-path reading of one git; the README's paragraph on that reading says what the two readings show | |
| 2 | `HeldSettings`: one `config --list`, held by how its files look, used by the trust gate, the status and the partial-clone question (plan 2) | Phase 1 | A whole status after a write is `status`, `for-each-ref`; opening is the same six commands on every git; a setting changed in the repository's configuration, an included file, a user's file made for the first time and the environment is each seen without a "look again"; `refreshSnapshot('everything')` takes the settings afresh | |
| 3 | Where the repository is, asked once at opening (plan 3) | Phase 2 | Opening is `--version`, `rev-parse`, `config`, `status`, `for-each-ref`; the trust and worktree specs pass unchanged | |
| 4 | The `'index'` hint from the watcher and from the writes that move only the index (plan 4) | Phase 2 | Watched, the read after staging and after an index report is `status` alone; a commit made by another git is still seen; a ref moved with no report of it is found by a look again; a real `git add` is reported as `'index'` and a real `git commit` as `null` | |
| 5 | `npm run budgets` prints what starting a git costs on Windows, by the `PATH` and directly (plan 5) | Nothing | The script runs unchanged elsewhere, and the line CI's Windows `budgets` job prints is recorded in the evidence | |

A phase that adds, changes or removes an export or a public method also regenerates `REFERENCE.md`.

## Constraints

- **Final validation.** `npm run typecheck`, `npm run reference:check`, `npm run build` and `npm test` on the last
  commit, and CI's `suite`, `git` and `budgets` jobs on it. The watcher's cases in Phase 4 are a platform claim on
  each of Linux, macOS and Windows, and Phase 5 is a Windows reading: until a CI run has passed, those are
  implemented and unverified, and the goal is open.
- **Counts are the same on every supported git from Phase 2 on.** A case that would need a different count on an
  older git is a finding, not a skip.
- **`tests/rig-churn.spec.ts` may skip some seeds on macOS**, with the reason in the skip, when the system
  delivered no file events to the case. That is the machine, not this work; a failure there is still a failure.
- **Evidence.** Checkpoint logs, the budgets lines before and after, and anything observed that the plan did not
  expect, go in `docs/evidence/fewer-gits-per-refresh.md`, dated, with the commit and the command.
