// A whole status over its budget says so, and whether git's own file monitor and untracked cache are on, either of
// which would make it faster; with both on it does not. The budget is the host's to set, here at nothing, so any
// status is over it. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-slow-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet']);
  return { root, git: (...args: string[]) => run('git', ['-C', root, ...args]) };
}

it('says a whole status over its budget is slow, with what is off, and says nothing once both are on', async () => {
  const { root, git } = await repository();

  const slow = (await new GitRepository(root, { statusBudgetMs: 0 }).readSnapshot()).slowStatus;
  expect(slow).toMatchObject({ budgetMs: 0, fileMonitor: false, untrackedCache: false });
  expect(slow!.ms).toBeGreaterThanOrEqual(0);

  await git('config', 'core.untrackedCache', 'true');
  await git('config', 'core.fsmonitor', 'true');
  expect((await new GitRepository(root, { statusBudgetMs: 0 }).readSnapshot()).slowStatus).toBeUndefined();
});

it('says nothing of a status within its budget', async () => {
  const { root } = await repository();

  expect((await new GitRepository(root, { statusBudgetMs: 60_000 }).readSnapshot()).slowStatus).toBeUndefined();
});

it('turns on what it can, and the repository is still trusted by what it names', async () => {
  const { root } = await repository();
  const repo = new GitRepository(root, { statusBudgetMs: 0 });

  const on = await repo.speedUpStatus();

  expect(on.untrackedCache).toBe(true);
  // Git has a file monitor of its own on macOS and Windows only
  if (process.platform === 'linux') expect(on.fileMonitor).toBe(false);
  expect((await repo.readTrust()).asks, 'git\'s own monitor names no program').toEqual([]);
  const after = (await repo.readSnapshot()).slowStatus;
  // With both on there is nothing more to offer; with the cache alone, the monitor is still offered
  if (on.fileMonitor) expect(after).toBeUndefined();
  else expect(after).toMatchObject({ untrackedCache: true, fileMonitor: false });
});

it('does not call a status that stopped being slow a change to the status', async () => {
  const { root, git } = await repository();
  const repo = new GitRepository(root, { statusBudgetMs: 0 });
  // The first check has nothing to compare with; what follows is compared with it
  await repo.refreshSnapshot();
  expect((await repo.readSnapshot()).slowStatus, 'every status is over a budget of nothing').toBeDefined();

  // Both on, so there is nothing left to offer: the note goes, and nothing a window shows of the status moved
  await git('config', 'core.untrackedCache', 'true');
  await git('config', 'core.fsmonitor', 'true');
  const change = await repo.refreshSnapshot();

  expect((await repo.readSnapshot()).slowStatus).toBeUndefined();
  expect(change.status, 'a slow note coming or going is how long git took, which load moves, not news of the status').toBe(false);
});
