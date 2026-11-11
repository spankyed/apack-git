// Git can be in the middle of a merge, a rebase, a cherry-pick or a revert: stopped at a conflict, waiting to be
// carried on with or given up. The repository says so, says how each file is in conflict, and moves git on. Every
// case runs a real git, since what is read is what git leaves in its own directory while it is stopped.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 }); });

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout.trim();
const write = (root: string, file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/**
 * Two branches that disagree. `main` and `side` each changed `m.txt` and each added `both.txt`, and `side` deleted
 * `d.txt`, which `main` changed. `side` has a second commit that changes `m.txt` again. Left on `main`.
 */
async function disagreeing() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-operation-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  write(root, 'm.txt', 'base\n');
  write(root, 'd.txt', 'x\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'base');
  await git(root, 'checkout', '--quiet', '-b', 'side');
  write(root, 'm.txt', 'side\n');
  write(root, 'both.txt', 'theirs\n');
  await git(root, 'rm', '--quiet', 'd.txt');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'side edit');
  write(root, 'm.txt', 'side again\n');
  await git(root, 'commit', '--quiet', '-am', 'side second');
  await git(root, 'checkout', '--quiet', 'main');
  write(root, 'm.txt', 'main\n');
  write(root, 'd.txt', 'x changed\n');
  write(root, 'both.txt', 'ours\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'main edit');
  const asked: string[] = [];
  return { root, asked, repo: new GitRepository(root, { log: { command: line => asked.push(line) } }) };
}
/** Runs a git command that stops at a conflict, which it reports by failing */
const stopping = (root: string, ...args: string[]) => git(root, ...args).catch(() => undefined);
/** Settles every conflict by taking what is in the working tree, with `m.txt` as given */
async function settled(root: string, content = 'settled\n') {
  write(root, 'm.txt', content);
  await git(root, 'add', '-A');
}
const conflicts = async (repo: GitRepository) =>
  Object.fromEntries((await repo.readSnapshot()).files.filter(file => file.status === 'unmerged').map(file => [file.path, file.conflict]));

it('says nothing is in progress in a checkout git is not in the middle of anything in', async () => {
  const { repo } = await disagreeing();

  expect((await repo.readSnapshot()).operation).toBeUndefined();
  await expect(repo.moveOperation('abort')).rejects.toThrow('not in the middle of anything');
});

it('says a merge is in progress, what is being merged in, and how each file is in conflict', async () => {
  const { root, repo } = await disagreeing();
  await stopping(root, 'merge', 'side');

  expect((await repo.readSnapshot()).operation).toEqual({ kind: 'merge', subject: 'side' });
  expect(await conflicts(repo)).toEqual({ 'both.txt': 'both-added', 'd.txt': 'deleted-by-them', 'm.txt': 'both-modified' });
});

it('says a rebase is in progress, of which branch, onto what, and where among its commits it is', async () => {
  const { root, repo } = await disagreeing();
  await git(root, 'checkout', '--quiet', 'side');
  await stopping(root, 'rebase', 'main');

  expect((await repo.readSnapshot()).operation).toEqual({ kind: 'rebase', subject: 'main', branch: 'side', step: 1, steps: 2 });
});

it('says a cherry-pick and a revert are in progress, and of which commit', async () => {
  const { root, repo } = await disagreeing();
  const picked = await git(root, 'rev-parse', 'side~1');
  await stopping(root, 'cherry-pick', picked);
  expect((await repo.readSnapshot()).operation).toEqual({ kind: 'cherry-pick', subject: picked.slice(0, 7) });
  await repo.moveOperation('abort');
  expect((await repo.readSnapshot()).operation).toBeUndefined();

  write(root, 'm.txt', 'main again\n');
  await git(root, 'commit', '--quiet', '-am', 'main again');
  const reverted = await git(root, 'rev-parse', 'HEAD~1');
  await stopping(root, 'revert', '--no-edit', reverted);
  expect((await repo.readSnapshot()).operation).toEqual({ kind: 'revert', subject: reverted.slice(0, 7) });
});

it('carries a merge on once its conflicts are settled, and not before', async () => {
  const { root, repo } = await disagreeing();
  await stopping(root, 'merge', 'side');

  await expect(repo.moveOperation('continue'), 'three files are still in conflict').rejects.toThrow();
  expect((await repo.readSnapshot()).operation, 'and the merge is still in progress').toEqual({ kind: 'merge', subject: 'side' });

  await settled(root);
  await repo.moveOperation('continue');

  expect((await repo.readSnapshot()).operation).toBeUndefined();
  expect(await git(root, 'log', '-1', '--format=%s'), 'with the message git proposed').toBe('Merge branch \'side\'');
  expect(read(root, 'm.txt')).toBe('settled\n');
});

it('gives a merge up, putting the checkout back as it was', async () => {
  const { root, repo } = await disagreeing();
  await stopping(root, 'merge', 'side');

  await repo.moveOperation('abort');

  expect(await repo.readSnapshot()).toMatchObject({ files: [], branch: 'main' });
  expect((await repo.readSnapshot()).operation).toBeUndefined();
  expect(read(root, 'm.txt')).toBe('main\n');
});

// Carrying a rebase on replays its next commit, and that one can stop at a conflict of its own. Git reports that
// as a failure; it is the rebase doing what was asked
it('goes on to the next commit of a rebase, stops there if it conflicts, and can leave that one out', async () => {
  const { root, repo } = await disagreeing();
  await git(root, 'checkout', '--quiet', 'side');
  await stopping(root, 'rebase', 'main');
  await settled(root);

  await repo.moveOperation('continue');
  expect((await repo.readSnapshot()).operation, 'the second commit changes the same file').toMatchObject({ kind: 'rebase', step: 2, steps: 2 });
  expect(await conflicts(repo)).toEqual({ 'm.txt': 'both-modified' });

  await repo.moveOperation('skip');
  expect((await repo.readSnapshot()).operation).toBeUndefined();
  expect(await git(root, 'log', '--format=%s', 'main..side'), 'the first commit was replayed and the second left out').toBe('side edit');
});

it('skips nothing but a rebase\'s commit', async () => {
  const { root, repo } = await disagreeing();
  await stopping(root, 'merge', 'side');

  await expect(repo.moveOperation('skip')).rejects.toThrow('Only a rebase');
});

// What git is in the middle of changes only when its own directory does, so a read of a few files in the working
// tree keeps what was held of it
it('still says a merge is in progress after a file is read by its path', async () => {
  const { root, repo, asked } = await disagreeing();
  await stopping(root, 'merge', 'side');
  repo.setWatched(true);
  await repo.refreshSnapshot();
  asked.length = 0;

  write(root, 'new.txt', '');
  repo.noteChanged(['new.txt']);
  await repo.refreshSnapshot('noted');

  expect(asked.filter(line => line.startsWith('git status ')).map(line => line.includes(' -- '))).toEqual([true]);
  expect(await repo.readSnapshot()).toMatchObject({ operation: { kind: 'merge', subject: 'side' } });
  expect((await repo.readSnapshot()).files.map(file => file.path)).toEqual(['both.txt', 'd.txt', 'm.txt', 'new.txt']);
});
