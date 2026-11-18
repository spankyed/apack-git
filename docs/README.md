# Documentation

What the engine is and the rules that hold it together are in the repository's [README.md](../README.md). Every
export is in [REFERENCE.md](../REFERENCE.md), generated from the source. What to know before changing the code is
in [CLAUDE.md](../CLAUDE.md). This folder holds the work around them.

## Where to look

| Directory | Purpose | What belongs here |
|---|---|---|
| [goals/](goals/) | Delivery scope and completion | Required outcomes, execution order, remaining checkpoints and acceptance |
| [plans/](plans/) | Intended designs | Proposed contracts, decisions, dependencies and acceptance cases |
| [plans/deferred/](plans/deferred/) | Designs put off | Each with its status and what would justify taking it up |
| [plans/wont-do/](plans/wont-do/) | Ideas declined | Each with its reason and what would reopen it |
| `evidence/` | What happened | What an investigation or a checkpoint established, dated, with its limits |
| `archive/` | Historical work and decisions | Completed, superseded, absorbed or abandoned documents with explicit status |

`evidence/` and `archive/` are made when the first document needs them.

Goals coordinate delivery; plans own detailed designs. A small goal may contain its design without a separate
plan. `README.md`, `REFERENCE.md` and `CLAUDE.md` describe implemented behavior; evidence records what a particular
investigation or checkpoint established. Moving a document never changes whether its requirements are complete.

## Document lifecycle

Keep current decisions and requirements in place. When a decision changes, reconcile the affected phase,
acceptance criteria, startup prompt and dependent plans in the same change; preserve the old reasoning in
evidence. Repair both incoming and outgoing links when moving a document.

Deferred plans stay in `plans/deferred/` with an explicit status and a condition for reconsideration. Deferral is
not permission to start work.

When implementation finishes, describe its resulting contract in `README.md`, `REFERENCE.md` or `CLAUDE.md`,
record closure evidence, and archive the goal and completed plans. A completed proposal must not be the only
account of current behavior. Do not archive unfinished requirements as completed or lose them when absorbing one
goal into another.

See [goal authoring](goals/README.md) for the template and [documentation rules](AGENTS.md) for upkeep.
