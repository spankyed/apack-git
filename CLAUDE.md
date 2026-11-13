# apack-git

The git engine of apack: one working tree's picture and every git process that keeps it. `README.md` says what
it is for and the rules that hold it together; this is what to know before changing it.

## Layout

- `src/index.ts` is the door: what it exports is the package. `src/staging.ts` and `src/availability.ts` are
  the other two entries, which import nothing of Node's.
- `REFERENCE.md` is generated from the entries by `scripts/reference.mjs`, and `examples/news.mjs` is a host in
  thirty lines over the built package.
- `src/repository.ts` is the class a host calls. It composes four parts and each of its methods is one of
  theirs: `runner.ts` runs git (lanes, locks, results), `model.ts` keeps the snapshot and says what changed,
  `reads.ts` and `writes.ts` are what the names say.
- `src/status.ts` reads `git status --porcelain=v2`; `errors.ts` reads why a command failed; `hunks.ts`,
  `objects.ts` and `progress.ts` each hold one mechanism.
- `src/trust.ts` reads what a repository would have git run and gates every command on it. **A setting is
  safe only when it is on its list of settings known to run nothing**: a new one git gains asks until it is
  added there, with a case in `tests/trust.spec.ts`.
- `src/discards.ts` keeps what a discard removes, as a tree nothing refers to, and puts it back.
- `src/watcher.ts` turns file events into hints, over `directory-watch.ts`, the platform's watch on a tree.
- `src/types.ts` holds the shapes the engine answers in, and `ties.ts` what a host hands in.

## Rules

- **No runtime dependencies and nothing native.** A consumer bundles this package; a native binding would
  have to be resolved by its host instead.
- **The engine imports only its own modules and Node's built-ins.**
- **A platform claim is made on that platform.** CI runs the suite on Linux, macOS and Windows on every push.
  A case that cannot run on a platform is skipped there with the reason in the skip, never deleted.
- **Every spec runs a real git** in a throwaway repository, and goes through the door: a spec imports an entry
  (`src/index.ts`, `src/staging.ts`, `src/availability.ts`) and nothing else of `src/`. What a spec needs to see
  inside is seen through a tie (`run`, `log`).
- **A spec's background process ends by itself**, and a spec removes the directories it made.
- **A new reason a command failed is a new entry in `errors.ts`**, most telling first, with a case in
  `tests/failures.spec.ts` that fails a real git that way.
- **A comment says how the code is, for whoever opens the file cold.** What changed and why goes in the
  commit message.
- **Nothing is kept for compatibility.** The engine has one consumer, pinned by commit, and both move together.

## Commands

```bash
npm run typecheck   # src, tests and the vitest config
npm run build       # dist/, which the package's entries name
npm test            # every spec
npm test -- tests/snapshot.spec.ts
npm run reference:update  # REFERENCE.md from the source; reference:check fails on a difference, or an export
                          # or a public member no spec uses
```
