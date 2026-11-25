// The settings are read once and held until a file they came from looks different. Each case reads a snapshot,
// changes a setting behind the engine, and says only that anything may have changed, as a watcher does: never "look
// again". What is held is a saving between two looks, and each of these is a way it could have gone stale.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.js';
import { removeDirectory } from './_support/remove.js';
import { GitRepository, type RepositoryTies } from '../src/index.js';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map(repo => repo.close()));
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

const temporary = (name: string) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-settings-${name}-`)));
  directories.push(directory);
  return directory;
};

/** A repository with one commit and a folder git tracks nothing in, watched, with a snapshot read */
async function repository(ties: RepositoryTies = {}) {
  const root = temporary('repo');
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  fs.mkdirSync(path.join(root, 'fresh'));
  fs.writeFileSync(path.join(root, 'fresh', 'one.txt'), '1\n');
  fs.writeFileSync(path.join(root, 'fresh', 'two.txt'), '2\n');
  const repo = new GitRepository(root, ties);
  repositories.push(repo);
  repo.setWatched(true);
  return { root, git, repo };
}

/** The paths of the snapshot's untracked rows */
const untracked = async (repo: GitRepository) => (await repo.readSnapshot()).files.filter(file => file.status === 'untracked').map(file => file.path);

it('sees a setting changed in the repository\'s own configuration', async () => {
  const { git, repo } = await repository();
  expect(await untracked(repo)).toEqual(['fresh/']);

  await git('config', 'status.showUntrackedFiles', 'all');
  repo.noteChanged(null);

  expect(await untracked(repo)).toEqual(['fresh/one.txt', 'fresh/two.txt']);
});

it('sees a setting changed in a file the configuration includes', async () => {
  const { root, git, repo } = await repository();
  const included = path.join(root, '.git', 'extra.config');
  fs.writeFileSync(included, '[status]\n\tshowUntrackedFiles = normal\n');
  await git('config', 'include.path', 'extra.config');
  expect(await untracked(repo)).toEqual(['fresh/']);

  fs.writeFileSync(included, '[status]\n\tshowUntrackedFiles = all\n');
  repo.noteChanged(null);

  expect(await untracked(repo)).toEqual(['fresh/one.txt', 'fresh/two.txt']);
});

/** The environment the specs run git in, with no identity of its own and the user's settings in `global` */
const withoutIdentity = (global: () => string) => () => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: global() };
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[name];
  return env;
};

it('sees the user\'s settings made for the first time', async () => {
  const global = path.join(temporary('user'), 'gitconfig');
  const { repo } = await repository({ environment: withoutIdentity(() => global) });
  expect((await repo.readSnapshot()).hasIdentity).toBe(false);

  fs.writeFileSync(global, '[user]\n\tname = t\n\temail = t@t\n');
  repo.noteChanged(null);

  expect((await repo.readSnapshot()).hasIdentity).toBe(true);
});

it('sees the environment name another file of settings', async () => {
  const user = temporary('user');
  const without = path.join(user, 'without');
  const named = path.join(user, 'named');
  fs.writeFileSync(without, '');
  fs.writeFileSync(named, '[user]\n\tname = t\n\temail = t@t\n');
  let global = without;
  const { repo } = await repository({ environment: withoutIdentity(() => global) });
  expect((await repo.readSnapshot()).hasIdentity).toBe(false);

  global = named;
  repo.noteChanged(null);

  expect((await repo.readSnapshot()).hasIdentity).toBe(true);
});

it('takes the settings afresh when told to look again, as a file that set nothing is not watched for', async () => {
  const { root, git, repo } = await repository();
  const included = path.join(root, '.git', 'extra.config');
  fs.writeFileSync(included, '');
  await git('config', 'include.path', 'extra.config');
  expect(await untracked(repo)).toEqual(['fresh/']);

  fs.writeFileSync(included, '[status]\n\tshowUntrackedFiles = all\n');
  repo.noteChanged(null);
  expect(await untracked(repo), 'a file that set nothing is not known to the reading').toEqual(['fresh/']);

  await repo.refreshSnapshot('everything');
  expect(await untracked(repo)).toEqual(['fresh/one.txt', 'fresh/two.txt']);
});
