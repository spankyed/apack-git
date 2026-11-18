# An undo that takes what it was shown, and failures that name their files

> **Done, 2026-11-18.** Every section was built as [its goal](../goals/goal-what-git-would-do-and-undo.md)'s
> Outcome records, with two findings written into sections 4 and 7. This is the design as it was; what the engine
> does now is in `README.md`, `REFERENCE.md` and `CLAUDE.md`.

Status: done, 2026-11-18. This document held the design for
[its goal](../goals/goal-what-git-would-do-and-undo.md), which owned the order, the dependencies and when each
section was done: the decisions, the shapes, the commands and the cases.

## Background

Surveyed at `cd73da3`, 2026-11-17, on macOS with git 2.38.1 (Homebrew) and 2.39.5 (Apple). The paths and names
cited were checked again against `master` at `968139b`. What was run against a real git says "observed"; the rest
was read. Inspect current code before relying on a path.

What was declined is in
[declined-engine-ideas](../../plans/wont-do/declined-engine-ideas.md). Raising the git floor is
[deferred](../../plans/deferred/raise-git-floor.md), and so are
[previews of a cherry-pick and a rebase](../../plans/deferred/preview-cherry-pick-and-rebase.md) and
[listing a folder at a commit](../../plans/deferred/list-folder-at-a-commit.md), which were sections of this plan until
2026-11-18.

**Already there when surveyed**, so not designed here:

- Discards are checkpoints. `src/discards.ts` calls `CheckpointStore.checkpoint`, and the store is a bare git
  directory outside the repository. `README.md` and `CLAUDE.md` described an older design (section 1).
- The git kept open for reading files (`src/objects.ts`) ends itself five seconds after its last read
  (`LINGER_MS`), is ended by `GitRepository.close()`, and is never started in an untrusted repository
  (`GitReads.fileInCommit` passes the trust gate first).
- A failed sign-in has a case that names the remote (`tests/failures.spec.ts`, "says the remote asked for a
  sign-in").

## Decisions

- **D1. The git floor stays at 2.35.0.** Nothing here needs a newer git.
  [The deferred plan](../../plans/deferred/raise-git-floor.md) says why the floor is where it is.
- **D2. What git named in a failure is read from the lines git wrote, in `src/errors.ts`, and is best-effort.**
  Git has no machine-readable errors, and no command answers "which files block this checkout"; working it out from
  diffs would be the engine guessing git's rules. So the list is read from git's own, under the conditions that
  make that safe: one place reads what git printed, every git child runs in English (`gitEnvironment`), and CI
  runs the cases from 2.35.0 to the newest git. A fact read this way is optional: when the lines are not as
  expected the failure keeps its code and git's words, and the fact is empty. It never turns a failure the engine
  knows into one it does not.
- **D3. A code that is not read from git has its case beside its feature.** `CLAUDE.md` asks for a case in
  `tests/failures.spec.ts` that fails a real git. A code the engine decides itself has no git to fail, so it follows
  `published`, whose cases are in `tests/undo.spec.ts` and `tests/rewrite.spec.ts`.
- **D4. The journal is the one list of what can be taken back, and a discard is in it.** Each write the engine
  can reverse is an entry, a discard included, as in an operation log. A host that lost the id a discard answered
  with finds it in the list, and there is one way to put a discard back: `undo`. `restoreDiscarded` is removed.
- **D5. `undo` takes the id of the entry to take back, and it is required.** "The last entry" changes whenever
  anything writes, so a host that showed "undo commit X" and then called a bare `undo()` could take back something
  else: a discard made from another window in between. With the id, a host takes back the entry it showed, or is
  refused with a code. Any entry can be taken back, not only the last, when nothing it moved has moved since: the
  check that protected the last entry protects every entry.
- **D6. An entry recorded with `HEAD` detached is refused once `HEAD` is on a branch.** Its ref was `HEAD` itself.
  Moving `HEAD` back now would move the branch `HEAD` is on, which the entry never touched.
- **D7. `lastUndoable()` is removed.** `undoables()` is the list, newest first, and a host that wants "undo the
  last commit" takes the newest entry that is one. What "last" means stays with the host, where the button is. No
  old name is kept beside the new (`CLAUDE.md`: nothing is kept for compatibility).

**Out of scope, on purpose.** Do not add these.

- A code for untracked files in the way of a checkout. `src/errors.ts` says why they have none.
- Refusing an undo because the branch is checked out in another worktree.
- A `remote` on a failed push or fetch. The caller named it or reads it with `readRemote()`.
- Any change to `src/staging.ts`, `src/availability.ts` or `GitStatusFile`.

## How the sections are written

Each section gives the shapes and commands as they are meant to be built, then its cases. A new export or public
method of `GitRepository` needs a case that calls it, since `npm run reference:check` fails on one no spec uses.

Cases follow the existing specs: a real git in a temporary directory, removed in `afterEach` with
`removeDirectory` from `tests/_support/remove.ts`, git run through `run` from `tests/_support/process.ts`, and the
engine imported only from `../src/index.ts`. Each section names the spec file whose setup to copy.

## 1. The documentation says what the code does

Landed with the revision of this plan dated 2026-11-18. `README.md` and `CLAUDE.md` described a discard as a tree
written into git's own object store and kept for git's two weeks. They now say what `src/discards.ts` does: a
discard is kept as a checkpoint, a commit in a store outside the repository, dropped after 14 days or as the oldest
of too many. The doc comment of `restoreDiscarded` says the same, `CLAUDE.md` lists `src/checkpoints.ts` and
`src/journal.ts`, and the README states that a prediction is never in a snapshot.

## 2. An undo acts on the branch it recorded

Landed in `0b00d6f`. Reproduced against a real git before the fix:

1. On `main`, call `repo.merge('side')`.
2. Check out `topic`, which has a commit of its own.
3. Call `repo.undo()`.

The undo answered as done, `main` kept the merge, and `topic` was moved to where `main` had been, so its own commit
was off the branch and its file gone from the working tree. `Journal.reverse` ran `git reset --keep <before>`, which
moves whatever branch is checked out.

As built, in `src/journal.ts`: a reset is run only when the branch the entry recorded is the one checked out, and
otherwise that branch alone is moved with `git update-ref`, leaving the working tree as it is. An entry whose ref is
`HEAD` itself, written with no branch checked out, is refused as moved once a branch is checked out (D6). Both
cases are in `tests/undo.spec.ts`.

## 3. One list of what can be undone, and an undo that takes its id

**Deliverable.** Decisions D3, D5 and D7. Discards join the list in section 4.

**Three codes.** In `src/errors.ts`, add to the end of `GIT_ERROR_CODES`, each with a doc comment in the style of
`published` that ends "Not read from what git printed":

| Code | Means | Thrown where |
|---|---|---|
| `moved-since` | An undo of a write whose ref has moved since: undoing it would undo what moved it too | `Journal.undo`, the "has moved since" error |
| `nothing-to-undo` | An undo of an entry that is not in the journal: taken back already, or past its age | `Journal.undo`, the "nothing to undo" error |
| `no-longer-kept` | A copy of the working tree the store has dropped: past its age, or the oldest of too many | `CheckpointStore.recorded` in `src/checkpoints.ts`, the "no longer kept" error |

Keep each error's message. Only add the code as the second argument of `new GitError`.

**The shapes.** In `src/types.ts`:

```ts
/** A write in the journal, and whether `undo` would take it back now */
export interface Undoable {
  entry: JournalEntry
  /** `ready`, or why `undo` would refuse it: the code its refusal carries */
  standing: 'ready' | 'moved-since' | 'published' | 'no-longer-kept'
  /** For `moved-since`: the refs that are no longer where the write left them */
  moved?: string[]
  /** For `published`: the remote branches that hold the commit, as git names them short (`origin/main`) */
  publishedOn?: string[]
}

/** What taking an entry back did */
export interface Undone {
  /** The entry taken back, which is no longer in the journal */
  entry: JournalEntry
}
```

**In `src/journal.ts`:**

- A private `standingOf(entry)` that answers an `Undoable`. It is the only place that decides whether an entry can
  be undone, so the list and `undo` cannot disagree. Check in this order and answer the first that holds:
  1. `moved-since`, with `moved`: any ref of `entry.refs` that is not at its `after` now, or is `'HEAD'` while a
     branch is checked out (section 2, D6).
  2. `published`, with `publishedOn`: the operation is `commit` and a remote branch holds `refs[0].after`. This is
     the `for-each-ref --contains` query `undo` runs today. Run it only when 1 did not hold.
  3. `ready`.
- `undo(id, { evenIfPublished })`. It takes back the entry with that id. No such entry is `nothing-to-undo`. It
  calls `standingOf` and refuses anything not `ready` with a `GitError` carrying the standing as its code and the
  message `undo` uses today. `published` is let through when `evenIfPublished`. After reversing, it writes the
  journal without that one entry (filter by id, not `slice(0, -1)`), and answers an `Undone`.
- `all()` answers every entry kept, newest first, each as an `Undoable`. Resolve each distinct ref once for the
  whole list, not once per entry.
- `last()` is removed.

**In `src/repository.ts`**, with a doc comment each. `lastUndoable` is removed:

```ts
undoables(): Promise<Undoable[]>
undo(id: string, options?: { evenIfPublished?: boolean }): Promise<Undone>
```

Export `type Undoable` and `type Undone` from `src/index.ts`.

**Cases.** Change the existing ones first. `grep -rn "lastUndoable\|\.undo(" tests` finds them, in
`tests/undo.spec.ts`, `tests/rewrite.spec.ts` and `tests/start-operations.spec.ts`: each reads the entry from
`undoables()` and passes its id. Then, in `tests/undo.spec.ts`:

- The existing moved-past case also expects the entry's standing to be `moved-since` with
  `moved: ['refs/heads/main']`, and `undo` of its id to reject with the code `moved-since`.
- The existing published case also expects the standing `published` with `publishedOn: ['origin/main']`.
- The existing nothing-to-undo case expects an empty `undoables()`, and `undo` of an id that is not in the journal
  to reject with `nothing-to-undo`. Undoing the same id twice rejects the second time the same way.
- *Takes back an entry that is not the last, by its id.* Delete a branch with `repo.deleteBranch`, then
  `repo.commit`. `undoables()` lists the commit then the deleted branch, both `ready`. `undo` of the deleted
  branch's id makes the branch again, leaves the commit, and `undoables()` then lists only the commit.
- *Takes back the entry it was handed, whatever was written since.* `repo.commit`, read the commit's id from the
  list, then `repo.deleteBranch` of another branch. `undo` of the commit's id takes the commit back and leaves the
  branch deleted.
- `tests/checkpoints.spec.ts`: the existing "says a checkpoint it no longer has is gone" case also expects the code
  `no-longer-kept`.

## 4. A discard is in the list, and `undo` puts it back

**Deliverable.** Decision D4. After this there is one way to put a discard back.

- `src/types.ts`
  - Add `'discard'` to `JournalEntry['operation']`. Extend the doc comment of `checkpoint` to say that for a
    discard it is what the discard kept.
  - `DiscardKept.id` now names the discard's entry in the journal. Its doc comment becomes: "Names the discard in
    the journal, for `undo`. Absent when nothing was kept: every file was too large, or there was none."
  - `Undone` gains the field below. `DiscardRestored` keeps its shape.

    ```ts
    /** For a discard: what was put back, and what was left because it changed or was made again since */
    discard?: DiscardRestored
    ```

- `src/journal.ts`
  - `record` answers the entry it wrote, so whoever recorded it has its id.
  - `reverse` of a `discard` calls `discards.restore(entry.checkpoint)`, and `undo` answers what that restored
    and left as `Undone.discard`.
  - **An entry whose restore left any file stays in the journal.** What it kept of those files is still there, and
    removing the entry would put it out of reach. It is removed once a restore leaves nothing.
  - **A file already as the discard kept it is restored, not left.** A first restore puts some files back, and they
    then differ from git's copy: counted as changed since, a second restore would leave them, and the entry would
    never leave the list. `DiscardStore.restore` compares a changed file with the checkpoint, and only one that
    differs from it is left. (A finding of 2026-11-18, in the evidence.)
  - `standingOf` gains a first check, ahead of `moved-since`: `no-longer-kept` when the operation is `discard` and
    `checkpoints.has(entry.checkpoint)` is false.
- `src/checkpoints.ts`, a public method on `CheckpointStore`:

  ```ts
  /** Whether a checkpoint is still kept */
  async has(id: string): Promise<boolean>
  ```

  It answers `false` for an id that does not match `/^[0-9a-f]{40,64}$/`, and otherwise whether
  `rev-parse --verify --quiet refs/checkpoints/<id>` succeeds in the store (use `inStore`).
- `src/repository.ts`: construct one `DiscardStore` and pass it to both `Journal` and `GitWrites`. Today
  `GitWrites` constructs its own.
- `src/writes.ts`, `revertFile` and `revertFiles`: after the discard has succeeded, when the store kept anything,
  record `{ operation: 'discard', summary, refs: [], checkpoint: <what the store kept> }` and answer the entry's id
  as `DiscardKept.id`. The summary is `` `discarding ${filePath}` `` for one path and
  `` `discarding ${n} files` `` for more. When nothing was kept, record nothing and answer no id: there is nothing
  to put back.
- **`restoreDiscarded` is removed** from `GitRepository` and `GitWrites`. `discardNotKept` stays.
- Update the doc comments of `undo`, `revertFile` and `revertFiles` to say how the code now is, and in
  `README.md` the bullet section 1 corrected: `undo` puts a discard back, where it names `restoreDiscarded`.

**Cases.** `grep -rn "restoreDiscarded" tests` finds the existing ones, in `tests/discards.spec.ts`,
`tests/names-not-text.spec.ts` and `tests/untracked-folders.spec.ts`. Each becomes `undo(kept.id)`, and what it
expected of the answer it expects of `Undone.discard`. Then, in `tests/discards.spec.ts`:

- *A discard is in the list, and undoing it puts the file back.* After `revertFile`, `undoables()` begins with
  `{ entry: { id: kept.id, operation: 'discard' }, standing: 'ready' }`. `undo(kept.id)` puts the content back, and
  the list is then empty.
- *A discard is found in the list by a host that did not keep its id.* The id read from `undoables()` puts it back.
- The existing "leaves alone what was changed or made again since" case also expects the entry to be in the list
  still. Once the file made again is deleted and the file written since is checked out as the commit has it, a
  second `undo` of the entry puts both back and empties the list.
- The existing "gone once the store has dropped it" case expects the standing `no-longer-kept`, and `undo` to
  reject with that code.
- The existing "keeps nothing, and says so" case expects no id and an empty list.

## 5. A failure names what it is about

**Deliverable.** Decision D2. Two failures gain a fact each. The table is the whole audit: every other code was
checked and needs nothing, so do not add a fact to any other.

| Code | Fact a host needs | Disposition |
|---|---|---|
| `local-changes` | The files in the way, to offer to stash them | **Build: `LocalChangesError.files`** |
| `host-refused` | Which of the host's rules, to word the sentence | **Build: `HostRefusedError.rule`** |
| `moved-since`, `published`, `no-longer-kept` | Which refs, which remote branches | Sections 3 and 4, on `Undoable` |
| `hook-refused`, `unsafe-ownership`, `untrusted`, `git-not-found`, `developer-tools-missing`, `git-too-old` | The hook, the directory, the asks, the git | Already carried by their own error classes |
| `authentication`, `permission`, `remote-unreachable`, `non-fast-forward` | Which remote | The caller named it, or reads it with `readRemote()` |
| `conflict`, `diverged` | Which files, how far apart | In the snapshot the host reads next |
| `unknown-ref`, `branch-exists`, `not-a-repository`, `content-missing`, `name-not-text` | The name or path | The caller passed it |
| `locked`, `no-remote` | The lock's path, the remotes there are | In the message, and nothing a host can act on |
| `signing-failed`, `unrelated-histories`, `nothing-to-commit`, `detached-head`, `aborted`, `nothing-to-undo` | None | Nothing to carry |

In `src/errors.ts`:

```ts
/**
 * A command refused because it would overwrite changes to these files, from the top of the checkout. The list is
 * read from what git printed, and is empty when git did not print it as expected: a host shows it when there is one
 */
export class LocalChangesError extends GitError {
  constructor(message: string, readonly files: string[]) { /* code 'local-changes', name 'LocalChangesError' */ }
}

/** Which of a hosting service's own rules refused a push */
export type HostRule = 'file-too-large' | 'protected-branch' | 'private-email' | 'rule-violation'

/** A push the hosting service refused for a rule of its own, with which rule */
export class HostRefusedError extends GitError {
  constructor(message: string, readonly rule: HostRule) { /* code 'host-refused', name 'HostRefusedError' */ }
}

/**
 * A failed command as the error that carries what git named: the files a `local-changes` lists, the rule a
 * `host-refused` gives, and a plain `GitError` for every other code
 */
export function gitErrorOf(message: string, code: GitErrorCode | undefined, printed: string): GitError
```

- **The files.** Git prints the list like this, on its error stream. It was observed for a checkout and for a
  merge, which ends "by merge:" and is what a pull prints too:

  ```text
  error: Your local changes to the following files would be overwritten by checkout:
  <TAB>sub/deep/f.txt
  <TAB>top.txt
  Please commit your changes or stash them before you switch branches.
  ```

  Read the lines that begin with a tab, directly after a line matching
  `/^error: Your local changes to the following files would be overwritten by \w+:$/m`, up to the first line that
  does not begin with a tab. Each is a path from the top of the checkout, printed as it is with no quoting
  (observed with a space and with a non-ASCII letter in the name, and from a working directory under the top). When
  the line is not there, or no tabbed line follows it, `files` is empty and the error is still a
  `LocalChangesError` with git's words (D2).
- **The rule.** The sign for `host-refused` already matches `GH0(01|06|07|13)`. Map `01` to `file-too-large`, `06`
  to `protected-branch`, `07` to `private-email`, `13` to `rule-violation`. Keep one regular expression for the
  sign and the rule, so the two cannot drift.
- `failure` in `src/runner.ts` returns `gitErrorOf(result.error || otherwise, result.code, result.error ?? '')`
  where it makes a plain `GitError` today. A hook's refusal stays first, as it is.
- In `src/writes.ts`, five methods build `new GitError(<message>, result.code)` themselves instead of calling
  `failure`: `checkoutBranch`, `checkoutBranchAt`, `pushBranch`, `pullBranch` and `updateSubmodules`. Find each one with
  `grep -n "result.code" src/writes.ts`. Each calls `gitErrorOf(<the same message>, result.code, result.error ??
  '')` instead. Keep every message as it is.
- Export `LocalChangesError`, `HostRefusedError`, `type HostRule` from `src/index.ts`. Do not export `gitErrorOf`.
- `CLAUDE.md`, "Rules". Add after the rule about a new reason a command failed:

  > - **What git printed is read in `errors.ts` and nowhere else.** A fact read from it, such as the files a
  >   refused checkout lists, is optional: when the lines are not as expected the failure keeps its code and
  >   git's words, and the fact is empty. Each has a case that fails a real git that way.

**Cases.** The `refusal` helper in both spec files answers only an error's code and message. Where a case needs
the error itself, catch it as `tests/undo.spec.ts` does.

- `tests/failures.spec.ts`
  - The existing case "refuses a branch git does not know, naming it, and a checkout that would overwrite work"
    also expects the refusal to be a `LocalChangesError` with `files` equal to `['a.txt']`.
  - *Names the files a merge would overwrite.* A branch that changes `a.txt`, an uncommitted edit to `a.txt` on
    `main`, `repo.merge(...)` rejects with `files: ['a.txt']`.
  - *Names them from the top of the checkout, as they are spelled.* Files `sub/deep/f.txt` and `sp ace ü.txt`
    changed on a branch and edited locally, a `GitRepository` opened on `<root>/sub`, `checkoutBranch` rejects with
    both paths from the top, in the order git printed them.
  - *Keeps the code when git's list is not there.* `classifyGitError` still answers `local-changes` for the
    first line alone, with no tabbed line after it. This is the one case that hands text to the engine, as the
    existing `it.each` over recorded failures in this file does.
- `tests/named-failures.spec.ts`: the existing `it.each` over the four `GH0…` lines gains the expected rule in each
  row, and expects the refusal to be a `HostRefusedError` with that `rule`.

## 6. How many gits each operation starts

**Deliverable.** `scripts/budgets.mjs` prints, beside each reading it already prints, how many git processes the
engine started for it. Nothing in `src/` changes.

- Count with the `run` tie, which sees every process the runner starts: import `runUnbounded` from
  `../dist/index.js` beside `GitRepository`, and pass
  `run: (file, args, options) => { started++; return runUnbounded(file, args, options) }` in the ties.
- Read and reset the count around each of the four operations the script times. Print it in the same line:
  `open 42 ms (5 gits), whole status 16 ms (3 gits), …`.
- Add a fifth reading, after the checkpoint: the three sides of a conflict. Make the conflict with the script's
  own `git` helper: commit what the script changed, make a branch that changes `d0/f0.txt` and commit it, change
  `d0/f0.txt` another way on `main` and commit it, and merge the branch, which stops. Then time and count
  `repo.conflictSides('d0/f0.txt')`, printed as `conflict sides 12 ms (4 gits)`. Section 7 is measured by this
  count.
- Update the script's header comment, and add one sentence to "Budgets" in `README.md`: the readings come with the
  number of gits started for each, which counts every process the runner starts and not the one git kept open for
  reading files.
- Do not change the README's tables: those readings are CI's, and CI prints the new ones on its next run.

## 7. The git kept open

**Deliverable.** Two small changes in `src/reads.ts`. The first is measured by section 6's fifth reading: taken
before and after, the three `cat-file blob` gits are gone from it. It falls from four to two, not one: a first read
of a file from a commit in a repository runs the engine's once-per-repository partial-clone check
(`GitRunner.isPartialClone`), and in the script the sides are that first read. A later read starts one git. This
was observed on 2026-11-18 and accepted by the user as it is.

1. **A conflict's three sides are read through the git kept open.** `conflictSides` reads each side with a
   `git cat-file blob <object>` of its own: three processes. Read each through `this.fileInCommit(<object>)`
   instead, which takes an object's name as it takes `HEAD:path`. An object's name always means the same content,
   so the index cannot make this stale. `fileInCommit` answers `undefined` for a file larger than it hands back; for
   a side that is there, fall back to the `cat-file blob` call as it is today, so a large side is never read as a
   side that deleted the file.
2. **The git kept open ends when the repository is refused as untrusted.** In `fileInCommit`, when
   `this.runner.trust.pass()` rejects, close `this.objects` and then rethrow. The README says an untrusted
   repository has no git run in it but the reading of its trust.

**Cases.**

- `tests/conflict-sides.spec.ts`: *reads the three sides without a git of their own.* Open the repository with a
  `run` tie that records each call's arguments and hands on to `runUnbounded` (exported from `src/index.ts`). After
  `conflictSides`, no recorded call holds `cat-file` followed by `blob`, and the sides are as the existing first
  case expects.
- `tests/trust.spec.ts`: *ends the git kept open for reading files once the repository is no longer trusted.* A
  repository with an executable hook (so it asks), opened with `isTrusted: () => trusted` and a `watchProcess` tie
  that records the pid it is handed and answers `{ output() {}, stop() {} }`. With `trusted` true, read a file at
  `HEAD`. Set `trusted` to false. The next read rejects with `UntrustedError`, and then, with `settles` from
  `tests/_support/settles.ts`, `process.kill(pid, 0)` throws: the process has gone. Close the repository in
  `afterEach`.

## What the consumer must change

The engine has one consumer, the apack monorepo, pinned by commit. **Do not edit it.** This list is for whoever
moves the pin, and must be correct for what was built: correct it if a section lands differently.

- `undo` takes the id of the entry to take back, where it took back the last. The consumer calls it with none.
- `lastUndoable()` is gone. The consumer reads `id` and `summary` from it; it reads them from the first entry of
  `undoables()`, or the newest entry of the kind its button is for.
- `undo` answers `{ entry, discard? }` where it answered the entry.
- `restoreDiscarded` is gone. A discard is put back with `undo(kept.id)`, and what it restored and left is the
  answer's `discard`. `DiscardKept.id` is now a journal entry's id.
- A discard is in `undoables()`. A host that shows "undo" for the newest entry will offer to undo a discard.
- `GitErrorCode` gains `moved-since`, `nothing-to-undo` and `no-longer-kept`. The consumer holds its own copy of
  the codes to the engine's with a type check, which will stop compiling until it adds them. It holds
  `DiscardKept` the same way; its shape does not change.
- `JournalEntry['operation']` gains `discard`.
- New and optional to use: `LocalChangesError.files`, `HostRefusedError.rule`.
