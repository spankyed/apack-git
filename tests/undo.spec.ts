// The last write the engine made can be taken back: a commit, a reset to a commit, a deleted branch, a dropped or
// cleared stash. Each case runs a real git and holds the refs, the index and the files to what git says after.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const temporary = (name: string) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-undo-${name}-`)));
  directories.push(directory);
  return directory;
};

/** A repository with two commits on `main`, the identity commits need, and its own checkpoint store */
async function repository() {
  const root = temporary('repo');
  const store = path.join(temporary('store'), 'store');
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  await git('config', 'user.name', 't');
  await git('config', 'user.email', 't@t');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await git('commit', '--quiet', '-am', 'second');
  return { root, git, repo: new GitRepository(root, { checkpointDirectory: () => store }) };
}
const refusal = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it was not refused'); }, (error: unknown) => error);

it('takes a commit back off its branch, leaving what it held staged', async () => {
  const { root, git, repo } = await repository();
  const before = await git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'a.txt'), 'three\n');
  await git('add', 'a.txt');

  await repo.commit('third');
  expect(await repo.lastUndoable()).toMatchObject({ operation: 'commit', summary: 'commit "third"' });
  await repo.undo();

  expect(await git('rev-parse', 'HEAD')).toBe(before);
  expect(await git('status', '--porcelain')).toBe('M  a.txt');
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('three\n');
  expect(await repo.lastUndoable(), 'and there is nothing more to take back').toBeUndefined();
});

it('takes back a reset, putting the branch and the index back and the files as they are', async () => {
  const { root, git, repo } = await repository();
  const before = await git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'a.txt'), 'edited\n');

  await repo.resetToCommit(await git('rev-parse', 'HEAD~1'));
  await repo.undo();

  expect(await git('rev-parse', 'HEAD')).toBe(before);
  expect(await git('diff', '--cached', '--name-only'), 'nothing staged, as before the reset').toBe('');
  expect(await git('diff', '--name-only')).toBe('a.txt');
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('edited\n');
});

it('makes a deleted branch again where it was, with the branch it followed', async () => {
  const { git, repo } = await repository();
  await git('branch', 'topic', 'HEAD~1');
  await git('config', 'branch.topic.remote', 'origin');
  await git('config', 'branch.topic.merge', 'refs/heads/topic');
  const was = await git('rev-parse', 'topic');

  await repo.deleteBranch('topic');
  expect(await git('branch', '--list', 'topic')).toBe('');
  await repo.undo();

  expect(await git('rev-parse', 'topic')).toBe(was);
  expect(await git('config', 'branch.topic.merge')).toBe('refs/heads/topic');
});

it('puts back a dropped stash on top, and cleared stashes in the order they stood', async () => {
  const { root, git, repo } = await repository();
  for (const name of ['older', 'newer']) {
    fs.writeFileSync(path.join(root, 'a.txt'), `${name}\n`);
    await git('stash', 'push', '--quiet', '-m', name);
  }
  const stashes = () => git('stash', 'list', '--format=%H %gs');

  await repo.stashDrop(1);
  expect(await stashes()).toMatch(/^\w+ On main: newer$/);
  await repo.undo();
  expect(await stashes()).toMatch(/^\w+ On main: older\n\w+ On main: newer$/);

  const standing = await stashes();
  await repo.stashClear();
  expect(await stashes()).toBe('');
  await repo.undo();
  expect(await stashes()).toBe(standing);
});

it('asks before taking back a commit a remote branch already holds', async () => {
  const { root, git, repo } = await repository();
  const remote = temporary('remote');
  await run('git', ['init', '--quiet', '--bare', remote]);
  await git('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  await git('add', 'b.txt');
  await repo.commit('third');
  await git('push', '--quiet', 'origin', 'main');

  const refused = await refusal(repo.undo());
  expect(refused).toBeInstanceOf(GitError);
  expect((refused as GitError).code).toBe('published');
  expect(await git('log', '-1', '--format=%s'), 'and nothing was undone').toBe('third');

  await repo.undo({ evenIfPublished: true });
  expect(await git('log', '-1', '--format=%s')).toBe('second');
});

it('refuses to take back a commit its branch has moved past since', async () => {
  const { root, git, repo } = await repository();
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  await git('add', 'b.txt');
  await repo.commit('third');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b, again\n');
  await git('commit', '--quiet', '-am', 'made elsewhere');

  await expect(repo.undo()).rejects.toThrow(/has moved since/);
  expect(await git('log', '-1', '--format=%s')).toBe('made elsewhere');
});

it('says there is nothing to undo when there is not', async () => {
  const { repo } = await repository();

  expect(await repo.lastUndoable()).toBeUndefined();
  await expect(repo.undo()).rejects.toThrow('nothing to undo');
});
