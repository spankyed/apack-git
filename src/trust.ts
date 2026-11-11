// What a repository would have git run, and the gate that keeps git from running any of it before the
// repository is trusted.
//
// A repository's own configuration can name programs: a file monitor that a plain status runs, a conversion or
// an external diff that a diff runs, a credential helper, a filter, a hook. Opening a folder is enough to run
// one. So until a host says a repository is trusted, the engine first reads what the repository itself says
// should run, without running it, and when that names anything it runs no git there but that reading.
//
// **The rule is a list of settings known to run nothing, and every other setting asks.** The other way round, a
// list of the settings that run programs, asks less often and makes a hole of every setting it forgets.
import * as path from 'path'
import * as fs from 'fs/promises'
import { GitError } from './errors.ts'

/** One thing a repository would have git run, or a setting not known to run nothing */
export type TrustAsk =
  /** A setting in the repository's own configuration, or in a file that includes */
  | { kind: 'setting'; key: string; value: string; file: string }
  /** A hook the repository holds, which git runs at the moment the hook is named for */
  | { kind: 'hook'; name: string; file: string }

/** The key an ask is given when a repository's configuration could not be read, with what git said of it as its value */
export const UNREADABLE = '(its configuration could not be read)'

/** What a repository asks to be trusted for, and whether a host has said it is */
export interface TrustReading {
  trusted: boolean
  /** What it would have git run. With none, nothing is refused whether it is trusted or not */
  asks: TrustAsk[]
  /** What names the repository to a host that remembers trust: where its git state lives, by its real path */
  repository?: string
}

/** A git command refused because the repository would have git run something and has not been trusted */
export class UntrustedError extends GitError {
  constructor(readonly asks: TrustAsk[], readonly repository: string | undefined) {
    super('This repository has settings or hooks that make git run programs, and it has not been trusted. Nothing was run.', 'untrusted')
    this.name = 'UntrustedError'
  }
}

const set = (...names: string[]) => new Set(names)
const ANY = Symbol('any variable')

/**
 * The settings known to run nothing, by section: the variables allowed directly under it (`pull.rebase`) and
 * under a subsection of it (`branch.<name>.remote`). `ANY` is a section none of whose variables names a program.
 * What `git init` and `git clone` write, identity, the bookkeeping of branches, remotes and submodules, and how
 * git's own commands format, compare and store.
 */
const RUNS_NOTHING: Record<string, { plain?: Set<string> | typeof ANY; sub?: Set<string> | typeof ANY }> = {
  core: { plain: set(
    'repositoryformatversion', 'filemode', 'bare', 'logallrefupdates', 'ignorecase', 'precomposeunicode', 'symlinks', 'autocrlf', 'eol',
    'safecrlf', 'quotepath', 'abbrev', 'compression', 'loosecompression', 'bigfilethreshold', 'preloadindex', 'untrackedcache', 'splitindex',
    'sparsecheckout', 'sparsecheckoutcone', 'commitgraph', 'multipackindex', 'longpaths', 'protecthfs', 'protectntfs', 'trustctime', 'checkstat',
    'fscache', 'fsync', 'fsyncmethod', 'worktree', 'sharedrepository', 'whitespace', 'commentchar', 'commentstring', 'filesrefslocktimeout',
    'packedrefstimeout', 'deltabasecachelimit', 'packedgitlimit', 'packedgitwindowsize', 'hidedotfiles', 'ignorestat', 'warnambiguousrefs',
    'notesref', 'excludesfile', 'attributesfile',
  ) },
  user: { plain: set('name', 'email', 'signingkey', 'usehttppath') },
  author: { plain: set('name', 'email') },
  committer: { plain: set('name', 'email') },
  init: { plain: set('defaultbranch') },
  remote: { plain: set('pushdefault'), sub: set(
    'url', 'pushurl', 'fetch', 'push', 'mirror', 'tagopt', 'prune', 'prunetags', 'promisor', 'partialclonefilter', 'skipdefaultupdate',
    'skipfetchall', 'followremotehead',
  ) },
  branch: { plain: set('autosetupmerge', 'autosetuprebase', 'sort'), sub: set('remote', 'merge', 'rebase', 'description', 'pushremote', 'mergeoptions', 'apack-base', 'vscode-merge-base', 'github-pr-owner-number') },
  submodule: { plain: set('active', 'recurse', 'fetchjobs', 'alternatelocation', 'alternateerrorstrategy', 'propagatebranches'), sub: set('url', 'active', 'path', 'branch', 'ignore', 'fetchrecursesubmodules') },
  pull: { plain: set('rebase', 'ff', 'octopus') },
  push: { plain: set('default', 'autosetupremote', 'followtags', 'recursesubmodules', 'gpgsign', 'useforceifincludes', 'negotiate') },
  fetch: { plain: set('prune', 'prunetags', 'recursesubmodules', 'parallel', 'output', 'negotiationalgorithm', 'showforcedupdates', 'writecommitgraph', 'unpacklimit', 'fsckobjects') },
  merge: { plain: set('ff', 'conflictstyle', 'log', 'renames', 'renamelimit', 'stat', 'autostash', 'verbosity', 'defaulttoupstream', 'suppressdest', 'directoryrenames') },
  rebase: { plain: set('autostash', 'autosquash', 'updaterefs', 'stat', 'abbreviatecommands', 'missingcommitscheck', 'reschedulefailedexec', 'forkpoint', 'backend') },
  diff: { plain: set(
    'renames', 'renamelimit', 'algorithm', 'context', 'interhunkcontext', 'mnemonicprefix', 'noprefix', 'colormoved', 'colormovedws',
    'statgraphwidth', 'submodule', 'wserrorhighlight', 'indentheuristic', 'ignoresubmodules', 'relative', 'orderfile', 'suppressblankempty',
    'autorefreshindex', 'dirstat',
  ) },
  commit: { plain: set('gpgsign', 'cleanup', 'status', 'verbose', 'template') },
  tag: { plain: set('sort', 'gpgsign', 'forcesignannotated') },
  blame: { plain: set('ignorerevsfile', 'coloring', 'date', 'showemail', 'showroot', 'markunblamablelines', 'markignoredlines') },
  http: {
    plain: set('sslverify', 'postbuffer', 'version', 'lowspeedlimit', 'lowspeedtime', 'followredirects', 'useragent', 'maxrequests', 'minsessions', 'sslbackend', 'schannelcheckrevoke', 'emptyauth', 'proxy', 'extraheader', 'cookiefile', 'savecookies', 'sslcainfo', 'sslcert', 'sslkey', 'sslcertpasswordprotected'),
    sub: set('sslverify', 'proxy', 'extraheader', 'cookiefile', 'sslcainfo', 'sslcert', 'sslkey', 'emptyauth', 'followredirects'),
  },
  credential: { plain: set('usehttppath', 'username'), sub: set('usehttppath', 'username') },
  lfs: { plain: set('repositoryformatversion', 'url', 'pushurl', 'fetchinclude', 'fetchexclude', 'locksverify'), sub: set('locksverify', 'access') },
  url: { sub: set('insteadof', 'pushinsteadof') },
  include: { plain: set('path') },
  includeif: { sub: set('path') },
  // Run only when the user types one, and the engine runs none
  alias: { plain: ANY },
  status: { plain: ANY }, color: { plain: ANY, sub: ANY }, advice: { plain: ANY }, column: { plain: ANY }, log: { plain: ANY },
  gc: { plain: ANY, sub: ANY }, pack: { plain: ANY }, index: { plain: ANY }, feature: { plain: ANY }, extensions: { plain: ANY },
  repack: { plain: ANY }, maintenance: { plain: ANY, sub: ANY }, versionsort: { plain: ANY }, i18n: { plain: ANY }, notes: { plain: ANY },
  rerere: { plain: ANY }, help: { plain: ANY }, apply: { plain: ANY }, am: { plain: ANY }, format: { plain: ANY }, grep: { plain: ANY },
  stash: { plain: ANY }, checkout: { plain: ANY }, clone: { plain: ANY }, worktree: { plain: ANY }, safe: { plain: ANY },
}

/**
 * Whether a setting is known to run nothing. A key is `section.variable` or `section.subsection.variable`, the
 * section and the variable in lower case as git prints them, the subsection as it is spelled and with any dots.
 */
export function settingRunsNothing(key: string, value: string): boolean {
  const first = key.indexOf('.')
  const last = key.lastIndexOf('.')
  if (first < 1) return false
  const section = key.slice(0, first)
  const variable = key.slice(last + 1)
  const subsection = first === last ? undefined : key.slice(first + 1, last)
  // An empty helper is how a repository says to ask none: it clears the list, and runs nothing
  if (section === 'credential' && variable === 'helper') return value === ''
  // Named as a program, git runs it at every status; said to be off, it runs nothing
  if (key === 'core.fsmonitor') return /^(false|no|off|0)$/i.test(value)
  // How a submodule is updated is a strategy by name, or a command when it starts with `!`
  if (section === 'submodule' && subsection !== undefined && variable === 'update') return /^(checkout|rebase|merge|none)$/.test(value)
  const allowed = RUNS_NOTHING[section]?.[subsection === undefined ? 'plain' : 'sub']
  return allowed === ANY || (allowed?.has(variable) ?? false)
}

/** `scope`, `origin`, `key` and `value` of each setting `git config --list --show-scope --show-origin -z` printed */
function settingsOf(output: string): { scope: string; origin: string; key: string; value: string }[] {
  const fields = output.split('\0')
  const settings = []
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const [scope, origin, entry] = [fields[at]!, fields[at + 1]!, fields[at + 2]!]
    // A key ends at the line break, and a setting with no value has none
    const end = entry.indexOf('\n')
    settings.push({ scope, origin, key: end === -1 ? entry : entry.slice(0, end), value: end === -1 ? '' : entry.slice(end + 1) })
  }
  return settings
}

/** Runs one git that reads and runs nothing: `rev-parse` for where the repository is, `config --list` for what it says */
export type ReadGit = (args: string[]) => Promise<{ success: boolean; output?: string; error?: string }>

export class TrustGate {
  /**
   * The last reading, with the files it was read from and how they looked. It holds until one of them differs,
   * so a command pays for a handful of looks at files and no git
   */
  private held: { repository: string; hooks: string; files: string[]; signature: string; asks: TrustAsk[] } | undefined

  constructor(
    private readonly workingDirectory: string,
    private readonly readGit: ReadGit,
    /** Whether a host has said the repository at this path is trusted. Without one, none is */
    private readonly isTrusted: (repository: string) => boolean = () => false,
  ) {}

  /** How the files a reading depends on look, without reading them: a change to one is a reading to take again */
  private async signatureOf(files: string[], hooks: string): Promise<string> {
    const looks = await Promise.all(files.map(file => fs.stat(file).then(stats => `${file}:${stats.mtimeMs}:${stats.size}`, () => `${file}:gone`)))
    const listed = await fs.readdir(hooks, { withFileTypes: true }).then(
      entries => Promise.all(entries.filter(entry => !entry.name.endsWith('.sample')).map(async (entry) => {
        const stats = await fs.stat(path.join(hooks, entry.name)).catch(() => undefined)
        return `${entry.name}:${stats?.mode ?? 'gone'}:${stats?.mtimeMs ?? ''}`
      })),
      () => [],
    )
    return [...looks, ...listed.sort()].join('\n')
  }

  /** Reads the repository afresh: where it is, what its own configuration says, and the hooks it holds */
  private async take(): Promise<TrustGate['held']> {
    const where = await this.readGit(['rev-parse', '--git-dir', '--git-common-dir'])
    const [gitDir, commonDir] = (where.success ? where.output ?? '' : '').split('\n').map(line => line.trim())
    // No repository here: nothing to trust, and nothing a repository could have run
    if (!gitDir || !commonDir) return undefined
    const common = path.resolve(this.workingDirectory, commonDir)
    const repository = await fs.realpath(common).catch(() => common)
    const hooks = path.join(common, 'hooks')

    const listed = await this.readGit(['config', '--list', '--show-scope', '--show-origin', '--includes', '-z'])
    const own = settingsOf(listed.success ? listed.output ?? '' : '').filter(setting => setting.scope === 'local' || setting.scope === 'worktree')
    const fileOf = (origin: string) => path.resolve(this.workingDirectory, origin.replace(/^file:/, ''))
    const asks: TrustAsk[] = own
      .filter(setting => !settingRunsNothing(setting.key, setting.value))
      .map(setting => ({ kind: 'setting', key: setting.key, value: setting.value, file: fileOf(setting.origin) }))
    // What it says could not be read, so what it names is not known: it asks, rather than passing for a
    // repository that names nothing
    if (!listed.success) asks.push({ kind: 'setting', key: UNREADABLE, value: (listed.error ?? '').trim().split('\n')[0] ?? '', file: path.join(common, 'config') })
    // A hook is a file in the hooks directory under the name git runs it by: the samples git writes there are
    // not, and on a platform with no executable bit every other file is
    const entries = await fs.readdir(hooks, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.filter(found => !found.name.endsWith('.sample')).sort((a, b) => a.name.localeCompare(b.name))) {
      const stats = await fs.stat(path.join(hooks, entry.name)).catch(() => undefined)
      if (stats?.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0)) asks.push({ kind: 'hook', name: entry.name, file: path.join(hooks, entry.name) })
    }
    // The repository's own configuration, a worktree's, and every file either includes
    const files = [...new Set([path.join(common, 'config'), path.join(path.resolve(this.workingDirectory, gitDir), 'config.worktree'), ...own.map(setting => fileOf(setting.origin))])]
    return { repository, hooks, files, signature: await this.signatureOf(files, hooks), asks }
  }

  /** What the repository would have git run, read without running any of it */
  async read(): Promise<TrustReading> {
    if (!this.held || this.held.signature !== await this.signatureOf(this.held.files, this.held.hooks)) this.held = await this.take()
    const held = this.held
    if (!held) return { trusted: false, asks: [] }
    return { trusted: this.isTrusted(held.repository), asks: held.asks, repository: held.repository }
  }

  /** Lets a git command through, or refuses it when the repository would have git run something and is not trusted */
  async pass(): Promise<void> {
    const reading = await this.read()
    if (!reading.trusted && reading.asks.length > 0) throw new UntrustedError(reading.asks, reading.repository)
  }
}
