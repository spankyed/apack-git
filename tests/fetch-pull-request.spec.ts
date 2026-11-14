// What a pull request proposes, fetched from where GitHub keeps it (`refs/pull/<number>/head`) rather than by its
// branch's name: GitHub keeps that ref after the branch is deleted, and for a pull request from a fork, whose
// branch is on no remote here. The remote is a real bare repository serving the ref as GitHub does.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();

it('fetches a pull request whose branch is gone from the ref GitHub keeps, and refuses one the remote has not', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-pull-ref-')));
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
  // The pull request's branch, pushed, opened as #1, then deleted: what the remote keeps is the pull ref alone
  await git(author, 'checkout', '--quiet', '-b', 'feature');
  fs.writeFileSync(path.join(author, 'b.txt'), 'two\n');
  await git(author, 'add', '.');
  await git(author, 'commit', '--quiet', '-m', 'second');
  const proposed = await git(author, 'rev-parse', 'HEAD');
  await git(author, 'push', '--quiet', 'origin', 'feature', 'feature:refs/pull/1/head');
  await git(author, 'push', '--quiet', 'origin', '--delete', 'feature');
  await run('git', ['clone', '--quiet', remote, checkout]);
  const repo = new GitRepository(checkout);

  const ref = await repo.fetchPullRequest(1);

  expect(ref).toBe('refs/remotes/origin/pull/1');
  expect(await git(checkout, 'rev-parse', ref)).toBe(proposed);
  expect((await repo.readBranchDiff('main', ref)).map(file => file.path), 'and its changes read against the base').toEqual(['b.txt']);

  const missing = await repo.fetchPullRequest(2).then(() => undefined, (error: unknown) => error);
  expect(missing).toBeInstanceOf(GitError);
  await expect(repo.fetchPullRequest(0)).rejects.toThrow('Invalid pull request number: 0');
  repo.close?.();
});
