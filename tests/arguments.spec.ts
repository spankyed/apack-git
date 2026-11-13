// What a caller names — a commit, a branch, a path — reaches git as that and never as an option. A name that
// begins with a dash is an option to git whatever the caller meant, so every case runs a real git and looks at
// what the repository is afterwards.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository } from '../src/index.ts';
import { removeDirectory } from './_support/remove.ts';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  // A repository read from a commit keeps a git open in its directory, which is deleted once that git has gone
  await Promise.all(repositories.splice(0).map(repository => repository.close()));
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout.trim();

/** A repository with two commits to `a.txt`, and the hash of each */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-arguments-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  const first = await git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');
  const repo = new GitRepository(root);
  repositories.push(repo);
  return { root, repo, first, second: await git(root, 'rev-parse', 'HEAD') };
}

it('refuses an option given as a commit, and leaves the working tree as it was', async () => {
  const { root, repo, second } = await repository();
  fs.writeFileSync(path.join(root, 'a.txt'), 'an edit nobody committed\n');

  for (const notACommit of ['--hard', '-q', 'HEAD', 'main', '']) {
    await expect(repo.resetToCommit(notACommit), `reset to ${JSON.stringify(notACommit)}`).rejects.toThrow('Invalid commit hash');
    await expect(repo.revertCommit(notACommit), `revert of ${JSON.stringify(notACommit)}`).rejects.toThrow('Invalid commit hash');
  }
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('an edit nobody committed\n');
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(second);
});

it('resets to a commit named by its hash, whole or abbreviated', async () => {
  const { root, repo, first } = await repository();
  await repo.resetToCommit(first.slice(0, 8));
  expect(await git(root, 'rev-parse', 'HEAD')).toBe(first);
});

it('refuses an option given as a branch', async () => {
  const { root, repo } = await repository();
  const marker = path.join(root, 'ran');
  const option = `--upload-pack=touch ${marker}`;

  await expect(repo.fetchRemoteBranch(option)).rejects.toThrow('Invalid branch');
  await expect(repo.deleteRemoteBranch('--force')).rejects.toThrow('Invalid branch');
  await expect(repo.readBranchDiff('--output=/dev/null')).rejects.toThrow('Invalid base branch');
  await expect(repo.readFileContentFromBranch('a.txt', '--textconv')).rejects.toThrow('Invalid branch');
  await expect(repo.readCommitsBetween('--all')).rejects.toThrow('Invalid base branch');
  await expect(repo.checkoutBranch('--detach')).rejects.toThrow('Invalid branch name');
  expect(fs.existsSync(marker)).toBe(false);
  expect(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
});

it('says whether names are commits here, refusing one that is an option', async () => {
  const { repo, first } = await repository();
  expect(await repo.commitsExist('main', 'HEAD', first)).toBe(true);
  expect(await repo.commitsExist('main', 'no-such-branch')).toBe(false);
  await expect(repo.commitsExist('--all')).rejects.toThrow('Invalid ref');
});

it('stages and unstages a file whose name begins with a dash', async () => {
  const { root, repo } = await repository();
  fs.writeFileSync(path.join(root, '-n.txt'), 'named like an option\n');

  await repo.stageFiles(['-n.txt']);
  expect(await git(root, 'diff', '--cached', '--name-only')).toBe('-n.txt');
  await repo.unstageFiles(['-n.txt']);
  expect(await git(root, 'diff', '--cached', '--name-only')).toBe('');
});

it('reads an image from a commit with every byte as it was committed', async () => {
  const { root, repo } = await repository();
  const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(root, 'pixel.png'), bytes);
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'image');
  fs.rmSync(path.join(root, 'pixel.png'));

  expect(await repo.readFileBytes('pixel.png', 'HEAD')).toEqual(bytes);
});
