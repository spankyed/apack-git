# Goal: failures that name what they are about, an undo that says where it stands, and previews

Status: planned, 2026-11-17. Phase 2 is done (`0b00d6f`); the rest is not started.

```text
# Goal: failures that name what they are about, an undo that says where it stands, and previews

Implement docs/goals/goal-what-git-would-do-and-undo.md in the apack-git repository. Follow CLAUDE.md.
Read Scope, Current handoff, Decisions, Phases and Constraints before you change anything.

The survey was made at cd73da3 and checked again against master at 968139b. Before Phase 1, confirm the base:
`git merge-base --is-ancestor cd73da3 HEAD` succeeds, `src/journal.ts` has a `reverse` method that runs
`git reset --keep`, and `src/discards.ts` keeps discards through `CheckpointStore`. If any of these is not
so, stop and say what you found: the plan was surveyed somewhere else.

Work on a new branch made from HEAD. Do the phases in order, 1 to 8. Each phase is one commit, made when
its "Done when" holds and these pass: npm run typecheck, npm run reference:check, npm run build, npm test.
Run the phase's own spec file while you work (npm test -- tests/<file>.spec.ts) and the whole suite once
before the commit.

Where the plan gives a type, a signature, a command or a regular expression, use it as written. Where it
does not say, do what the nearest existing code does and note the choice in the handoff. If a step cannot
be done as written, stop and say why. Do not widen or narrow the scope, and do not loosen an assertion to
make a case pass.

Finished when:
- Phases 1 to 7 each meet their "Done when" on current source, with the four checks above passing.
- Phase 8 is implemented, and its cases have passed on a git of 2.40 or later. This machine's gits are
  older, so that needs a CI run or a newer git the user points you at: ask, do not install one.
- REFERENCE.md is regenerated (npm run reference:update) and README.md describes what changed.
- Current handoff and Acceptance in the goal document are filled in, and "What the consumer must change"
  is correct for what you built.

Never:
- push, open a pull request, or change anything outside this repository, unless the user asks.
- add a dependency, or import anything but the engine's own modules and Node's built-ins (CLAUDE.md).
- import anything of src/ into a spec except an entry: src/index.ts, src/staging.ts, src/availability.ts.
- change GIT_FLOOR, or keep an old name or shape beside a new one for compatibility.
- write a comment that says what changed. A comment says how the code is; the commit message says why.
```

## Scope and background

**The outcome.** Six things a host cannot do today, each small:

1. An undo that was refused, or a copy of the working tree that is gone, carries a code a host can act on.
2. A host can ask what can be undone and whether each entry can be undone now, before it tries.
3. A discard is in that list, so a host that lost the id a discard answered with can still put it back.
4. A checkout or a merge refused over local changes names the files in the way.
5. A host can list a folder as a commit has it, without checking the commit out.
6. A host can ask what a cherry-pick or a rebase would do before it starts one.

Along the way it fixes one defect (Phase 2), corrects documentation that no longer matches the code (Phase 1), and
makes the cost of starting gits visible (Phase 6).

**What is not part of it.** What was declined is in
[declined-engine-ideas](../plans/wont-do/declined-engine-ideas.md), and raising the git floor is
[deferred](../plans/deferred/raise-git-floor.md). Do not build anything those two documents decline.

**Surveyed** at `cd73da3` on `feat/checkout-at-and-remotes`, 2026-11-17, on macOS with git 2.38.1 (Homebrew) and
2.39.5 (Apple). The paths and lines it cites were checked again against `master` at `968139b` (#40), which has
`cd73da3` and five later pull requests; Phases 1 and 4 were corrected for what those changed.

**What the survey found already done.** Do not rebuild these.

- Discards are already checkpoints. `src/discards.ts` calls `CheckpointStore.checkpoint`, and the store is a bare
  git directory outside the repository. `README.md` and `CLAUDE.md` still describe an older design (Phase 1).
- The git kept open for reading files (`src/objects.ts`) already ends itself five seconds after its last read
  (`LINGER_MS`), is ended by `GitRepository.close()`, and is never started in an untrusted repository
  (`GitReads.fileInCommit` passes the trust gate first).
- A failed sign-in already has a case that names the remote (`tests/failures.spec.ts`, "says the remote asked for a
  sign-in").

**A defect the survey found**, reproduced against a real git on the surveyed commit:

1. On `main`, call `repo.merge('side')`.
2. Check out `topic`, which has a commit of its own.
3. Call `repo.undo()`.

The undo answers as done. `main` still has the merge. `topic` has been moved to where `main` was before the merge,
so the commit `topic` had is no longer on it and its file is gone from the working tree. The cause is in
`Journal.reverse` (`src/journal.ts`): it runs `git reset --keep <before>`, which moves whatever branch is checked
out, not the branch the entry recorded. Phase 2 fixes it.

## Current handoff

Phase 2 is done, ahead of Phase 1. Update this section in place as you go; do not append to it.

- **Branch and last commit:** Phase 2 is `0b00d6f` on `fix/undo-branch-and-watch-delivery`, made from `master` at
  `968139b`, with this plan and a fix of `tests/rig-churn.spec.ts` beside it. Start from `master` once that branch is
  merged, or from the branch itself if it is not yet.
- **Next:** Phase 1, then Phase 3.
- **Proven** (2026-11-17, macOS, git 2.38.1): both Phase 2 cases pass, and both fail with `src/journal.ts` as it
  was. `npm run typecheck`, `npm run reference:check` and `npm run build` pass.
- **The churn cases** (`tests/rig-churn.spec.ts`) open a watch of their own and skip, with the reason, when macOS did
  not deliver what the case made: it delivers nothing to any process while another one writes files fast enough. A
  skip of those seeds in your run is the machine, not this work.
- **Open:** Phase 8 cannot be verified on this machine (see its "Done when").
- **Choices made where the plan did not say:** none yet.

## Decisions

Each is settled. Do not reopen one without the user.

- **D1. The git floor stays at 2.35.0.** What needs a newer git answers `unknown` below it, as `previewMerge`
  does below 2.38. See the deferred plan for why.
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

## Phases

Every phase ends with the same four checks: `npm run typecheck`, `npm run reference:check`, `npm run build`,
`npm test`. When a phase adds or changes an export, a public method of `GitRepository`, or a doc comment on one, run
`npm run reference:update` and commit `REFERENCE.md` with it. `reference:check` also fails when an exported value or
a public method is used by no spec, so each new one needs a spec that calls it.

Specs follow the existing ones: a real git in a temporary directory, removed in `afterEach` with
`removeDirectory` from `tests/_support/remove.ts`, git run through `run` from `tests/_support/process.ts`, and
imports of the engine only from `../src/index.ts`. Copy the setup of the spec file named in each phase.

### Phase 1: the documentation says what the code does

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

**Dependencies.** None.

**Done when.** `grep -in "nothing refers to\|two weeks" README.md CLAUDE.md src/repository.ts` prints nothing,
`REFERENCE.md` is regenerated, and the four checks pass.

### Phase 2: an undo acts on the branch it recorded

**Deliverable.** The defect in "Scope and background". All of it is in `src/journal.ts`.

1. Add a private method that answers the branch `HEAD` is on as a full ref, or `'HEAD'` when it is on none. Copy
   `headRef` from `src/writes.ts` (`git symbolic-ref --quiet HEAD`).
2. In `undo`, in the loop that compares each ref with where the write left it, also treat an entry as moved when
   its `ref` is `'HEAD'` and that method does not answer `'HEAD'` (D6). Throw the same error as for a moved ref.
3. In `reverse`, the two branches that run `git reset` (the one for `merge`, `rebase`, `cherry-pick` and `rewrite`,
   and the one for `reset`) keep doing so only when the method from step 1 answers the entry's `refs[0].ref`. When
   it answers anything else, the branch is not checked out here, so move the ref alone, exactly as the loop at the
   end of `reverse` does:
   `git update-ref -m "undo: <summary>" <ref> <before> <after>`. The working tree is on another branch and is left
   as it is.

**Dependencies.** None.

**Cases**, added to `tests/undo.spec.ts` (its `repository()` gives a store of its own):

- *Takes back a merge on the branch it was made on, when another branch has been checked out since.* Make `side`
  from `main` with one commit. Make `topic` from `main` with one commit that adds `t.txt`. Add a commit to `main`.
  `await repo.merge('side')`, then `git checkout topic`, then `await repo.undo()`. Expect: `main` is at the commit
  it was on before the merge, `topic` is at the commit it was on, `t.txt` exists, `git status --porcelain` is empty.
- *Refuses an entry recorded with no branch checked out, once a branch is.* `git checkout --detach`, stage a
  change, `await repo.commit('detached')`, then `git checkout -b other`. Expect `repo.undo()` to reject with a
  message matching `/has moved since/`, and `other` still at the commit.

**Done when.** Both cases pass, both fail when the changes to `src/journal.ts` are reverted (check this once, then
restore the fix), and the four checks pass.

### Phase 3: one list of what can be undone, with where each entry stands

**Deliverable.** Decisions D3, D4, D5 and D7. Do it in the three steps below. Each step leaves the suite passing.

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
     branch is checked out (Phase 2, step 2).
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

**Dependencies.** Phase 2.

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

**Done when.** Every case above passes, `undoables` and the new shapes are in `REFERENCE.md`, and the four checks
pass.

### Phase 4: a failure names what it is about

**Deliverable.** Decision D2. Two failures gain a fact each. The table is the whole audit: every other code was
checked and needs nothing, so do not add a fact to any other.

| Code | Fact a host needs | Disposition |
|---|---|---|
| `local-changes` | The files in the way, to offer to stash them | **Build: `LocalChangesError.files`** |
| `host-refused` | Which of the host's rules, to word the sentence | **Build: `HostRefusedError.rule`** |
| `moved-since`, `published`, `no-longer-kept` | Which refs, which remote branches | Done in Phase 3, on `Undoable` |
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

**Dependencies.** None.

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

**Done when.** The cases pass on this machine, and the four checks pass. The same cases running on CI's Windows job
and its 2.35.0 job is what proves the format there (`CLAUDE.md`: a platform claim is made on that platform); record
in the handoff that this is unverified until a CI run.

### Phase 5: a folder as a commit has it

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

**Dependencies.** None.

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

**Done when.** The cases pass and the four checks pass.

### Phase 6: how many gits each operation starts

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

**Dependencies.** None.

**Done when.** `npm run build && npm run budgets -- 1000` prints the four counts, and that line is pasted into the
handoff as the first reading. The four checks pass.

### Phase 7: the git kept open

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

**Dependencies.** None.

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

**Done when.** Both cases pass, the existing cases in both files still pass, and the four checks pass.

### Phase 8: what a cherry-pick and a rebase would do

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

**Dependencies.** None in code. It is last because it cannot be verified on this machine.

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

**Done when.** The four checks pass here, where the gated cases are skipped, **and** the gated cases have passed on
a git of 2.40 or later. Ask the user which they want: a push so CI's `suite` jobs run them, or a newer git to put
first on `PATH` for one run. Until one of those has happened, the handoff says Phase 8 is implemented and
unverified, and the goal is not finished.

## Acceptance

Fill in as each phase lands. "Proven by" is the spec case or command, and the commit it passed on.

| Requirement | Phase | State | Proven by |
|---|---|---|---|
| README and CLAUDE.md describe discards as the code keeps them | 1 | missing | |
| An undo moves the branch it recorded, whatever is checked out | 2 | done, `0b00d6f` | `tests/undo.spec.ts`, "takes back a merge on the branch it was made on…" |
| An entry recorded with `HEAD` detached is refused once a branch is checked out | 2 | done, `0b00d6f` | `tests/undo.spec.ts`, "refuses an entry written with no branch checked out…" |
| A refused undo and a dropped copy carry `moved-since`, `nothing-to-undo`, `no-longer-kept` | 3 | missing | |
| `lastUndoable` and `undoables` say where each entry stands; `undo` takes an id | 3 | missing | |
| A discard is in the journal, undone by `undo`, and leaves it when put back by id | 3 | missing | |
| A refused checkout, merge or pull names the files in the way | 4 | missing | |
| A push the host refused names the rule | 4 | missing | |
| `listFolder` lists a folder at a commit, in a bare repository too | 5 | missing | |
| `npm run budgets` prints the gits started for each reading | 6 | missing | |
| A conflict's sides are read with no git of their own | 7 | missing | |
| The git kept open ends when the repository is refused as untrusted | 7 | missing | |
| `previewCherryPick` and `previewRebase` name what a real one then stops on | 8 | missing | on git ≥ 2.40 |
| Phases 4, 5 and 7 hold on Linux, Windows and git 2.35.0 | 4, 5, 7 | missing | a CI run |

## What the consumer must change

The engine has one consumer, the apack monorepo, pinned by commit. **Do not edit it.** This list is for whoever
moves the pin, and must be correct for what was built: correct it if a phase lands differently.

- `GitErrorCode` gains `moved-since`, `nothing-to-undo` and `no-longer-kept`. The consumer holds its own copy of
  the codes to the engine's with a type check, which will stop compiling until it adds them.
- `lastUndoable()` answers `{ entry, standing, … }` where it answered the entry. The consumer reads `id` and
  `summary` from it.
- After a discard, the last undoable is the discard. A host that shows "undo" for the last entry will offer to undo
  the discard, where it offered the write before it.
- `JournalEntry['operation']` gains `discard`, and `MergePreview`'s conflicts gain an optional `commit`.
- New and optional to use: `undoables()`, `undo({ id })`, `listFolder`, `previewCherryPick`, `previewRebase`,
  `LocalChangesError.files`, `HostRefusedError.rule`.

## Constraints

- `CLAUDE.md` holds the standing rules. The ones this work is most likely to meet: no dependencies, specs go
  through the door, a spec removes what it made and its background processes end by themselves, and a comment says
  how the code is.
- A case that cannot run on a platform is skipped there with the reason in the skip. It is never deleted.
- This machine is macOS. Nothing here can show that a case passes on Linux or Windows, or on git 2.35.0. Say so in
  the handoff instead of claiming it.
- Commit with a message in the style of `git log`: `feat:` or `fix:`, then what is now true. No session or
  co-author lines unless the user's own instructions add them.
