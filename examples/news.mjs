// Prints the news of a git working tree as it happens: what the repository is now, then, for every hint the
// watcher gives, which parts of it git says really changed. It is a host in thirty lines — a repository, a watcher
// handing it hints, and nothing shown that git did not confirm — and the diagnostic for a watch as well: an edit
// that prints no hint is one the watch did not deliver, and once checks keep finding such changes the snapshot
// says the watch is silent.
//
//   npm run build && node examples/news.mjs [folder]   (the folder the process is in when none is given; Ctrl-C stops it)
//
// It runs the built package, as a host does, so it is plain JavaScript over `dist/`.
import { GitRepository, GitWatcherService, REPOSITORY_PARTS, changedAnything } from '../dist/index.js'

const folder = process.argv[2] ?? process.cwd()
const repo = new GitRepository(folder)
const watcher = new GitWatcherService(folder)
watcher.setGitRepository(repo)

const at = () => new Date().toISOString().slice(11, 23)
/** @param {import('../dist/index.js').RepositorySnapshot} snapshot */
const describe = (snapshot) => [
  `on ${snapshot.branch || '(no branch)'}`,
  ...(snapshot.hasUpstream ? [`${snapshot.ahead} ahead, ${snapshot.behind} behind`] : ['no upstream']),
  `${snapshot.files.length} changed file${snapshot.files.length === 1 ? '' : 's'}`,
  ...(snapshot.operation ? [`a ${snapshot.operation.kind} of ${snapshot.operation.subject} in progress`] : []),
  ...(snapshot.slowStatus ? [`a slow status: ${snapshot.slowStatus.ms} ms against ${snapshot.slowStatus.budgetMs} ms`] : []),
  ...(snapshot.watchSilent ? ['the watch is not delivering'] : []),
].join(', ')

console.log(`${at()} ${folder}: ${describe(await repo.readSnapshot())}`)

watcher.setChangeCallback((paths) => {
  repo.noteChanged(paths)
  void repo.refreshSnapshot('noted').then(async (change) => {
    const hinted = paths === null ? 'anything' : paths.join(', ')
    if (!changedAnything(change)) return console.log(`${at()} a hint (${hinted}): git says nothing changed`)
    const parts = REPOSITORY_PARTS.filter(part => change[part]).join(', ')
    console.log(`${at()} news (${hinted}): ${parts}${change.files ? ` — ${change.files.join(', ')}` : ''}`)
    console.log(`${at()}   now ${describe(await repo.readSnapshot())}`)
  }, (error) => console.error(`${at()} reading it failed:`, error))
})

// The watches do not hold the process open, so a host's own life is what does; here, a timer until Ctrl-C
const alive = setInterval(() => {}, 1 << 30)
const stop = new AbortController()
process.once('SIGINT', () => {
  stop.abort()
  clearInterval(alive)
  void watcher.stopWatching().then(() => repo.close())
})
await watcher.startWatching(stop.signal)
console.log(`${at()} watching; Ctrl-C to stop`)
