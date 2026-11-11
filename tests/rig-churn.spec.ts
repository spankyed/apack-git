// The watcher against a tree changed faster than it can follow, on the platform's own watch and a real git.
// What is held to: once the tree is quiet, what the watched repository holds is what a repository that has read
// nothing says, without anyone asking it to look again; and after that, a file made in any directory is seen.
import { afterEach, expect, it } from 'vitest';
import { PER_DIRECTORY, catchesUp, churn, cleanUp, directoriesOf, platformWatch, probeEveryDirectory, seeded, watchedRepository } from './_support/rig.ts';

afterEach(cleanUp);

/** Fixed, so every run and every platform churns the same way, and a failure names the seed to run again */
const SEEDS = [1, 20261111, 0xC0FFEE];

it.each(SEEDS)('holds what git says once a churn of the tree has gone quiet, and sees a file made in any directory after it (seed %i)', async (seed) => {
  const platform = platformWatch();
  const { root, held, truth } = await watchedRepository({ subscribe: platform.subscribe });

  const made = churn(root, seeded(seed), 300);
  const said = `seed ${seed}; the churn ended with: ${made.slice(-8).join(', ')}`;

  await catchesUp(async () => expect(await held(), said).toEqual(await truth()));
  // A watch on every directory there is and on no other, where a watch is held on each
  if (PER_DIRECTORY) {
    const expected = directoriesOf(root).map(directory => (directory === '' ? root : `${root}/${directory}`));
    await catchesUp(() => expect(platform.watched().filter(watched => watched === root || (watched.startsWith(`${root}/`) && !watched.startsWith(`${root}/.git`))), said).toEqual(expected.sort()));
  }

  const directories = probeEveryDirectory(root, 'after');
  await catchesUp(async () => {
    const now = await held();
    expect(now.files.filter(file => file.path.endsWith('probe-after.txt')), said).toHaveLength(directories);
    expect(now, said).toEqual(await truth());
  });
});

it('holds what git says after a flood of new files', async () => {
  const platform = platformWatch();
  const { root, held, truth } = await watchedRepository({ subscribe: platform.subscribe });
  const fs = await import('node:fs');
  const path = await import('node:path');

  for (let directory = 0; directory < 40; directory++) {
    fs.mkdirSync(path.join(root, 'flood', `d${directory}`), { recursive: true });
    for (let file = 0; file < 100; file++) fs.writeFileSync(path.join(root, 'flood', `d${directory}`, `f${file}.txt`), '');
  }

  await catchesUp(async () => expect(await held()).toEqual(await truth()));
  expect((await held()).files).toHaveLength(4000);
});
