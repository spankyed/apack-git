# Documentation maintenance

Follow the repository's [CLAUDE.md](../CLAUDE.md). Use [README.md](README.md) for document locations
and [goals/README.md](goals/README.md) when creating or maintaining goals.

- Active goals and plans describe current decisions. Keep scope and execution in goals, detailed design
  in plans, current implemented behavior in `README.md`, `REFERENCE.md` and `CLAUDE.md`, and dated history in
  evidence.
- When changing a decision, reconcile affected requirements, phase checks, startup prompts and links
  in the same edit. Replace obsolete instructions instead of appending a contradictory correction.
- Maintain one current handoff per goal: source state, next checkpoint, proven checks and unresolved
  failures. Update it in place; put detailed checkpoint logs in `evidence/`.
- Before a checkpoint, name its deliverable, dependencies and closing checks. Map new findings to an
  existing requirement or propose additional scope explicitly. Do not reopen completed work without
  changed relevant inputs or new evidence; final integrated acceptance remains required.
- Moving evidence, archiving or consolidating documents never completes, excludes or defers an unmet
  requirement. Preserve its owner and acceptance criteria; scope changes require user authorization.
- Repair incoming and outgoing links when moving documents. Preserve historical claims as dated
  evidence; do not rewrite archived surveys as current implementation claims.
- Follow root validation guidance. Documentation maintenance alone does not justify the spec suite;
  check affected links, copied commands or prose assertions as appropriate.
