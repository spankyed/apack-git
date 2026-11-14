// What a caller named — a ref, a row's path, a stash, a commit — as an argument git reads as that and nothing else

/**
 * A branch, tag or other ref a caller named, as an argument git will read as a ref.
 *
 * **A name that begins with a dash is an option to git, whatever the caller meant by it**: `--hard` given as a
 * commit resets the working tree, and `--upload-pack=…` given as a branch names a program to run. Names reach
 * here from events and from a pull request's data, so the refusal is here, where the argument is built.
 */
export function refArgument(name: string, what = 'ref'): string {
  // eslint-disable-next-line no-control-regex
  if (!name || name.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`Invalid ${what}: ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * A branch name a caller gave, to check out or make: letters, digits, `.`, `_`, `-` and `/`, not beginning with a
 * dash. Narrower than git's own rule, which takes names a shell or a URL reads otherwise.
 */
export function branchNameArgument(name: string): string {
  if (!name.trim()) throw new Error('Branch name cannot be empty')
  if (name.startsWith('-') || !/^[a-zA-Z0-9._/-]+$/.test(name)) {
    throw new Error('Invalid branch name. Branch names can only contain letters, numbers, dots, underscores, hyphens, and forward slashes.')
  }
  return name
}

/**
 * The records of a listing whose fields are separated by NUL and whose records, under `-z`, end with one: every
 * `fields` values are one record. NUL is the one byte a commit message, a ref or a path cannot hold, so no
 * subject or body can be mistaken for a separator.
 */
export function recordsOf(output: string, fields: number): string[][] {
  const values = output.split('\0')
  const records: string[][] = []
  for (let i = 0; i + fields <= values.length; i += fields) records.push(values.slice(i, i + fields))
  return records
}

/**
 * A status row's path as an argument git reads as that path and no other: from the top of the checkout, which is
 * where a status names its paths from, and letter for letter. Left as it is spelled, git reads it as a pattern
 * from the working directory: `app/[id]/` is then also `app/i/` and `app/d/`, and a write over it reaches them.
 */
export const rowSpec = (rowPath: string): string => `:(top,literal)${rowPath.replace(/\/$/, '')}`

/** A stash a caller named by its position in the list */
export function stashArgument(index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid stash index: ${JSON.stringify(index)}`)
  return `stash@{${index}}`
}

/** A commit a caller named by its hash, whole or abbreviated */
export function commitArgument(hash: string): string {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) throw new Error(`Invalid commit hash: ${JSON.stringify(hash)}`)
  return hash
}
