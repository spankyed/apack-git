// Whether the git a host handed in can be used, asked once of each repository before its first command: that
// there is a git at all, that on macOS it is not the placeholder that stands for the developer tools until they
// are installed, and that it is new enough for what the engine asks of it.
import { GitError } from './errors.ts'
import type { RunProcess } from './ties.ts'

/**
 * The oldest git the engine works with: the oldest the suite passes on in CI (`.github/workflows/ci.yml`, the `git`
 * jobs), which run it against the oldest git still-supported systems ship (Debian 12's and macOS's own, 2.39.5) and
 * against this floor, built. Ubuntu 22.04's 2.34.1 is below it: its `status --porcelain=v2 --show-stash` gives no
 * count of the stashes, which git 2.35 added, so a stash dropped below the newest goes unseen.
 */
export const GIT_FLOOR = '2.35.0'

/** Why a git cannot be used */
export type GitUnusable =
  | { code: 'git-not-found'; git: string }
  /** On macOS, `/usr/bin/git` before the developer tools are installed: running it offers to install them */
  | { code: 'developer-tools-missing'; git: string }
  | { code: 'git-too-old'; git: string; version: string }

/** A command not run because the git it would run cannot be used */
export class GitUnusableError extends GitError {
  constructor(readonly unusable: GitUnusable) {
    super(describe(unusable), unusable.code)
    this.name = 'GitUnusableError'
  }
}

function describe(unusable: GitUnusable): string {
  switch (unusable.code) {
    case 'git-not-found': return `There is no git at ${unusable.git}.`
    case 'developer-tools-missing': return 'Git on this Mac comes with the developer tools, which are not installed.'
    case 'git-too-old': return `Git ${unusable.version} is older than ${GIT_FLOOR}, the oldest git this works with.`
  }
}

/** The version `git --version` printed, whatever a build adds after it: `2.39.5 (Apple Git-154)`, `2.47.1.windows.1` */
export function gitVersionOf(printed: string): string | undefined {
  return /^git version (\d+\.\d+(?:\.\d+)?)/m.exec(printed)?.[1]
}

/** Whether version `a` is older than `b`, comparing the numbers each part holds */
export function olderThan(a: string, b: string): boolean {
  const [x, y] = [a, b].map(version => version.split('.').map(Number))
  for (let part = 0; part < 3; part++) {
    const difference = (x![part] ?? 0) - (y![part] ?? 0)
    if (difference !== 0) return difference < 0
  }
  return false
}

/** Why `git` cannot be used, or nothing when it can */
export async function checkGit(git: string, run: RunProcess, env: NodeJS.ProcessEnv): Promise<GitUnusable | undefined> {
  const options = { cwd: process.cwd(), env, maxBuffer: 1024 * 1024, encoding: 'utf8' as const }
  // The placeholder is the one git that does something when merely asked its version, so it is not asked first
  if (process.platform === 'darwin' && git === '/usr/bin/git') {
    const tools = await run('xcode-select', ['-p'], options).then(() => true, () => false)
    if (!tools) return { code: 'developer-tools-missing', git }
  }
  const printed = await run(git, ['--version'], options).then(
    ({ stdout }) => stdout,
    (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : ''),
  )
  if (printed === undefined) return { code: 'git-not-found', git }
  const version = gitVersionOf(printed)
  if (version === undefined || olderThan(version, GIT_FLOOR)) return { code: 'git-too-old', git, version: version ?? printed.trim() }
  return undefined
}
