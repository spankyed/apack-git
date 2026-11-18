// What the engine's work costs on a repository of each size: opening it, a whole status, a status of one path the
// watcher named, a checkpoint of the whole tree, and the three sides of a conflicted file. Prints a reading per size
// with the machine's conditions beside it, and fails on none of them: a reading informs the budgets the README
// states, and is never compared with one. Beside each reading is how many git processes the engine started for it,
// counted at the `run` tie, which every command passes through: the one git kept open for reading files is not
// started there, and is not counted.
//
//   npm run build && npm run budgets -- 1000 100000      (the sizes CI reads)
//   npm run budgets -- 1000000                           (by hand: it writes a million files)
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { GitRepository, runUnbounded } from '../dist/index.js'

const sizes = process.argv.slice(2).map(Number).filter(size => size > 0)
if (sizes.length === 0) {
  console.error('Which sizes? npm run budgets -- 1000 100000')
  process.exit(2)
}

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
const ms = (since) => Math.round(performance.now() - since)

/**
 * A repository of `size` files, a hundred to a folder, committed and checked out. Git writes them: a commit is
 * streamed to `git fast-import` and checked out, which at a million files is minutes where writing each file from
 * here and adding them is hours
 */
function generate(size) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-budget-${size}-`)))
  git(root, 'init', '--quiet', '--initial-branch=main')
  const stream = path.join(root, '.git', 'import')
  const out = fs.openSync(stream, 'w')
  fs.writeSync(out, 'commit refs/heads/main\ncommitter budget <budget@example.com> 0 +0000\ndata 5\nfiles\n')
  for (let file = 0; file < size; file++) {
    const content = `file ${file}\n`
    fs.writeSync(out, `M 100644 inline d${Math.floor(file / 100)}/f${file % 100}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`)
  }
  fs.closeSync(out)
  execFileSync('git', ['-C', root, 'fast-import', '--quiet'], { stdio: [fs.openSync(stream, 'r'), 'ignore', 'pipe'] })
  fs.rmSync(stream)
  git(root, 'checkout', '--quiet', '--force', 'main')
  return root
}

console.log(`machine: ${os.platform()} ${os.arch()}, ${os.cpus().length} cores (${os.cpus()[0]?.model ?? 'unknown'}), load ${os.loadavg().map(load => load.toFixed(2)).join(' ')}, ${Math.round(os.totalmem() / 2 ** 30)} GiB`)
console.log(`git: ${git(os.tmpdir(), '--version').trim()}, node ${process.version}`)

for (const size of sizes) {
  const made = performance.now()
  const root = generate(size)
  const generated = ms(made)
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'apack-budget-store-'))
  let started = 0
  const run = (file, args, options) => { started++; return runUnbounded(file, args, options) }
  const repo = new GitRepository(root, { checkpointDirectory: () => path.join(store, 'store'), run })
  /** How long `work` took and how many gits it started, as a reading prints them */
  const reading = async (work) => {
    started = 0
    const at = performance.now()
    await work()
    return `${ms(at)} ms (${started} gits)`
  }
  try {
    const open = await reading(() => repo.readSnapshot())
    fs.writeFileSync(path.join(root, 'd0', 'f0.txt'), 'changed\n')
    const whole = await reading(() => repo.refreshSnapshot('everything'))
    // A watched repository reads only what its watcher named, which is the read a file event makes
    repo.setWatched(true)
    fs.writeFileSync(path.join(root, 'd0', 'f1.txt'), 'changed\n')
    repo.noteChanged([path.join(root, 'd0', 'f1.txt')])
    const noted = await reading(() => repo.refreshSnapshot('noted'))
    const checkpoint = await reading(() => repo.checkpoint())
    // A merge that stops on `d0/f0.txt`, changed one way on a branch and another on `main`. Each is told who it is
    // by: a runner has no identity of its own, and a merge refuses before it starts without one
    const as = ['-c', 'user.name=budget', '-c', 'user.email=budget@example.com']
    const commit = (...args) => git(root, ...as, 'commit', '--quiet', ...args)
    commit('-am', 'changed')
    git(root, 'checkout', '--quiet', '-b', 'side')
    fs.writeFileSync(path.join(root, 'd0', 'f0.txt'), 'side\n')
    commit('-am', 'side')
    git(root, 'checkout', '--quiet', 'main')
    fs.writeFileSync(path.join(root, 'd0', 'f0.txt'), 'main\n')
    commit('-am', 'main')
    try { git(root, ...as, 'merge', '--quiet', 'side') } catch { /* it stops on the conflict, which is what is read */ }
    const sides = await reading(() => repo.conflictSides('d0/f0.txt'))
    console.log(`${size.toLocaleString('en')} files: open ${open}, whole status ${whole}, one noted path ${noted}, checkpoint ${checkpoint}, conflict sides ${sides} (generated in ${generated} ms)`)
  } finally {
    await repo.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(store, { recursive: true, force: true })
  }
}
