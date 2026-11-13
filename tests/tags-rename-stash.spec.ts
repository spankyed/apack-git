// Tags made, pushed and deleted; a branch renamed with what it follows; and a stash of chosen paths, or of only what
// is staged. Each is held to what git reports afterwards. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository, StashConflictError } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-tags-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  for (const name of ['a', 'b']) {
    fs.writeFileSync(path.join(root, `${name}.txt`), `${name}\n`);
    await git('add', '.');
    await git('commit', '--quiet', '-m', name);
  }
  return { root, git, repo: new GitRepository(root) };
}

it('makes, pushes and deletes tags, plain and annotated', async () => {
  const { git, repo } = await repository();
  const remote = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-tags-remote-')));
  directories.push(remote);
  await run('git', ['init', '--quiet', '--bare', remote]);
  await git('remote', 'add', 'origin', remote);

  await repo.createTag('plain', { commit: await git('rev-parse', 'HEAD~1') });
  await repo.createTag('v1', { message: 'the first' });
  expect(await git('cat-file', '-t', 'v1')).toBe('tag');
  expect(await git('rev-parse', 'plain')).toBe(await git('rev-parse', 'HEAD~1'));

  await repo.pushTag('v1');
  expect((await run('git', ['-C', remote, 'tag', '--list'])).stdout.trim()).toBe('v1');

  await repo.deleteTag('plain');
  expect(await git('tag', '--list')).toBe('v1');
});

it('renames a branch with what it follows, and refuses a name a branch has', async () => {
  const { git, repo } = await repository();
  await git('branch', 'topic');
  await git('config', 'branch.topic.remote', 'origin');
  await git('config', 'branch.topic.merge', 'refs/heads/topic');
  await git('branch', 'taken');

  await repo.renameBranch('topic', 'renamed');
  expect(await git('branch', '--list', 'topic', 'renamed', '--format=%(refname:short)')).toBe('renamed');
  expect(await git('config', 'branch.renamed.merge')).toBe('refs/heads/topic');

  const refused = await repo.renameBranch('renamed', 'taken').then(() => undefined, (error: unknown) => error);
  expect((refused as GitError).code).toBe('branch-exists');
});

it('stashes only the paths it is given, and only what is staged when asked', async () => {
  const { root, git, repo } = await repository();
  fs.writeFileSync(path.join(root, 'a.txt'), 'a, changed\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b, changed\n');

  await repo.stashPush('just a', false, ['a.txt']);
  expect(await git('stash', 'show', '--name-only', 'stash@{0}')).toBe('a.txt');
  expect(await git('status', '--porcelain')).toBe('M b.txt');

  await git('add', 'b.txt');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a, changed again\n');
  await repo.stashPush('what is staged', true);
  expect(await git('stash', 'show', '--name-only', 'stash@{0}')).toBe('b.txt');
  expect(await git('status', '--porcelain')).toBe('M a.txt');
});

it('applies a stash and keeps it, pops one and drops it, and says one that conflicts was applied with conflicts and kept', async () => {
  const { root, git, repo } = await repository();
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'stashed\n');
  await git('stash', 'push', '--quiet');

  await repo.stashApply(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('stashed\n');
  expect(await git('stash', 'list', '--format=%s'), 'applied, and kept').not.toBe('');
  await git('checkout', '--', 'a.txt');
  await repo.stashPop(0);
  expect(fs.readFileSync(file, 'utf8')).toBe('stashed\n');
  expect(await git('stash', 'list'), 'popped, and dropped').toBe('');

  // The line the stash changes was changed by a commit since
  await git('stash', 'push', '--quiet');
  fs.writeFileSync(file, 'committed\n');
  await git('commit', '--quiet', '-am', 'committed');
  for (const [name, take] of [['apply', () => repo.stashApply(0)], ['pop', () => repo.stashPop(0)]] as const) {
    const conflicted = await take().then(() => undefined, (error: unknown) => error);
    expect(conflicted, name).toBeInstanceOf(StashConflictError);
    expect(conflicted, `${name}: a conflict, by the code every git error carries`).toMatchObject({ code: 'conflict' });
    expect((await repo.readSnapshot()).files, `${name}: the file is in conflict`).toMatchObject([{ path: 'a.txt', status: 'unmerged' }]);
    expect(await git('stash', 'list', '--format=%s'), `${name}: and the stash is kept`).not.toBe('');
    await git('reset', '--hard', '--quiet');
  }
});
