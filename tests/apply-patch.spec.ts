// Applying a patch of several files, as an agent proposes one: to the working tree, or to what is staged and nothing
// else, from a repository opened in a folder below the top, whole or not at all, and never outside the checkout.
// Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.js';
import { removeDirectory } from './_support/remove.js';
import { GitError, GitRepository } from '../src/index.js';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout;
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/**
 * A checkout of `a.txt` and `src/b.txt`, opened at `src/`, and the patch that changes both and adds `c.txt`, made
 * there and taken back so that the checkout is as committed
 */
async function checkout() {
  const outer = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-patch-')));
  directories.push(outer);
  const root = path.join(outer, 'work');
  await run('git', ['init', '--quiet', '--initial-branch=main', root]);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'src/b.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'one');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'src/b.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'c.txt'), 'new\n');
  await git(root, 'add', '--intent-to-add', 'c.txt');
  const patch = await git(root, 'diff');
  await git(root, 'reset', '--quiet');
  await git(root, 'checkout', '--', '.');
  fs.rmSync(path.join(root, 'c.txt'));
  const repo = new GitRepository(path.join(root, 'src'));
  repositories.push(repo);
  return { outer, root, repo, patch };
}

it('applies a patch of several files to the working tree, from a repository opened below the top, leaving what is staged', async () => {
  const { root, repo, patch } = await checkout();

  await repo.applyPatch(patch);

  expect([read(root, 'a.txt'), read(root, 'src/b.txt'), read(root, 'c.txt')]).toEqual(['two\n', 'two\n', 'new\n']);
  expect(await repo.readStagedFiles()).toEqual([]);
});

it('applies a patch to what is staged and nothing else', async () => {
  const { root, repo, patch } = await checkout();

  await repo.applyPatch(patch, { staged: true });

  expect((await repo.readStagedFiles()).map(file => file.path).sort()).toEqual(['a.txt', 'c.txt', 'src/b.txt']);
  expect(read(root, 'a.txt'), 'the working tree is as it was').toBe('one\n');
  expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(false);
});

it('applies none of a patch any part of which does not apply', async () => {
  const { root, repo, patch } = await checkout();
  fs.writeFileSync(path.join(root, 'src/b.txt'), 'changed since\n');

  const refused = await repo.applyPatch(patch).then(() => undefined, (error: unknown) => error);

  expect(refused).toBeInstanceOf(GitError);
  expect([read(root, 'a.txt'), read(root, 'src/b.txt'), fs.existsSync(path.join(root, 'c.txt'))]).toEqual(['one\n', 'changed since\n', false]);
});

it('refuses a patch that names a path outside the checkout, writing nothing there', async () => {
  const { outer, repo } = await checkout();
  const escaping = 'diff --git a/../escaped.txt b/../escaped.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../escaped.txt\n@@ -0,0 +1 @@\n+out\n';

  const refused = await repo.applyPatch(escaping).then(() => undefined, (error: unknown) => error);

  expect(refused).toBeInstanceOf(GitError);
  expect(fs.existsSync(path.join(outer, 'escaped.txt'))).toBe(false);
});
