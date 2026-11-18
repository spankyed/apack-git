// How many gits each common operation starts, and which. A time varies with the machine, so the budgets are
// readings; a count does not, so it is held here, and a process added to a common path fails a case. Every git is a
// real one, seen through the `run` tie, which every command the engine runs passes through.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, runUnbounded } from '../src/index.ts';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map(repo => repo.close()));
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

/** A command's name: what follows the options the runner and a caller put ahead of it (`-c color.ui=never`, `-C <top>`) */
function nameOf(args: readonly string[]): string {
  let at = 0;
  while (args[at] === '-c' || args[at] === '-C') at += 2;
  return args[at] ?? '';
}

/** A repository with one commit, opened with a `run` tie that records the name of every command it starts */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-gits-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  let started: string[] = [];
  const repo = new GitRepository(root, { run: (file, args, options) => { started.push(nameOf(args)); return runUnbounded(file, args, options); } });
  repositories.push(repo);
  /** The commands `work` started, in the order they were started */
  const startedBy = async (work: () => Promise<unknown>): Promise<string[]> => {
    started = [];
    await work();
    return started;
  };
  return { root, repo, startedBy };
}

it('opens a repository with at most eight gits, ending with the status, the refs and where it is', async () => {
  const { repo, startedBy } = await repository();

  const opening = await startedBy(() => repo.readSnapshot());

  expect(opening.slice(-3)).toEqual(['status', 'for-each-ref', 'rev-parse']);
  expect(opening.length, opening.join(', ')).toBeLessThanOrEqual(8);
});

it('reads a whole status, unwatched, with the settings, the status and the refs', async () => {
  const { repo, startedBy } = await repository();
  await repo.readSnapshot();

  expect(await startedBy(() => repo.refreshSnapshot('everything'))).toEqual(['config', 'status', 'for-each-ref']);
});

it('reads a noted path with a snapshot held by a status of it alone', async () => {
  const { root, repo, startedBy } = await repository();
  repo.setWatched(true);
  await repo.readSnapshot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  repo.noteChanged(['a.txt']);

  expect(await startedBy(() => repo.refreshSnapshot('noted'))).toEqual(['status']);
});

it('reads everything after staging a file, watched', async () => {
  const { root, repo, startedBy } = await repository();
  repo.setWatched(true);
  await repo.readSnapshot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await repo.stageFiles(['a.txt']);

  expect(await startedBy(() => repo.readSnapshot())).toEqual(['config', 'status', 'for-each-ref']);
});

it('starts no git for a read with nothing noted, watched', async () => {
  const { repo, startedBy } = await repository();
  repo.setWatched(true);
  await repo.readSnapshot();

  expect(await startedBy(() => repo.readSnapshot())).toEqual([]);
});
