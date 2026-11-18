# Fewer gits for each refresh

Status: planned, 2026-11-18. The design for [its goal](../goals/goal-fewer-gits-per-refresh.md), which owns the
order, the dependencies and when each section is done. This document owns the design: the decisions, the shapes
and the cases.

## Background

Surveyed at `ad3f0f1` on `master`, 2026-11-18, on macOS with git 2.38.1. Every count below was observed there, by
opening a repository with a `run` tie that records each process the runner starts. Inspect current code before
relying on a path.

**What each operation starts today.**

| Operation | Gits | What they are |
|---|---|---|
| Opening (`readSnapshot` on a new `GitRepository`) | 8 | `--version`; `config --get-regexp` for a partial clone; `rev-parse --git-dir --git-common-dir`; `config --list`; `config --get-regexp` for the status settings; `status`; `for-each-ref`; `rev-parse --git-dir --git-common-dir --show-prefix` |
| A whole status (`loadSnapshot`) | 3 | `config --get-regexp`, `status`, `for-each-ref` |
| A noted path, with a snapshot held (`loadNoted`) | 1 | `status -- <path>` |
| The read after staging a file, watched | 3 | the whole status again |
| The read after the watcher says the index changed | 3 | the whole status again |
| Nothing noted | 0 | the held snapshot |

Opening is 7 on a git that can be told not to fetch (`refusesLazyFetch`), which is not asked whether the clone is
partial.

**What that shows.**

- **A whole status asks two questions whose answers rarely change.** The settings change when a configuration file
  does. The refs change when a ref does. Staging a file changes neither, and is followed by two whole statuses: the
  write's own, and the one the watcher's report of the index asks for. Six gits, of which two were needed.
- **Opening asks the same things more than once.** Where the git directory is, twice. And the one `config --list`
  the trust gate takes already holds what both `config --get-regexp` calls ask for.
- **Keeping more gits open is not the lever.** Git has no long-lived mode for a status, the settings or the refs.
  `cat-file --batch-command`, which the [deferred floor plan](deferred/raise-git-floor.md) lists under 2.36, would
  remove none of the processes above.
- **The budgets script's "one noted path" reading is a whole status.** `scripts/budgets.mjs` calls
  `setWatched(true)`, which marks everything unread, and then notes a path without a read between, so the engine
  reads everything. It also notes an absolute path, where `noteChanged` takes one relative to the working
  directory. With a snapshot held the same read is one git. The README's column for that reading, and its paragraph
  saying a status of one path costs about what a whole one does, rest on the wrong reading (section 1).

**The pattern already here.** `TrustGate` (`src/trust.ts`) takes `config --list` once and holds it with how the
files it was read from look, their size and time. Each command then costs a few looks at files and no git. Section
2 gives that reading to everyone who needs a setting.

## Decisions

- **D1. Ask git only what something said may have changed.** A snapshot's parts already change on their own
  (`REPOSITORY_PARTS`). The reads follow: the settings when a file they came from looks different, the refs when a
  ref may have moved, the status when a file or the index may have.
- **D2. A host can always say "look again", and then everything is asked.** `refreshSnapshot('everything')` takes
  the settings afresh and reads the refs, whatever is held. The README's rule that the engine never assumes a
  watcher saw everything is kept by this: what is held is only ever a saving between two such checks.
- **D3. The count of gits an operation starts is asserted, in a spec.** A time varies with the machine, which is
  why the budgets are readings and not gates. A count does not, so it is a gate: a process added to a common path
  fails a case.
- **D4. One reading of the settings, in one place.** A second place that runs `git config` for a status is a second
  thing to keep fresh. Reads of one setting made by a write (`publishRemote`, `rememberedBaseOf`, `readRemote`)
  stay as they are: they are not on a path that runs for every file event.
- **D5. Git's version is asked once for each repository, as now.** Holding it for the whole process would save one
  git at opening and could answer wrongly after the user installs another git.
- **D6. Nothing here needs a newer git, and nothing is kept open.**

**Out of scope, on purpose.**

- Working out whether a ref moved by looking at git's files. How refs are stored is git's to change (packed refs,
  reftable); `for-each-ref` is asked, or not asked.
- `cat-file --batch-command`, more gits kept open, and raising the git floor.
- Choosing which `git.exe` a host runs on Windows. Section 5 measures it; which git is the host's
  (`RepositoryTies.git`).

## How the sections are written

Each section gives the shapes as they are meant to be built, then its cases. Cases follow the existing specs: a real
git in a temporary directory, removed in `afterEach` with `removeDirectory` from `tests/_support/remove.ts`, git run
through `run` from `tests/_support/process.ts`, and the engine imported only from `../src/index.ts`.

Counts are seen through the `run` tie, as `scripts/budgets.mjs` does: a function that records its arguments and
hands on to `runUnbounded`. The runner puts `-c color.ui=never` ahead of every command, so a command's name is the
third argument.

## 1. The counts are right, and held

**Deliverable.** D3. No change to `src/`.

**`scripts/budgets.mjs`.** The "one noted path" reading is taken the way a file event takes it:

1. `repo.setWatched(true)`.
2. `await repo.readSnapshot()`, outside the reading, so a snapshot is held.
3. Write the file, and `repo.noteChanged(['d0/f1.txt'])`: relative to the working directory, with `/`.
4. The reading: `repo.refreshSnapshot('noted')`.

Update the script's comment for that reading. In `README.md`, "Budgets": the paragraph that begins "A status of one
path costs about what a whole one does" was written from the wrong reading. Take `npm run budgets -- 1000 100000`
here after the fix, and rewrite the paragraph to say what the two readings show. Leave the tables: they are CI's,
and its next run prints the corrected reading.

**A new `tests/gits-started.spec.ts`.** One repository with a commit, opened with the recording `run` tie. Each case
asserts the commands started, by name and in order, so a failure says which process was added:

| Case | Commands, at this section |
|---|---|
| Opening | ends `status`, `for-each-ref`, `rev-parse`, and is at most 8 |
| A whole status, unwatched (`refreshSnapshot('everything')`) | `config`, `status`, `for-each-ref` |
| A noted path, with a snapshot held | `status` |
| The read after `stageFiles`, watched | `config`, `status`, `for-each-ref` |
| A read with nothing noted, watched | none |

Opening is "at most 8" here because it differs by git's version until section 2. Each later section changes this
table's expectations in the same commit as the code.

## 2. One reading of the settings, held until a file it came from changes

**Deliverable.** D1, D2 and D4.

**A new `src/settings.ts`.**

```ts
/** One setting as `git config --list --show-scope --show-origin` printed it */
export interface Setting { scope: string; origin: string; key: string; value: string }

/** What git says a repository's settings are, from every file that sets one, and where its git state lives */
export interface SettingsReading {
  /** Every setting, in the order git lists them: a later one of the same key is the one git uses */
  settings: Setting[]
  /** What git said when the settings could not be listed */
  unreadable?: string
  /** The value git uses for a key, spelled as git prints it (`core.ignorecase`), or nothing */
  value(key: string): string | undefined
}

export class HeldSettings {
  constructor(workingDirectory: string, readGit: ReadGit, environment: () => NodeJS.ProcessEnv)
  /** The reading: taken from git the first time, and again when a file it depends on looks different */
  read(): Promise<SettingsReading>
  /** Has the next `read` take the reading from git, whatever the files look like */
  forget(): void
}
```

- The reading is `config --list --show-scope --show-origin --includes -z`, the command `TrustGate.take` runs today.
  Move `settingsOf` from `src/trust.ts` here. `ReadGit` moves here too, and `src/trust.ts` imports it.
- **What a reading depends on**, each as `path:mtimeMs:size` or `path:gone`, joined into one signature:
  - every file a setting of any scope came from (an origin that begins `file:`, resolved against the working
    directory);
  - the repository's own `config` and its `config.worktree`, whether or not they set anything;
  - where a user's settings would be if they were made: `GIT_CONFIG_GLOBAL` from the environment when set, else
    `$XDG_CONFIG_HOME/git/config` (`~/.config/git/config` without it) and `~/.gitconfig`; and `GIT_CONFIG_SYSTEM`
    when set;
  - the value of every environment variable whose name begins `GIT_CONFIG`.
- `read()` compares the signature with the held one and takes the reading again when they differ, as
  `TrustGate.read` does today.
- A file that sets nothing and is not one of the places above is not known to the reading: a system file that does
  not exist yet, or an included file with no setting in it. A setting added there is seen at the next "look again"
  (D2). Say so in the class's comment.

**`src/runner.ts`.** The runner makes one `HeldSettings`, with `args => this.runGitOnce(args)` as `TrustGate` is
given today, exposes it as `readonly settings`, and hands it to `TrustGate`.

- `isPartialClone()` answers from the reading: a value for `extensions.partialclone`, or a `remote.<name>.promisor`
  that is true. The `partial` field and its `config --get-regexp` go.

**`src/trust.ts`.** `TrustGate` takes the `HeldSettings` in place of running `config --list` itself.

- Its asks are worked out from the reading's settings of scope `local` and `worktree`, as now, and an unreadable
  listing still asks (`UNREADABLE`).
- It keeps its own look at the hooks directory, and works its asks out again when the reading it was given is
  another object than the one it last used or the hooks look different.
- It still runs `rev-parse --git-dir --git-common-dir` for where the repository is. Section 3 removes that.

**`src/model.ts`.** `loadSnapshot` takes `status.showuntrackedfiles`, `core.ignorecase`, `user.name`, `user.email`,
`core.fsmonitor` and `core.untrackedcache` from `this.runner.settings.read()`. Its `config --get-regexp` goes.

- `refreshSnapshot('everything')` calls `this.runner.settings.forget()` before it reads (D2).

**Cases.**

- `tests/gits-started.spec.ts`: opening is exactly `--version`, `rev-parse`, `config`, `status`, `for-each-ref`,
  `rev-parse`, on every git. A whole status after a write or a `noteChanged(null)` is `status`, `for-each-ref`.
  `refreshSnapshot('everything')` is `config`, `status`, `for-each-ref`.
- A new `tests/settings-held.spec.ts`, each case with a snapshot read first and no "look again" after the change:
  - *Sees a setting changed in the repository's own configuration.* `git config status.showUntrackedFiles all`
    from outside, `noteChanged(null)`, and the next snapshot lists the files of an untracked folder one by one.
  - *Sees a setting changed in a file the configuration includes.*
  - *Sees the user's settings made for the first time.* Open with `ties.environment` naming a `GIT_CONFIG_GLOBAL`
    that does not exist and no identity in the environment: `hasIdentity` is false. Write `user.name` and
    `user.email` to that file, `noteChanged(null)`: `hasIdentity` is true.
  - *Sees the environment name another file of settings.*
  - *Takes the settings afresh when told to look again.* A setting added to an included file that set nothing is
    not seen after `noteChanged(null)`, and is seen after `refreshSnapshot('everything')`.
- `tests/trust.spec.ts` passes unchanged: a repository's settings changed behind the engine are still asked about.
- `tests/partial-clone.spec.ts` passes unchanged.

## 3. Opening asks where the repository is once

**Deliverable.** `SettingsReading` gains where the git state lives, and both who asked now read it there.

```ts
/** Where the repository's git state lives, as git said when first asked; nothing when the directory is in none */
directories?: GitDirectories
```

- `HeldSettings` asks `rev-parse --git-dir --git-common-dir --show-prefix` once, the first time it is read, and
  resolves the two directories against the working directory as `RepositoryModel.resolveGitDirectories` does.
  `forget()` does not ask again: only the listing is retaken.
- `TrustGate` takes the directories from the reading. Its own `rev-parse` goes.
- `RepositoryModel` uses `this.gitDirectories ?? (await this.runner.settings.read()).directories` where it uses
  `this.gitDirectories ?? await this.resolveGitDirectories()` today. `resolveGitDirectories()` itself still asks
  git each time it is called: it is what a watcher calls when it checks its watches, and a host calls to ask again.

**Cases.** `tests/gits-started.spec.ts`: opening is exactly `--version`, `rev-parse`, `config`, `status`,
`for-each-ref`. `tests/worktrees.spec.ts` and `tests/trust.spec.ts` pass unchanged, which is what holds a linked
worktree's two directories and a repository's name to what they were.

## 4. A change to the index alone reads the status alone

**Deliverable.** D1. The refs are not read again when what changed cannot have moved one.

**The hint.** `ChangedPaths` in `src/watcher.ts` gains a member:

```ts
/**
 * What a report says changed: paths in the working tree, when nothing else changed and they are few enough to
 * name; `'index'` when git's index changed and no ref did, so any file's standing may have and no ref has; `null`
 * when anything may have.
 */
export type ChangedPaths = string[] | 'index' | null
```

- `GitWatcherService`: a change to the file `index` in the git directory, from the watch on that directory or from
  the follower of that file, is reported as `'index'`. Every other change to git's own files stays `null`: `HEAD`,
  a ref, the packed refs, what a merge or a rebase keeps there.
- What is waiting to be reported widens and never narrows: paths, then `'index'`, then `null`. Paths noted before
  an `'index'` report are covered by it.
- `GitRepository.noteChanged` and `RepositoryModel.noteChanged` take the new type.

**The model.** `unread` gains the same middle value: `Set<string> | 'status' | 'anything'`.

- `noteChanged('index')` sets `unread` to `'status'` unless it is `'anything'`, and counts as a notice.
- A new `markStatusStale()` does the same for a write made here. `markSnapshotStale()` is unchanged.
- `LoadedSnapshot` (`src/status.ts`) keeps the lines `for-each-ref` printed, as `refs: string[]`.
- `readSnapshotOnce`: with a snapshot held and `'status'` unread, it calls `loadSnapshot` with the held
  snapshot's `refs`, and `loadSnapshot` then runs no `for-each-ref`. Everything it works out from the refs (the
  `history`, `refs` and `stashes` identities, the operation's name) is worked out as now, from the status it just
  read and the held lines. Unwatched there is no held snapshot, so everything is read, as now.

**The writes that move only the index.** `GitWrites.withWriteFlag` takes what the write may have moved, `'index'`
or everything, and calls `markStatusStale()` or `markSnapshotStale()` when it ends. Everything is the default.
These pass `'index'`, and drop their own calls to `markSnapshotStale()`:

- `stageFiles`, `unstageFiles`, `applyHunk`, `resolveConflict`, and `applyPatch`, which changes files or what is
  staged and moves no ref either way.

Every other write stays as it is: a commit, a checkout, a merge, a stash and a fetch move refs, and a discard is
left reading everything, since it is rare and writes more than the index.

**Cases.**

- `tests/gits-started.spec.ts`, watched, with a snapshot held: the read after `stageFiles` is `status`; the read
  after `noteChanged('index')` is `status`; the read after `noteChanged(null)` is `status`, `for-each-ref`.
- `tests/noted-paths.spec.ts` or a new spec beside it:
  - *A file staged by another git is listed as staged after an index report.* `git add` from outside,
    `noteChanged('index')`, and the snapshot has the row staged.
  - *A commit made by another git is seen.* `git commit` from outside, then the reports a watcher would make of it,
    `noteChanged('index')` and `noteChanged(null)` in either order: `refreshSnapshot('noted')` says `history` and
    `refs` changed, and the snapshot's branch commit is the new one.
  - *An index report alone never says a ref moved, and a look again finds one that did.* A branch made by another
    git with no report of it, `noteChanged('index')`: `refs` is not said to have changed.
    `refreshSnapshot('everything')` then says it has.
- `tests/watcher.spec.ts`: a real `git add` in a watched repository is reported as `'index'`, and a real
  `git commit` as `null`. Copy how the existing cases there wait for a report.
- `tests/staging.spec.ts`, `tests/hunks.spec.ts` and `tests/conflict-sides.spec.ts` pass unchanged.

**What the consumer must change.** Nothing has to. Its watcher actor hands what the watcher reports straight to
`noteChanged` (`git-watcher-actor.ts`), and the type it is handed widens with it. A host that reads the report
itself must treat `'index'` as it treats `null`, or better. Keep this paragraph correct for what was built.

## 5. What starting a git costs on Windows

**Deliverable.** A reading, and no change to `src/`.

Git for Windows' `git.exe` on the `PATH` (`cmd\git.exe`) starts a second `git.exe` that does the work, so each
command is two processes. `src/objects.ts` and `src/runner.ts` already say so where they wait for a git to be gone.
Whether running the inner one directly is cheaper, and by how much, is not known.

`scripts/budgets.mjs`, on `win32` only, prints one more line before the sizes:

- Find the inner git: `git --exec-path` answers `…\mingw64\libexec\git-core`; the inner git is
  `…\mingw64\bin\git.exe`. When that file is not there, print that it was not found and carry on.
- Run `git --version` fifty times with each, one after another, and print the mean of each in milliseconds:
  `starting a git: 41 ms by the PATH, 19 ms directly`.

Record the line CI's Windows `budgets` job prints in
`docs/evidence/fewer-gits-per-refresh.md`. What a host should do with it is the host's to decide, and is not part
of this plan.

## What it comes to

| Operation | Today | After |
|---|---|---|
| Opening | 8, or 7 on a newer git | 5 |
| A whole status after a write, or when anything may have changed | 3 | 2 |
| A whole status when told to look again | 3 | 3 |
| The read after staging, unstaging, a hunk or a resolved conflict, watched | 3 | 1 |
| The read after the watcher reports the index, watched | 3 | 1 |
| A noted path | 1 | 1 |

Staging a file and seeing it listed goes from six gits to two.
