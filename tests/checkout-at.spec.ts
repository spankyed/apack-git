// Checking out a branch at a commit, as a pull request's head is checked out: made where there is none, moved
// forward where it is only behind, left where it has commits of its own, and following only what it was told to.
// And every remote, with its address as git would use it.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository } from '../src/index.ts';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
const gitFails = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, ...args]).then(() => false, () => true);

/** A remote with `main` and a pull request #1 from a branch it no longer has, and a clone of it */
async function cloned() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-checkout-at-')));
  directories.push(root);
  const remote = path.join(root, 'remote.git');
  const author = path.join(root, 'author');
  const checkout = path.join(root, 'checkout');
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  await run('git', ['init', '--quiet', '--initial-branch=main', author]);
  fs.writeFileSync(path.join(author, 'a.txt'), 'one\n');
  await git(author, 'add', '.');
  await git(author, 'commit', '--quiet', '-m', 'first');
  await git(author, 'remote', 'add', 'origin', remote);
  await git(author, 'push', '--quiet', 'origin', 'main');
  await run('git', ['clone', '--quiet', remote, checkout]);
  const repo = new GitRepository(checkout);
  repositories.push(repo);
  /** Commits `file` on `branch` of the author's and pushes it there, or to `to` */
  const proposes = async (branch: string, file: string, to = branch) => {
    await git(author, 'checkout', '--quiet', '-B', branch);
    fs.writeFileSync(path.join(author, file), `${file}\n`);
    await git(author, 'add', '.');
    await git(author, 'commit', '--quiet', '-m', file);
    await git(author, 'push', '--quiet', '--force', 'origin', `${branch}:${to}`);
    return git(author, 'rev-parse', 'HEAD');
  };
  return { remote, checkout, repo, proposes };
}

it('makes a branch at a pull request\'s ref following nothing, and moves it forward when the pull request does', async () => {
  const { checkout, repo, proposes } = await cloned();
  const first = await proposes('fork-topic', 'b.txt', 'refs/pull/1/head');
  const ref = await repo.fetchPullRequest(1);

  expect(await repo.checkoutBranchAt('pr/1', ref)).toBe('created');
  expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(first);
  expect(await git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('pr/1');
  // git would otherwise set it to follow `origin/pull/1`, a remote branch there is none of
  expect(await gitFails(checkout, 'config', '--get', 'branch.pr/1.merge'), 'it follows nothing').toBe(true);

  expect(await repo.checkoutBranchAt('pr/1', ref), 'checked out again, at it').toBe('current');

  await git(checkout, 'checkout', '--quiet', 'main');
  const second = await proposes('fork-topic', 'c.txt', 'refs/pull/1/head');
  await repo.fetchPullRequest(1);
  expect(await repo.checkoutBranchAt('pr/1', ref)).toBe('fast-forwarded');
  expect(await git(checkout, 'rev-parse', 'pr/1')).toBe(second);
  expect(await git(checkout, 'symbolic-ref', '--short', 'HEAD')).toBe('pr/1');
});

it('leaves a branch with commits of its own where it is, and checks it out', async () => {
  const { checkout, repo, proposes } = await cloned();
  await proposes('topic', 'b.txt');
  const head = await repo.fetchRemoteBranch('topic');
  expect(await repo.checkoutBranchAt('topic', head, { track: true })).toBe('created');
  expect(await git(checkout, 'rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'told to, it follows the remote\'s branch').toBe('origin/topic');

  fs.writeFileSync(path.join(checkout, 'mine.txt'), 'mine\n');
  await git(checkout, 'add', '.');
  await git(checkout, 'commit', '--quiet', '-m', 'mine');
  const mine = await git(checkout, 'rev-parse', 'HEAD');
  await git(checkout, 'checkout', '--quiet', 'main');
  await proposes('topic', 'c.txt');
  await repo.fetchRemoteBranch('topic');

  expect(await repo.checkoutBranchAt('topic', head, { track: true })).toBe('kept');
  expect(await git(checkout, 'rev-parse', 'HEAD'), 'the commit of its own is not lost').toBe(mine);
  expect(await git(checkout, 'rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'and it follows what it followed').toBe('origin/topic');
});

it('refuses a commit that is not here, and a checkout over changes it would lose', async () => {
  const { checkout, repo, proposes } = await cloned();
  const missing = await repo.checkoutBranchAt('pr/2', 'refs/remotes/origin/pull/2').then(() => undefined, (error: unknown) => error);
  expect(missing).toBeInstanceOf(GitError);
  expect((missing as GitError).code).toBe('unknown-ref');
  expect(await gitFails(checkout, 'rev-parse', '--verify', 'refs/heads/pr/2'), 'no branch was made').toBe(true);

  // The pull request changes a.txt, which is changed here too and not committed
  await proposes('topic', 'a.txt', 'refs/pull/3/head');
  const ref = await repo.fetchPullRequest(3);
  fs.writeFileSync(path.join(checkout, 'a.txt'), 'changed here\n');
  const refused = await repo.checkoutBranchAt('pr/3', ref).then(() => undefined, (error: unknown) => error);
  expect((refused as GitError).code).toBe('local-changes');
  expect(fs.readFileSync(path.join(checkout, 'a.txt'), 'utf8')).toBe('changed here\n');
  await expect(repo.checkoutBranchAt('-x', ref)).rejects.toThrow('Invalid branch name');
});

it('lists every remote with its address as git would use it', async () => {
  const { checkout, remote, repo } = await cloned();
  await git(checkout, 'remote', 'add', 'upstream', 'gh:octo/repo');
  await git(checkout, 'config', 'url.https://github.com/.insteadOf', 'gh:');

  expect(await repo.readRemotes()).toEqual([
    { name: 'origin', url: remote },
    { name: 'upstream', url: 'https://github.com/octo/repo' },
  ]);
});
