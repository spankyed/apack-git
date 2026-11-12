// What the engine's work costs on a repository of each size: opening it, a whole status, a status of one path the
// watcher named, and a checkpoint of the whole tree. Prints a reading per size with the machine's conditions beside
// it, and fails on none of them: a reading informs the budgets the README states, and is never compared with one.
//
//   npm run build && npm run budgets -- 1000 100000      (the sizes CI reads)
//   npm run budgets -- 1000000                           (by hand: it writes a million files)
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { GitRepository } from '../dist/index.js'

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
  const repo = new GitRepository(root, { checkpointDirectory: () => path.join(store, 'store') })
  try {
    let at = performance.now()
    await repo.readSnapshot()
    const open = ms(at)
    fs.writeFileSync(path.join(root, 'd0', 'f0.txt'), 'changed\n')
    at = performance.now()
    await repo.refreshSnapshot('everything')
    const whole = ms(at)
    // A watched repository reads only what its watcher named, which is the read a file event makes
    repo.setWatched(true)
    fs.writeFileSync(path.join(root, 'd0', 'f1.txt'), 'changed\n')
    repo.noteChanged([path.join(root, 'd0', 'f1.txt')])
    at = performance.now()
    await repo.refreshSnapshot('noted')
    const noted = ms(at)
    at = performance.now()
    await repo.checkpoint()
    const checkpoint = ms(at)
    console.log(`${size.toLocaleString('en')} files: open ${open} ms, whole status ${whole} ms, one noted path ${noted} ms, checkpoint ${checkpoint} ms (generated in ${generated} ms)`)
  } finally {
    await repo.close()
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(store, { recursive: true, force: true })
  }
}
