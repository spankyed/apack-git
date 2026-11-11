// The git engine's door: the only module anything outside this folder imports.
//
// The engine owns one working tree's truth and every git process. A host owns who is looking, what to show and
// what to say: it hands in how a process is run, the environment git starts from and where to log
// (`RepositoryTies`), tells the engine what may have changed, and is told only what really differs.
export { GitRepository } from './repository.ts'
export { GitWatcherService, type ChangedPaths } from './watcher.ts'
export { nodeSubscriber, perDirectorySubscriber, subscribeToDirectory, type SubscribeToDirectory, type WatchDirectory, type WatchTree, type WatchedChange } from './directory-watch.ts'
export { GIT_ERROR_CODES, GitError, classifyGitError, type GitErrorCode } from './errors.ts'
export { StashConflictError } from './writes.ts'
export { GitObjectReader } from './objects.ts'
export { progressReader, withoutProgress } from './progress.ts'
export { UNTRACKED_LISTED_LIMIT } from './reads.ts'
export { NOTHING_CHANGED, STATUS_LIMIT, changedAnything, parseStatus } from './status.ts'
export { runUnbounded, type RepositoryLog, type RepositoryTies, type RunOptions, type RunProcess, type WatchProcess } from './ties.ts'
export {
  CONFLICT_KINDS, OPERATION_KINDS, OPERATION_MOVES, REPOSITORY_PARTS,
  type CommitLogEntry, type ConflictKind, type DiffHunk, type GitDirectories, type GitProgress, type GitStatusFile, type OperationKind, type OperationMove,
  type RepositoryChange, type RepositoryOperation, type RepositoryPart, type RepositorySnapshot, type StashEntry, type WorktreeEntry,
} from './types.ts'
