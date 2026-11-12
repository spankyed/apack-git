// What git does around a command decides what the commit panel can rely on: how much it prints, what language it
// prints in, what its hooks leave running, and whether it is there at all. Every case runs a real git.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository, STATUS_LIMIT } from '../src/index.ts';
import { removeDirectory } from './_support/remove.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout.trim();
const write = (root: string, file: string, content = '') => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
/** Sets environment variables for the rest of the case */
function environment(values: Record<string, string>) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  cleanups.push(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
/** A hook that runs `body` in the repository's root */
function hook(root: string, name: string, body: string) {
  const file = path.join(root, '.git', 'hooks', name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}
/** Waits, in a hook, until the case writes `release` */
// Ends when it is released, and when its repository is gone: a case's cleanup releases it and then deletes the
// repository at once, and a loop that looked only for the file never saw it and ran on with nowhere to look
const UNTIL_RELEASED = 'while [ ! -f ./release ] && [ -e ./.git ]; do sleep 0.1; done';

/** A repository on `main` with one commit, whose commits need no user configuration */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-robust-')));
  cleanups.push(() => removeDirectory(root));
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await git(root, 'config', 'user.name', 'spec');
  await git(root, 'config', 'user.email', 'spec@example.com');
  write(root, 'a.txt', 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  // Trusted, since cases here write hooks of their own for git to run
  return { root, repo: new GitRepository(root, { isTrusted: () => true }) };
}

it('lists the first changed files and says there are more, where git reports more than it lists', async () => {
  const { root, repo } = await repository();
  // Each of these is a row of its own where the user has git list every file: a folder git tracks nothing in is
  // otherwise one row, however many files it holds
  await git(root, 'config', 'status.showUntrackedFiles', 'all');
  for (let i = 0; i < STATUS_LIMIT + 25; i++) write(root, `untracked/${Math.floor(i / 500)}/file-${i}.txt`);

  const snapshot = await repo.readSnapshot();
  expect(snapshot.files).toHaveLength(STATUS_LIMIT);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.branch).toBe('main');
});

it('says a short list of changes is the whole of it', async () => {
  const { root, repo } = await repository();
  write(root, 'new.txt');
  expect(await repo.readSnapshot()).toMatchObject({ truncated: false, files: [{ path: 'new.txt' }] });
});

it('lists branches by name, whatever git would draw beside them', async () => {
  const { root, repo } = await repository();
  await git(root, 'branch', 'feature/in-a-worktree');
  await git(root, 'branch', 'plain');
  const worktree = `${root}-worktree`;
  await git(root, 'worktree', 'add', '--quiet', worktree, 'feature/in-a-worktree');
  cleanups.push(() => removeDirectory(worktree));
  // A detached HEAD, which `git branch` lists as a line of its own
  await git(root, 'checkout', '--quiet', '--detach');

  expect((await repo.getAllBranches()).sort()).toEqual(['feature/in-a-worktree', 'main', 'plain']);
});

it('reads what a failure means whatever language the user reads git in', async () => {
  const { root, repo } = await repository();
  environment({ LC_ALL: 'de_DE.UTF-8', LANG: 'de_DE.UTF-8', LANGUAGE: 'de' });

  // Checking out a branch that does not exist creates it, which is decided by what git says of the first try
  await repo.checkoutBranch('brand-new');
  expect(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('brand-new');
});

it('answers a read while a write is still running', async () => {
  const { root, repo } = await repository();
  hook(root, 'pre-commit', UNTIL_RELEASED);
  cleanups.push(() => write(root, 'release'));
  write(root, 'a.txt', 'two\n');
  await repo.stageFiles(['a.txt']);

  let committed = false;
  const committing = repo.commit('second').then(() => { committed = true; });
  const snapshot = await repo.readSnapshot();
  expect(committed, 'the commit is still held by its hook').toBe(false);
  expect(snapshot.files).toEqual([{ path: 'a.txt', status: 'modified', staged: true, originalPath: undefined }]);

  write(root, 'release');
  await committing;
});

it('answers a command once git has exited, though a hook left a process holding its output', async () => {
  const { root, repo } = await repository();
  hook(root, 'post-commit', `(${UNTIL_RELEASED}) &`);
  cleanups.push(() => write(root, 'release'));
  write(root, 'a.txt', 'two\n');
  await repo.stageFiles(['a.txt']);

  await repo.commit('second');
  expect(fs.existsSync(path.join(root, 'release')), 'the process the hook left is still running').toBe(false);
  expect(await git(root, 'log', '-1', '--format=%s')).toBe('second');
});

it('says git is not installed, and not that the directory is no repository', async () => {
  const { repo } = await repository();
  environment({ PATH: '/nonexistent' });
  await expect(repo.isGitRepository()).rejects.toThrow('Git is not installed');
});

it('reads a commit, a stash and a range whose text holds what could pass for a separator', async () => {
  const { root, repo } = await repository();
  await git(root, 'checkout', '--quiet', '-b', 'topic');
  write(root, 'a.txt', 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'a|||b ---RECORD_SEP--- c', '-m', 'body line one\n\nbody ||| line two');
  write(root, 'a.txt', 'three\n');
  await git(root, 'stash', 'push', '--quiet', '-m', 'wip ||| with bars');

  const [latest, first] = await repo.gitLog(5);
  expect(latest).toMatchObject({ subject: 'a|||b ---RECORD_SEP--- c', body: 'body line one\n\nbody ||| line two', authorName: 'spec' });
  expect(first).toMatchObject({ subject: 'first', body: '' });
  expect(await repo.getCommitsBetweenBranches('main', 'topic')).toEqual([{ subject: 'a|||b ---RECORD_SEP--- c', body: 'body line one\n\nbody ||| line two' }]);
  expect(await repo.stashList()).toMatchObject([{ index: 0, ref: 'stash@{0}', message: 'On topic: wip ||| with bars' }]);
});
