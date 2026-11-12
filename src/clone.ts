// Making a repository: cloning one, or starting one. Neither has a repository to run in yet, so each runs git in the
// folder the new one goes in, and answers the repository it made. A clone is a repository the user asked for, and its
// settings are what git wrote, so it opens trusted by what it names: nothing.
import * as path from 'path'
import * as fs from 'fs/promises'
import { GitError } from './errors.ts'
import { GitRunner, failure } from './runner.ts'
import type { RepositoryTies } from './ties.ts'
import type { GitProgress } from './types.ts'

/** An address git reads as an address and not as an option */
function addressArgument(url: string): string {
  if (!url || url.startsWith('-')) throw new Error(`Invalid address: ${JSON.stringify(url)}`)
  return url
}

/**
 * Clones `url` into `directory`, which must not exist yet or be empty, with git's progress handed to `onProgress`.
 * Stopped through `signal`, or failed, it leaves no directory behind that it made.
 */
export async function cloneInto(url: string, directory: string, ties: RepositoryTies, { onProgress, signal }: { onProgress?: (progress: GitProgress) => void; signal?: AbortSignal } = {}): Promise<void> {
  const target = path.resolve(directory)
  const existed = await fs.stat(target).then(() => true, () => false)
  const parent = path.dirname(target)
  await fs.mkdir(parent, { recursive: true })
  const runner = new GitRunner(parent, ties)
  await runner.passUsableGit()
  const result = await runner.runGitOnce(['clone', '--progress', '--', addressArgument(url), target], false, undefined, onProgress, 'utf8', undefined, signal)
  if (result.success) return
  // Whatever git left of a clone it did not finish is not a repository anyone asked for
  if (!existed) await fs.rm(target, { recursive: true, force: true })
  else for (const entry of await fs.readdir(target).catch(() => [])) await fs.rm(path.join(target, entry), { recursive: true, force: true })
  throw result.code === 'aborted' ? new GitError('The clone was stopped', 'aborted') : failure(result, `Failed to clone ${url}`)
}

/** Starts a repository in `directory`, which is made when it does not exist */
export async function initIn(directory: string, ties: RepositoryTies, { initialBranch }: { initialBranch?: string } = {}): Promise<void> {
  const target = path.resolve(directory)
  await fs.mkdir(target, { recursive: true })
  const runner = new GitRunner(target, ties)
  await runner.passUsableGit()
  const result = await runner.runGitOnce(['init', '--quiet', ...(initialBranch ? [`--initial-branch=${initialBranch}`] : []), target])
  if (!result.success) throw failure(result, `Failed to start a repository in ${directory}`)
}

export { addressArgument }
