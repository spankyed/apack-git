// The watcher when the operating system drops events, which it does from a queue that is full and says to
// nobody the engine can hear. The platform's watch is real and its reports are thrown away on purpose. What is
// held to: nothing is promised while events are lost; once a host says "look again", what is held is what git
// says, and from then on a file made in any directory is seen without being asked for.
import { afterEach, expect, it } from 'vitest';
import { catchesUp, churn, cleanUp, platformWatch, probeEveryDirectory, seeded, watchedRepository } from './_support/rig.ts';

afterEach(cleanUp);

it.each([7, 20261111])('sees every directory again after events were lost and it was asked to look, seed %i', async (seed) => {
  const platform = platformWatch();
  const { root, repo, watcher, held, truth } = await watchedRepository({ subscribe: platform.subscribe });

  platform.state.losing = true;
  const made = churn(root, seeded(seed), 200);
  const said = `seed ${seed}; the churn ended with: ${made.slice(-8).join(', ')}`;
  // Long enough for the platform to have delivered what it had, into nothing
  await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
  platform.state.losing = false;

  // What a host does when something says a change is likely: a window gaining focus, a command ending
  await watcher.check();
  await repo.refreshSnapshot('everything');
  expect(await held(), said).toEqual(await truth());

  const directories = probeEveryDirectory(root, 'after-loss');
  await catchesUp(async () => {
    const now = await held();
    expect(now.files.filter(file => file.path.endsWith('probe-after-loss.txt')), said).toHaveLength(directories);
    expect(now, said).toEqual(await truth());
  });
});
