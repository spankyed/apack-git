// Every git a spec runs, the engine's included, runs with no configuration but the repository's own and an
// identity to commit as: a case then passes or fails the same on a developer's machine, whose global
// configuration says how to pull or which branch to start on, and on a runner, which has none and no identity.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const empty = path.join(os.tmpdir(), `apack-git-specs-${process.pid}.gitconfig`)
fs.writeFileSync(empty, '')
process.on('exit', () => { fs.rmSync(empty, { force: true }) })

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: empty,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'spec',
  GIT_AUTHOR_EMAIL: 'spec@example.com',
  GIT_COMMITTER_NAME: 'spec',
  GIT_COMMITTER_EMAIL: 'spec@example.com',
})
