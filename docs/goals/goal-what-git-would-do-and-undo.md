# Goal: failures that name their files, an undo list, and previews

Status: active, 2026-11-17. Phase 2 has landed (`0b00d6f`); the rest is not started. The design is
[the plan](../plans/what-git-would-do-and-undo.md).

```text
# Goal: failures that name their files, an undo that says where it stands, and previews

Implement docs/goals/goal-what-git-would-do-and-undo.md. Follow CLAUDE.md and docs/AGENTS.md.
Read the plan it links, then Scope, Current handoff, Decisions, Phases and Constraints before continuing.
The survey was made at cd73da3 and checked again at 968139b; inspect current code before relying on it.
Follow the current checkout arrangement and preserve unrelated work.

Finished when:
- Every phase's Done when holds on current source, with its commit recorded in Phases.
- The final validation under Constraints has passed, on CI for what this machine cannot show.
- README.md, REFERENCE.md and CLAUDE.md describe the resulting contract.
- Outcome is written, the goal and the plan are archived, links are repaired and the closure is committed.

Commit each phase as its own checkpoint. Do not expand or reduce scope without user authorization.
```

## Scope

Six things a host cannot do today, and the housekeeping they need. The design of each is the plan's section of the
same number.

In:

1. An undo that was refused, or a copy of the working tree that is gone, carries a code a host can act on.
2. A host can ask what can be undone, and whether each entry can be undone now, before it tries.
3. A discard is in that list, so a host that lost the id a discard answered with can still put it back.
4. A checkout, a merge or a pull refused over local changes names the files in the way, and a push a hosting
   service refused names which of its rules.
5. A host can list a folder as a commit has it, without checking the commit out.
6. A host can ask what a cherry-pick or a rebase would do before it starts one.

With them: an undo that moved the wrong branch (Phase 2, landed), documentation that describes an older design of
discards (Phase 1), and the number of gits each operation starts made visible (Phase 6).

Out:

- Everything in [declined-engine-ideas](../plans/wont-do/declined-engine-ideas.md), and raising the git floor,
  which is [deferred](../plans/deferred/raise-git-floor.md).
- The plan's own "Out of scope, on purpose" list, under its Decisions.
- The consumer. The apack monorepo is not edited from here; the plan's "What the consumer must change" is kept
  correct for whoever moves its pin.

## Current handoff

- **Source:** `master` at `5fcf8fd`, which has Phase 2 (`0b00d6f`), this goal and its plan. No branch for the rest
  yet.
- **Next:** Phase 1. It has no dependency; Phase 3 is the next that changes code.
- **Proven** (2026-11-17, macOS, git 2.38.1): both Phase 2 cases pass, and both fail with `src/journal.ts` as it
  was. [spankyed/apack-git#42](https://github.com/spankyed/apack-git/pull/42), which carried Phase 2, was reported
  as passing every CI job; read the run before relying on that.
- **Unresolved:** nothing failing. Phase 8's cases cannot run on this machine (Constraints).
- **Choices made where the plan did not say:** none yet.

## Decisions

The design decisions are the plan's, D1 to D10, and are settled: change one only with the user, and in the plan.
These are the goal's own.

- **Phases land in order, each as one commit**, on a branch made from `master`. Phases 4 to 7 depend on nothing
  and may be reordered among themselves if one is blocked; say so in the handoff.
- **Phase 8 is last** because its cases need git 2.40 and this machine has 2.38.1 and 2.39.5. It is built here and
  proven on CI.
- **Where the plan gives a shape, a command or a pattern, build that.** Where it is silent, do what the nearest
  existing code does and record the choice in the handoff. Where it cannot be built as written, that is a finding:
  say what was observed and which requirement it touches before changing the design.
- **Nothing is pushed and no pull request is opened** until the user asks. That includes the CI run Phase 8 needs.

## Phases

"Done when" is what must be observed. The cases that show it are listed in the plan's section. Record the commit in
the last column as each phase lands.

| # | Deliverable | Depends on | Done when | Landed |
|---|---|---|---|---|
| 1 | `README.md`, `CLAUDE.md` and the doc comment of `restoreDiscarded` describe discards as checkpoints, and the README states that a prediction is never in a snapshot (plan 1) | Nothing | No sentence in those three files says a discard is kept as a tree in git's own object store or for git's two weeks; `REFERENCE.md` is regenerated | |
| 2 | An undo moves the branch its entry recorded, whatever is checked out (plan 2) | Nothing | A merge on `main` undone while `topic` is checked out puts `main` back and leaves `topic` and its files alone; an entry written on a detached `HEAD` is refused once a branch is checked out | `0b00d6f` |
| 3 | Codes for a refused undo and a dropped copy; `lastUndoable` and `undoables` say where each entry stands; `undo` takes an id; a discard is a journal entry (plan 3) | Phase 2 | The plan's cases pass in `tests/undo.spec.ts`, `tests/discards.spec.ts` and `tests/checkpoints.spec.ts`: each refusal carries its code, the list's standing agrees with what `undo` then does, an entry that is not the last is undone by id, and a discard is undone by `undo` and leaves the list when put back by id | |
| 4 | `LocalChangesError.files` and `HostRefusedError.rule` (plan 4) | Nothing | A refused checkout and a refused merge name the files git listed, from the top of the checkout, with a space and a non-ASCII letter in a name; each of the four host refusals names its rule | |
| 5 | `GitRepository.listFolder` (plan 5) | Nothing | It lists the top and a nested folder with kinds and sizes, answers nothing for a folder the commit lacks, refuses an unknown commit as `unknown-ref`, and does all of that in a repository with no working tree | |
| 6 | `npm run budgets` prints the gits started for each reading (plan 6) | Nothing | `npm run build && npm run budgets -- 1000` prints a count beside each of its four readings, and that line is recorded in the handoff | |
| 7 | A conflict's sides are read through the git kept open, which ends when the repository is refused as untrusted (plan 7) | Nothing | Reading a conflict's sides starts no `cat-file blob` of its own; after a read is refused as untrusted, the process that was kept open has gone | |
| 8 | `previewCherryPick` and `previewRebase` (plan 8) | Nothing in code | On a git of 2.40 or later, each names the commit and the files a real cherry-pick or rebase then stops on, and moves nothing; on an older git each answers `unknown` where a merge would have to be tried | |

A phase that adds an export or a public method also regenerates `REFERENCE.md`, and a phase that changes what a host
sees updates the plan's "What the consumer must change" in the same commit.

## Constraints

- **Final validation.** `npm run typecheck`, `npm run reference:check`, `npm run build` and `npm test` on the last
  commit, and CI's `suite` and `git` jobs on it. CI is what shows Phases 4, 5 and 7 on Linux, Windows and git
  2.35.0, and Phase 8 at all: until a run has passed, those are implemented and unverified, and the goal is open.
- **A newer git is not installed or built here to prove Phase 8.** Ask the user for a push, or for a git they
  already have.
- **`tests/rig-churn.spec.ts` may skip some seeds on macOS**, with the reason in the skip, when the system
  delivered no file events to the case. That is the machine, not this work; a failure there is still a failure.
- **Evidence.** Checkpoint logs, and anything observed that the plan did not expect, go in
  `docs/evidence/what-git-would-do-and-undo.md`, dated, with the commit and the command.
