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
import { relativeWithin } from './paths.ts'
import type { HeldSettings, ReadGit, SettingsReading } from './settings.ts'

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
    'fscache', 'fsync', 'fsyncmethod', 'sharedrepository', 'whitespace', 'commentchar', 'commentstring', 'filesrefslocktimeout',
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
  branch: { plain: set('autosetupmerge', 'autosetuprebase', 'sort'), sub: set('remote', 'merge', 'rebase', 'description', 'pushremote', 'apack-base', 'vscode-merge-base', 'github-pr-owner-number') },
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
    plain: set('postbuffer', 'version', 'lowspeedlimit', 'lowspeedtime', 'followredirects', 'useragent', 'maxrequests', 'minsessions', 'sslbackend', 'schannelcheckrevoke', 'emptyauth', 'savecookies', 'sslcertpasswordprotected'),
    sub: set('emptyauth', 'followredirects'),
  },
  credential: { plain: set('usehttppath', 'username'), sub: set('usehttppath', 'username') },
  lfs: { plain: set('repositoryformatversion', 'url', 'pushurl', 'fetchinclude', 'fetchexclude', 'locksverify'), sub: set('locksverify', 'access') },
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
  // Named as a program, git runs it at every status. Said to be off it runs nothing, and said to be on it is git's
  // own monitor, which is git: no program the repository names
  if (key === 'core.fsmonitor') return /^(false|no|off|0|true|yes|on|1)$/i.test(value)
  // How a submodule is updated is a strategy by name, or a command when it starts with `!`
  if (section === 'submodule' && subsection !== undefined && variable === 'update') return /^(checkout|rebase|merge|none)$/.test(value)
  const allowed = RUNS_NOTHING[section]?.[subsection === undefined ? 'plain' : 'sub']
  return allowed === ANY || (allowed?.has(variable) ?? false)
}

/** Where a repository's git state is, by the paths a host and a hook are named by */
interface Location {
  /** The common git directory as git named it, resolved, which holds the configuration and the hooks */
  common: string
  /** Its real path: what names the repository to a host that remembers trust */
  repository: string
  hooks: string
  /** The checkout root, when this repository has a working tree */
  top?: string
}

/** Bounds on walking submodule git directories so a pathological tree cannot stall trust checks */
const MAX_SUBMODULE_DEPTH = 10
const MAX_SUBMODULE_DIRS = 500

/** Parses `git config --file <path> --list --show-origin --includes -z` into `(origin, key, value)` entries */
function fileSettingsOf(output: string): { origin: string; key: string; value: string }[] {
  const fields = output.split('\0')
  const entries: { origin: string; key: string; value: string }[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const origin = fields[at]!
    const entry = fields[at + 1]!
    const end = entry.indexOf('\n')
    entries.push({ origin, key: end === -1 ? entry : entry.slice(0, end), value: end === -1 ? '' : entry.slice(end + 1) })
  }
  return entries
}

/** One stat-signature string for a set of files, without reading their contents */
async function fileSignatureOf(files: string[]): Promise<string> {
  const looks = await Promise.all(files.map(async file => `${file}:${await fs.stat(file).then(stats => `${stats.mtimeMs}:${stats.size}`, () => 'gone')}`))
  return looks.sort().join('\n')
}

export class TrustGate {
  /** Where the repository is, from the settings' reading, with its real path looked up once */
  private location: Location | undefined
  /** The asks last worked out, from this reading of the settings, the hooks and any submodules as they looked */
  private held: { reading: SettingsReading; hooks: string; submodules: string; asks: TrustAsk[] } | undefined
  /** Per-submodule cached config asks keyed by submodule git directory */
  private readonly submoduleHeld = new Map<string, { files: string[]; signature: string; asks: TrustAsk[] }>()

  constructor(
    private readonly workingDirectory: string,
    /** The repository's settings, held, which say where it is and every setting that asks is worked out from */
    private readonly settings: HeldSettings,
    /** Whether a host has said the repository at this path is trusted. Without one, none is */
    private readonly isTrusted: (repository: string) => boolean = () => false,
    /** Reads a submodule's own configuration with git, without running anything it names */
    private readonly readGit?: ReadGit,
  ) {}

  /** Where the repository is, as the settings' reading says: nothing when the directory is in none */
  private async where(reading: SettingsReading): Promise<Location | undefined> {
    const common = reading.directories?.commonDir
    // No repository here: nothing to trust, and nothing a repository could have run
    if (!common) return undefined
    const top = reading.directories?.top
    if (this.location?.common !== common || this.location.top !== top) {
      this.location = { common, repository: await fs.realpath(common).catch(() => common), hooks: path.join(common, 'hooks'), top }
    }
    return this.location
  }

  /** How a hooks directory looks, without reading what is in it: a change to it is asks to work out again */
  private async hooksLook(hooks: string): Promise<string> {
    const listed = await fs.readdir(hooks, { withFileTypes: true }).then(
      entries => Promise.all(entries.filter(entry => !entry.name.endsWith('.sample')).map(async (entry) => {
        const stats = await fs.stat(path.join(hooks, entry.name)).catch(() => undefined)
        return `${entry.name}:${stats?.mode ?? 'gone'}:${stats?.mtimeMs ?? ''}`
      })),
      () => [],
    )
    return listed.sort().join('\n')
  }

  /** Hook asks for one hooks directory */
  private async hookAsksOf(hooksDir: string): Promise<TrustAsk[]> {
    const asks: TrustAsk[] = []
    const entries = await fs.readdir(hooksDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.filter(found => !found.name.endsWith('.sample')).sort((a, b) => a.name.localeCompare(b.name))) {
      const stats = await fs.stat(path.join(hooksDir, entry.name)).catch(() => undefined)
      if (stats?.isFile() && (process.platform === 'win32' || (stats.mode & 0o111) !== 0)) {
        asks.push({ kind: 'hook', name: entry.name, file: path.join(hooksDir, entry.name) })
      }
    }
    return asks
  }

  /**
   * Every submodule git directory that git may recurse into during a status or diff: under `<common>/modules/**`
   * (nested submodules included) and any legacy `<top>/<submodule>/.git` directory named in `.gitmodules`.
   */
  private async submoduleGitDirs(where: Location): Promise<string[]> {
    const found = new Set<string>()
    let visited = 0
    const walkModules = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_SUBMODULE_DEPTH || visited >= MAX_SUBMODULE_DIRS) return
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory() || visited >= MAX_SUBMODULE_DIRS) continue
        visited++
        const candidate = path.join(dir, entry.name)
        const hasConfig = await fs.access(path.join(candidate, 'config')).then(() => true, () => false)
        const hasHead = hasConfig || await fs.access(path.join(candidate, 'HEAD')).then(() => true, () => false)
        if (hasHead) {
          found.add(candidate)
          // Nested submodules live under `<submodule-git-dir>/modules/`
          await walkModules(path.join(candidate, 'modules'), depth + 1)
        } else {
          // A submodule whose name contains `/` is stored in nested folders under `modules/`
          await walkModules(candidate, depth + 1)
        }
      }
    }
    await walkModules(path.join(where.common, 'modules'), 0)

    if (where.top) {
      const gitmodules = await fs.readFile(path.join(where.top, '.gitmodules'), 'utf8').catch(() => '')
      for (const match of gitmodules.matchAll(/^\s*path\s*=\s*(.+)$/gm)) {
        const subPath = match[1]!.trim().replace(/^"(.*)"$/, '$1')
        if (!subPath || subPath.includes('\0')) continue
        const resolvedSub = path.resolve(where.top, subPath)
        if (relativeWithin(where.top, resolvedSub) === undefined) continue
        const dotGit = path.join(resolvedSub, '.git')
        const stats = await fs.lstat(dotGit).catch(() => undefined)
        if (stats?.isDirectory()) found.add(dotGit)
      }
    }
    return [...found].sort()
  }

  /** Config and hook asks for one submodule git directory, cached by the stat signatures of its files */
  private async submoduleAsksOf(subDir: string, top: string | undefined): Promise<{ signature: string; asks: TrustAsk[] }> {
    const configPath = path.join(subDir, 'config')
    const hooksDir = path.join(subDir, 'hooks')
    const hooksSig = await this.hooksLook(hooksDir)
    const cached = this.submoduleHeld.get(subDir)
    if (cached) {
      const sigNow = `${await fileSignatureOf(cached.files)}\n--hooks--\n${hooksSig}`
      if (sigNow === cached.signature) return { signature: sigNow, asks: cached.asks }
    }
    const asks: TrustAsk[] = []
    const files = new Set<string>([configPath])
    if (await fs.access(configPath).then(() => true, () => false)) {
      if (!this.readGit) {
        asks.push({ kind: 'setting', key: UNREADABLE, value: 'Submodule configuration could not be read', file: configPath })
      } else {
        const listed = await this.readGit(['config', '--file', configPath, '--list', '--show-origin', '--includes', '-z'])
        if (!listed.success) {
          asks.push({ kind: 'setting', key: UNREADABLE, value: (listed.error ?? '').trim().split('\n')[0] ?? '', file: configPath })
        } else {
          for (const setting of fileSettingsOf(listed.output ?? '')) {
            const file = setting.origin.startsWith('file:') ? path.resolve(subDir, setting.origin.slice('file:'.length)) : configPath
            files.add(file)
            // `git submodule` writes `core.worktree` pointing back to the submodule's folder inside the parent tree
            const safeSubmoduleWorktree = setting.key === 'core.worktree' && top !== undefined
              && relativeWithin(top, path.resolve(subDir, setting.value)) !== undefined
            if (!safeSubmoduleWorktree && !settingRunsNothing(setting.key, setting.value)) {
              asks.push({ kind: 'setting', key: setting.key, value: setting.value, file })
            }
          }
        }
      }
    }
    asks.push(...await this.hookAsksOf(hooksDir))
    const fileList = [...files]
    const signature = `${await fileSignatureOf(fileList)}\n--hooks--\n${hooksSig}`
    this.submoduleHeld.set(subDir, { files: fileList, signature, asks })
    return { signature, asks }
  }

  /** What the repository and its submodules would have git run */
  private async asksOf(reading: SettingsReading, where: Location, submoduleAsks: TrustAsk[]): Promise<TrustAsk[]> {
    const own = reading.settings.filter(setting => setting.scope === 'local' || setting.scope === 'worktree')
    const fileOf = (origin: string) => path.resolve(this.workingDirectory, origin.replace(/^file:/, ''))
    const realWorkingDir = await fs.realpath(this.workingDirectory).catch(() => path.resolve(this.workingDirectory))
    const asks: TrustAsk[] = []
    for (const setting of own) {
      if (settingRunsNothing(setting.key, setting.value)) continue
      // Opening a submodule directly reads its own `.git/modules/<name>/config`, whose `core.worktree` points back
      // to the submodule's working tree (whose `.git` gitfile points right back to this git directory); any other
      // `core.worktree` (such as `..` or `/` pointing outside) still asks
      if (setting.key === 'core.worktree') {
        const target = await fs.realpath(path.resolve(where.common, setting.value)).catch(() => path.resolve(where.common, setting.value))
        if (relativeWithin(target, realWorkingDir) !== undefined) {
          const gitFile = await fs.readFile(path.join(target, '.git'), 'utf8').catch(() => undefined)
          const gitDirTarget = gitFile?.match(/^gitdir:\s*(.+?)\r?$/m)?.[1]?.trim()
          if (gitDirTarget) {
            const linked = await fs.realpath(path.resolve(target, gitDirTarget)).catch(() => path.resolve(target, gitDirTarget))
            if (linked === where.repository) continue
          }
        }
      }
      asks.push({ kind: 'setting', key: setting.key, value: setting.value, file: fileOf(setting.origin) })
    }
    // What it says could not be read, so what it names is not known: it asks, rather than passing for a
    // repository that names nothing
    if (reading.unreadable !== undefined) asks.push({ kind: 'setting', key: UNREADABLE, value: reading.unreadable, file: path.join(where.common, 'config') })
    // A hook is a file in the hooks directory under the name git runs it by: the samples git writes there are
    // not, and on a platform with no executable bit every other file is
    asks.push(...await this.hookAsksOf(where.hooks))
    asks.push(...submoduleAsks)
    return asks
  }

  /**
   * What the repository would have git run, read without running any of it. Worked out again when the settings'
   * reading is another than the one it was worked out from, or the hooks or submodules look different
   */
  async read(): Promise<TrustReading> {
    const reading = await this.settings.read()
    const where = await this.where(reading)
    if (!where) return { trusted: false, asks: [] }
    const [hooks, subDirs] = await Promise.all([this.hooksLook(where.hooks), this.submoduleGitDirs(where)])
    const subResults = await Promise.all(subDirs.map(subDir => this.submoduleAsksOf(subDir, where.top)))
    const submodulesSig = subResults.map((res, i) => `${subDirs[i]}\0${res.signature}`).join('\n---\n')
    if (this.held?.reading !== reading || this.held.hooks !== hooks || this.held.submodules !== submodulesSig) {
      const subAsks = subResults.flatMap(res => res.asks)
      this.held = { reading, hooks, submodules: submodulesSig, asks: await this.asksOf(reading, where, subAsks) }
    }
    return { trusted: this.isTrusted(where.repository), asks: this.held.asks, repository: where.repository }
  }

  /** Lets a git command through, or refuses it when the repository would have git run something and is not trusted */
  async pass(): Promise<void> {
    const reading = await this.read()
    if (!reading.trusted && reading.asks.length > 0) throw new UntrustedError(reading.asks, reading.repository)
  }
}
