// Rewriting the last commits: amending the last one, and squashing, reordering, rewording or dropping those after a
// base, by a rebase whose list the engine writes rather than an editor the user fills in. Each takes a checkpoint
// first and is written in the journal, so `undo` takes it back. A range that reaches commits already on a remote
// branch is refused with `published` unless whoever asked says to go on: rewriting it here leaves them there.
import * as os from 'node:os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { commitArgument, refArgument } from './arguments.ts'
import { GitError } from './errors.ts'
import { failure, type GitRunner } from './runner.ts'
import type { RewriteStep } from './types.ts'

/** A file of the engine's own for what it hands git, removed with the rest once the command has run */
async function scratch(): Promise<{ directory: string; file: (name: string, content: string) => Promise<string>; done: () => Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'apack-git-rewrite-'))
  return {
    directory,
    file: async (name, content) => {
      const file = path.join(directory, name)
      await fs.writeFile(file, content)
      return file
    },
    done: () => fs.rm(directory, { recursive: true, force: true }),
  }
}

/** A path as a command line run by git's shell reads it, on every platform */
const quoted = (file: string) => `"${file.replaceAll('\\', '/')}"`

/** The commits from `base` to `HEAD` that a remote branch already holds */
export async function publishedIn(runner: GitRunner, base: string): Promise<string[]> {
  // What no remote branch holds, against everything in the range: the rest is on one
  const listed = await runner.executeGitCommand(['rev-list', `${base}..HEAD`, '--not', '--remotes'])
  const all = await runner.executeGitCommand(['rev-list', `${base}..HEAD`])
  if (!listed.success || !all.success) return []
  const local = new Set((listed.output ?? '').split('\n').filter(Boolean))
  return (all.output ?? '').split('\n').filter(commit => commit && !local.has(commit))
}

/**
 * The todo a rebase is handed, from the steps in the order they are to stand: each a `pick`, a `fixup` into the one
 * before, or left out to drop it, and an `exec` that sets a message from a file where one is given
 */
export async function todoOf(steps: RewriteStep[], file: (name: string, content: string) => Promise<string>): Promise<string> {
  const lines: string[] = []
  for (const [at, step] of steps.entries()) {
    const commit = commitArgument(step.commit)
    if (step.action === 'drop') continue
    if (step.action === 'squash' && at === 0) throw new Error('The first commit of a range has nothing before it to be folded into')
    lines.push(`${step.action === 'squash' ? 'fixup' : 'pick'} ${commit}`)
    if (step.message !== undefined) {
      if (!step.message.trim()) throw new Error('A commit message cannot be empty')
      const message = await file(`message-${at}`, step.message)
      lines.push(`exec git commit --amend --quiet --no-verify --allow-empty -F ${quoted(message)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** Runs `git rebase -i` over `base` with `todo` handed to it as its list, in place of an editor */
export async function rebaseWithTodo(runner: GitRunner, base: string, steps: RewriteStep[]): Promise<void> {
  const files = await scratch()
  try {
    const todo = await files.file('todo', await todoOf(steps, files.file))
    // Git hands its sequence editor the list to fill in; this one copies the engine's over it
    const editor = await files.file('editor.cjs', `require('fs').copyFileSync(${JSON.stringify(todo)}, process.argv[2])\n`)
    const result = await runner.executeGitCommand(['rebase', '--interactive', '--keep-empty', refArgument(base, 'commit')], {
      env: { GIT_SEQUENCE_EDITOR: `${quoted(process.execPath)} ${quoted(editor)}` },
    })
    if (!result.success) throw failure(result, 'Failed to rewrite the commits')
  } finally {
    await files.done()
  }
}

/** Refuses a range a remote branch already holds part of, unless told to go on */
export async function refusePublished(runner: GitRunner, base: string, evenIfPublished: boolean): Promise<void> {
  if (evenIfPublished) return
  const published = await publishedIn(runner, base)
  if (published.length > 0) {
    throw new GitError(`${published.length === 1 ? 'One of these commits is' : `${published.length} of these commits are`} already on a remote branch. Rewriting them here leaves them there.`, 'published')
  }
}
