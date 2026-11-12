// A repository's branches, remotes and tags, as one model: every branch with what it follows and how far from it it
// is, read in one command, the remotes with their addresses, and the tags.
import { failure, type GitRunner } from './runner.ts'
import type { BranchStanding, RefsModel } from './types.ts'

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
    const [listed, configured] = await Promise.all([
      this.runner.executeGitCommand(['for-each-ref', `--format=${FIELDS.join('%00')}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.runner.executeGitCommand(['config', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']),
    ])
    if (!listed.success) throw failure(listed, 'Failed to read the branches')
    const branches: BranchStanding[] = []
    const tags: RefsModel['tags'] = []
    for (const line of (listed.output ?? '').split('\n')) {
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
    for (const line of (configured.success ? configured.output ?? '' : '').split('\n').filter(Boolean)) {
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
}
