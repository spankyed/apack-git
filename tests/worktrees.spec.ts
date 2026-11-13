// A checkout's worktrees: listed with the main one first and the one asked from marked, and removed, a worktree
// holding changes only when told to; and where a checkout's own git state and the shared one live. Every git is a
// real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A repository on `main` with one commit, and the path beside it a linked worktree is made at */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-worktrees-')));
  const linked = `${root}-linked`;
  directories.push(root, linked);
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  return { root, linked, git, repo: new GitRepository(root) };
}

it('lists the worktrees with the main one first and the one asked from marked, and removes one', async () => {
  const { root, linked, repo } = await repository();
  await repo.worktreeAdd(linked, 'topic', true);
  const listed = async (from: GitRepository) => (await from.worktreeList())
    .map(({ path: at, branch, isMain, isCurrent }) => ({ at: path.resolve(at), branch, isMain, isCurrent }));

  expect(await listed(repo)).toEqual([
    { at: root, branch: 'main', isMain: true, isCurrent: true },
    { at: linked, branch: 'topic', isMain: false, isCurrent: false },
  ]);
  expect((await listed(new GitRepository(linked))).map(({ at, isCurrent }) => [at, isCurrent])).toEqual([[root, false], [linked, true]]);

  await repo.worktreeRemove(linked);
  expect(fs.existsSync(linked)).toBe(false);
  expect(await listed(repo)).toEqual([{ at: root, branch: 'main', isMain: true, isCurrent: true }]);
});

it('removes a worktree holding changes only when told to', async () => {
  const { linked, repo } = await repository();
  await repo.worktreeAdd(linked, 'topic', true);
  fs.writeFileSync(path.join(linked, 'a.txt'), 'changed there\n');

  await expect(repo.worktreeRemove(linked)).rejects.toThrow();
  expect(fs.readFileSync(path.join(linked, 'a.txt'), 'utf8'), 'and the change is where it was').toBe('changed there\n');

  await repo.worktreeRemove(linked, true);
  expect(fs.existsSync(linked)).toBe(false);
});

it('says where a checkout\'s own git state lives and where the state it shares does, and nothing outside a repository', async () => {
  const { root, linked, repo } = await repository();
  await repo.worktreeAdd(linked, 'topic', true);
  fs.mkdirSync(path.join(root, 'sub'));
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-worktrees-outside-')));
  directories.push(outside);
  const common = path.join(root, '.git');

  expect(await repo.resolveGitDirectories()).toEqual({ gitDir: common, commonDir: common, prefix: '' });
  expect(await new GitRepository(path.join(root, 'sub')).resolveGitDirectories()).toEqual({ gitDir: common, commonDir: common, prefix: 'sub/' });
  expect(await new GitRepository(linked).resolveGitDirectories())
    .toEqual({ gitDir: path.join(common, 'worktrees', path.basename(linked)), commonDir: common, prefix: '' });
  expect(await new GitRepository(outside).resolveGitDirectories()).toBeNull();
});
