// A repository's branches with their standing against what they follow, its remotes with their addresses, and its
// tags, read as one model. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const temporary = (name: string) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-refs-${name}-`)));
  directories.push(directory);
  return directory;
};

it('reads every branch with how far it is from what it follows, the remotes and the tags', async () => {
  const remote = temporary('remote');
  const root = temporary('repo');
  const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();
  const commit = async (cwd: string, message: string) => {
    fs.appendFileSync(path.join(cwd, 'a.txt'), `${message}\n`);
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '--quiet', '-m', message);
  };
  await git(remote, 'init', '--quiet', '--initial-branch=main');
  await commit(remote, 'one');
  await git(remote, 'branch', 'doomed');
  await run('git', ['clone', '--quiet', remote, root]);
  await git(root, 'remote', 'set-url', '--push', 'origin', 'ssh://example.invalid/pushed-here.git');
  await git(root, 'branch', '--track', 'doomed', 'origin/doomed');
  await commit(root, 'mine');
  await commit(remote, 'theirs');
  await git(remote, 'branch', '-D', 'doomed');
  await git(root, 'fetch', '--quiet', '--prune', 'origin');
  await git(root, 'tag', '-a', 'v1', '-m', 'annotated');
  await git(root, 'tag', 'light', 'HEAD~1');

  const model = await new GitRepository(root).refsModel();

  expect(model.branches.find(branch => branch.name === 'main')).toMatchObject({ current: true, upstream: 'origin/main', ahead: 1, behind: 1, remote: false });
  expect(model.branches.find(branch => branch.name === 'doomed')).toMatchObject({ current: false, upstream: 'origin/doomed', upstreamGone: true });
  expect(model.branches.find(branch => branch.name === 'origin/main')).toMatchObject({ remote: true, current: false, ahead: 0, behind: 0 });
  expect(model.branches.map(branch => branch.name), 'and a remote\'s HEAD is no branch').not.toContain('origin/HEAD');
  expect(model.remotes).toEqual([{ name: 'origin', fetchUrl: remote, pushUrl: 'ssh://example.invalid/pushed-here.git' }]);
  expect(model.tags).toEqual([
    { name: 'light', commit: await git(root, 'rev-parse', 'HEAD~1') },
    { name: 'v1', commit: await git(root, 'rev-parse', 'HEAD') },
  ]);
});
