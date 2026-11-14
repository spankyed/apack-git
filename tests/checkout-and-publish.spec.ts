// Checking out a branch moves to it and does nothing else; a branch only a remote has is made to follow it, and a
// name no branch has is refused rather than made. Publishing a branch goes to the remote it is set to push to, else
// the one there is, and is refused in words where there is none to choose or no branch to push. A remote-tracking
// ref is deleted without asking the remote. Every git is a real one, with real remotes on this machine.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
const refusal = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it did not fail'); }, (error: Error & { code?: string }) => ({ code: error.code, message: error.message }));

/** A checkout with one commit on `main` and the given remotes, each a bare repository holding `main` */
async function checkout(remotes: string[]) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-publish-')));
  directories.push(root);
  const work = path.join(root, 'work');
  await run('git', ['init', '--quiet', '--initial-branch=main', work]);
  await git(work, 'config', 'credential.helper', '');
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

/** A commit on `branch` of the remote `name`, made from a clone of it, which the checkout has not fetched */
async function commitOnRemote(root: string, name: string, branch: string) {
  const other = path.join(root, `other-${name}`);
  await run('git', ['clone', '--quiet', path.join(root, `${name}.git`), other]);
  await git(other, 'checkout', '--quiet', '-B', branch);
  fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
  await git(other, 'add', '.');
  await git(other, 'commit', '--quiet', '-m', 'theirs');
  await git(other, 'push', '--quiet', 'origin', branch);
  return git(other, 'rev-parse', 'HEAD');
}

it('checks out a branch and pulls nothing, though its remote has moved on', async () => {
  const { root, work, repo } = await checkout(['origin']);
  await git(work, 'branch', '--quiet', '--set-upstream-to=origin/main');
  await git(work, 'checkout', '--quiet', '-b', 'side');
  const here = await git(work, 'rev-parse', 'main');
  await commitOnRemote(root, 'origin', 'main');
  await git(work, 'fetch', '--quiet', 'origin');

  await repo.checkoutBranch('main');

  expect((await repo.readSnapshot()).branch).toBe('main');
  expect(await git(work, 'rev-parse', 'HEAD'), 'the branch is where it was: nothing was merged into it').toBe(here);
  expect(fs.existsSync(path.join(work, 'theirs.txt'))).toBe(false);
});

it('makes a branch only one remote has follow that remote, whatever it is called', async () => {
  const { root, work, repo } = await checkout(['upstream']);
  const theirs = await commitOnRemote(root, 'upstream', 'feature');
  await git(work, 'fetch', '--quiet', 'upstream');

  await repo.checkoutBranch('feature');

  expect(await git(work, 'rev-parse', 'HEAD')).toBe(theirs);
  expect(await git(work, 'rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('upstream/feature');
});

it('publishes to the only remote when it is not origin, and the branch then follows it', async () => {
  const { root, work, repo } = await checkout(['fork']);
  await repo.createBranch('topic');

  await repo.pushBranch();

  expect(await git(path.join(root, 'fork.git'), 'rev-parse', 'topic')).toBe(await git(work, 'rev-parse', 'HEAD'));
  expect(await git(work, 'rev-parse', '--abbrev-ref', 'topic@{upstream}')).toBe('fork/topic');
});

it('publishes to the remote the repository is set to push to, among several', async () => {
  const { root, work, repo } = await checkout(['origin', 'fork']);
  await git(work, 'config', 'remote.pushDefault', 'fork');
  await repo.createBranch('topic');

  await repo.pushBranch();

  expect(await git(path.join(root, 'fork.git'), 'branch', '--list', 'topic')).toContain('topic');
  expect(await git(path.join(root, 'origin.git'), 'branch', '--list', 'topic'), 'not to origin').toBe('');
});

it('refuses to publish where there is no remote to choose, saying which', async () => {
  const none = await checkout([]);
  await none.repo.createBranch('topic');
  expect(await refusal(none.repo.pushBranch())).toMatchObject({ code: 'no-remote', message: expect.stringContaining('no remote') });

  const two = await checkout(['fork', 'upstream']);
  await two.repo.createBranch('topic');
  expect(await refusal(two.repo.pushBranch())).toMatchObject({ code: 'no-remote', message: expect.stringContaining('fork, upstream') });
});

it('refuses to push with no branch checked out, in words', async () => {
  const { work, repo } = await checkout(['origin']);
  await git(work, 'checkout', '--quiet', '--detach');

  expect(await refusal(repo.pushBranch())).toMatchObject({ code: 'detached-head', message: expect.stringContaining('no branch') });
});

it('deletes the record of a branch on a remote without asking the remote', async () => {
  const { root, work, repo } = await checkout(['upstream']);
  await commitOnRemote(root, 'upstream', 'gone');
  await git(work, 'fetch', '--quiet', 'upstream');

  await repo.deleteRemoteTrackingBranch('gone', 'upstream');

  expect(await git(work, 'branch', '--remotes', '--list', 'upstream/gone')).toBe('');
  expect(await git(path.join(root, 'upstream.git'), 'branch', '--list', 'gone'), 'the remote still has it').toContain('gone');
  await expect(repo.deleteRemoteTrackingBranch('gone', 'upstream'), 'one already gone is no failure').resolves.toBeUndefined();
});
