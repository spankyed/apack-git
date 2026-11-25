// A repository's branches, remotes and tags, as one model: every branch with what it follows and how far from it it
// is, read in one command, the remotes with their addresses, and the tags.
import { refArgument } from './arguments.js'
import { failure, type GitRunner } from './runner.js'
import type { BranchStanding, RefsModel } from './types.js'

const FIELDS = ['%(refname)', '%(refname:short)', '%(objectname)', '%(HEAD)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(*objectname)']

/** `ahead 2, behind 1`, `ahead 2`, `behind 1`, `gone` or nothing, as `%(upstream:track,nobracket)` says it */
function standingOf(track: string): Pick<BranchStanding, 'ahead' | 'behind' | 'upstreamGone'> {
  if (track === 'gone') return { ahead: 0, behind: 0, upstreamGone: true }
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
  }
}

export class Refs {
  constructor(private readonly runner: GitRunner) {}

  async model(): Promise<RefsModel> {
    const listed = await this.runner.read(['for-each-ref', `--format=${FIELDS.join('%00')}`, 'refs/heads', 'refs/remotes', 'refs/tags'])
    if (!listed.success) throw failure(listed, 'Failed to read the branches')
    const { settings } = await this.runner.settings.read()
    const remoteLines = settings
      .filter(({ key }) => /^remote\..+\.(url|pushurl)$/.test(key))
      .map(({ key, value }) => `${key} ${value}`)
      .join('\n')
    const model = parseRefs(listed.output ?? '', remoteLines)
    // Only invoke git URL rewriting when `url.*.insteadOf` or `pushInsteadOf` rules exist in the settings
    const hasRewrites = settings.some(({ key }) => /^url\..+\.(?:push)?insteadof$/.test(key))
    if (hasRewrites && model.remotes.length > 0) {
      model.remotes = await Promise.all(model.remotes.map(async (remote) => {
        const named = refArgument(remote.name, 'remote')
        const [fetchRes, pushRes] = await Promise.all([
          this.runner.read(['remote', 'get-url', named]),
          this.runner.read(['remote', 'get-url', '--push', named]),
        ])
        const fetchUrl = (fetchRes.success && fetchRes.output?.trim()) || remote.fetchUrl
        const pushUrl = (pushRes.success && pushRes.output?.trim()) || remote.pushUrl
        return { name: remote.name, fetchUrl, pushUrl }
      }))
    }
    return model
  }
}

/**
 * `for-each-ref` with `FIELDS` over branches, remotes' branches and tags, and `config --get-regexp` of the remotes'
 * addresses: the model they make
 */
export function parseRefs(listing: string, configuring: string): RefsModel {
  const branches: BranchStanding[] = []
  const tags: RefsModel['tags'] = []
  for (const line of listing.split('\n')) {
    const [ref, name, commit, head, upstream, track, peeled] = line.split('\0')
    if (!ref || !name || !commit) continue
    if (ref.startsWith('refs/tags/')) {
      // An annotated tag names a tag object: the commit is what it peels to
      tags.push({ name, commit: peeled || commit })
      continue
    }
    // A remote's `HEAD` says which of its branches is its default, and is no branch of its own
    if (ref.startsWith('refs/remotes/') && ref.endsWith('/HEAD')) continue
    branches.push({
      name, ref, commit,
      remote: ref.startsWith('refs/remotes/'),
      current: head === '*',
      ...(upstream && { upstream }),
      ...standingOf(track ?? ''),
    })
  }
  // `remote.<name>.url` and `.pushurl`: a remote pushes where it fetches unless it says otherwise
  const remotes = new Map<string, { name: string; fetchUrl: string; pushUrl?: string }>()
  for (const line of configuring.split('\n').filter(Boolean)) {
    const [key = '', ...value] = line.split(' ')
    const match = /^remote\.(.+)\.(url|pushurl)$/.exec(key)
    if (!match) continue
    const remote = remotes.get(match[1]!) ?? { name: match[1]!, fetchUrl: '' }
    if (match[2] === 'url') remote.fetchUrl = value.join(' ')
    else remote.pushUrl = value.join(' ')
    remotes.set(remote.name, remote)
  }
  return {
    branches,
    remotes: [...remotes.values()].map(({ name, fetchUrl, pushUrl }) => ({ name, fetchUrl, pushUrl: pushUrl ?? fetchUrl })),
    tags,
  }
}
