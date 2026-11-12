// What a merge would do, before it is done: nothing, a fast-forward, a clean merge, or the files a real merge then
// stops on. Nothing moves while it is asked. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, gitVersionOf, olderThan } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** `main` and three branches off it: one behind it, one ahead of it, one that conflicts in `a.txt` */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-preview-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]).catch(error => error)).stdout?.trim();
  const commit = async (file: string, content: string, message: string) => {
    fs.writeFileSync(path.join(root, file), content);
    await git('add', '-A');
    await git('commit', '--quiet', '-m', message);
  };
  await git('init', '--quiet', '--initial-branch=main');
  await commit('a.txt', 'one\n', 'one');
  await git('branch', 'behind');
  await commit('b.txt', 'b\n', 'two');
  await git('checkout', '--quiet', '-b', 'ahead');
  await commit('c.txt', 'c\n', 'three');
  await git('checkout', '--quiet', '-b', 'clean', 'main~0');
  await commit('d.txt', 'd\n', 'four');
  await git('checkout', '--quiet', '-b', 'conflicting', 'main');
  await commit('a.txt', 'theirs\n', 'five');
  await git('checkout', '--quiet', 'main');
  await commit('a.txt', 'ours\n', 'six');
  return { root, git, repo: new GitRepository(root) };
}

const mergeTree = !olderThan(gitVersionOf((await run('git', ['--version'])).stdout)!, '2.38.0');

it('says nothing would change, and a fast-forward, without asking for a merge', async () => {
  const { git, repo } = await repository();
  await git('checkout', '--quiet', 'behind');

  expect(await repo.previewMerge('main')).toEqual({ kind: 'fast-forward' });
  await git('checkout', '--quiet', 'main');
  expect(await repo.previewMerge('behind')).toEqual({ kind: 'up-to-date' });
});

it.runIf(mergeTree)('names the files a real merge then stops on, moving nothing', async () => {
  const { root, git, repo } = await repository();
  const before = { head: await git('rev-parse', 'HEAD'), status: await git('status', '--porcelain'), index: fs.readFileSync(path.join(root, '.git', 'index')).toString('base64') };

  expect(await repo.previewMerge('clean')).toEqual({ kind: 'clean' });
  const preview = await repo.previewMerge('conflicting');

  expect({ head: await git('rev-parse', 'HEAD'), status: await git('status', '--porcelain'), index: fs.readFileSync(path.join(root, '.git', 'index')).toString('base64') }).toEqual(before);
  await git('merge', '--quiet', 'conflicting');
  expect(preview).toEqual({ kind: 'conflicts', files: (await git('diff', '--name-only', '--diff-filter=U')).split('\n') });
});

it.runIf(!mergeTree)('says it does not know on a git without merge-tree', async () => {
  const { repo } = await repository();

  expect(await repo.previewMerge('conflicting')).toEqual({ kind: 'unknown' });
});
