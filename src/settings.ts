// What git says a repository's settings are, read once and held until a file they came from looks different. A
// status, the trust gate and the question of whether a clone is partial each need a setting, and each asked git for
// it on every read: here one `git config --list` answers all three, and a read after it costs a few looks at files.
import * as os from 'node:os'
import * as path from 'path'
import * as fs from 'fs/promises'
import type { GitDirectories } from './types.ts'

/** Runs one git that reads and runs nothing: `rev-parse` for where the repository is, `config --list` for what it says */
export type ReadGit = (args: string[]) => Promise<{ success: boolean; output?: string; error?: string }>

/** One setting as `git config --list --show-scope --show-origin` printed it */
export interface Setting {
  scope: string
  origin: string
  key: string
  value: string
}

/** What git says a repository's settings are, from every file that sets one */
export interface SettingsReading {
  /** Every setting, in the order git lists them: a later one of the same key is the one git uses */
  settings: Setting[]
  /** What git said when the settings could not be listed */
  unreadable?: string
  /** The value git uses for a key, spelled as git prints it (`core.ignorecase`), or nothing */
  value(key: string): string | undefined
  /** Where the repository's git state lives, as git said when first asked; nothing when the directory is in none */
  directories?: GitDirectories
}

/** `scope`, `origin`, `key` and `value` of each setting `git config --list --show-scope --show-origin -z` printed */
export function settingsOf(output: string): Setting[] {
  const fields = output.split('\0')
  const settings: Setting[] = []
  for (let at = 0; at + 2 < fields.length; at += 3) {
    const [scope, origin, entry] = [fields[at]!, fields[at + 1]!, fields[at + 2]!]
    // A key ends at the line break, and a setting with no value has none
    const end = entry.indexOf('\n')
    settings.push({ scope, origin, key: end === -1 ? entry : entry.slice(0, end), value: end === -1 ? '' : entry.slice(end + 1) })
  }
  return settings
}

/** A reading of these settings, with the value git uses for each key: the last one listed */
function readingOf(settings: Setting[], unreadable: string | undefined, directories: GitDirectories | undefined): SettingsReading {
  const last = new Map(settings.map(setting => [setting.key, setting.value]))
  return { settings, ...(unreadable !== undefined && { unreadable }), value: key => last.get(key), ...(directories && { directories }) }
}

/**
 * A repository's settings, held. The reading is taken from git the first time it is asked for, and again whenever a
 * file it depends on looks different, by its time and size: every file a setting came from, the repository's own
 * `config` and `config.worktree`, the places a user's settings would be were they made, the system file the
 * environment names, and the environment's `GIT_CONFIG*` variables themselves.
 *
 * **A file that sets nothing and is none of those places is not known to the reading**: a system file that does not
 * exist yet, or an included file with no setting in it. A setting added there is seen when a host says to look again
 * (`forget`), as a refresh of everything does.
 */
export class HeldSettings {
  private held: { reading: SettingsReading; files: string[]; signature: string } | undefined
  /**
   * Where the git state lives: asked of git the first time, and held once found. Taking the settings afresh does not
   * ask again; a directory in no repository is asked again until it is one
   */
  private directories: GitDirectories | undefined
  /** The reading being taken, which every read asked for meanwhile waits on */
  private taking: Promise<SettingsReading> | undefined

  constructor(
    private readonly workingDirectory: string,
    private readonly readGit: ReadGit,
    /** The environment git runs with, which names where a user's and the system's settings are */
    private readonly environment: () => NodeJS.ProcessEnv,
  ) {}

  /** The reading: taken from git the first time, and again when a file it depends on looks different */
  async read(): Promise<SettingsReading> {
    if (this.taking) return this.taking
    const held = this.held
    // A directory in no repository yet is asked again each time, until it is one
    if (held && this.directories && held.signature === await this.signatureNow(held.files)) return held.reading
    // Another read may have begun taking it while this one looked at the files
    if (this.taking) return this.taking
    this.taking = this.take().finally(() => { this.taking = undefined })
    return this.taking
  }

  /** Has the next `read` take the reading from git, whatever the files look like */
  forget(): void {
    this.held = undefined
  }

  /** Where the repository's git state lives, asked of git until it is found and then held */
  private async located(): Promise<GitDirectories | undefined> {
    if (this.directories) return this.directories
    const result = await this.readGit(['rev-parse', '--git-dir', '--git-common-dir', '--show-prefix'])
    const [gitDir, commonDir, prefix] = (result.success ? result.output ?? '' : '').split('\n').map(line => line.trim())
    if (gitDir && commonDir) {
      this.directories = { gitDir: path.resolve(this.workingDirectory, gitDir), commonDir: path.resolve(this.workingDirectory, commonDir), prefix: prefix ?? '' }
    }
    return this.directories
  }

  /** The files a reading of these settings depends on, whether they are there or not */
  private filesOf(settings: Setting[]): string[] {
    const env = this.environment()
    const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
    const fileOf = (origin: string) => path.resolve(this.workingDirectory, origin.replace(/^file:/, ''))
    const origins = settings.filter(setting => setting.origin.startsWith('file:')).map(setting => fileOf(setting.origin))
    // The repository's own files, whether or not they set anything: its configuration, and a worktree's beside its
    // own git directory
    const own = this.directories ? [path.join(this.directories.commonDir, 'config'), path.join(this.directories.gitDir, 'config.worktree')] : []
    const user = env.GIT_CONFIG_GLOBAL !== undefined
      ? [env.GIT_CONFIG_GLOBAL]
      : [path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'git', 'config'), path.join(home, '.gitconfig')]
    const system = env.GIT_CONFIG_SYSTEM !== undefined ? [env.GIT_CONFIG_SYSTEM] : []
    return [...new Set([...origins, ...own, ...user, ...system].filter(Boolean).map(file => path.resolve(this.workingDirectory, file)))]
  }

  /** How each file looks, without reading it: its time and size, or that it is not there */
  private async looksOf(files: string[]): Promise<Map<string, string>> {
    return new Map(await Promise.all(files.map(async file => [file, await fs.stat(file).then(stats => `${stats.mtimeMs}:${stats.size}`, () => 'gone')] as const)))
  }

  /** The environment's settings of git's configuration, which name other files or carry settings themselves */
  private environmentLook(): string {
    const env = this.environment()
    return Object.keys(env).filter(name => name.toUpperCase().startsWith('GIT_CONFIG')).sort().map(name => `${name}=${env[name]}`).join('\n')
  }

  /** What a reading depends on, in one string: each file with how it looks, and the environment's settings */
  private signatureOf(files: string[], looks: Map<string, string>, environment: string): string {
    return [...files.map(file => `${file}\0${looks.get(file)}`), environment].join('\n')
  }

  /** What the files a reading depends on look like now */
  private async signatureNow(files: string[]): Promise<string> {
    return this.signatureOf(files, await this.looksOf(files), this.environmentLook())
  }

  /**
   * Takes the reading from git, with how its files looked just before. A file changed while git reads it then looks
   * different at the next read, which takes the reading again. A file the listing names for the first time can only
   * be looked at after it, and a change made to it in that moment is seen at the next look again
   */
  private async take(): Promise<SettingsReading> {
    const directories = await this.located()
    const environment = this.environmentLook()
    const before = await this.looksOf(this.held?.files ?? this.filesOf([]))
    const listed = await this.readGit(['config', '--list', '--show-scope', '--show-origin', '--includes', '-z'])
    const settings = listed.success ? settingsOf(listed.output ?? '') : []
    const reading = readingOf(settings, listed.success ? undefined : (listed.error ?? '').trim().split('\n')[0] ?? '', directories)
    const files = this.filesOf(settings)
    const after = await this.looksOf(files.filter(file => !before.has(file)))
    this.held = { reading, files, signature: this.signatureOf(files, new Map([...after, ...before]), environment) }
    return reading
  }
}
