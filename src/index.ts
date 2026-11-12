// The git engine's door: the only module anything outside this folder imports.
//
// The engine owns one working tree's truth and every git process. A host owns who is looking, what to show and
// what to say: it hands in how a process is run, the environment git starts from and where to log
// (`RepositoryTies`), tells the engine what may have changed, and is told only what really differs.
export { GitRepository } from './repository.ts'
export { GitWatcherService, type ChangedPaths } from './watcher.ts'
export {
  nodeSubscriber, perDirectorySubscriber, subscribeToDirectory,
  type DirectorySubscription, type SubscribeToDirectory, type WatchDirectory, type WatchTree, type WatchedChange,
} from './directory-watch.ts'
export { followFile, followFileWith, type FileFollower, type FollowFile, type WatchFile } from './file-watch.ts'
export { GIT_ERROR_CODES, GitError, UnsafeOwnershipError, classifyGitError, type GitErrorCode } from './errors.ts'
export { GIT_FLOOR, GitUnusableError, gitVersionOf, olderThan, type GitUnusable } from './git-check.ts'
export { UNREADABLE, UntrustedError, settingRunsNothing, type TrustAsk, type TrustReading } from './trust.ts'
export { StashConflictError } from './writes.ts'
export { GitObjectReader } from './objects.ts'
export { progressReader, withoutProgress } from './progress.ts'
export { CHECKPOINT_MAX_AGE_MS, CHECKPOINT_STORE_LIMIT, KEPT_FILE_LIMIT } from './checkpoints.ts'
export { UNTRACKED_LISTED_LIMIT } from './reads.ts'
export { NOTHING_CHANGED, STATUS_LIMIT, changedAnything, parseStatus } from './status.ts'
export { runUnbounded, type RepositoryLog, type RepositoryTies, type RunOptions, type RunProcess, type WatchProcess } from './ties.ts'
export {
  CONFLICT_KINDS, OPERATION_KINDS, OPERATION_MOVES, REPOSITORY_PARTS,
  type Checkpoint, type CheckpointChange, type CommitLogEntry, type ConflictAnswer, type ConflictKind, type ConflictSides, type JournalEntry, type DiffHunk, type DiscardKept, type DiscardRestored, type GitDirectories, type GitProgress, type GitStatusFile, type OperationKind, type OperationMove, type ChangedFile, type LineCount,
  type RepositoryChange, type RepositoryOperation, type RepositoryPart, type RepositorySnapshot, type StashEntry, type WorktreeEntry,
} from './types.ts'
