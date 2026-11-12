// The watcher against more events than the platform holds for it. The tree is written without the event loop
// getting a turn, so nothing is read from the platform's queue while it fills: past what it holds, the kernel
// drops events, which is a real loss and not one made up at the seam. What is held to is what the churn is held
// to: once the tree is quiet, what the watched repository holds is what git says, without anyone asking it to
// look again.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { catchesUp, cleanUp, platformWatch, watchedRepository } from './_support/rig.ts';

afterEach(cleanUp);

/** How many events Linux holds for one reader before it drops them, where the system says */
function queueSize(): number | undefined {
  try { return Number(fs.readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8').trim()) || undefined; } catch { return undefined; }
}

it('holds what git says after a flood the platform could not hold all of', async () => {
  const platform = platformWatch();
  const { root, held, truth } = await watchedRepository({ subscribe: platform.subscribe });
  const queue = queueSize();
  // Twice what the queue holds where that is known, each file two events: made and written
  const files = Math.min(queue === undefined ? 30_000 : queue * 2, 120_000);
  const directories = 60;

  for (let directory = 0; directory < directories; directory++) fs.mkdirSync(path.join(root, 'flood', `d${directory}`), { recursive: true });
  // Give the watches on the new directories their turn, so the flood lands in directories that are watched
  await catchesUp(async () => expect((await held()).files.length).toBeGreaterThanOrEqual(0));
  await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
  const before = platform.state.delivered;

  for (let file = 0; file < files; file++) fs.writeFileSync(path.join(root, 'flood', `d${file % directories}`, `f${file}.txt`), 'x');

  await catchesUp(async () => expect(await held()).toEqual(await truth()), 120_000);
  const delivered = platform.state.delivered - before;
  // Every file made is at least one event: fewer delivered than files made is events the platform dropped
  console.info(`[overflow] ${process.platform}: ${files} files made, ${delivered} events delivered, queue ${queue ?? 'unknown'}: ${delivered < files ? 'events were dropped' : 'no loss is shown'}`);
  // Where the queue's size is known the flood is sized to overflow it, and a drill that dropped nothing drilled nothing
  if (queue !== undefined && queue * 2 === files) expect(delivered, 'the kernel dropped events').toBeLessThan(files * 2);
});
