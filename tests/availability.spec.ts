// What can be done now, and why not, read from the snapshot of a real repository in each state: every reason has a
// state that gives it and one that does not.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';
import { whatCanBeDone } from '../src/availability.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const temporary = (name: string) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-can-${name}-`)));
  directories.push(directory);
  return directory;
};

/** A clone of a remote with one commit, `main` following `origin/main`, and the state of each asked of the engine */
async function cloned() {
  const remote = temporary('remote');
  const root = path.join(temporary('clone'), 'clone');
  const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args]).catch(error => error)).stdout?.trim();
  const commit = async (cwd: string, file: string, content: string) => {
    fs.writeFileSync(path.join(cwd, file), content);
    await git(cwd, 'add', '-A');
    await git(cwd, 'commit', '--quiet', '-m', `${file}: ${content.trim()}`);
  };
  await git(remote, 'init', '--quiet', '--initial-branch=main');
  await commit(remote, 'a.txt', 'one');
  await run('git', ['clone', '--quiet', remote, root]);
  const can = async (repo = new GitRepository(root)) => whatCanBeDone(await repo.readSnapshot());
  return { remote, root, git, commit, can };
}

it('says a commit has nothing staged, until something is', async () => {
  const { root, git, can } = await cloned();

  expect((await can()).commit).toEqual({ possible: false, reason: 'nothing-staged' });
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await git(root, 'add', 'a.txt');
  expect((await can()).commit).toEqual({ possible: true });
});

it('says a commit has no identity to be written with, until git has one', async () => {
  const { root, git, can } = await cloned();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await git(root, 'add', 'a.txt');
  const empty = path.join(temporary('home'), 'gitconfig');
  fs.writeFileSync(empty, '');
  const nobody = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(AUTHOR|COMMITTER)_|^EMAIL$/.test(key)));
  const environment = () => ({ ...nobody, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' });

  expect((await can(new GitRepository(root, { environment }))).commit).toEqual({ possible: false, reason: 'no-identity' });
  await git(root, 'config', 'user.name', 'Someone');
  await git(root, 'config', 'user.email', 'someone@example.com');
  expect((await can(new GitRepository(root, { environment }))).commit).toEqual({ possible: true });
});

it('says a push has nothing to push, then can, then is refused once both sides moved on', async () => {
  const { remote, root, commit, can } = await cloned();

  expect((await can()).push).toEqual({ possible: false, reason: 'up-to-date' });
  await commit(root, 'b.txt', 'mine');
  expect((await can()).push).toEqual({ possible: true });
  await commit(remote, 'c.txt', 'theirs');
  await run('git', ['-C', root, 'fetch', '--quiet']);
  expect((await can()).push).toEqual({ possible: false, reason: 'diverged' });
  expect((await can()).pull, 'and a pull brings them together').toEqual({ possible: true });
});

it('says there is nothing to push to or pull from on a branch that follows nothing', async () => {
  const { root, git, can } = await cloned();
  await git(root, 'checkout', '--quiet', '-b', 'alone');

  expect(await can()).toMatchObject({ push: { reason: 'no-upstream' }, pull: { reason: 'no-upstream' }, sync: { reason: 'no-upstream' } });
});

it('says conflicts wait to be settled, and what is under way waits to be carried on or given up', async () => {
  const { root, git, commit, can } = await cloned();
  await git(root, 'checkout', '--quiet', '-b', 'topic');
  await commit(root, 'a.txt', 'topic');
  await git(root, 'checkout', '--quiet', 'main');
  await commit(root, 'a.txt', 'main');
  await git(root, 'rebase', 'topic');

  const stopped = await can();
  expect(stopped.commit).toEqual({ possible: false, reason: 'conflicts' });
  expect(stopped.pull).toEqual({ possible: false, reason: 'conflicts' });
  expect(stopped.push).toEqual({ possible: false, reason: 'operation-in-progress' });
  await git(root, 'rebase', '--abort');
  expect((await can()).push, 'and once given up, it can be pushed').toEqual({ possible: true });
});
