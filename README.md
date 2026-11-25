# @apackdev/git

A live picture of one git working tree, and every git process that keeps it.

It answers what a source control panel asks: what changed, on which branch, how far from its upstream, what git
is in the middle of. It says which parts of that differ since the last time it was checked, so a host tells its
windows only what is new. And it makes the reads and writes such a panel makes, from staging one piece of a file's
change to rewriting the last few commits, each of which can be undone where it destroys something.

It is the git engine of [apack](https://github.com/spankyed/apack), in a repository of its own so that it is
checked on Linux, macOS and Windows on every push.

```ts
import { GitRepository, GitWatcherService } from '@apackdev/git'

const repo = new GitRepository(dir, { run, environment, log })   // every tie is optional (`RepositoryTies`)

await repo.readSnapshot()            // plain data: files, branch, ahead and behind, an operation in progress
repo.noteChanged(paths)              // a hint from a watcher: these paths, or `null` for anything
await repo.refreshSnapshot('noted')  // which parts really differ: status, diffs, history, stashes, refs, worktrees

await repo.stageFiles(paths)         // resolves, or rejects with a `GitError` carrying a code

const watcher = new GitWatcherService(dir)   // file events in, hints out
watcher.setGitRepository(repo)
watcher.setChangeCallback(paths => { repo.noteChanged(paths); void repo.refreshSnapshot('noted') })
```

## What it does

- **The working tree**: the snapshot and what changed in it; diffs, as text and as pieces (`readHunks`) a file's
  change is staged or unstaged by one at a time; a file as the working tree, the index, a commit or a branch has
  it; how many lines each change adds and removes; the folders git ignores; the three sides of a conflicted file,
  and resolving it with one side or with content written in its place.
- **Writes**: staging, committing and amending; discarding a file's changes, which keeps what it removed
  for `undo`; stashing all of it, only what is staged, or only some paths, and applying, popping and
  dropping a stash, whose files are read without applying it.
- **History**: pages of history to draw, with each commit's parents and refs, that neither repeat nor drop a commit
  while the repository moves; a file's history across its renames; blame, a group of lines at a time; a commit's
  files and whole message; where two histories meet (`mergeBase`); the branch a branch was made from.
- **Branches, remotes and tags** as one model (`refsModel`): each branch with what it follows and how far ahead and
  behind; making, renaming, deleting and checking out a branch, at a commit when asked; every remote with its
  address as git would use it, and adding, renaming, removing and re-addressing one; making, deleting and pushing a
  tag; worktrees.
- **The remote**: fetching, pulling and pushing, with progress, and a fetch or a push stopped through an
  `AbortSignal`; a branch fetched or deleted on a named remote; a GitHub pull request fetched from
  `refs/pull/<n>/head`, a fork's included.
- **Merges and rewrites**: what a merge or a pull would do before it is done (`previewMerge`); merging, rebasing
  and cherry-picking, and carrying on with, skipping or giving up what git is in the middle of; rewriting the
  commits after one by keeping, rewording, folding or dropping each (`rewrite`).
- **Undo**: every commit, amend, reset, deleted branch, dropped stash, merge, rebase, cherry-pick, rewrite and
  discard made here in the last 14 days is listed with whether it can be taken back now (`undoables`), and `undo`
  takes back the one a host names by its id: refused with a code when it has moved since, is published or is no
  longer kept, and never another entry than the one named. A merge, rebase, cherry-pick or rewrite takes a
  checkpoint of the working tree before it, in a store outside the repository, which `restoreCheckpoint` puts back.
- **Repositories**: cloning and initialising one, with progress; every repository under a folder
  (`GitRepository.repositoriesUnder`); where a checkout's git state lives, a linked worktree's included.

[`REFERENCE.md`](REFERENCE.md) has every one of them, with its comment and signature.

## What is supported

Linux, macOS and Windows, with Node 24.12 or later, and git from 2.35.0 (`GIT_FLOOR`) to the newest. CI runs exactly
that on every push: the whole suite on each of the three systems with the git its runner installs, which is the
newest, and again against git 2.35.0 built from its source, Debian 12's own git and macOS's own (`.github/workflows/ci.yml`).
An older git is refused by name (`GitUnusableError`) rather than half working, and so is a git that cannot be found
or run, with the reason. A read that needs a newer git says so rather than guessing: `previewMerge` answers `unknown`
before 2.38.

## What holds it together

- **The engine owns one working tree's truth and every git process. A host owns who is looking, what to show
  and what to say.** It names no window, user, host or setting.
- **Plain data out.** A snapshot crosses a host's bus to its windows, so it is data and never an object with
  methods.
- **Codes, not prose.** A failure carries a code (`GitErrorCode`) read from what git printed, in one place. A
  host writes the sentence. Where git names what a failure is about, the error carries that too, as an optional
  fact: the files a checkout, a merge or a pull would overwrite (`LocalChangesError.files`), and which of a hosting
  service's rules refused a push (`HostRefusedError.rule`).
- **Hints in, news out.** A file event is a hint, and git says whether anything changed. The engine never
  assumes a watcher saw everything: a host can always say "look again", and a watch that has stopped delivering
  is said in the snapshot. A hint asks git only what it says may have changed: named paths read a status of those
  paths, a change to git's index (`'index'`) reads the whole status and keeps the refs, and anything reads both. The
  settings are held until a file they came from looks different, and a look again takes them afresh.
- **A prediction is never in a snapshot.** Where a file will be listed once it is staged is worked out ahead of
  git, for a window to show at once (`@apackdev/git/staging`). That lives in the entries that import nothing of
  Node's. A snapshot the engine answers with is what git said, and nothing else.
- **What it runs with is handed in** (`RepositoryTies`): which git, how a process is run, the environment git
  starts from, what watches a git kept open, where to log, how long a status may take, whether a repository is
  trusted, and where checkpoints are kept. With none it uses Node's `execFile` and the process's own environment.
- **A read never reaches the network, and nothing fetches unasked.** A partial clone's missing content is a
  `content-missing` code, until a host lets one read fetch it (`fetchingMissing`); when to fetch is the host's to
  decide.
- **Nothing native, and no dependencies.** A tree is watched with Node's own `fs.watch`.
- **A repository cannot make it run a program before it is trusted.** A repository's own configuration and hooks
  can name programs, and a plain status runs one of them. Until a host says the repository is trusted
  (`isTrusted`), the engine reads what it would run without running it (`readTrust`), and when that names
  anything it runs no git there but that reading: a command is refused with an `UntrustedError` carrying the
  list. The rule is a list of settings known to run nothing, and every other setting asks. A git kept open while
  the repository was trusted is ended when a read is refused.
- **What a write destroys can be had back.** Before a changed file is checked out again, or an untracked file or
  folder deleted, what is about to go is kept as a checkpoint: a commit in a store outside the repository
  (`RepositoryTies.checkpointDirectory`), and the discard is an entry `undo` puts back. The repository's index, refs,
  objects and stash are not touched, and a checkpoint is dropped after 14 days, or as the oldest while the store is
  larger than a gigabyte. A merge, rebase, cherry-pick
  or rewrite checkpoints the working tree first, and `undo` takes back the write it is named. An amend, a rewrite or an undo that
  would change commits a remote branch already holds is refused as `published` unless the host says
  `evenIfPublished`.

## Three entries

- `@apackdev/git` is the engine, for Node.
- `@apackdev/git/staging` is where a file will be listed once it is staged or unstaged, worked out before git
  answers. It imports nothing of Node's, so a window can use it.
- `@apackdev/git/availability` says whether a commit, a push, a pull and a sync can be done from a snapshot, and why
  not when one cannot. It imports nothing of Node's either.

## Budgets

What the engine's work should cost, by the number of files a repository tracks. They are statements, not gates:
`npm run budgets -- <sizes>` prints a reading of each against a repository it generates, with the machine's
conditions beside it, and fails on none of them. CI prints the readings for 1,000 and 100,000 files on Linux, macOS
and Windows (the `budgets` jobs); a million files is read by hand. Each reading comes with the number of gits
started for it, which counts every process the runner starts and not the one git kept open for reading files.

| Files | Opening | A whole status | A status of one noted path | A checkpoint of the whole tree |
|---|---|---|---|---|
| 1,000 | 500 ms | 200 ms | 200 ms | 1.5 s |
| 100,000 | 1 s | 1 s | 1 s | 5 s |
| 1,000,000 | 3 s | 3 s | 3 s | 60 s |

Each is about twice the slowest reading on an unloaded machine below, so a machine that is not busy keeps to it. A
busy one does not, as the macOS readings taken under load show, and a whole status over its budget is what the
snapshot's `slowStatus` reports, against the budget a host sets (`RepositoryTies.statusBudgetMs`, 1 s when none is set).

A status of one noted path, with a snapshot held, is one git asked about that path alone, where a whole status is
three. At 100,000 files on CI below it took 18 ms on Linux, 43 ms on macOS and 61 ms on Windows, against 133 ms,
325 ms and 276 ms for a whole status: git still matches the path against the index, but walks none of the working
tree.

### Readings

Each with the machine it was taken on, as the command printed it. The 1,000 and 100,000 rows are CI's `budgets`
jobs; the million is a dispatch of CI by hand (`budget_sizes: 1000000`) and a run on a developer's Mac.

| Taken | Machine | git | Files | Opening | Whole status | One noted path | Checkpoint |
|---|---|---|---|---|---|---|---|
| CI, 2026-11-21 | Linux x64, 4 cores, load 0.91 | 2.56.1 | 1,000 | 133 ms | 13 ms | 4 ms | 32 ms |
| | | | 100,000 | 155 ms | 133 ms | 18 ms | 435 ms |
| CI, 2026-11-21 | macOS arm64 (virtual), 3 cores, load 73.8 | 2.56.1 | 1,000 | 123 ms | 62 ms | 50 ms | 201 ms |
| | | | 100,000 | 354 ms | 325 ms | 43 ms | 1,180 ms |
| CI, 2026-11-21 | Windows x64, 4 cores | 2.56.1.windows.1 | 1,000 | 214 ms | 130 ms | 35 ms | 452 ms |
| | | | 100,000 | 325 ms | 276 ms | 61 ms | 3,315 ms |
| CI by hand, 2026-11-12 | Linux x64, 4 cores, load 0.35 | 2.56.0 | 1,000,000 | 1,763 ms | 1,067 ms | 1,129 ms | 4,809 ms |
| CI by hand, 2026-11-12 | macOS arm64 (virtual), 3 cores, load 85.6 | 2.56.0 | 1,000,000 | 11,874 ms | 34,961 ms | 13,301 ms | 32,850 ms |
| CI by hand, 2026-11-12 | Windows x64, 4 cores | 2.56.0.windows.4 | 1,000,000 | 1,384 ms | 1,009 ms | 958 ms | 25,812 ms |
| By hand, 2026-11-12 | macOS arm64, Apple M1 Pro, 10 cores, loaded | 2.38.1 | 1,000,000 | 11,054 ms | 12,273 ms | 12,564 ms | 47,189 ms |

## The reference, and an example

[`REFERENCE.md`](REFERENCE.md) is every export of the three entries with its comment and its signature, generated
from the source (`npm run reference:update`); CI fails when it differs from the source, or when an export or a
public member is used by no spec. [`examples/news.mjs`](examples/news.mjs) is a host in thirty lines: it prints what
a folder's repository is and then each piece of news as it happens (`npm run example -- <folder>`). It is the
diagnostic for a watch as well: an edit that prints nothing is one the watch did not deliver.

## Using it

It is made to be published to npm as `@apackdev/git`, publicly, by `npm publish`, which builds `dist/` afresh before it
packs (`prepack`). It is ESM, with types for each entry and source maps that carry their source, and has no
dependencies and no effects on import (`sideEffects: false`). `npm run package:check`, which CI runs on each system,
packs it as a publish would, installs it into a consumer of its own and compiles and loads each entry there.

It is not on npm yet, and nothing in CI puts it there. Instead each `master` commit whose CI passes gets a GitHub
prerelease, `pkg-<commit>`, holding the package as `npm pack` packs it and a `SHA256SUMS` of it
([`packages.yml`](.github/workflows/packages.yml)). apack depends on a commit's package by its URL, with no checkout
of this repository and no build:

```bash
npm install https://github.com/spankyed/apack-git/releases/download/pkg-<commit>/apackdev-git-0.1.0.tgz
```

The lockfile records the bytes' integrity, so a prerelease, once written, keeps its package; one CI missed, such as a
commit whose run a later push cancelled, is made by dispatching `packages.yml` with the commit's full hash.
`npm run workflows:check`, which CI runs, fails when a workflow runs a command that writes to npm, reads a secret
other than the `GITHUB_TOKEN`, or the manifest gains a publish script.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Every spec runs a real git in a throwaway repository. Beside the suite, `npm run budgets -- <sizes>` prints the
readings above, and `npm run soak:sequences` runs random sequences of edits through the platform's own watch and
counts the steps whose events never came. Neither fails anything.
