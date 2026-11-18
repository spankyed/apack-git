# Goal docs

A goal lets someone resume delivery without the conversation that produced it. It owns the required
outcomes, execution order and completion criteria. [Plans](../plans/) own detailed designs; evidence records
(`docs/evidence/`) own investigations and checkpoint history. See the [documentation guide](../README.md) for the
full layout and [maintenance rules](../AGENTS.md).

Write a goal for work spanning sessions, requiring coordinated checkpoints or awaiting important
decisions. A small fix can stay in the conversation. A small goal can contain its design; a separate
plan is useful only when the design needs substantial explanation.

## Where they live

- `docs/goals/goal-<topic>.md`: planned, active or deferred work, with an explicit status.
- `docs/archive/goals/`: completed, absorbed, superseded, abandoned or rejected work, with its reason
  and successor links. Archiving does not mean every proposal was implemented.

Deferred documents name what would justify reconsideration. They are not the active execution queue.
Declined ideas are recorded in `docs/plans/wont-do/`, each with its reason and what would reopen it.

## Structure

Use only sections the work needs. Each fact has one authoritative home; link rather than repeat it.

### 1. The prompt block

Open with a short task prompt that points to this document, its surveyed base and the current handoff.
Keep it below the goal runner's 4,000-character limit. Reference standing repository instructions
instead of copying their prohibitions, validation commands or compatibility policy.

````text
```text
# Goal: <required outcome>

Implement docs/goals/goal-<topic>.md. Follow CLAUDE.md and docs/AGENTS.md.
Read Scope, Current handoff, Decisions, Phases and Constraints before continuing.
The initial survey was made at <commit> on <branch>; inspect current code before relying on it.
Follow the current checkout arrangement and preserve unrelated work.

Finished when:
- Every required outcome and phase acceptance condition below is met on current source.
- Required integrated/final validation passes, with source commits and evidence recorded.
- README.md, REFERENCE.md and CLAUDE.md describe the resulting contract.
- Record Outcome, archive completed work, repair links and commit closure.

Commit usable checkpoints as you go. Do not expand or reduce scope without user authorization.
```
````

The prompt delegates detail to the document; it must not become a second specification. If the survey
is stale, inspect current implementation and reconcile the plan before acting. A moved path is a reason
to investigate, not automatically to stop. Respect explicit user instructions and blocking decisions.

### 2. Scope and background

State the outcome, required deliverables and exclusions. Name the surveyed commit/date and relevant
entry points. Keep background short and factual; detailed surveys and spike results belong in evidence.
A deferred requirement names its disposition and owner. Consolidation must account for every unfinished
requirement transferred from a predecessor; “absorbed” does not authorize dropping deliverables.

### 3. Current handoff

Maintain one replaceable handoff with:

- branch/checkout and latest usable source checkpoint;
- the next concrete deliverable and its actual dependencies;
- proven checks, unresolved failures and links to detailed evidence.

Update it in place. Do not append new “next steps” or remaining-work lists after each checkpoint.
Mark implemented work separately from unverified final acceptance so an evidence gap does not silently
restart implementation. Historical handoffs live in evidence and do not override current ordering.

### 4. Decisions

Record settled choices and their reasons, or cite the owning subsystem plan's decision. Keep one
owner for each contract. Identify genuinely open decisions and the phase they block; continue
independent work where possible.

When a decision changes, update every affected phase, acceptance condition and startup instruction
in the same change. Link the previous reasoning from evidence. Routine corrections follow repository
and user instructions; material scope or product changes need a user decision. Do not silently replace
an approved outcome or reopen settled design without evidence.

### 5. Phases

Each phase or coherent checkpoint names:

- **Deliverable:** the concrete behavior or contract being changed, citing its owning decision.
- **Dependencies:** only the guarantees it actually consumes, not blanket phase-number barriers.
- **Done when:** finite observable conditions, the checks that prove them and relevant existing evidence.

Specify the acceptance boundary before implementation. A new finding must name the observed defect
or required gap, the existing requirement it serves, and a finite exit condition. Additional work outside
those requirements is a scope proposal, not an automatic extension of the goal.

Commit validated logical checkpoints before expanding work. Large phases may contain several usable
checkpoints. Follow root instructions for staging and validation; do not commit other sessions' changes.

### 6. Acceptance and evidence

For a large goal, keep one acceptance table rather than competing checklists. Small goals may use their
phase conditions directly. Distinguish the following states explicitly:

| Requirement | Implementation / source | Evidence | Remaining work |
|---|---|---|---|
| <observable outcome> | <implemented, partial or missing; commit> | <check/result or evidence link> | <specific missing implementation or verification> |

Detailed cases stay in their owning plan; the goal records closure and links to them. Existing evidence
can close a requirement when it actually covers that requirement and its relevant inputs still apply.
Reopen it when new evidence or changed inputs invalidate the claim. Required final integrated gates
remain required; a focused pass cannot stand in for broader acceptance.

Checkpoint logs belong in `docs/evidence/<topic>.md`. Date entries, record source commits, exact
commands/results and limitations. Failed checks remain visible until resolved; old failures alone do
not establish a current failure. Evidence records are history, not another implementation queue.

### 7. Deferred and constraints

Include only goal-specific exclusions, operational constraints and authorized deferrals. Cite standing
repository rules rather than copying them. Deferring required work is a scope change; an agent cannot
move it here merely to call the goal complete. Open decisions and unsupported hypotheses do not
silently become new requirements either.

## Keeping the loop fast

Run the spec a change touches while working (`npm test -- tests/<file>.spec.ts`), and the commands
[CLAUDE.md](../../CLAUDE.md) lists at a checkpoint and at the end. A claim about Linux, Windows or an older git is
made by CI, not by a run on another platform. Diagnose failures from preserved logs
and the smallest relevant reproducer; do not rerun broad suites for reassurance after every fix.

Name the behavior a check proves. Mutation checks are useful for meaningful guards; do not require
one for every helper or test, or invent tests that merely restate wiring. If a test reads built output,
confirm that output matches the source being claimed. Keep detailed timings and experiments in evidence,
not standing instructions. Documentation-only edits need relevant document checks, not app suites.

## Finishing a goal

Audit every required outcome against current source and appropriate evidence. Resolve missing or weak
proof, run the required final checks on recorded source, and write Outcome. A checkpoint or a smaller
passing subset does not complete the goal.

Document the resulting implemented contract in `README.md`, `REFERENCE.md` (generated) and `CLAUDE.md` before
archiving completed plans. Update existing documentation where it already owns that contract; do not manufacture
a new reference document for every goal.

Move completed goals to `docs/archive/goals/` and completed plans to `docs/archive/plans/`. Add a status
notice identifying done, absorbed, superseded, abandoned or rejected, with source/successor links and
any unmet requirements' owner. Repair incoming and outgoing links, including anchors. Keep deferred
and unfinished work visible; do not archive it as completed. Commit closure without assuming permission
to push, publish or merge.

### Invariants and milestones

A milestone was true when work landed; later renaming does not make that goal unfinished. An invariant
must continue to hold. For each lasting invariant, identify its enforcing type, check or spec,
or state explicitly that no automated guard exists. Guard the behavior, not the absence of an obsolete
identifier. Put the current contract in `README.md`, `REFERENCE.md` or `CLAUDE.md`, not solely in archived plans.

### The Outcome section

Keep closure concise:

```text
## Outcome (YYYY-MM-DD)

<What landed, where, and the result.>

| Phase / requirement | Disposition | Source and evidence |
|---|---|---|

<Resulting documentation and final validation.>
<Authorized exclusions or follow-ups, their owners and relevant decision.>
```

Write from commits and evidence, not memory. Missing required work keeps completion open; recording
it as a follow-up does not waive it. Omit empty sections and repeated histories.

## Writing style

Use plain, specific language and checkable outcomes. Distinguish observed facts, decisions and hypotheses.
Date historical evidence and identify its source. Update active instructions instead of appending
contradictions. Avoid arbitrary document-length gates; keep execution usable by giving history its own home.
