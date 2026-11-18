# A folder as a commit has it

Status: deferred, 2026-11-18. It was Phase 6 of
[goal-what-git-would-do-and-undo](../../goals/goal-what-git-would-do-and-undo.md) and section 6 of
[its plan](../what-git-would-do-and-undo.md), and was taken out before any of it was built.

## What it is

`GitRepository.listFolder(commit, directory)`: what a folder holds as a commit has it, so a host can browse a
commit without checking it out. `readFileContentFromBranch` already reads a file that way; this is the listing
beside it.

## Why it is deferred

No host calls it. The engine's reference check refuses an export no spec uses, and an ability no host uses is the
same thing one level up: it would be kept correct on three platforms for nobody.

The design carries little risk. What it rests on was observed against a real git on 2026-11-17 (git 2.38.1): the
format `git ls-tree -z -l` prints, what git says for a folder the commit lacks and for a path that is a file, and
that a `GitRepository` opened on a bare repository reads a file and a history from a commit.

## What would justify taking it up

A place in a host that browses a commit's files: a file tree for a commit in a history, or for a pull request's
head. Then this is one phase, with nothing to settle first.

## The design as drafted

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
