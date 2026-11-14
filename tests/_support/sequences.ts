// Sequences of the things a person, a build or git does to a checkout, made from a seed, and the run that holds a
// watched repository to a whole status after each one.
//
// What a platform's watch would report of a step is worked out here, from the tree and git's own files as they
// were before the step and as they are after it, and handed to the engine's watcher through the subscription it
// opened. So the paths the repository is told are the ones the watcher itself names, and nothing waits on the
// platform's watch to deliver. Whether it delivers is the platform's to answer, and the longer command asks it.
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  GitRepository, GitWatcherService,
  type RepositorySnapshot, type SubscribeToDirectory, type WatchedChange,
} from '../../src/index.ts'
import { run } from './process.ts'
import { removeDirectory } from './remove.ts'
import { seeded } from './rig.ts'

export const STEP_KINDS = [
  'write', 'edit', 'delete', 'rename', 'rename-case', 'make-folder',
  'add', 'add-all', 'reset', 'commit', 'branch', 'switch', 'stash', 'unstash', 'ignore', 'nested-repository',
] as const
export type StepKind = (typeof STEP_KINDS)[number]

/** One step: what it does, and a number that picks what it does it to among what is there when it runs */
export interface Step { kind: StepKind; pick: number }

/** The steps a seed makes: data, so a run can be repeated with some taken out */
export function stepsOf(seed: number, count: number): Step[] {
  const random = seeded(seed)
  return Array.from({ length: count }, () => ({ kind: random.pick(STEP_KINDS), pick: random.below(1_000_000) }))
}

const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])

/** Every file and folder under `root` but git's own directories, relative to it, with what each holds */
function treeOf(root: string): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const child = relative === '' ? entry.name : path.join(relative, entry.name)
      if (entry.isDirectory()) {
        found.set(child, 'folder')
        walk(child)
      } else {
        found.set(child, crypto.createHash('sha1').update(fs.readFileSync(path.join(root, child))).digest('hex'))
      }
    }
  }
  walk('')
  return found
}

/** Git's own files that say something about status, with what each holds, relative to its directory */
function gitFilesOf(gitDir: string): Map<string, string> {
  const found = new Map<string, string>()
  const read = (relative: string) => {
    const file = path.join(gitDir, relative)
    if (!fs.existsSync(file)) return
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file)) read(path.join(relative, name))
      return
    }
    found.set(relative, crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'))
  }
  for (const name of ['index', 'HEAD', 'ORIG_HEAD', 'refs', 'packed-refs']) read(name)
  return found
}

/** What differs between two listings: what was made, changed or removed */
function differing(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>()
  for (const [name, held] of after) if (before.get(name) !== held) changed.add(name)
  for (const name of before.keys()) if (!after.has(name)) changed.add(name)
  return [...changed].sort()
}

/** The files the steps work among: every file in the tree, in a fixed order */
const filesOf = (root: string) => [...treeOf(root)].filter(([, held]) => held !== 'folder').map(([name]) => name).sort()
const folderOf = (root: string, pick: number) => {
  const folders = ['', ...[...treeOf(root)].filter(([, held]) => held === 'folder').map(([name]) => name).sort()]
  return folders[pick % folders.length]!
}

/** Does one step, choosing among what is there; a step with nothing to act on does nothing */
async function take(root: string, { kind, pick }: Step, index: number): Promise<void> {
  const files = filesOf(root)
  const one = files.length > 0 ? files[pick % files.length]! : undefined
  const at = (name: string) => path.join(root, name)
  switch (kind) {
    case 'write': fs.writeFileSync(at(path.join(folderOf(root, pick), `made-${index}.txt`)), `${index}\n`); return
    case 'edit': if (one) fs.appendFileSync(at(one), `${index}\n`); return
    case 'delete': if (one) fs.rmSync(at(one)); return
    case 'rename': if (one) fs.renameSync(at(one), at(path.join(path.dirname(one), `renamed-${index}-${path.basename(one)}`))); return
    // A rename that changes only case, which a file system that ignores case keeps as one file
    case 'rename-case': if (one) fs.renameSync(at(one), at(path.join(path.dirname(one), path.basename(one).toUpperCase() === path.basename(one) ? path.basename(one).toLowerCase() : path.basename(one).toUpperCase()))); return
    case 'make-folder': {
      const folder = at(path.join(folderOf(root, pick), `folder-${index}`, 'inner'))
      fs.mkdirSync(folder, { recursive: true })
      fs.writeFileSync(path.join(folder, 'leaf.txt'), `${index}\n`)
      return
    }
    case 'add': if (one) await git(root, 'add', '--', one).catch(() => {}); return
    // Refused by git when the tree holds a repository with no commit yet; what git did before it stopped stays
    case 'add-all': await git(root, 'add', '--all').catch(() => {}); return
    case 'reset': await git(root, 'reset', '--quiet').catch(() => {}); return
    case 'commit': await git(root, 'commit', '--quiet', '--allow-empty', '-m', `step ${index}`).catch(() => {}); return
    case 'branch': await git(root, 'checkout', '--quiet', '-b', `branch-${index}`).catch(() => {}); return
    case 'switch': {
      const branches = (await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')).stdout.trim().split('\n').filter(Boolean).sort()
      // A switch that would overwrite work is refused by git, and so leaves the checkout as it was
      if (branches.length > 0) await git(root, 'checkout', '--quiet', branches[pick % branches.length]!).catch(() => {})
      return
    }
    case 'stash': await git(root, 'stash', 'push', '--quiet', '--include-untracked').catch(() => {}); return
    case 'unstash': await git(root, 'stash', 'pop', '--quiet').catch(() => {}); return
    // An ignore file edited: a pattern that hides some of what is there, or none of it
    case 'ignore': fs.appendFileSync(at('.gitignore'), pick % 2 === 0 && one ? `${path.basename(one).replaceAll('\\', '/')}\n` : `*.nothing-${index}\n`); return
    case 'nested-repository': {
      const nested = at(path.join(folderOf(root, pick), `nested-${index}`))
      fs.mkdirSync(nested, { recursive: true })
      await run('git', ['-C', nested, 'init', '--quiet', '--initial-branch=main'])
      fs.writeFileSync(path.join(nested, 'inside.txt'), `${index}\n`)
      return
    }
  }
}

/** A watch opened by the watcher, which the run hands what a platform would report */
interface Opened { directory: string; ignore: string[]; onChanges: (error: Error | null, changes: WatchedChange[]) => void }

/**
 * Runs `steps` over a fresh checkout, a step at a time. After each, the watcher is handed what changed, the
 * repository reads what the watcher said, and a repository that has read nothing reads everything. Answers the
 * first step after which the two differ, with both, or nothing when they never do.
 */
export async function runSequence(
  steps: readonly Step[],
  /**
   * `handed`: what a platform would report is worked out and handed to the watcher, so nothing waits on the
   * platform. `platform`: the platform's own watch reports what it sees, and each step waits up to `settleMs` for
   * the watcher to report. That is the longer command's (`npm run soak:sequences`), which reports and gates nothing
   */
  { watch = 'handed', settleMs = 2_000 }: { watch?: 'handed' | 'platform'; settleMs?: number } = {},
): Promise<{ step: number; held: RepositorySnapshot; truth: RepositorySnapshot } | undefined> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-sequence-')))
  const opened: Opened[] = []
  const subscribe: SubscribeToDirectory = async (directory, onChanges, { ignore }) => {
    const watch = { directory, ignore, onChanges }
    opened.push(watch)
    return {
      unsubscribe: async () => { opened.splice(opened.indexOf(watch), 1) },
      check: async (options) => { watch.ignore = options.ignore },
    }
  }
  // The files of git's it follows one by one, handed the same way: a change to one is reported at once
  const followed = new Map<string, () => void>()
  const followFile = (file: string, onChange: () => void) => {
    followed.set(fs.realpathSync.native(path.dirname(file)) + path.sep + path.basename(file), onChange)
    return { close() { followed.delete(file) }, look() {} }
  }
  const watcher = watch === 'handed' ? new GitWatcherService(root, { subscribe, followFile }) : new GitWatcherService(root)
  try {
    await git(root, 'init', '--quiet', '--initial-branch=main')
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
    for (const [file, held] of [['a.txt', 'a\n'], ['src/b.txt', 'b\n'], ['src/deep/c.txt', 'c\n'], ['.gitignore', '*.log\n']]) fs.writeFileSync(path.join(root, file!), held!)
    await git(root, 'add', '.')
    await git(root, 'commit', '--quiet', '-m', 'first')

    // Never slow: whether a status was is how long git took, which load moves, and a sequence compares what git says
    const repo = new GitRepository(root, { statusBudgetMs: Number.POSITIVE_INFINITY })
    const reports: (string[] | null)[] = []
    let reported: (() => void) | undefined
    watcher.setGitRepository(repo)
    watcher.setChangeCallback((paths) => {
      reports.push(paths)
      reported?.()
    })
    await watcher.startWatching(new AbortController().signal)
    await repo.refreshSnapshot()
    const gitDir = path.join(root, '.git')

    for (const [index, step] of steps.entries()) {
      const [treeBefore, gitBefore] = [treeOf(root), gitFilesOf(gitDir)]
      await take(root, step, index)
      const tree = differing(treeBefore, treeOf(root))
      const own = differing(gitBefore, gitFilesOf(gitDir))
      // The watches are taken as the watcher holds them now: it opens and closes them as the checkout moves
      await watcher.check()
      if (watch === 'platform') {
        const report = reports.length
        const arrived = new Promise<void>((resolve) => { reported = resolve })
        if (tree.length + own.length > 0 && reports.length === report) {
          await Promise.race([arrived, new Promise<void>((resolve) => { setTimeout(resolve, settleMs) })])
        }
        for (const paths of reports.splice(report)) repo.noteChanged(paths)
        await repo.refreshSnapshot('noted')
        const [held, truth] = [await repo.readSnapshot(), await new GitRepository(root, { statusBudgetMs: Number.POSITIVE_INFINITY }).readSnapshot()]
        if (JSON.stringify(held) !== JSON.stringify(truth)) {
          await repo.close()
          return { step: index, held, truth }
        }
        continue
      }
      const ignoredBy = (watch: Opened) => (name: string) => watch.ignore.some(ignored => name === ignored || name.startsWith(`${ignored}${path.sep}`))
      const report = reports.length
      const arrived = new Promise<void>((resolve) => { reported = resolve })
      let delivered = 0
      for (const watch of opened) {
        const relevant = watch.directory === root ? tree : watch.directory === fs.realpathSync.native(gitDir) ? own : []
        const changes = relevant.filter(name => !ignoredBy(watch)(name))
        if (changes.length === 0) continue
        watch.onChanges(null, changes)
        delivered += changes.length
      }
      for (const name of own) {
        const onChange = followed.get(path.join(fs.realpathSync.native(gitDir), name))
        if (onChange) { onChange(); delivered++ }
      }
      // What reached a watch is reported by the watcher once its quiet time has passed, and every change handed
      // to it here is one it counts. A step that changed nothing a watch sees reports nothing, and waits for nothing
      if (delivered > 0 && reports.length === report) await arrived
      for (const paths of reports.splice(report)) repo.noteChanged(paths)
      await repo.refreshSnapshot('noted')
      const [held, truth] = [await repo.readSnapshot(), await new GitRepository(root, { statusBudgetMs: Number.POSITIVE_INFINITY }).readSnapshot()]
      if (JSON.stringify(held) !== JSON.stringify(truth)) {
        await repo.close()
        return { step: index, held, truth }
      }
    }
    await repo.close()
    return undefined
  } finally {
    await watcher.stopWatching()
    await removeDirectory(root)
  }
}

/**
 * The fewest of `steps` that still end on a difference: each step is left out in turn, and kept out when the
 * difference still shows without it. What a failure prints, so it can be read rather than replayed.
 */
export async function shortestFailing(steps: readonly Step[]): Promise<Step[]> {
  let kept = [...steps]
  for (let index = kept.length - 2; index >= 0; index--) {
    const without = [...kept.slice(0, index), ...kept.slice(index + 1)]
    const failed = await runSequence(without)
    if (failed && failed.step === without.length - 1) kept = without
  }
  return kept
}
