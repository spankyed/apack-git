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

it('opens a repository with the same five gits on every git, asking where it is once', async () => {
  const { repo, startedBy } = await repository();

  expect(await startedBy(() => repo.readSnapshot())).toEqual(['--version', 'rev-parse', 'config', 'status', 'for-each-ref']);
});

it('takes the settings afresh, with the status and the refs, when told to look again', async () => {
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

it('reads the status alone after staging a file, watched, since staging moves no ref', async () => {
  const { root, repo, startedBy } = await repository();
  repo.setWatched(true);
  await repo.readSnapshot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await repo.stageFiles(['a.txt']);

  expect(await startedBy(() => repo.readSnapshot())).toEqual(['status']);
});

it('reads the status alone after a report that git\'s index changed, watched', async () => {
  const { repo, startedBy } = await repository();
  repo.setWatched(true);
  await repo.readSnapshot();
  repo.noteChanged('index');

  expect(await startedBy(() => repo.readSnapshot())).toEqual(['status']);
});

it('reads the status and the refs when anything may have changed, with the settings held', async () => {
  const { repo, startedBy } = await repository();
  repo.setWatched(true);
  await repo.readSnapshot();
  repo.noteChanged(null);

  expect(await startedBy(() => repo.readSnapshot())).toEqual(['status', 'for-each-ref']);
});

it('takes a checkpoint, once opened, without asking again where the repository is', async () => {
  const { repo, startedBy } = await repository();
  await repo.readSnapshot();

  expect(await startedBy(() => repo.checkpoint())).not.toContain('rev-parse');
});

it('starts no git for a read with nothing noted, watched', async () => {
  const { repo, startedBy } = await repository();
  repo.setWatched(true);
  await repo.readSnapshot();

  expect(await startedBy(() => repo.readSnapshot())).toEqual([]);
});

it('runs read commands without hook tracing and with GIT_NO_LAZY_FETCH, and branch mutations in the write lane', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-lanes-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  await git('branch', 'temp');
  const head = await git('rev-parse', 'HEAD');
  const seen: { cmd: string; hasTrace: boolean; noLazy: string | undefined }[] = [];
  const repo = new GitRepository(root, {
    run: (file, args, options) => {
      seen.push({ cmd: nameOf(args), hasTrace: Boolean(options.env.GIT_TRACE2_EVENT), noLazy: options.env.GIT_NO_LAZY_FETCH });
      return runUnbounded(file, args, options);
    },
  });
  repositories.push(repo);

  await repo.readSnapshot();
  await repo.blame('a.txt');
  await repo.changesIn(head);
  await repo.trailersIn('subj\n\nSigned-off-by: A <a@b>');
  await repo.deleteBranch('temp');

  for (const readCmd of ['config', 'blame', 'diff-tree', 'interpret-trailers']) {
    const calls = seen.filter(entry => entry.cmd === readCmd);
    expect(calls.length, `${readCmd} ran`).toBeGreaterThan(0);
    expect(calls.every(entry => !entry.hasTrace), `${readCmd} creates no hook trace`).toBe(true);
  }
  for (const lazyRead of ['blame', 'diff-tree', 'interpret-trailers']) {
    expect(seen.filter(entry => entry.cmd === lazyRead).every(entry => entry.noLazy === '1'), `${lazyRead} sets GIT_NO_LAZY_FETCH=1`).toBe(true);
  }
  const branchDel = seen.filter(entry => entry.cmd === 'branch');
  expect(branchDel.length).toBeGreaterThan(0);
  expect(branchDel.every(entry => entry.hasTrace && entry.noLazy === undefined), 'deleteBranch runs in write lane').toBe(true);
});
