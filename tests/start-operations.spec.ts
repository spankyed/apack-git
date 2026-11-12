// A merge, a rebase and a cherry-pick started here: each goes through, stops on a conflict that can be carried on
// with or given up, and once through can be undone, putting the branch and its files back. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** `main` and `topic` from one commit: `topic` adds `t.txt`, and `clash` changes `a.txt` as `main` does too */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-ops-')));
  directories.push(root);
  const store = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-ops-store-'))), 'store');
  directories.push(path.dirname(store));
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout.trim();
  const commit = async (file: string, content: string, message: string) => {
    fs.writeFileSync(path.join(root, file), content);
    await git('add', '-A');
    await git('commit', '--quiet', '-m', message);
  };
  await git('init', '--quiet', '--initial-branch=main');
  await commit('a.txt', 'one\n', 'base');
  await git('checkout', '--quiet', '-b', 'topic');
  await commit('t.txt', 'topic\n', 'on topic');
  await git('checkout', '--quiet', '-b', 'clash', 'main');
  await commit('a.txt', 'theirs\n', 'on clash');
  await git('checkout', '--quiet', 'main');
  await commit('a.txt', 'ours\n', 'on main');
  const repo = new GitRepository(root, { checkpointDirectory: () => store });
  return { root, git, repo, exists: (file: string) => fs.existsSync(path.join(root, file)) };
}
const refusal = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it was not refused'); }, (error: unknown) => error);

it('merges a branch, and undoing it puts the branch and its files back', async () => {
  const { git, repo, exists } = await repository();
  const before = await git('rev-parse', 'HEAD');

  await repo.merge('topic');
  expect(await git('rev-list', '--parents', '-n', '1', 'HEAD')).toMatch(/^\w+ \w+ \w+$/);
  expect(exists('t.txt')).toBe(true);

  expect(await repo.undo()).toMatchObject({ operation: 'merge', summary: 'merge topic' });
  expect(await git('rev-parse', 'HEAD')).toBe(before);
  expect(exists('t.txt'), 'and what it brought is gone').toBe(false);
  expect(await git('status', '--porcelain')).toBe('');
});

it('stops a merge on a conflict, which can be given up', async () => {
  const { git, repo } = await repository();

  const refused = await refusal(repo.merge('clash'));
  expect((refused as GitError).code).toBe('conflict');
  expect((await repo.readSnapshot()).operation).toMatchObject({ kind: 'merge' });

  await repo.moveOperation('abort');
  expect((await repo.readSnapshot()).operation).toBeUndefined();
  expect(await git('status', '--porcelain')).toBe('');
});

it('rebases onto a branch, and undoing it puts the branch back', async () => {
  const { git, repo, exists } = await repository();
  await git('checkout', '--quiet', 'topic');
  const before = await git('rev-parse', 'HEAD');

  await repo.rebaseOnto('main');
  expect(await git('merge-base', '--is-ancestor', 'main', 'HEAD').then(() => true, () => false)).toBe(true);
  expect(exists('t.txt')).toBe(true);

  await repo.undo();
  expect(await git('rev-parse', 'HEAD')).toBe(before);
});

it('cherry-picks a commit, stops on one that conflicts, and carries on once it is settled', async () => {
  const { root, git, repo, exists } = await repository();

  await repo.cherryPick([await git('rev-parse', 'topic')]);
  expect(exists('t.txt')).toBe(true);
  expect(await repo.lastUndoable()).toMatchObject({ operation: 'cherry-pick' });

  expect(((await refusal(repo.cherryPick([await git('rev-parse', 'clash')]))) as GitError).code).toBe('conflict');
  expect((await repo.readSnapshot()).operation).toMatchObject({ kind: 'cherry-pick' });
  await repo.resolveConflict('a.txt', { content: 'both\n' });
  await repo.moveOperation('continue');

  expect((await repo.readSnapshot()).operation).toBeUndefined();
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('both\n');
  expect(await git('log', '-1', '--format=%s')).toBe('on clash');
});
