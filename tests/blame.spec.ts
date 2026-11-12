// Who last changed each line, against a file three people wrote and a commit the repository lists to be left out
// of blame, which reformatted a line. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, type BlameLine } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** `notes.txt` with a line by each of three people, then a commit by a fourth that reformats Bea's, listed as ignored */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-blame-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout.trim();
  // Through the environment, which the suite's setup also uses and which wins over a setting
  const as = async (name: string, ...args: string[]) => (await run('git', ['-C', root, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name.toLowerCase()}@example.com`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name.toLowerCase()}@example.com` },
  })).stdout.trim();
  const write = (content: string) => fs.writeFileSync(path.join(root, 'notes.txt'), content);
  await git('init', '--quiet', '--initial-branch=main');
  write('ada\n');
  await git('add', '.');
  await as('Ada', 'commit', '--quiet', '-m', 'by ada');
  write('ada\nbea\n');
  await as('Bea', 'commit', '--quiet', '-am', 'by bea');
  write('ada\nbea\ncal\n');
  await as('Cal', 'commit', '--quiet', '-am', 'by cal');
  write('ada\n  bea\ncal\n');
  await as('Dee', 'commit', '--quiet', '-am', 'reformatted');
  fs.writeFileSync(path.join(root, '.git-blame-ignore-revs'), `${await git('rev-parse', 'HEAD')}\n`);
  await as('Dee', 'add', '.git-blame-ignore-revs');
  await as('Dee', 'commit', '--quiet', '-m', 'ignore the reformat');
  return { root, git, repo: new GitRepository(root) };
}

it('answers each line as git blame does, leaving out the commit the repository lists', async () => {
  const { git, repo } = await repository();
  const handed: BlameLine[][] = [];

  const lines = await repo.blame('notes.txt', { onLines: group => handed.push(group) });

  expect(lines.map(({ line, author, summary }) => [line, author, summary])).toEqual([
    [1, 'Ada', 'by ada'],
    [2, 'Bea', 'by bea'],
    [3, 'Cal', 'by cal'],
  ]);
  const byGit = (await git('blame', '--root', '-l', '-s', '--ignore-revs-file', '.git-blame-ignore-revs', 'notes.txt')).split('\n').map(row => row.split(' ')[0]!);
  expect(lines.map(({ commit }) => commit)).toEqual(byGit);
  expect(handed.flat().map(({ line }) => line).sort(), 'every line was handed on as it was found').toEqual([1, 2, 3]);
  expect(lines[1]).toMatchObject({ authorEmail: 'bea@example.com', originalLine: 2, originalPath: 'notes.txt' });
});

it('answers a revision as that commit had the file', async () => {
  const { repo } = await repository();

  const lines = await repo.blame('notes.txt', { revision: 'HEAD~3' });

  expect(lines.map(({ author }) => author)).toEqual(['Ada', 'Bea']);
});
