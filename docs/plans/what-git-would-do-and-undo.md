# Failures that name what they are about, an undo list, and previews

Status: planned, 2026-11-17. Section 2 has landed; the rest is the design for
[its goal](../goals/goal-what-git-would-do-and-undo.md), which owns the order, the dependencies and when each
section is done. This document owns the design: the decisions, the shapes, the commands and the cases.

## Background

Surveyed at `cd73da3`, 2026-11-17, on macOS with git 2.38.1 (Homebrew) and 2.39.5 (Apple). The paths and names
cited were checked again against `master` at `968139b`. What was run against a real git says "observed"; the rest
was read. Inspect current code before relying on a path.

The items came out of comparing the engine with isomorphic-git. What was declined is in
[declined-engine-ideas](wont-do/declined-engine-ideas.md), and raising the git floor is
[deferred](deferred/raise-git-floor.md).

**Already there when surveyed**, so not designed here:

- Discards are checkpoints. `src/discards.ts` calls `CheckpointStore.checkpoint`, and the store is a bare git
  directory outside the repository. `README.md` and `CLAUDE.md` described an older design (section 1).
- The git kept open for reading files (`src/objects.ts`) ends itself five seconds after its last read
  (`LINGER_MS`), is ended by `GitRepository.close()`, and is never started in an untrusted repository
  (`GitReads.fileInCommit` passes the trust gate first).
- A failed sign-in has a case that names the remote (`tests/failures.spec.ts`, "says the remote asked for a
  sign-in").

## Decisions

- **D1. The git floor stays at 2.35.0.** What needs a newer git answers `unknown` below it, as `previewMerge`
  does below 2.38. [The deferred plan](deferred/raise-git-floor.md) says why.
- **D2. What git named in a failure is read from the lines git wrote, in `src/errors.ts`.** The files a refused
  checkout lists are read from git's own list. There is no git command that answers "which files block this", and
  working it out from diffs would be the engine guessing git's rules. `src/errors.ts` is already the one place that
  reads what git printed, every git child runs in English (`gitEnvironment`), and CI runs the cases from 2.35.0 to
  the newest git.
- **D3. A code that is not read from git has its case beside its feature.** `CLAUDE.md` asks for a case in
  `tests/failures.spec.ts` that fails a real git. A code the engine decides itself has no git to fail, so it follows
  `published`, whose cases are in `tests/undo.spec.ts` and `tests/rewrite.spec.ts`.
- **D4. A discard is a journal entry.** After a discard, `lastUndoable()` answers the discard, and `undo()` puts
  the discarded files back. This changes what a host sees after a discard, on purpose: undo takes back the last
  thing done.
- **D5. `undo` takes an entry's id.** An entry that is not the last can be undone when nothing it moved has moved
  since: a deleted branch, a dropped stash, a discard. The check that already protects the last entry protects
  every entry, so no new rule is needed.
- **D6. An entry recorded with `HEAD` detached is refused once `HEAD` is on a branch.** Its ref was `HEAD` itself.
  Moving `HEAD` back now would move the branch `HEAD` is on, which the entry never touched.
- **D7. `lastUndoable()` changes what it answers**, from `JournalEntry` to `Undoable`. No old shape is kept beside
  it (`CLAUDE.md`: nothing is kept for compatibility).
- **D8. `MergePreview` gains one optional field** instead of a second preview type, so a host has one shape to
  show.
- **D9. A cherry-pick of a commit whose change is already there previews as `unknown`.** Git stops on it for a
  reason that is not a conflict, and the preview has no word for that. A rebase drops such a commit and carries on,
  so there it previews as clean.
- **D10. A rebase whose range holds a merge commit, or more than 100 commits, previews as `unknown`.** What a
  rebase does with a merge depends on settings the preview does not follow, and each commit previewed is three gits.

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

**Deliverable.** Text only. No source file changes except one doc comment.

1. `README.md`, "What holds it together", the bullet that begins "**What a write destroys can be had back.**" Its
   first sentence ends "…is written into git's object store as a tree built with an index of its own, and
   `restoreDiscarded` puts it back; the user's index, refs and stash are not touched, and git keeps that tree as
   long as it keeps objects nothing refers to, two weeks unless told otherwise." Replace that part, from "is
   written", with:

   > is kept as a checkpoint: a commit in a store outside the repository (`RepositoryTies.checkpointDirectory`),
   > and `restoreDiscarded` puts it back. The repository's index, refs, objects and stash are not touched, and a
   > checkpoint is dropped after 14 days, or as the oldest while the store is larger than a gigabyte.

   Leave the rest of the bullet (merge, rebase, `undo`, `published`) as it is.

2. `README.md`, the same list. Add this bullet after "Hints in, news out":

   > **A prediction is never in a snapshot.** Where a file will be listed once it is staged is worked out ahead of
   > git, for a window to show at once (`apack-git/staging`). That lives in the entries that import nothing of
   > Node's. A snapshot the engine answers with is what git said, and nothing else.

3. `CLAUDE.md`, "Layout". Replace the `src/discards.ts` line, and add the two lines after it:

   > - `src/discards.ts` keeps what a discard removes, as a checkpoint, and puts it back.
   > - `src/checkpoints.ts` keeps copies of the working tree in a store outside the repository: a bare git
   >   directory that borrows the repository's objects.
   > - `src/journal.ts` writes down each write that can be taken back, and takes one back (`undo`).

4. `src/repository.ts`, the doc comment of `restoreDiscarded`. Its last sentence, which begins "Rejects when git no
   longer keeps it", describes git's own two-week clock. Replace that sentence with: "Rejects once the store has
   dropped it: after 14 days, or as the oldest of too many."

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

## 3. One list of what can be undone, with where each entry stands

**Deliverable.** Decisions D3, D4, D5 and D7, in three steps. Each step leaves the suite passing.

**Step A: three codes.** In `src/errors.ts`, add to the end of `GIT_ERROR_CODES`, each with a doc comment in the
style of `published` that ends "Not read from what git printed":

| Code | Means | Thrown where |
|---|---|---|
| `moved-since` | An undo of a write whose ref has moved since: undoing it would undo what moved it too | `Journal.undo`, the "has moved since" error |
| `nothing-to-undo` | An undo with nothing in the journal to take back, or of an entry no longer in it | `Journal.undo`, the "nothing to undo" error |
| `no-longer-kept` | A copy of the working tree the store has dropped: past its age, or the oldest of too many | `CheckpointStore.recorded` in `src/checkpoints.ts`, the "no longer kept" error |

Keep each error's message. Only add the code as the second argument of `new GitError`.

**Step B: standing, the list, and undo by id.**

In `src/types.ts`:

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
```

In `src/checkpoints.ts`, a public method on `CheckpointStore`:

```ts
/** Whether a checkpoint is still kept */
async has(id: string): Promise<boolean>
```

It answers `false` for an id that does not match `/^[0-9a-f]{40,64}$/`, and otherwise whether
`rev-parse --verify --quiet refs/checkpoints/<id>` succeeds in the store (use `inStore`).

In `src/journal.ts`:

- A private `standingOf(entry)` that answers an `Undoable`. It is the only place that decides whether an entry can
  be undone. Check in this order and answer the first that holds:
  1. `no-longer-kept`: the entry's operation is `discard` (Step C) and `checkpoints.has(entry.checkpoint)` is false.
  2. `moved-since`, with `moved`: any ref of `entry.refs` that is not at its `after` now, or is `'HEAD'` while a
     branch is checked out (section 2, D6).
  3. `published`, with `publishedOn`: the operation is `commit` and a remote branch holds `refs[0].after`. This is
     the `for-each-ref --contains` query `undo` runs today. Run it only when 1 and 2 did not hold.
  4. `ready`.
- `undo({ id, evenIfPublished })`. With `id`, it takes back the entry with that id; without, the last. No such
  entry is `nothing-to-undo`. It calls `standingOf` and refuses anything not `ready` with a `GitError` carrying the
  standing as its code and the message `undo` uses today. `published` is let through when `evenIfPublished`. After
  reversing, it writes the journal without that one entry (filter by id, not `slice(0, -1)`).
- `last()` answers `Undoable | undefined`.
- `all()` answers every entry kept, newest first, each as an `Undoable`. Resolve each distinct ref once for the
  whole list, not once per entry.

In `src/repository.ts`, with a doc comment each:

```ts
lastUndoable(): Promise<Undoable | undefined>
undoables(): Promise<Undoable[]>
undo(options?: { id?: string; evenIfPublished?: boolean }): Promise<JournalEntry>
```

Export `type Undoable` from `src/index.ts`.

**Step C: discards in the journal.**

- `src/types.ts`: add `'discard'` to `JournalEntry['operation']`. Extend the doc comment of `checkpoint` to say
  that for a discard it is what the discard kept.
- `src/repository.ts`: construct one `DiscardStore` and pass it to both `Journal` and `GitWrites`. Today
  `GitWrites` constructs its own.
- `src/writes.ts`, `revertFile` and `revertFiles`: after the discard has succeeded, when `kept.id` is defined,
  record `{ operation: 'discard', summary, refs: [], checkpoint: kept.id }`. The summary is
  `` `discarding ${filePath}` `` for one path and `` `discarding ${n} files` `` for more. Record nothing when
  `kept.id` is undefined: nothing was kept, so there is nothing to put back.
- `src/journal.ts`, `reverse`: a `discard` is reversed with `discards.restore(entry.checkpoint)`.
- `src/journal.ts`: a public `forgetDiscard(checkpoint)` that removes any `discard` entry with that checkpoint.
  `GitWrites.restoreDiscarded` calls it after a restore succeeds, so a discard put back by its id leaves the list.
- Update the doc comments of `lastUndoable`, `undo`, `revertFile` and `restoreDiscarded` to say how the code now is.

**Cases.** Change the existing ones first: `grep -rn "lastUndoable" tests` and update each expectation to the new
shape (`{ entry: { operation, summary }, standing: 'ready' }`). Then:

- `tests/undo.spec.ts`
  - The existing moved-past case also expects the code `moved-since`, and `lastUndoable()` to answer
    `standing: 'moved-since'` with `moved: ['refs/heads/main']`.
  - The existing published case also expects `lastUndoable()` to answer `standing: 'published'` with
    `publishedOn: ['origin/main']`.
  - The existing nothing-to-undo case also expects the code `nothing-to-undo`.
  - *Takes back an entry that is not the last, by its id.* Delete a branch with `repo.deleteBranch`, then
    `repo.commit`. `undoables()` lists the commit then the deleted branch, both `ready`. `undo({ id })` with the
    deleted branch's id makes the branch again, leaves the commit, and `undoables()` then lists only the commit.
  - *Refuses an id that is not in the journal* with `nothing-to-undo`.
- `tests/discards.spec.ts`
  - *A discard is the last thing that can be undone, and undoing it puts the file back.* After `revertFile`,
    `lastUndoable()` is `{ entry: { operation: 'discard', checkpoint: kept.id }, standing: 'ready' }`. `undo()`
    puts the content back and `lastUndoable()` is then undefined.
  - *A discard put back by its id leaves the list.* After `restoreDiscarded(kept.id)`, `undoables()` is empty.
  - The existing "gone once the store has dropped it" case also expects the code `no-longer-kept` from
    `restoreDiscarded`, `lastUndoable()` to answer `standing: 'no-longer-kept'`, and `undo()` to reject with that
    code.
- `tests/checkpoints.spec.ts`: the existing "says a checkpoint it no longer has is gone" case also expects the code.

## 4. A failure names what it is about

**Deliverable.** Decision D2. Two failures gain a fact each. The table is the whole audit: every other code was
checked and needs nothing, so do not add a fact to any other.

| Code | Fact a host needs | Disposition |
|---|---|---|
| `local-changes` | The files in the way, to offer to stash them | **Build: `LocalChangesError.files`** |
| `host-refused` | Which of the host's rules, to word the sentence | **Build: `HostRefusedError.rule`** |
| `moved-since`, `published`, `no-longer-kept` | Which refs, which remote branches | Section 3, on `Undoable` |
| `hook-refused`, `unsafe-ownership`, `untrusted`, `git-not-found`, `developer-tools-missing`, `git-too-old` | The hook, the directory, the asks, the git | Already carried by their own error classes |
| `authentication`, `permission`, `remote-unreachable`, `non-fast-forward` | Which remote | The caller named it, or reads it with `readRemote()` |
| `conflict`, `diverged` | Which files, how far apart | In the snapshot the host reads next |
| `unknown-ref`, `branch-exists`, `not-a-repository`, `content-missing`, `name-not-text` | The name or path | The caller passed it |
| `locked`, `no-remote` | The lock's path, the remotes there are | In the message, and nothing a host can act on |
| `signing-failed`, `unrelated-histories`, `nothing-to-commit`, `detached-head`, `aborted`, `nothing-to-undo` | None | Nothing to carry |

In `src/errors.ts`:

```ts
/** A command refused because it would overwrite changes to these files, from the top of the checkout */
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
  the line is not there, `files` is empty.
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
- `tests/named-failures.spec.ts`: the existing `it.each` over the four `GH0…` lines gains the expected rule in each
  row, and expects the refusal to be a `HostRefusedError` with that `rule`.

## 5. A folder as a commit has it

**Deliverable.** `GitRepository.listFolder`.

In `src/types.ts`:

```ts
/** One entry of a folder as a commit has it */
export interface FolderEntry {
  /** Its name in the folder */
  name: string
  /** Its path from the top of the tree, with `/` between its parts */
  path: string
  /** A file, a folder, a symbolic link, or a submodule: a commit of another repository */
  kind: 'file' | 'folder' | 'link' | 'submodule'
  /** A file git marks as a program to run */
  executable?: true
  /** How many bytes a file or a link's target is; absent for a folder and a submodule */
  size?: number
}
```

In `src/repository.ts`, implemented in `src/reads.ts`:

```ts
/**
 * What a folder holds as a commit has it, in git's order, without checking anything out: `directory` from the top
 * of the tree, the top itself when empty. Nothing when the commit has no such folder. Refused as `unknown-ref`
 * when `commit` names no commit here.
 */
listFolder(commit: string, directory?: string): Promise<{ entries: FolderEntry[]; truncated: boolean } | undefined>
```

How it works:

1. `refArgument(commit, 'commit')`. Then `rev-parse --verify --quiet <commit>^{commit}`. When that fails, throw
   `new GitError(`There is no commit ${commit} here.`, 'unknown-ref')`, as `checkoutBranchAt` does.
2. Take any trailing `/` off `directory`. Throw a plain `Error` for a directory that begins with `/` or has a `.`
   or `..` part: git would read those from the working directory.
3. Run `git ls-tree -z -l <name>`, where `<name>` is `<commit>^{tree}` for the top and `<commit>:<directory>`
   otherwise.
4. Add `'ls-tree'` to `READS` in `src/runner.ts`, so the command waits behind no write. (The checkpoint store's own
   `ls-tree` begins with `-C`, so its lane does not change.)
5. When the command fails: with the code `content-missing`, throw `failure(...)`; with `truncated`, keep the output
   up to its last NUL and answer `truncated: true`, as `listUntracked` does; otherwise answer `undefined`. Git says
   "Not a valid object name" for a folder the commit lacks and "not a tree object" for a file, and both mean there
   is no such folder.
6. Each record, split on NUL, is `<mode> <type> <object> <size>` then a tab then the name. The size is padded with
   spaces on its left, and is `-` for a folder and a submodule. Observed:

   ```text
   100644 blob 5626abf…       4<TAB>a.txt
   040000 tree 978536a…       -<TAB>dir
   120000 blob 8d14cbf…       5<TAB>link
   100755 blob 1a24852…      10<TAB>run.sh
   ```

   Mode `040000` is a folder, `120000` a link, `160000` a submodule, `100755` a file with `executable: true`, and
   anything else a file.

Export `type FolderEntry` from `src/index.ts`.

**Cases**, in a new `tests/list-folder.spec.ts` (copy the setup of `tests/objects.spec.ts`). Make the executable
file and the link through git, so the cases mean the same on Windows: `git update-index --chmod=+x run.sh` after
adding it, and for the link `git hash-object -w <a file that holds the link's target>` then
`git update-index --add --cacheinfo 120000,<object>,link`.

- Lists the top and a nested folder: names, paths, kinds, `executable`, sizes, in git's order.
- Lists a folder whose name has a space and a non-ASCII letter.
- Answers `undefined` for a folder the commit does not have, and for a path that is a file.
- Refuses a commit git does not know with `unknown-ref`.
- *Browses a commit in a repository with no working tree.* `git clone --bare` the repository, open a
  `GitRepository` on the bare directory, and expect `listFolder('main')` and
  `readFileContentFromBranch('a.txt', 'main')` to answer as in the clone's source. Close it before the directory is
  removed.

## 6. How many gits each operation starts

**Deliverable.** `scripts/budgets.mjs` prints, beside each reading it already prints, how many git processes the
engine started for it. Nothing in `src/` changes.

- Count with the `run` tie, which sees every process the runner starts: import `runUnbounded` from
  `../dist/index.js` beside `GitRepository`, and pass
  `run: (file, args, options) => { started++; return runUnbounded(file, args, options) }` in the ties.
- Read and reset the count around each of the four operations the script times. Print it in the same line:
  `open 42 ms (5 gits), whole status 16 ms (3 gits), …`.
- Update the script's header comment, and add one sentence to "Budgets" in `README.md`: the readings come with the
  number of gits started for each, which counts every process the runner starts and not the one git kept open for
  reading files.
- Do not change the README's tables: those readings are CI's, and CI prints the new ones on its next run.

## 7. The git kept open

**Deliverable.** Two small changes in `src/reads.ts`.

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

## 8. What a cherry-pick and a rebase would do

**Deliverable.** Decisions D1, D8, D9 and D10. Two previews beside `previewMerge`, in `src/merge-preview.ts`.

In `src/types.ts`, `MergePreview`'s conflicts gain one field, and its doc comment says the three previews answer
in it:

```ts
| { kind: 'conflicts'; files: string[]; /** The commit a cherry-pick or a rebase would stop at */ commit?: string }
```

In `src/repository.ts`:

```ts
/**
 * What cherry-picking these commits onto what is checked out would do, oldest first, before it is done: a clean
 * pick, or the commit it would stop at and the files in conflict there. Nothing moves. `unknown` on a git older
 * than 2.40, for a merge commit, and for a commit whose change is already here, which git stops on as empty.
 */
previewCherryPick(commits: string[]): Promise<MergePreview>

/**
 * What rebasing what is checked out onto `target` would do: nothing, a fast-forward, a clean rebase, or the commit
 * it would stop at and the files in conflict there. Nothing moves. `unknown` on a git older than 2.40, and for a
 * range that holds a merge commit or more than 100 commits.
 */
previewRebase(target: string): Promise<MergePreview>
```

How it works. `REPLAY_FROM = '2.40.0'` is the first git whose `merge-tree --write-tree` takes `--merge-base`.

- **One commit onto a tip.** A cherry-pick of commit `C` onto `T` is a three-way merge of `T` and `C` with `C`'s
  parent as the base:

  ```text
  git merge-tree --write-tree --name-only --no-messages --merge-base=<C^1> <T> <C>
  ```

  Read its answer as `previewMerge` does: on success the first line is the tree it made; on exit 1 with a first
  line that is an object name, the remaining lines are the files in conflict.
- **Several commits.** After a clean pick, the next commit is picked onto the result, so the result has to be a
  commit. Make one that nothing refers to:
  `git commit-tree <tree> -p <T> -m preview`, with the author and committer set in the command's environment the
  way `IDENTITY` is in `src/checkpoints.ts`. Its output is the new `T`. Add `'commit-tree'` to `READS` in
  `src/runner.ts`, and change that set's comment to say its commands take no lock and write at most objects nothing
  refers to (`merge-tree` already does).
- **A commit that comes out empty.** When the tree a pick made is the tree `T` already has
  (`rev-parse <T>^{tree}`), the commit's change is already there. For a cherry-pick, answer `unknown` (D9). For a
  rebase, leave `T` as it is and carry on.
- **`previewCherryPick(commits)`.** Check each with `commitArgument`, as `cherryPick` does. None is
  `{ kind: 'up-to-date' }`. On a git older than `REPLAY_FROM`, `unknown`. A commit with a second parent
  (`rev-parse --verify --quiet <C>^2` succeeds) or with no parent is `unknown`. Otherwise pick each in turn from
  `T = HEAD`; the first that conflicts answers `{ kind: 'conflicts', files, commit: <its full hash> }`, and none
  conflicting answers `{ kind: 'clean' }`.
- **`previewRebase(target)`.** Check `target` as `previewMerge` checks its own. Then, in this order:
  1. `target` is an ancestor of `HEAD`: `{ kind: 'up-to-date' }`.
  2. `HEAD` is an ancestor of `target`: `{ kind: 'fast-forward' }`.
  3. A git older than `REPLAY_FROM`: `unknown`.
  4. `git rev-list --count --merges <target>..HEAD` is not `0`: `unknown` (D10).
  5. The commits a rebase replays, oldest first, leaving out those whose change `target` already has:
     `git rev-list --reverse --no-merges --cherry-pick --right-only <target>...HEAD` (three dots). More than 100:
     `unknown`.
  6. Pick each in turn from `T = <target>`, as above.

**Cases**, in a new `tests/replay-preview.spec.ts`. Copy `tests/merge-preview.spec.ts`: its repository, its way of
holding `HEAD`, the status and the index's bytes to what they were, and its gate, here
`const replay = !olderThan(gitVersionOf(...)!, '2.40.0')`.

- Not gated: `previewRebase` says `up-to-date` and `fast-forward`; `previewCherryPick([])` says `up-to-date`.
- `it.runIf(replay)`: a cherry-pick that is clean, and one that conflicts. For the conflict, expect nothing moved,
  then run a real `git cherry-pick <commit>` and expect `files` to equal
  `git diff --name-only --diff-filter=U`, and `commit` to equal the commit's full hash.
- `it.runIf(replay)`: a rebase that is clean, and one that conflicts. For the conflict, run a real
  `git rebase <target>` after the preview and expect `files` to equal `git diff --name-only --diff-filter=U` and
  `commit` to equal `git rev-parse REBASE_HEAD`.
- `it.runIf(replay)`: of two commits, the first is clean and the second conflicts, and `commit` names the second.
- `it.runIf(replay)`: a commit whose change is already on the target. The rebase previews `clean`; the
  cherry-pick of it previews `unknown`.
- `it.runIf(replay)`: a range with a merge commit previews `unknown` for a rebase.
- `it.runIf(!replay)`: both say `unknown` where a merge-tree would be needed.

## What the consumer must change

The engine has one consumer, the apack monorepo, pinned by commit. **Do not edit it.** This list is for whoever
moves the pin, and must be correct for what was built: correct it if a section lands differently.

- `GitErrorCode` gains `moved-since`, `nothing-to-undo` and `no-longer-kept`. The consumer holds its own copy of
  the codes to the engine's with a type check, which will stop compiling until it adds them.
- `lastUndoable()` answers `{ entry, standing, … }` where it answered the entry. The consumer reads `id` and
  `summary` from it.
- After a discard, the last undoable is the discard. A host that shows "undo" for the last entry will offer to undo
  the discard, where it offered the write before it.
- `JournalEntry['operation']` gains `discard`, and `MergePreview`'s conflicts gain an optional `commit`.
- New and optional to use: `undoables()`, `undo({ id })`, `listFolder`, `previewCherryPick`, `previewRebase`,
  `LocalChangesError.files`, `HostRefusedError.rule`.
