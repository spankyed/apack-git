// What can be done now in a checkout, and why not, from its snapshot alone: an entry with no Node imports, so a
// window can say why a button is not to be pressed without asking anything. Each answer is a reason a host can word,
// never git's text.
import type { RepositorySnapshot } from './types.ts'

/** Why something cannot be done now */
export const UNAVAILABLE_REASONS = [
  /** A commit with nothing staged */
  'nothing-staged',
  /** Files are still in conflict, which a commit, a pull and a sync wait for */
  'conflicts',
  /** Git has no name and email to write a commit with */
  'no-identity',
  /** A merge, a rebase, a cherry-pick or a revert is under way, to be carried on with or given up first */
  'operation-in-progress',
  /** The branch follows nothing to pull from or push to, or nothing is checked out but a commit */
  'no-upstream',
  /** The branch and what it follows have both moved on: a push is refused until the two are brought together */
  'diverged',
  /** There is nothing to push, or nothing to pull */
  'up-to-date',
] as const
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number]

export type Availability = { possible: true } | { possible: false; reason: UnavailableReason }

/** Whether a commit, a push, a pull and a sync (a pull then a push) can be done now, and the first reason when not */
export interface WhatCanBeDone {
  commit: Availability
  push: Availability
  pull: Availability
  sync: Availability
}

const possible: Availability = { possible: true }
/** The first of these that holds, as the reason, or possible when none does */
const unless = (...checks: [boolean, UnavailableReason][]): Availability => {
  const held = checks.find(([holds]) => holds)
  return held ? { possible: false, reason: held[1] } : possible
}

/** What can be done now, from a snapshot as the engine reads it */
export function whatCanBeDone(snapshot: RepositorySnapshot): WhatCanBeDone {
  const conflicts = snapshot.files.some(file => file.status === 'unmerged')
  const staged = snapshot.files.some(file => file.staged)
  // A merge that is stopped is concluded by a commit, once its conflicts are settled; anything else under way is not
  const midway = snapshot.operation !== undefined
  const tracking = snapshot.hasUpstream && snapshot.branch !== 'HEAD'
  const diverged = snapshot.ahead > 0 && snapshot.behind > 0
  return {
    commit: unless(
      [conflicts, 'conflicts'],
      [midway && snapshot.operation?.kind !== 'merge', 'operation-in-progress'],
      [!staged && snapshot.operation?.kind !== 'merge', 'nothing-staged'],
      [!snapshot.hasIdentity, 'no-identity'],
    ),
    push: unless(
      [midway, 'operation-in-progress'],
      [!tracking, 'no-upstream'],
      [diverged, 'diverged'],
      [snapshot.ahead === 0, 'up-to-date'],
    ),
    pull: unless(
      [conflicts, 'conflicts'],
      [midway, 'operation-in-progress'],
      [!tracking, 'no-upstream'],
      [snapshot.behind === 0, 'up-to-date'],
    ),
    sync: unless(
      [conflicts, 'conflicts'],
      [midway, 'operation-in-progress'],
      [!tracking, 'no-upstream'],
      [snapshot.ahead === 0 && snapshot.behind === 0, 'up-to-date'],
    ),
  }
}
