// A watch that is not delivering is said: checks with nothing to go by that keep finding changes the watcher never
// reported lead to the snapshot saying live updates are not arriving, and a watcher that reports them does not. The
// watcher is stood in for; every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';
import { MISSED_CHECKS_SILENT } from '../src/model.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A watched repository, checked once, and an edit to make before each check after */
async function watched() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-silent-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '--quiet', '-m', 'first']);
  const repo = new GitRepository(root);
  repo.setWatched(true);
  await repo.refreshSnapshot();
  let edits = 0;
  const edit = () => fs.writeFileSync(path.join(root, 'a.txt'), `edit ${++edits}\n`);
  return { root, repo, edit };
}

it('says live updates are not arriving once checks keep finding what the watcher never reported, and is news of it', async () => {
  const { repo, edit } = await watched();

  for (let check = 1; check < MISSED_CHECKS_SILENT; check++) {
    edit();
    await repo.refreshSnapshot();
    expect((await repo.readSnapshot()).watchSilent, `after ${check} missed`).toBeUndefined();
  }
  edit();
  expect((await repo.refreshSnapshot()).status).toBe(true);
  expect((await repo.readSnapshot()).watchSilent).toBe(true);
});

it('says nothing of a watcher that reports the changes the checks find, and hears again once it does', async () => {
  const { root, repo, edit } = await watched();

  for (let check = 0; check < MISSED_CHECKS_SILENT + 1; check++) {
    edit();
    repo.noteChanged([path.join(root, 'a.txt')]);
    await repo.refreshSnapshot();
  }
  expect((await repo.readSnapshot()).watchSilent).toBeUndefined();

  for (let check = 0; check < MISSED_CHECKS_SILENT; check++) {
    edit();
    await repo.refreshSnapshot();
  }
  expect((await repo.readSnapshot()).watchSilent).toBe(true);
  edit();
  repo.noteChanged([path.join(root, 'a.txt')]);
  expect((await repo.refreshSnapshot()).status, 'hearing again is news too').toBe(true);
  expect((await repo.readSnapshot()).watchSilent).toBeUndefined();
});

it('counts no check that found nothing changed', async () => {
  const { repo } = await watched();

  for (let check = 0; check < MISSED_CHECKS_SILENT + 1; check++) await repo.refreshSnapshot();

  expect((await repo.readSnapshot()).watchSilent).toBeUndefined();
});
