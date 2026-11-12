// Every repository under a folder, each its own: the folder's, one nested in it, a submodule and a linked worktree.
// A change inside the submodule is news for the submodule and one row in its parent. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

it('finds the folder\'s repository, one nested in it, a submodule and a linked worktree, each its own', async () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-under-')));
  directories.push(base);
  const folder = path.join(base, 'folder');
  const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args])).stdout.trim();
  const commit = async (cwd: string, message: string) => git(cwd, 'commit', '--quiet', '--allow-empty', '-m', message);
  await git(base, 'init', '--quiet', '--initial-branch=main', 'library');
  await commit(path.join(base, 'library'), 'library');
  await git(base, 'init', '--quiet', '--initial-branch=main', 'folder');
  await commit(folder, 'first');
  await git(folder, 'submodule', 'add', '--quiet', path.join(base, 'library'), 'libs/library');
  await commit(folder, 'with the library');
  await git(folder, 'init', '--quiet', '--initial-branch=main', 'tools/nested');
  await git(folder, 'worktree', 'add', '--quiet', '-b', 'other', 'trees/other');
  fs.mkdirSync(path.join(folder, 'node_modules', 'pkg'), { recursive: true });
  await git(path.join(folder, 'node_modules', 'pkg'), 'init', '--quiet');

  const { repositories, truncated } = await GitRepository.repositoriesUnder(folder);

  expect(truncated).toBe(false);
  expect(repositories.map(({ relative, kind }) => [relative, kind])).toEqual([
    ['', 'top'],
    ['libs/library', 'submodule'],
    ['tools/nested', 'nested'],
    ['trees/other', 'worktree'],
  ]);

  const submodule = new GitRepository(path.join(folder, 'libs/library'));
  const parent = new GitRepository(folder);
  await submodule.refreshSnapshot();
  fs.writeFileSync(path.join(folder, 'libs/library', 'new.txt'), 'new\n');

  expect((await submodule.refreshSnapshot()).status, 'news for the submodule').toBe(true);
  const rows = (await parent.readSnapshot()).files.filter(file => file.path.startsWith('libs/'));
  expect(rows).toEqual([{ path: 'libs/library', status: 'modified', staged: false, originalPath: undefined, submodule: { commit: false, modified: false, untracked: true } }]);
});
