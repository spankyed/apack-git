// The sequences of `sequences.spec.ts` through the platform's own watch, as many as it is given
// (`SOAK_SEEDS`, default 50): real edits, real file events, and the watcher reporting what it saw. A step whose
// report never comes, or names too little, leaves the repository holding less than a whole status, and that is
// what this counts and prints. It fails nothing: whether a platform delivers its events is the platform's to
// answer, and a run on a busy machine loses more of them than one on a quiet one.
import { it } from 'vitest'
import { runSequence, stepsOf } from '../_support/sequences.ts'

const SEEDS = Number(process.env.SOAK_SEEDS ?? 50)
const FIRST = Number(process.env.SOAK_FIRST_SEED ?? 1000)

it(`holds what a whole status says through ${SEEDS} sequences on the platform's watch`, async () => {
  const lost: string[] = []
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    const steps = stepsOf(seed, 30)
    const failed = await runSequence(steps, { watch: 'platform' })
    if (failed) lost.push(`seed ${seed}: after step ${failed.step} (${steps[failed.step]!.kind})`)
  }
  // Written to the terminal itself: vitest keeps what a passing test logs to itself
  process.stdout.write(`\n${SEEDS - lost.length} of ${SEEDS} sequences held what a whole status says on ${process.platform}${lost.length ? `; lost:\n  ${lost.join('\n  ')}` : ''}\n\n`)
})
