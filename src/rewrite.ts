// Rewriting the last commits: amending the last one, and squashing, reordering, rewording or dropping those after a
// base, by a rebase whose list the engine writes rather than an editor the user fills in. Each takes a checkpoint
// first and is written in the journal, so `undo` takes it back. A range that reaches commits already on a remote
// branch is refused with `published` unless whoever asked says to go on: rewriting it here leaves them there.
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'path'
import * as fs from 'fs/promises'
import { commitArgument, refArgument } from './arguments.js'
import { GitError } from './errors.js'
import { failure, type GitRunner } from './runner.js'
import type { RewriteStep } from './types.js'

/** Subfolder inside a checkout's git directory where rewrite message files live while a rebase is in progress */
const REWRITE_MESSAGES_DIR = 'apack-rewrite-messages'

/** Removes any rewrite message files kept for a rebase that has finished or been given up */
export async function cleanupRewriteMessages(gitDir: string | undefined): Promise<void> {
  if (!gitDir) return
  await fs.rm(path.join(gitDir, REWRITE_MESSAGES_DIR), { recursive: true, force: true }).catch(() => {})
}

/** A path quoted for git's POSIX `/bin/sh` (`GIT_SEQUENCE_EDITOR` and rebase `exec`), safe against `$`, `` ` `` and `"` */
const shellQuoted = (file: string) => `'${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`

/** The commits from `base` to `HEAD` that a remote branch already holds */
export async function publishedIn(runner: GitRunner, base: string): Promise<string[]> {
  // What no remote branch holds, against everything in the range: the rest is on one
  const listed = await runner.read(['rev-list', `${base}..HEAD`, '--not', '--remotes'])
  const all = await runner.read(['rev-list', `${base}..HEAD`])
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
    if (step.action === 'squash' && lines.length === 0) throw new Error('The first kept commit of a range has nothing before it to be folded into')
    if (step.action === 'reword' && (step.message === undefined || !step.message.trim())) throw new Error('A commit message cannot be empty')
    lines.push(`${step.action === 'squash' ? 'fixup' : 'pick'} ${commit}`)
    if (step.message !== undefined) {
      if (!step.message.trim()) throw new Error('A commit message cannot be empty')
      const message = await file(`message-${at}`, step.message)
      lines.push(`exec git commit --amend --quiet --no-verify --allow-empty -F ${shellQuoted(message)}`)
    }
  }
  return lines.length === 0 ? 'noop\n' : `${lines.join('\n')}\n`
}

/**
 * Runs `git rebase -i` over `base` with `todo` handed to it as its list, in place of an editor.
 * Message files referenced by `exec` steps live inside `gitDir` so they survive if the rebase pauses on a conflict
 * and is resumed later by `moveOperation('continue')`.
 */
export async function rebaseWithTodo(runner: GitRunner, base: string, steps: RewriteStep[], gitDir: string | undefined): Promise<void> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apack-git-rewrite-'))
  const messagesDir = gitDir ? path.join(gitDir, REWRITE_MESSAGES_DIR, randomUUID()) : scratchDir
  let rebasePaused = false
  try {
    await fs.mkdir(messagesDir, { recursive: true })
    const writeMessage = async (name: string, content: string) => {
      const target = path.join(messagesDir, name)
      await fs.writeFile(target, content)
      return target
    }
    const todoText = await todoOf(steps, writeMessage)
    const todo = path.join(scratchDir, 'todo')
    await fs.writeFile(todo, todoText)
    // Git hands its sequence editor the list to fill in; this one copies the engine's over it
    const editor = path.join(scratchDir, 'editor.cjs')
    await fs.writeFile(editor, `require('fs').copyFileSync(${JSON.stringify(todo)}, process.argv[2])\n`)
    const result = await runner.write(['rebase', '--interactive', '--keep-empty', refArgument(base, 'commit')], {
      env: { GIT_SEQUENCE_EDITOR: `${shellQuoted(process.execPath)} ${shellQuoted(editor)}` },
    })
    if (!result.success) {
      rebasePaused = gitDir !== undefined && await fs.access(path.join(gitDir, 'rebase-merge', 'onto')).then(() => true, () => false)
      throw failure(result, 'Failed to rewrite the commits')
    }
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true })
    if (!rebasePaused && messagesDir !== scratchDir) {
      await fs.rm(messagesDir, { recursive: true, force: true }).catch(() => {})
      if (gitDir) await fs.rmdir(path.join(gitDir, REWRITE_MESSAGES_DIR)).catch(() => {})
    }
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

/** Refuses a single commit (root commit included) that a remote branch already holds, unless told to go on */
export async function refusePublishedCommit(runner: GitRunner, commit: string, evenIfPublished: boolean): Promise<void> {
  if (evenIfPublished) return
  const holding = await runner.read(['for-each-ref', '--format=%(refname:short)', '--contains', commit, 'refs/remotes/'])
  const publishedOn = (holding.output ?? '').split('\n').filter(Boolean)
  if (publishedOn.length > 0) {
    throw new GitError(`That commit is already on ${publishedOn.join(', ')}. Rewriting it here leaves it there.`, 'published')
  }
}
