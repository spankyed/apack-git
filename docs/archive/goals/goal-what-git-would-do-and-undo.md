# Goal: an undo that takes what it was shown, and failures that name their files

> **Done, 2026-11-18.** Every phase landed; see [Outcome](#outcome-2026-11-18). Archived with
> [its plan](../plans/what-git-would-do-and-undo.md). Two phases that were here are deferred, each with its own
> plan: [the previews](../../plans/deferred/preview-cherry-pick-and-rebase.md) and
> [the listing](../../plans/deferred/list-folder-at-a-commit.md).

Status: done, 2026-11-18. The design is [the plan](../plans/what-git-would-do-and-undo.md).

```text
# Goal: an undo that takes what it was shown, and failures that name their files

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

Four things a host cannot do today, and the housekeeping they need. The design of each phase is the plan's section
of the same number.

In:

1. A host can list what can be undone, with whether each entry can be undone now and why not, before it tries.
2. A host undoes the entry it showed, by its id, and is refused with a code when that entry has moved, is
   published or is gone. It can no longer undo something other than what it showed.
3. A discard is in that list and is put back by the same `undo`, so there is one way to take anything back.
4. A checkout, a merge or a pull refused over local changes names the files in the way, and a push a hosting
   service refused names which of its rules.

With them: an undo that moved the wrong branch (Phase 2, landed), documentation that described an older design of
discards (Phase 1, landed), the number of gits each operation starts made visible (Phase 6), and two small changes
to the git kept open for reading files, the first measured by that number (Phase 7).

Out:

- Previews of a cherry-pick and a rebase, and listing a folder at a commit. Both were phases here until 2026-11-18
  and are deferred, each with what would justify taking it up:
  [the previews](../../plans/deferred/preview-cherry-pick-and-rebase.md) because nothing in them has been run, and
  [the listing](../../plans/deferred/list-folder-at-a-commit.md) because no host calls it.
- Raising the git floor, which is [deferred](../../plans/deferred/raise-git-floor.md), and everything in
  [declined-engine-ideas](../../plans/wont-do/declined-engine-ideas.md).
- The plan's own "Out of scope, on purpose" list, under its Decisions.
- The consumer. The apack monorepo is not edited from here; the plan's "What the consumer must change" is kept
  correct for whoever moves its pin.

## Current handoff

Closed. Every phase landed on `feat/undo-list-and-named-failures`
([spankyed/apack-git#43](https://github.com/spankyed/apack-git/pull/43)); see the Outcome. Nothing is left to hand
off: the deferred phases have their own plans, and the consumer's changes are listed in the plan.

## Decisions

The design decisions are the plan's, D1 to D7, and are settled: change one only with the user, and in the plan.
Three of them change what a host sees and were confirmed by the user on 2026-11-18: a discard is a journal entry
(D4), `undo` requires the id of the entry (D5), and what git named in a failure is read from its output and is
best-effort (D2).

These are the goal's own.

- **Phases land in order, each as one commit**, on a branch made from `master`. Phase 5 depends on nothing and may
  be taken ahead of 3 and 4 if they are blocked; say so in the handoff.
- **The count comes before the change it measures.** Phase 6 records how many gits reading a conflict's sides
  starts, and Phase 7 is held to that number falling.
- **The undo list and discards in it are two phases**, 3 and 4. Phase 4 is the one that removes
  `restoreDiscarded` and changes what a host sees after a discard, so it can be reverted on its own.
- **Where the plan gives a shape, a command or a pattern, build that.** Where it is silent, do what the nearest
  existing code does and record the choice in the handoff. Where it cannot be built as written, that is a finding:
  say what was observed and which requirement it touches before changing the design.
- **Nothing is pushed and no pull request is opened** until the user asks.

## Phases

"Done when" is what must be observed. The cases that show it are listed in the plan's section. Record the commit in
the last column as each phase lands.

| # | Deliverable | Depends on | Done when | Landed |
|---|---|---|---|---|
| 1 | `README.md`, `CLAUDE.md` and the doc comment of `restoreDiscarded` describe discards as checkpoints, and the README states that a prediction is never in a snapshot (plan 1) | Nothing | No sentence in those three files says a discard is kept as a tree in git's own object store or for git's two weeks; `REFERENCE.md` is regenerated | `bb24b4e` |
| 2 | An undo moves the branch its entry recorded, whatever is checked out (plan 2) | Nothing | A merge on `main` undone while `topic` is checked out puts `main` back and leaves `topic` and its files alone; an entry written on a detached `HEAD` is refused once a branch is checked out | `0b00d6f` |
| 3 | Codes for a refused undo and a dropped copy; `undoables` lists every entry with where it stands; `undo` takes the entry's id; `lastUndoable` is gone (plan 3) | Phase 2 | Each refusal carries its code; an entry's standing in the list is what `undo` of it then does; an entry that is not the last is undone by its id; an entry read before a later write is the one undone after it; no source or spec names `lastUndoable` | `add9bb5` |
| 4 | A discard is a journal entry, put back by `undo`; `restoreDiscarded` is gone (plan 4) | Phase 3 | A discard answers its entry's id and is in the list; `undo` of it puts the files back and answers what it restored and left; an entry that left files stays until a restore leaves none; a dropped copy reads as `no-longer-kept` in the list and from `undo`; no source or spec names `restoreDiscarded` | `ceb2abb` |
| 5 | `LocalChangesError.files` and `HostRefusedError.rule`, and the rule in `CLAUDE.md` for what is read from git's output (plan 5) | Nothing | A refused checkout and a refused merge name the files git listed, from the top of the checkout, with a space and a non-ASCII letter in a name; the failure keeps its code when the list is not there; each of the four host refusals names its rule || `5e47156` |
| 6 | `npm run budgets` prints the gits started for each reading, and a fifth reading: a conflict's three sides (plan 6) | Nothing | `npm run build && npm run budgets -- 1000` prints a count beside each of its five readings, and that line is recorded in the handoff || `84b6ff2` |
| 7 | A conflict's sides are read through the git kept open, which ends when the repository is refused as untrusted (plan 7) | Phase 6 | The same command prints fewer gits for a conflict's sides than Phase 6 recorded, and that line is recorded beside it: the three `cat-file blob` gits are gone, and a first read of a file from a commit in a repository still runs the once-per-repository partial-clone check (4 to 2; 1 on a later read; settled with the user 2026-11-18); reading the sides starts no `cat-file blob` of its own; after a read is refused as untrusted, the process that was kept open has gone || `4fbf892` |

A phase that adds, changes or removes an export or a public method also regenerates `REFERENCE.md`, and a phase that
changes what a host sees updates the plan's "What the consumer must change" in the same commit.

## Constraints

- **Final validation.** `npm run typecheck`, `npm run reference:check`, `npm run build` and `npm test` on the last
  commit, and CI's `suite` and `git` jobs on it. CI is what shows Phases 3, 4, 5 and 7 on Linux, Windows and git
  2.35.0: until a run has passed, those are implemented and unverified, and the goal is open.
- **`tests/rig-churn.spec.ts` may skip some seeds on macOS**, with the reason in the skip, when the system
  delivered no file events to the case. That is the machine, not this work; a failure there is still a failure.
- **Evidence.** Checkpoint logs, and anything observed that the plan did not expect, go in
  `docs/evidence/what-git-would-do-and-undo.md`, dated, with the commit and the command.

## Outcome (2026-11-18)

A host can list what can be undone and why not (`undoables`), undo the entry it showed by its id (`undo(id)`), and
put a discard back the same way. A checkout, a merge or a pull refused over local changes names the files in the way,
and a push a hosting service refused names its rule. The budgets count the gits each reading starts, and a conflict's
sides are read through the git kept open, which ends when trust is refused. All of it is on
`feat/undo-list-and-named-failures`, [spankyed/apack-git#43](https://github.com/spankyed/apack-git/pull/43).

| Phase | Disposition | Source and evidence |
|---|---|---|
| 1. The documentation describes discards as checkpoints | Done | `bb24b4e` |
| 2. An undo moves the branch it recorded | Done | `0b00d6f`, through [#42](https://github.com/spankyed/apack-git/pull/42)'s CI |
| 3. `undoables`, undo by id, three codes | Done | `add9bb5`; `tests/undo.spec.ts`, and a mutation in the evidence |
| 4. A discard is in the journal, and `undo` puts it back | Done, with a finding | `ceb2abb`; a file already put back is restored, not left (plan section 4) |
| 5. `LocalChangesError.files`, `HostRefusedError.rule` | Done | `5e47156`; `tests/failures.spec.ts`, `tests/named-failures.spec.ts`, a mutation |
| 6. The budgets count gits, and read a conflict's sides | Done | `84b6ff2`, and `6b6c54d` for a runner without an identity of its own |
| 7. The sides through the git kept open; it ends on a trust refusal | Done, with a finding | `4fbf892`; the count fell from 4 to 2, not 1, accepted by the user (plan section 7) |

`README.md` describes undo and its list, discards, the two failure facts and the git kept open; `CLAUDE.md` holds the
rule for facts read from git's output; `REFERENCE.md` is regenerated. On macOS the four commands passed on
`4fbf892` (560 passed, 6 skipped); CI's run on `6b6c54d`, the last commit with code, passed all ten jobs ([run 44302131547](https://github.com/spankyed/apack-git/actions/runs/44302131547)): the suite on Linux, macOS and Windows, the `git` jobs on Debian 12's git, Apple's and 2.35.0, and the budgets on all three. The checkpoint log
is [the evidence](../../evidence/what-git-would-do-and-undo.md).

Out of this goal, each with its plan: [the previews](../../plans/deferred/preview-cherry-pick-and-rebase.md),
[the listing](../../plans/deferred/list-folder-at-a-commit.md) and [the git floor](../../plans/deferred/raise-git-floor.md).
The apack monorepo moves its pin by the plan's "What the consumer must change".
