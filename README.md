# apack-git

A live picture of one git working tree, and every git process that keeps it.

It answers what a source control panel asks: what changed, on which branch, how far from its upstream, what git
is in the middle of. It says which parts of that differ since the last time it was checked, so a host tells its
windows only what is new. And it makes the reads and writes such a panel makes: a diff, a file as a commit has
it, the log, branches, stashes and worktrees; staging a file or one piece of its change, committing, checking
out, stashing, fetching, pulling and pushing.

It is the git engine of [apack](https://github.com/spankyed/apack), in a repository of its own so that it is
checked on Linux, macOS and Windows on every push.

```ts
import { GitRepository, GitWatcherService } from 'apack-git'

const repo = new GitRepository(dir, { run, environment, log })

await repo.readSnapshot()            // plain data: files, branch, ahead and behind, an operation in progress
repo.noteChanged(paths)              // a hint from a watcher: these paths, or `null` for anything
await repo.refreshSnapshot('noted')  // which parts really differ: status, diffs, history, stashes, worktrees

await repo.stageFiles(paths)         // resolves, or rejects with a `GitError` carrying a code
```

## What holds it together

- **The engine owns one working tree's truth and every git process. A host owns who is looking, what to show
  and what to say.** It names no window, user, host or setting.
- **Plain data out.** A snapshot crosses a host's bus to its windows, so it is data and never an object with
  methods.
- **Codes, not prose.** A failure carries a code (`GitErrorCode`) read from what git printed, in one place. A
  host writes the sentence.
- **Hints in, news out.** A file event is a hint, and git says whether anything changed. The engine never
  assumes a watcher saw everything: a host can always say "look again".
- **What it runs with is handed in** (`RepositoryTies`): how a process is run, the environment git starts
  from, what watches a git kept open, and where to log. With none it uses Node's `execFile` and the process's
  own environment.
- **Nothing native, and no dependencies.** A tree is watched with Node's own `fs.watch`.
- **A repository cannot make it run a program before it is trusted.** A repository's own configuration and hooks
  can name programs, and a plain status runs one of them. Until a host says the repository is trusted
  (`isTrusted`), the engine reads what it would run without running it (`readTrust`), and when that names
  anything it runs no git there but that reading: a command is refused with an `UntrustedError` carrying the
  list. The rule is a list of settings known to run nothing, and every other setting asks.
- **A discard keeps what it removes.** Before a changed file is checked out again, or an untracked file or folder
  deleted, what is about to go is written into git's object store as a tree built with an index of its own, and
  `restoreDiscarded` puts it back. The user's index, refs and stash are not touched. Nothing refers to that tree,
  so git keeps it for as long as it keeps such objects: two weeks, unless told otherwise.

## Two entries

- `apack-git` is the engine, for Node.
- `apack-git/staging` is where a file will be listed once it is staged or unstaged, worked out before git
  answers. It imports nothing of Node's, so a window can use it.

## Budgets

What the engine's work should cost, by the number of files a repository tracks. They are statements, not gates:
`npm run budgets -- <sizes>` prints a reading of each against a repository it generates, with the machine's
conditions beside it, and fails on none of them. CI prints the readings for 1,000 and 100,000 files on Linux, macOS
and Windows (the `budgets` jobs); a million files is read by hand.

| Files | Opening | A whole status | A status of one noted path | A checkpoint of the whole tree |
|---|---|---|---|---|
| 1,000 | 500 ms | 200 ms | 200 ms | 1.5 s |
| 100,000 | 1 s | 1 s | 1 s | 5 s |
| 1,000,000 | 3 s | 3 s | 3 s | 60 s |

Each is about twice the slowest reading on an unloaded machine below, so a machine that is not busy keeps to it. A
busy one does not, as the macOS readings taken under load show, and a whole status over its budget is what the
snapshot's `slowStatus` reports (`STATUS_BUDGET_MS`).

A status of one path costs about what a whole one does at 100,000 files and more: git matches the path against every
file in the index. What the engine saves there is the process for each path, not git's walk.

### Readings

Each with the machine it was taken on, as the command printed it. The 1,000 and 100,000 rows are CI's `budgets`
jobs; the million is a dispatch of CI by hand (`budget_sizes: 1000000`) and a run on a developer's Mac.

| Taken | Machine | git | Files | Opening | Whole status | One noted path | Checkpoint |
|---|---|---|---|---|---|---|---|
| CI, 2026-11-12 | Linux x64, 4 cores, load 0.34 | 2.56.1 | 1,000 | 42 ms | 16 ms | 16 ms | 67 ms |
| | | | 100,000 | 200 ms | 165 ms | 165 ms | 469 ms |
| CI, 2026-11-12 | macOS arm64 (virtual), 3 cores, load 113 | 2.56.0 | 1,000 | 68 ms | 31 ms | 31 ms | 75 ms |
| | | | 100,000 | 317 ms | 263 ms | 361 ms | 1,393 ms |
| CI, 2026-11-12 | Windows x64, 4 cores | 2.56.0.windows.4 | 1,000 | 421 ms | 148 ms | 140 ms | 1,172 ms |
| | | | 100,000 | 392 ms | 276 ms | 201 ms | 3,472 ms |
| CI by hand, 2026-11-12 | Linux x64, 4 cores, load 0.35 | 2.56.0 | 1,000,000 | 1,763 ms | 1,067 ms | 1,129 ms | 4,809 ms |
| CI by hand, 2026-11-12 | macOS arm64 (virtual), 3 cores, load 85.6 | 2.56.0 | 1,000,000 | 11,874 ms | 34,961 ms | 13,301 ms | 32,850 ms |
| CI by hand, 2026-11-12 | Windows x64, 4 cores | 2.56.0.windows.4 | 1,000,000 | 1,384 ms | 1,009 ms | 958 ms | 25,812 ms |
| By hand, 2026-11-12 | macOS arm64, Apple M1 Pro, 10 cores, loaded | 2.38.1 | 1,000,000 | 11,054 ms | 12,273 ms | 12,564 ms | 47,189 ms |

## Using it

It is not published to a registry. A consumer depends on a checkout of this repository at a pinned commit and
resolves the package through it; `npm run build` writes the `dist/` the package's entries name.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Every spec runs a real git in a throwaway repository. Node 24.12 or later.
