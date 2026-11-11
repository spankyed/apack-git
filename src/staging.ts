import type { GitStatusFile } from './types.ts'

/**
 * The changed files as git will list them once some are staged or unstaged, for a window to show at once: the
 * click is answered on the screen, and what git says replaces this when it arrives.
 *
 * A file is moved only where the list itself says where it goes. Where only git can tell — a conflict being
 * settled, a copy, a file put back over a staged deletion, a folder git tracks nothing in or a file inside one —
 * its rows are left as they are and move with git's answer.
 */

/** A file's rows after it is staged or unstaged, or nothing when the list cannot tell */
type Move = (staged: GitStatusFile | undefined, unstaged: GitStatusFile | undefined) => GitStatusFile[] | undefined

const afterStaging: Move = (staged, unstaged) => {
  if (!unstaged) return undefined
  // A folder git tracks nothing in is one row for whatever it holds, and only git says what that is
  if (unstaged.isDirectory) return undefined
  const row = (status: GitStatusFile['status']): GitStatusFile[] => [{ path: unstaged.path, status, staged: true, originalPath: undefined }]
  // What is staged of a renamed or copied file is read against the file it came from
  if (staged && (staged.status === 'renamed' || staged.status === 'copied')) return undefined
  switch (unstaged.status) {
    case 'untracked': return staged ? undefined : row('added')
    // A file new to the index stays new to it, and a change of kind stays one, whatever else is staged of it
    case 'modified':
    case 'typechange':
      return row(staged?.status === 'added' ? 'added' : staged?.status === 'typechange' || unstaged.status === 'typechange' ? 'typechange' : 'modified')
    // A file added and then deleted was never in a commit: staged, there is nothing left of it to list
    case 'deleted': return staged?.status === 'added' ? [] : row('deleted')
    default: return undefined
  }
}

const afterUnstaging: Move = (staged, unstaged) => {
  if (!staged) return undefined
  const row = (path: string, status: GitStatusFile['status']): GitStatusFile => ({ path, status, staged: false, originalPath: undefined })
  switch (staged.status) {
    // Unstaged, an added file is one git does not track: there, or gone if it was deleted since
    case 'added': return unstaged?.status === 'deleted' ? [] : [row(staged.path, 'untracked')]
    case 'modified':
    case 'typechange': return [unstaged ?? row(staged.path, staged.status)]
    case 'deleted': return unstaged ? undefined : [row(staged.path, 'deleted')]
    // Both halves of a rename are unstaged together: the old name is tracked and missing, the new one is not tracked
    case 'renamed': return staged.originalPath ? [row(staged.originalPath, 'deleted'), row(staged.path, 'untracked')] : undefined
    default: return undefined
  }
}

/** Where git lists a changed file: the tracked ones, then the conflicts, then the untracked ones, each by path */
const rank = (file: GitStatusFile) => file.status === 'untracked' ? 2 : file.status === 'unmerged' ? 1 : 0
const asListed = (files: GitStatusFile[]) => [...files].sort((a, b) =>
  rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : Number(b.staged) - Number(a.staged)))

function moved(files: GitStatusFile[], paths: string[], move: Move): GitStatusFile[] {
  // Read once into the rows of each named path: every file may be named at once, in a list of thousands
  const rowsOf = new Map<string, GitStatusFile[]>(paths.map(path => [path, []]))
  for (const file of files) rowsOf.get(file.path)?.push(file)
  const after = [...rowsOf.values()].flatMap(rows => move(rows.find(file => file.staged), rows.find(file => !file.staged)) ?? rows)
  // A path that a move names, such as the one a rename came from, takes the place of what was listed for it
  const taken = new Set(after.map(file => `${file.path}\0${file.staged}`))
  return asListed([...files.filter(file => !rowsOf.has(file.path) && !taken.has(`${file.path}\0${file.staged}`)), ...after])
}

/** The list once these paths are staged */
export const withStaged = (files: GitStatusFile[], paths: string[]): GitStatusFile[] => moved(files, paths, afterStaging)

/** The list once these paths are unstaged */
export const withUnstaged = (files: GitStatusFile[], paths: string[]): GitStatusFile[] => moved(files, paths, afterUnstaging)
