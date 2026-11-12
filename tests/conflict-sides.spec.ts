// The three sides of a conflicted file, read from what git left in the index after a real merge, and resolving it
// with one side, with content written in its place, or by deleting it where the side taken deleted it.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/**
 * A merge of `topic` into `main` that stops on conflicts: `a.txt` changed on both, `gone.txt` changed on `main`
 * and deleted on `topic`
 */
async function conflicted() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-conflict-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout;
  const write = (file: string, content: string) => fs.writeFileSync(path.join(root, file), content);
  await git('init', '--quiet', '--initial-branch=main');
  write('a.txt', 'first\nshared\nlast\n');
  write('gone.txt', 'here\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'base');
  await git('checkout', '--quiet', '-b', 'topic');
  write('a.txt', 'first\ntheirs\nlast\n');
  await git('rm', '--quiet', 'gone.txt');
  await git('commit', '--quiet', '-am', 'theirs');
  await git('checkout', '--quiet', 'main');
  write('a.txt', 'first\nours\nlast\n');
  write('gone.txt', 'here, changed\n');
  await git('commit', '--quiet', '-am', 'ours');
  await git('merge', '--quiet', 'topic').catch(() => {});
  return { root, git, repo: new GitRepository(root) };
}

it('reads each side as the commit it came from holds it, and where the conflict is marked', async () => {
  const { root, git, repo } = await conflicted();

  const sides = await repo.conflictSides('a.txt');

  expect(sides.base).toBe(await git('show', 'main~1:a.txt'));
  expect(sides.ours).toBe(await git('show', 'main:a.txt'));
  expect(sides.theirs).toBe(await git('show', 'topic:a.txt'));
  expect(sides.working).toBe(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'));
  expect(sides.binary).toBe(false);
  expect(sides.regions).toEqual([{ start: 2, separator: 4, end: 6 }]);
  expect(sides.working!.split('\n').slice(1, 6)).toEqual(['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> topic']);
});

it('says a side that deleted the file has none', async () => {
  const { repo } = await conflicted();

  expect(await repo.conflictSides('gone.txt')).toMatchObject({ base: 'here\n', ours: 'here, changed\n', theirs: null });
});

it('resolves with content written in its place, and marks it resolved', async () => {
  const { root, git, repo } = await conflicted();

  await repo.resolveConflict('a.txt', { content: 'first\nboth\nlast\n' });

  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('first\nboth\nlast\n');
  expect(await git('status', '--porcelain', '--', 'a.txt')).toBe('M  a.txt\n');
});

it('resolves with a side that deleted the file by deleting it', async () => {
  const { root, git, repo } = await conflicted();

  await repo.resolveConflict('gone.txt', 'theirs');

  expect(fs.existsSync(path.join(root, 'gone.txt'))).toBe(false);
  expect(await git('status', '--porcelain', '--', 'gone.txt')).toBe('D  gone.txt\n');
});

it('resolves with one side as it is', async () => {
  const { root, git, repo } = await conflicted();

  await repo.resolveConflict('a.txt', 'theirs');

  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('first\ntheirs\nlast\n');
  expect(await git('diff', '--name-only', '--diff-filter=U', '--', 'a.txt')).toBe('');
});
