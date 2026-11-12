// History that can be drawn, read a page at a time: a history with a merge and a renamed file pages without
// repeating or dropping a commit, even when a ref moves between pages, and a file's history follows it across its
// rename. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, type HistoryCommit } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** Seven commits: two on a branch merged back into `main`, and `old.txt` renamed to `new.txt` and changed after */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-history-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
  const commit = async (file: string, content: string, message: string) => {
    fs.writeFileSync(path.join(root, file), content);
    await git('add', '-A');
    await git('commit', '--quiet', '-m', message);
  };
  await git('init', '--quiet', '--initial-branch=main');
  await commit('old.txt', Array.from({ length: 20 }, (_, line) => `line ${line}\n`).join(''), 'one');
  await commit('a.txt', 'a\n', 'two');
  await git('checkout', '--quiet', '-b', 'topic');
  await commit('b.txt', 'b\n', 'three, on topic');
  await commit('b.txt', 'b again\n', 'four, on topic');
  await git('checkout', '--quiet', 'main');
  await git('mv', 'old.txt', 'new.txt');
  await git('commit', '--quiet', '-m', 'five, renamed');
  await git('merge', '--quiet', '--no-ff', '-m', 'six, merged', 'topic');
  fs.appendFileSync(path.join(root, 'new.txt'), 'one more\n');
  await git('commit', '--quiet', '-am', 'seven');
  return { root, git, repo: new GitRepository(root) };
}

/** Every page from the first, `size` commits at a time, with `between` run after each page */
async function allPages(repo: GitRepository, options: { refs?: string[]; path?: string }, size: number, between = async () => {}) {
  const pages: HistoryCommit[][] = [];
  let page = await repo.history({ ...options, limit: size });
  pages.push(page.commits);
  while (page.cursor) {
    await between();
    page = await repo.history({ cursor: page.cursor, limit: size });
    pages.push(page.commits);
  }
  return pages;
}

it('pages a history with a merge without repeating or dropping a commit, each with its parents', async () => {
  const { git, repo } = await repository();

  const pages = await allPages(repo, {}, 2);
  const read = pages.flat();

  expect(pages.map(page => page.length)).toEqual([2, 2, 2, 1]);
  expect(read.map(commit => commit.hash)).toEqual((await git('rev-list', '--topo-order', 'HEAD')).split('\n'));
  const merge = read.find(commit => commit.subject === 'six, merged')!;
  expect(merge.parents).toEqual([await git('rev-parse', 'HEAD~1^1'), await git('rev-parse', 'topic')]);
  expect(read.at(-1)!.parents, 'and the first commit has none').toEqual([]);
  expect(read[0]!.refs).toContain('HEAD -> main');
});

it('goes on from where the first page stood when a ref moves between pages', async () => {
  const { root, git, repo } = await repository();
  const stood = (await git('rev-list', '--topo-order', 'HEAD')).split('\n');
  let moved = false;

  const read = (await allPages(repo, { refs: ['main'] }, 3, async () => {
    if (moved) return;
    moved = true;
    fs.writeFileSync(path.join(root, 'later.txt'), 'later\n');
    await git('add', 'later.txt');
    await git('commit', '--quiet', '-m', 'eight, made between pages');
  })).flat();

  expect(read.map(commit => commit.hash)).toEqual(stood);
});

it('reads from several refs at once, each commit once, a branch that has moved on among them', async () => {
  const { root, git, repo } = await repository();
  await git('checkout', '--quiet', '-b', 'later', 'topic');
  fs.writeFileSync(path.join(root, 'c.txt'), 'c\n');
  await git('add', 'c.txt');
  await git('commit', '--quiet', '-m', 'eight, on later');
  await git('checkout', '--quiet', 'main');

  const read = (await allPages(repo, { refs: ['main', 'later', 'topic'] }, 3)).flat();

  expect(read.map(commit => commit.hash)).toEqual((await git('rev-list', '--topo-order', 'main', 'later')).split('\n'));
  await expect(repo.history({ refs: ['main', 'none-such'] }), 'and one that names nothing is refused').rejects.toThrow();
});

it('reads a file\'s history across its rename', async () => {
  const { repo } = await repository();

  const read = (await allPages(repo, { path: 'new.txt' }, 1)).flat();

  expect(read.map(commit => commit.subject)).toEqual(['seven', 'five, renamed', 'one']);
});

it('says a repository with no commit has no history, and a cursor it never gave is refused', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-history-empty-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet']);
  const repo = new GitRepository(root);

  expect(await repo.history()).toEqual({ commits: [] });
  await expect(repo.history({ refs: ['main'] }), 'a ref asked for by name must name a commit').rejects.toThrow();
  await expect(repo.history({ cursor: 'made-up' })).rejects.toThrow('Not a cursor');
});
