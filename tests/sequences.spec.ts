// A watched repository reads only the paths its watcher named, and holds the answer where a whole status would be.
// `noted-paths.spec.ts` holds the cases someone listed; this holds sequences nobody listed, made from a seed: after
// every step, what the repository holds must be what a repository that has read nothing gets from a whole status.
// A difference prints the seed and the fewest steps that still show it.
import { expect, it } from 'vitest'
import { runSequence, shortestFailing, stepsOf } from './_support/sequences.ts'

/** Fixed, so a run here is a run anywhere; `npm run soak:sequences` takes as many more as it is given */
const SEEDS = [1, 7, 42, 20261112]
const STEPS = 30

it.each(SEEDS)('holds what a whole status says after every step of sequence %i', async (seed) => {
  const steps = stepsOf(seed, STEPS)
  const failed = await runSequence(steps)
  if (failed) {
    const shortest = await shortestFailing(steps.slice(0, failed.step + 1))
    expect.fail(`seed ${seed}: differs after step ${failed.step}; the fewest steps that still show it: ${JSON.stringify(shortest.map(step => step.kind))}\n`
      + `held: ${JSON.stringify(failed.held.files)}\nwhole status: ${JSON.stringify(failed.truth.files)}`)
  }
})
