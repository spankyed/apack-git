// The watcher against a tree changed faster than it can follow, on the platform's own watch and a real git.
// What is held to: once the tree is quiet, what the watched repository holds is what a repository that has read
// nothing says, without anyone asking it to look again; and after that, a file made in any directory is seen, once
// the platform has delivered it.
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PER_DIRECTORY, catchesUp, churn, cleanUp, directoriesOf, independentWatch, platformWatch, probeEveryDirectory, seeded, watchedRepository } from './_support/rig.js';

afterEach(cleanUp);

/** Fixed, so every run and every platform churns the same way, and a failure names the seed to run again */
const SEEDS = [1, 20261111, 0xC0FFEE];

/**
 * Why a case is skipped when the platform delivers nothing: on macOS one service of the system's feeds every
 * process's watches, and while another process writes files fast enough it delivers nothing to anyone
 */
const NOTHING_DELIVERED = 'the platform delivered no file event in 30 seconds: another process is writing files faster than it delivers them';

it.for(SEEDS)('holds what git says once a churn of the tree has gone quiet, and sees a file made in any directory after it (seed %i)', async (seed, { skip }) => {
  const platform = platformWatch();
  const { root, held, truth } = await watchedRepository({ subscribe: platform.subscribe });

  const before = platform.state.delivered;
  const made = churn(root, seeded(seed), 300);
  const said = `seed ${seed}; the churn ended with: ${made.slice(-8).join(', ')}`;

  // The churn is something to hold the watcher to only once the platform has delivered some of it to its watches
  const churnDelivered = await catchesUp(() => { if (platform.state.delivered === before) throw new Error('nothing delivered yet'); }).then(() => true, () => false);
  skip(!churnDelivered, NOTHING_DELIVERED);
  await catchesUp(async () => expect(await held(), said).toEqual(await truth()));
  // A watch on every directory there is and on no other, where a watch is held on each
  if (PER_DIRECTORY) {
    const expected = directoriesOf(root).map(directory => (directory === '' ? root : `${root}/${directory}`));
    await catchesUp(() => expect(platform.watched().filter(watched => watched === root || (watched.startsWith(`${root}/`) && !watched.startsWith(`${root}/.git`))), said).toEqual(expected.sort()));
  }

  // A file made in each directory is something to hold the watcher to only once the platform has delivered it
  const delivery = await independentWatch(root);
  skip(!delivery.live, NOTHING_DELIVERED);
  const probes = directoriesOf(root).map(directory => path.join(directory, 'probe-after.txt'));
  const directories = probeEveryDirectory(root, 'after');
  const delivered = await delivery.delivered(probes);
  skip(delivered < probes.length, `the platform delivered ${delivered} of the ${probes.length} files made, to a watch of the case's own as well: the rest were lost before any watch saw them`);
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
