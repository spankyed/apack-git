// Rewriting the last commits: amending, and squashing, reordering, rewording and dropping a range, each leaving the
// tree's content as it was (a drop aside, which removes what its commit brought) and each undone. A range a remote
// branch holds is refused until told to go on. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A base commit, then four, each adding a file named for it */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-rewrite-')));
  directories.push(root);
  const store = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-rewrite-store-'))), 'store');
  directories.push(path.dirname(store));
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  for (const name of ['base', 'one', 'two', 'three', 'four']) {
    fs.writeFileSync(path.join(root, `${name}.txt`), `${name}\n`);
    await git('add', '.');
    await git('commit', '--quiet', '-m', name);
  }
  const commit = (back: number) => git('rev-parse', `HEAD~${back}`);
  return { root, git, commit, repo: new GitRepository(root, { checkpointDirectory: () => store }) };
}
const subjects = async (git: (...args: string[]) => Promise<string>) => (await git('log', '--format=%s', 'HEAD~4..HEAD')).split('\n').reverse();

it('amends the last commit\'s message and content, and undoing it leaves what it took in staged', async () => {
  const { root, git, repo } = await repository();
  const before = await git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'late.txt'), 'late\n');
  await git('add', 'late.txt');

  await repo.amend({ message: 'four, amended' });
  expect(await git('log', '-1', '--format=%s')).toBe('four, amended');
  expect(await git('ls-tree', '--name-only', 'HEAD')).toContain('late.txt');

  await repo.undo();
  expect(await git('rev-parse', 'HEAD')).toBe(before);
  expect(await git('diff', '--cached', '--name-only')).toBe('late.txt');
});

it('reorders, rewords and squashes a range, leaving the tree as it was, and is undone', async () => {
  const { git, commit, repo } = await repository();
  const tree = await git('rev-parse', 'HEAD^{tree}');
  const before = await git('rev-parse', 'HEAD');
  const [one, two, three, four] = [await commit(3), await commit(2), await commit(1), await commit(0)];

  await repo.rewrite(await commit(4), [
    { commit: two, action: 'pick' },
    { commit: one, action: 'reword', message: 'one, reworded' },
    { commit: three, action: 'pick' },
    { commit: four, action: 'squash', message: 'three and four' },
  ]);

  expect((await git('log', '--format=%s', 'HEAD~3..HEAD')).split('\n').reverse()).toEqual(['two', 'one, reworded', 'three and four']);
  expect(await git('rev-parse', 'HEAD^{tree}'), 'the tree is as it was').toBe(tree);

  await repo.undo();
  expect(await git('rev-parse', 'HEAD')).toBe(before);
  expect(await subjects(git)).toEqual(['one', 'two', 'three', 'four']);
});

it('drops a commit, removing what it brought, and is undone', async () => {
  const { root, commit, repo } = await repository();
  const [one, two, three, four] = [await commit(3), await commit(2), await commit(1), await commit(0)];

  await repo.rewrite(await commit(4), [
    { commit: one, action: 'pick' },
    { commit: two, action: 'drop' },
    { commit: three, action: 'pick' },
    { commit: four, action: 'pick' },
  ]);
  expect(fs.existsSync(path.join(root, 'two.txt'))).toBe(false);

  await repo.undo();
  expect(fs.existsSync(path.join(root, 'two.txt'))).toBe(true);
});

it('refuses to rewrite commits a remote branch holds, until told to go on', async () => {
  const { git, commit, repo } = await repository();
  const remote = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-rewrite-remote-')));
  directories.push(remote);
  await run('git', ['init', '--quiet', '--bare', remote]);
  await git('remote', 'add', 'origin', remote);
  await git('push', '--quiet', 'origin', 'main');
  const steps = [{ commit: await commit(1), action: 'pick' as const }, { commit: await commit(0), action: 'reword' as const, message: 'four, reworded' }];

  const refused = await repo.rewrite(await commit(2), steps).then(() => undefined, (error: unknown) => error);
  expect((refused as GitError).code).toBe('published');
  await expect(repo.amend({ message: 'x' })).rejects.toMatchObject({ code: 'published' });

  await repo.rewrite(await commit(2), steps, { evenIfPublished: true });
  expect(await git('log', '-1', '--format=%s')).toBe('four, reworded');
});
