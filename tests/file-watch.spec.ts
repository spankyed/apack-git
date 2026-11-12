// A file followed by its path is reported each time it differs, through being replaced, deleted and made again.
// The platform's own watch on a real file is what is run: whether a watch survives its file being replaced is
// the platform's to answer.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { settles } from './_support/settles.ts';
import { followFile } from '../src/index.ts';
import { removeDirectory } from './_support/remove.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function followed(content?: string) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-follow-')));
  cleanups.push(() => removeDirectory(directory));
  const file = path.join(directory, 'index');
  if (content !== undefined) fs.writeFileSync(file, content);
  let reports = 0;
  const follower = followFile(file, () => { reports++; });
  cleanups.push(() => follower.close());
  return { directory, file, follower, reports: () => reports };
}
/** Replaces the file as git does: written beside it under another name, and renamed over it */
function replace(file: string, content: string) {
  fs.writeFileSync(`${file}.lock`, content);
  fs.renameSync(`${file}.lock`, file);
}
/** Lets the follower look at the file as it is, so the next change is one to it */
const settled = () => new Promise<void>((resolve) => { setTimeout(resolve, 100); });

it('reports a file written in place', async () => {
  const { file, reports } = followed('one');
  await settled();

  fs.writeFileSync(file, 'two, longer');

  await settles(() => expect(reports()).toBeGreaterThan(0));
});

// A watch is on the file it was opened on: the one renamed over it is another file
it('goes on reporting a file each time it is replaced by another renamed over it', async () => {
  const { file, reports } = followed('0');
  await settled();

  for (let round = 1; round <= 10; round++) {
    const before = reports();
    replace(file, `round ${round} ${'x'.repeat(round)}`);
    await settles(() => expect(reports(), `the replacement in round ${round}`).toBeGreaterThan(before));
  }
});

it('reports a file deleted, and reports it made again', async () => {
  const { file, follower, reports } = followed('here');
  await settled();

  fs.rmSync(file);
  await settles(() => expect(reports()).toBeGreaterThan(0));

  // A file that is not there has no watch: whoever watches its directory hears it made, and says to look
  const before = reports();
  fs.writeFileSync(file, 'back');
  follower.look();
  await settles(() => expect(reports(), 'made again').toBeGreaterThan(before));

  const again = reports();
  await settled();
  replace(file, 'and followed from there');
  await settles(() => expect(reports(), 'and watched once more').toBeGreaterThan(again));
});

it('reports nothing once closed', async () => {
  const { file, follower, reports } = followed('one');
  await settled();

  follower.close();
  replace(file, 'two, longer');
  await settled();

  expect(reports()).toBe(0);
});
