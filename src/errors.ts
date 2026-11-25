// What a failed git command means, read from what git printed, in one place. Git says why it failed in prose, and
// every caller that needs to know why reads the code this gives rather than the prose: a second place matching the
// text is a second list to keep in step with git, and the one that falls behind answers wrongly without failing.
//
// The prose is English because every git child is run in English (`gitEnvironment`, git.ts), whatever the user's
// locale is.

/** Why a git command failed, where what it printed says */
export const GIT_ERROR_CODES = [
  /** Another process holds a lock the command needs */
  'locked',
  /** The remote asked for a sign-in git does not have: no stored credentials, or a key it refused */
  'authentication',
  /** The remote knows who is asking and will not allow it */
  'permission',
  /** The remote could not be reached at all */
  'remote-unreachable',
  /** A push the remote refused because its branch has commits this one lacks */
  'non-fast-forward',
  /** A pull of a branch that both sides have added to, which git was not told how to bring together */
  'diverged',
  /** A merge, a rebase or a stash stopped on changes that conflict */
  'conflict',
  /** The command would overwrite changes in the working tree */
  'local-changes',
  /** A branch, a commit or a path that git does not know */
  'unknown-ref',
  /** The directory is in no git repository */
  'not-a-repository',
  /**
   * The directory is in a repository git will not read, because another user owns it and it is not one of the
   * user's `safe.directory` entries (`UnsafeOwnershipError`)
   */
  'unsafe-ownership',
  /** A commit was to be signed and the signing program failed, or could not be run */
  'signing-failed',
  /** A pull or a merge of a branch that shares no commit with this one */
  'unrelated-histories',
  /** A commit with nothing staged */
  'nothing-to-commit',
  /** A branch was to be made under a name a branch already has */
  'branch-exists',
  /** A push with no branch checked out, which has nothing to publish. Not read from git: git was not asked */
  'detached-head',
  /** A branch to publish with no remote to publish it to, or several and nothing naming one. Not read from git */
  'no-remote',
  /**
   * The hosting service refused a push for a rule of its own: a file too large, a protected branch, an email
   * address the user keeps private, a secret found in it. What it said is in git's words, on lines it begins
   * with `remote:`
   */
  'host-refused',
  /** The command was stopped by whoever asked for it: no failure, and nothing to report as one */
  'aborted',
  /** There is no git where the host said git is (`GitUnusableError`) */
  'git-not-found',
  /** On macOS, git is the placeholder that stands for the developer tools, which are not installed */
  'developer-tools-missing',
  /** Git is older than the oldest the engine works with (`GIT_FLOOR`) */
  'git-too-old',
  /**
   * The repository would have git run a program and has not been trusted, so the command was not run. The one
   * code that is not read from what git printed: git was not asked (`trust.ts`)
   */
  'untrusted',
  /**
   * A read needed content a partial clone has not fetched, and reads do not fetch (`GIT_NO_LAZY_FETCH`): it is
   * fetched when whoever asked says so (`GitRepository.fetchingMissing`)
   */
  'content-missing',
  /**
   * A hook the repository runs refused the command: its name and exit code are the error's (`HookRefusedError`),
   * read from git's event stream rather than what it printed, and what it printed is the hook's
   */
  'hook-refused',
  /**
   * A path whose name is not text (not valid UTF-8, which Linux allows): it is listed, and refused by name before
   * git is run, since a command naming it as the engine read it would name a file that is not there
   */
  'name-not-text',
  /**
   * A commit to be undone is already on a remote branch, so undoing it here leaves it there: undone only when whoever
   * asked says so. Not read from what git printed: the engine asks before it runs anything
   */
  'published',
  /**
   * An undo of a write whose ref has moved since: undoing it would undo what moved it too. Not read from what git
   * printed: the engine asks before it runs anything
   */
  'moved-since',
  /** An undo of an entry the journal does not hold: taken back already, or past its age. Not read from what git printed */
  'nothing-to-undo',
  /**
   * A copy of the working tree the store has dropped: past its age, or the oldest of too many. Not read from what
   * git printed
   */
  'no-longer-kept',
  /** A pull with no upstream branch configured for the current branch. Not read from git */
  'no-upstream',
  /** A hunk to apply no longer matches the file as it stands now. Not read from git */
  'stale-hunk',
  /** Git wrote more output than the engine's buffer bound (`maxBuffer`), so the command was truncated */
  'output-too-large',
] as const

export type GitErrorCode = (typeof GIT_ERROR_CODES)[number]

/** What git says when another process holds a lock it needs, with the lock's path */
export const LOCKED = /Unable to create '(.+\.lock)': File exists/

/**
 * What git prints when a read needed content a partial clone never fetched and was told not to fetch it: the
 * warning, then why the read failed. `git show rev:path` says only that the object is bad, having found its id in
 * a tree it holds and no content under that id; a bad object named without a path is not this, and gets no code.
 */
export const CONTENT_MISSING = /^warning: lazy fetching disabled|^fatal: could not fetch \S+ from promisor remote|^fatal: bad object [^\s:]*:/m

/** What git says of a repository another user owns, with its path as git will match it in `safe.directory` */
const OWNED_BY_ANOTHER = /^fatal: detected dubious ownership in repository at '(.+)'$/m

/**
 * What git prints for each, most telling first: a refused key prints "Permission denied (publickey)" and then
 * "Could not read from remote repository", and the first is why.
 *
 * **Each is a line git itself writes, matched from the line's start.** What git printed also holds names the
 * user chose (a branch called `fix/CONFLICT-markers`, a file called `CONFLICTS.md`), what a hook printed, and
 * what another step of the same command said (a tag a pull could not move is `[rejected]` too). A phrase found
 * anywhere in that reads those as git's reason; a whole line of git's does not. A reason with no line here
 * gets no code, and git's own words are what is shown.
 */
/** What a hosting service prints when a rule of its own refused a push, with the rule's number */
const HOST_RULE = /^remote: error: GH0(01|06|07|13):/m

/** Which of a hosting service's own rules refused a push */
export type HostRule = 'file-too-large' | 'protected-branch' | 'private-email' | 'rule-violation'

/** Each rule by the number GitHub prints for it */
const HOST_RULES: Readonly<Record<string, HostRule>> = { '01': 'file-too-large', '06': 'protected-branch', '07': 'private-email', '13': 'rule-violation' }

/** The line git prints above the files a command would overwrite, one to a line after it, each after a tab */
const LOCAL_CHANGES = /^error: Your local changes to the following files would be overwritten by \w+:$/m

const SIGNS: readonly (readonly [GitErrorCode, RegExp])[] = [
  ['locked', LOCKED],
  // The host's reason, ahead of git's own lines after it: a refused push also ends `[remote rejected]`
  ['host-refused', HOST_RULE],
  ['authentication', /^fatal: Authentication failed|^fatal: could not read (Username|Password)|^\S+: Permission denied \(publickey|^remote: Invalid username or (password|token)/m],
  ['permission', /^(remote: |ERROR: )?Permission to \S+ denied|^fatal: unable to access .*The requested URL returned error: 403/m],
  ['remote-unreachable', /^fatal: unable to access .*(Could not resolve host|Failed to connect|Couldn't connect|Connection refused|Connection timed out|Network is unreachable)|^fatal: Could not read from remote repository|^ssh: .*(Could not resolve hostname|Connection refused|Connection timed out|Network is unreachable)|^fatal: unable to (connect to|look up) /m],
  // A branch the remote would not move, and not a tag: git says which in the brackets that end the line
  ['non-fast-forward', /^ ! \[rejected\].*\((non-fast-forward|fetch first)\)\s*$|^hint: Updates were rejected because/m],
  ['diverged', /^fatal: Not possible to fast-forward|^fatal: Need to specify how to reconcile divergent branches/m],
  ['conflict', /^CONFLICT \(|^Automatic merge failed|^(error|fatal): .*[Mm]erge conflict/m],
  // Changes to tracked files. Untracked files in the way are not these, and git's own words name them
  ['local-changes', /^error: Your local changes/m],
  // A ref fetched by name that the remote does not have, as a pull request's head is once its branch is deleted
  ['unknown-ref', /^(error|fatal): pathspec '.*' did not match|^fatal: invalid reference: |^fatal: .*cannot be resolved|^fatal: .*unknown revision|^fatal: couldn't find remote ref /m],
  ['not-a-repository', /^fatal: not a git repository/im],
  ['unsafe-ownership', OWNED_BY_ANOTHER],
  ['signing-failed', /^error: gpg failed to sign the data/m],
  ['unrelated-histories', /^fatal: refusing to merge unrelated histories/m],
  // On stdout, with exit 1: `git commit` says it on the stream it reports a commit on
  ['nothing-to-commit', /^nothing (added )?to commit\b/m],
  // Before git 2.37 the sentence began with a capital
  ['branch-exists', /^fatal: a branch named '.+' already exists/im],
  ['content-missing', CONTENT_MISSING],
]

/** Why git failed, from everything it printed; nothing when it does not say, or says something not known here */
export function classifyGitError(printed: string): GitErrorCode | undefined {
  return SIGNS.find(([, sign]) => sign.test(printed))?.[0]
}

/** A git command that failed, with why where git said */
export class GitError extends Error {
  constructor(message: string, readonly code?: GitErrorCode) {
    super(message)
    this.name = 'GitError'
  }
}

/**
 * A command refused because it would overwrite changes to these files, from the top of the checkout. The list is
 * read from what git printed, and is empty when git did not print it as expected: a host shows it when there is one
 */
export class LocalChangesError extends GitError {
  constructor(message: string, readonly files: string[]) {
    super(message, 'local-changes')
    this.name = 'LocalChangesError'
  }
}

/** A push the hosting service refused for a rule of its own, with which rule */
export class HostRefusedError extends GitError {
  constructor(message: string, readonly rule: HostRule) {
    super(message, 'host-refused')
    this.name = 'HostRefusedError'
  }
}

/** The files git listed under the line that says they would be overwritten, or none when it did not list them */
function filesInTheWay(printed: string): string[] {
  const said = LOCAL_CHANGES.exec(printed)
  if (!said) return []
  const files: string[] = []
  for (const line of printed.slice(said.index + said[0].length).replace(/^\r?\n/, '').split(/\r?\n/)) {
    if (!line.startsWith('\t')) break
    files.push(line.slice(1))
  }
  return files
}

/**
 * A failed command as the error that carries what git named: the files a `local-changes` lists, the rule a
 * `host-refused` gives, and a plain `GitError` for every other code. What is read is optional: lines not as
 * expected leave the fact empty, and the failure its code and git's words
 */
export function gitErrorOf(message: string, code: GitErrorCode | undefined, printed: string): GitError {
  if (code === 'local-changes') return new LocalChangesError(message, filesInTheWay(printed))
  const rule = code === 'host-refused' ? HOST_RULES[HOST_RULE.exec(printed)?.[1] ?? ''] : undefined
  if (rule) return new HostRefusedError(message, rule)
  return new GitError(message, code)
}

/** A command a repository's hook refused, with the hook's name, the code it exited with and what it printed */
export class HookRefusedError extends GitError {
  constructor(readonly hook: string, readonly exitCode: number, readonly output: string) {
    super(`The ${hook} hook refused it (exit code ${exitCode})${output.trim() ? `:\n${output.trim()}` : '.'}`, 'hook-refused')
    this.name = 'HookRefusedError'
  }
}

/**
 * A repository git will not read because another user owns it: on a shared or external drive, in a container,
 * in a folder made under `sudo`. `directory` is the path as git printed it, which is the one git matches against
 * the user's `safe.directory` entries (`GitRepository.trustOwnership`).
 */
export class UnsafeOwnershipError extends GitError {
  constructor(readonly directory: string) {
    super(`Git will not use the repository at ${directory}, because another user owns it.`, 'unsafe-ownership')
    this.name = 'UnsafeOwnershipError'
  }
}

/** The repository git refused for who owns it, when that is what it printed */
export function ownershipRefusal(printed: string): UnsafeOwnershipError | undefined {
  const directory = OWNED_BY_ANOTHER.exec(printed)?.[1]
  return directory === undefined ? undefined : new UnsafeOwnershipError(directory)
}
