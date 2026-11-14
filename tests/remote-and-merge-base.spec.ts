// Which remote a pull request or a push goes to, fetching and deleting a branch on that remote rather than on
// `origin` alone, a fetch that fails saying so, and the commit two histories last share. Every git is a real one,
// with real remotes on this machine.
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

/** A checkout with one commit and the given remotes, each a bare repository holding `main` */
async function checkout(remotes: string[]) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-remote-')));
  directories.push(root);
  const work = path.join(root, 'work');
  await run('git', ['init', '--quiet', '--initial-branch=main', work]);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '--quiet', '-m', 'first');
  for (const name of remotes) {
    const bare = path.join(root, `${name}.git`);
    await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    await git(work, 'remote', 'add', name, bare);
    await git(work, 'push', '--quiet', name, 'main');
  }
  return { root, work, repo: new GitRepository(work) };
}

it('reads the remote the branch follows, else origin, else the only one, and none where it cannot tell', async () => {
  const both = await checkout(['origin', 'upstream']);
  expect((await both.repo.readRemote())?.name, 'no branch followed: origin').toBe('origin');
  await git(both.work, 'branch', '--set-upstream-to=upstream/main');
  expect(await both.repo.readRemote()).toEqual({ name: 'upstream', url: path.join(both.root, 'upstream.git') });

  const one = await checkout(['fork']);
  expect((await one.repo.readRemote())?.name).toBe('fork');

  const two = await checkout(['fork', 'upstream']);
  expect(await two.repo.readRemote(), 'two remotes, neither followed nor origin').toBeUndefined();
  const none = await checkout([]);
  expect(await none.repo.readRemote()).toBeUndefined();
});

it('fetches and deletes a branch on the remote it is named, and says so when the fetch fails', async () => {
  const { work, repo } = await checkout(['origin', 'upstream']);
  await git(work, 'checkout', '--quiet', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'b.txt'), 'two\n');
  await git(work, 'add', '.');
  await git(work, 'commit', '--quiet', '-m', 'second');
  const pushed = await git(work, 'rev-parse', 'HEAD');
  await git(work, 'push', '--quiet', 'upstream', 'feature');
  await git(work, 'update-ref', '-d', 'refs/remotes/upstream/feature');

  expect(await repo.fetchRemoteBranch('feature', 'upstream')).toBe('refs/remotes/upstream/feature');
  expect(await git(work, 'rev-parse', 'refs/remotes/upstream/feature')).toBe(pushed);

  const missing = await repo.fetchRemoteBranch('feature').then(() => undefined, (error: unknown) => error);
  expect(missing, 'origin has no such branch').toBeInstanceOf(GitError);

  await repo.deleteRemoteBranch('feature', 'upstream');
  expect(await git(work, 'ls-remote', '--heads', 'upstream', 'feature')).toBe('');
});

it('answers the commit two histories last share', async () => {
  const { work, repo } = await checkout([]);
  const shared = await git(work, 'rev-parse', 'HEAD');
  await git(work, 'checkout', '--quiet', '-b', 'feature');
  await git(work, 'commit', '--quiet', '--allow-empty', '-m', 'on feature');
  await git(work, 'checkout', '--quiet', 'main');
  await git(work, 'commit', '--quiet', '--allow-empty', '-m', 'on main');

  expect(await repo.mergeBase('main', 'feature')).toBe(shared);
  expect(await repo.mergeBase('main', 'no-such-branch')).toBeUndefined();
});
