// A report that git's index changed and no ref did reads the whole status and keeps the refs the snapshot holds.
// Each case changes the repository with a real git from outside, as another tool would, and tells the engine only
// what a watcher would report of it: never "look again", until the case is about what that finds.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.js';
import { removeDirectory } from './_support/remove.js';
import { GitRepository } from '../src/index.js';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map(repo => repo.close()));
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

/** A repository with one commit, watched, checked once so that later checks say what changed since */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-index-hint-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  const repo = new GitRepository(root);
  repositories.push(repo);
  repo.setWatched(true);
  await repo.refreshSnapshot();
  return { root, git, repo };
}

it('lists a file staged by another git as staged after a report of the index', async () => {
  const { root, git, repo } = await repository();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  repo.noteChanged(['a.txt']);
  expect((await repo.readSnapshot()).files).toEqual([expect.objectContaining({ path: 'a.txt', staged: false })]);

  await git('add', 'a.txt');
  repo.noteChanged('index');

  expect((await repo.readSnapshot()).files).toEqual([expect.objectContaining({ path: 'a.txt', status: 'modified', staged: true })]);
});

for (const order of [['index', null], [null, 'index']] as const) {
  it(`sees a commit made by another git from the reports a watcher makes of it, ${order[0] ?? 'anything'} first`, async () => {
    const { root, git, repo } = await repository();
    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
    await git('commit', '--quiet', '-am', 'second');

    for (const report of order) repo.noteChanged(report);
    const change = await repo.refreshSnapshot('noted');

    expect(change).toMatchObject({ history: true, refs: true });
    expect((await repo.refsModel()).branches.find(branch => branch.current)?.commit).toBe(await git('rev-parse', 'HEAD'));
  });
}

it('never says a ref moved from a report of the index alone, and finds one that did when told to look again', async () => {
  const { git, repo } = await repository();
  await git('branch', 'made-elsewhere');

  repo.noteChanged('index');
  expect(await repo.refreshSnapshot('noted'), 'the refs are kept as they were read').toMatchObject({ refs: false });

  expect(await repo.refreshSnapshot('everything')).toMatchObject({ refs: true });
});
