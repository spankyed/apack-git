// The failures a commit panel meets that it can say more of than git does, each named by a code. Every case fails
// a real git the way a user's does. A hosting service's refusal is the one that cannot be produced on a machine:
// the remote here is a real one whose hook prints GitHub's words, as `dugite` 3.3.3 matches them (its
// `lib/errors.ts`, read 2026-11-11), and git carries them back as it carries a host's.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
function scratch(prefix: string): string {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

/** A repository with one commit on `main` */
async function repository(prefix = 'apack-named-') {
  const root = scratch(prefix);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  return root;
}
const refusal = (attempt: Promise<unknown>) => attempt.then(
  () => { throw new Error('it did not fail'); },
  (error: Error & { code?: string }) => ({ code: error.code, message: error.message }),
);

it('says a commit could not be signed', async () => {
  const root = await repository();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await git(root, 'add', '.');
  // As the user's own configuration would ask it, where the repository's would be one to trust first
  const signing = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: path.join(root, 'no-such-signer') };
  const repo = new GitRepository(root, { environment: () => ({ ...process.env, ...signing }) });

  expect(await refusal(repo.commit('second'))).toMatchObject({ code: 'signing-failed' });
});

it('says there was nothing to commit', async () => {
  const root = await repository();

  expect(await refusal(new GitRepository(root).commit('nothing'))).toMatchObject({ code: 'nothing-to-commit' });
});

it('says a pull would merge a branch that shares no commit with this one', async () => {
  const root = await repository();
  // A first commit of its own: one with the same file, author and second would be the same commit
  const other = scratch('apack-named-other-');
  await git(other, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(other, 'b.txt'), 'theirs\n');
  await git(other, 'add', '.');
  await git(other, 'commit', '--quiet', '-m', 'theirs');
  await git(root, 'config', 'pull.rebase', 'false');
  await git(root, 'remote', 'add', 'origin', other);
  await git(root, 'fetch', '--quiet', 'origin');
  await git(root, 'branch', '--quiet', '--set-upstream-to=origin/main', 'main');

  expect(await refusal(new GitRepository(root).pullBranch())).toMatchObject({ code: 'unrelated-histories' });
});

it('says a branch of that name already exists', async () => {
  const root = await repository();
  await git(root, 'branch', 'topic');
  const elsewhere = path.join(scratch('apack-named-worktrees-'), 'topic');

  expect(await refusal(new GitRepository(root).worktreeAdd(elsewhere, 'topic', true))).toMatchObject({ code: 'branch-exists' });
});

it.each([
  ['a file too large', 'GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.'],
  ['a protected branch', 'GH006: Protected branch update failed for refs/heads/main.'],
  ['a private email address', 'GH007: Your push would publish a private email address.'],
  ['a secret in it', 'GH013: Repository rule violations found for refs/heads/main.'],
])('says the host refused a push for %s, keeping its words', async (_reason, said) => {
  const root = await repository();
  const remote = scratch('apack-named-host-');
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  const hook = path.join(remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, `#!/bin/sh\necho 'error: ${said}' >&2\nexit 1\n`);
  fs.chmodSync(hook, 0o755);
  await git(root, 'remote', 'add', 'origin', remote);

  const refused = await refusal(new GitRepository(root).pushBranch());

  expect(refused.code).toBe('host-refused');
  expect(refused.message).toContain(said.split(':')[0]);
});
