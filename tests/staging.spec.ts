// A file that is staged or unstaged moves in the commit panel at once, before git has answered, so what the
// panel shows for that moment is a guess. Git is what it is a guess of: each case here puts a real repository in
// a state, takes the list as git gives it, and holds the guess to the list git gives after really staging or
// unstaging. Where the list alone cannot tell where a file goes, the guess is to leave it where it is.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository } from '../src/index.ts';
import { withStaged, withUnstaged } from '../src/staging.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args]);
const write = (root: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
const remove = (root: string, file: string) => fs.rmSync(path.join(root, file));
const LONG = 'a file that will be renamed, long enough for git to follow it\n';

type Step = (root: string) => unknown;
/** A repository on `main` with one commit holding `kept.txt`, `gone.txt`, `other.txt` and `old name.txt`, then changed */
async function repository(change: Step) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-staging-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  for (const file of ['kept.txt', 'gone.txt', 'other.txt']) write(root, file, 'one\n');
  write(root, 'old name.txt', LONG);
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await change(root);
  return root;
}
const listed = (root: string) => new GitRepository(root).getStatus();

const edit = (file: string, content = 'two\n'): Step => root => write(root, file, content);
const add = (...files: string[]): Step => root => git(root, 'add', '--', ...files);
const all = (...steps: Step[]): Step => async (root) => { for (const step of steps) await step(root); };

const staging: Record<string, { change: Step; paths: string[] }> = {
  'a file git does not track': { change: edit('new.txt'), paths: ['new.txt'] },
  'an edited file': { change: edit('kept.txt'), paths: ['kept.txt'] },
  'a deleted file': { change: root => remove(root, 'gone.txt'), paths: ['gone.txt'] },
  'a file staged and edited again': { change: all(edit('kept.txt'), add('kept.txt'), edit('kept.txt', 'three\n')), paths: ['kept.txt'] },
  'a new file staged and edited again': { change: all(edit('new.txt'), add('new.txt'), edit('new.txt', 'three\n')), paths: ['new.txt'] },
  'a new file staged and then deleted': { change: all(edit('new.txt'), add('new.txt'), root => remove(root, 'new.txt')), paths: ['new.txt'] },
  'an edited file staged and then deleted': { change: all(edit('kept.txt'), add('kept.txt'), root => remove(root, 'kept.txt')), paths: ['kept.txt'] },
  'two files among others that stay': {
    change: all(edit('kept.txt'), edit('new.txt'), edit('other.txt'), edit('zzz-new.txt'), root => remove(root, 'gone.txt')),
    paths: ['new.txt', 'kept.txt'],
  },
};

it.each(Object.entries(staging))('shows what git lists once %s is staged', async (_name, { change, paths }) => {
  const root = await repository(change);
  const before = await listed(root);

  await new GitRepository(root).stageFiles(paths);

  expect(withStaged(before, paths)).toEqual(await listed(root));
});

const unstaging: Record<string, { change: Step; paths: string[] }> = {
  'a new file': { change: all(edit('new.txt'), add('new.txt')), paths: ['new.txt'] },
  'an edited file': { change: all(edit('kept.txt'), add('kept.txt')), paths: ['kept.txt'] },
  'a deleted file': { change: all(root => remove(root, 'gone.txt'), add('gone.txt')), paths: ['gone.txt'] },
  'a file staged and edited again': { change: all(edit('kept.txt'), add('kept.txt'), edit('kept.txt', 'three\n')), paths: ['kept.txt'] },
  'a new file staged and edited again': { change: all(edit('new.txt'), add('new.txt'), edit('new.txt', 'three\n')), paths: ['new.txt'] },
  'a new file staged and then deleted': { change: all(edit('new.txt'), add('new.txt'), root => remove(root, 'new.txt')), paths: ['new.txt'] },
  'an edited file staged and then deleted': { change: all(edit('kept.txt'), add('kept.txt'), root => remove(root, 'kept.txt')), paths: ['kept.txt'] },
  'two files among others that stay': {
    change: all(edit('kept.txt'), edit('new.txt'), edit('other.txt'), add('kept.txt', 'new.txt', 'other.txt'), edit('zzz-new.txt')),
    paths: ['new.txt', 'kept.txt'],
  },
};

it.each(Object.entries(unstaging))('shows what git lists once %s is unstaged', async (_name, { change, paths }) => {
  const root = await repository(change);
  const before = await listed(root);

  await new GitRepository(root).unstageFiles(paths);

  expect(withUnstaged(before, paths)).toEqual(await listed(root));
});

// The backend unstages both names of a renamed file together, since one without the other is half a rename
it('shows a renamed file unstaged as its old name missing and its new name not tracked', async () => {
  const root = await repository(root => git(root, 'mv', 'old name.txt', 'new name.txt'));
  const before = await listed(root);
  expect(before).toEqual([{ path: 'new name.txt', status: 'renamed', staged: true, originalPath: 'old name.txt' }]);

  await new GitRepository(root).unstageFiles(['new name.txt', 'old name.txt']);

  expect(withUnstaged(before, ['new name.txt'])).toEqual(await listed(root));
});

// Where a file goes then depends on what it holds, which the list does not say: it stays where it is until git answers
it.each([
  ['staging a file put back where a deletion is staged', all(root => remove(root, 'gone.txt'), add('gone.txt'), edit('gone.txt')), withStaged, 'gone.txt'],
  ['unstaging a deletion whose file was put back', all(root => remove(root, 'gone.txt'), add('gone.txt'), edit('gone.txt')), withUnstaged, 'gone.txt'],
  ['staging an edit to a renamed file', all(root => git(root, 'mv', 'old name.txt', 'new name.txt'), edit('new name.txt', `${LONG}and more\n`)), withStaged, 'new name.txt'],
  // A folder git tracks nothing in is one row for whatever it holds
  ['staging a folder git tracks nothing in', edit('fresh/deep/a.txt'), withStaged, 'fresh/'],
  ['staging a file inside a folder git tracks nothing in', edit('fresh/deep/a.txt'), withStaged, 'fresh/deep/a.txt'],
] as const)('leaves the list as it is when %s', async (_name, change, guess, file) => {
  const before = await listed(await repository(change));

  expect(guess(before, [file])).toEqual(before);
});

it('leaves a conflict where it is when it is staged', async () => {
  const root = await repository(async (root) => {
    await git(root, 'checkout', '--quiet', '-b', 'side');
    write(root, 'kept.txt', 'side\n');
    await git(root, 'commit', '--quiet', '-am', 'side');
    await git(root, 'checkout', '--quiet', 'main');
    write(root, 'kept.txt', 'main\n');
    await git(root, 'commit', '--quiet', '-am', 'main');
    await git(root, 'merge', '--quiet', 'side').catch(() => {});
  });
  const before = await listed(root);
  expect(before.map(file => file.status)).toEqual(['unmerged']);

  expect(withStaged(before, ['kept.txt'])).toEqual(before);
});
