// A folder git tracks nothing in is one row of the status, whatever it holds: a folder of thousands of files
// nobody ignored is one line, and is not walked. What is in it is listed when the row is opened. Every case runs
// a real git.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository, UNTRACKED_LISTED_LIMIT } from '../src/index.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 }); });

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout;
const write = (root: string, file: string, content = '') => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

/** A repository tracking `src/a.ts` and ignoring `*.log`, with these files written and not tracked */
async function repository(untracked: string[]) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-folders-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  write(root, '.gitignore', '*.log\n');
  write(root, 'src/a.ts', 'a\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  for (const file of untracked) write(root, file);
  return { root, repo: new GitRepository(root) };
}
const rows = async (repo: GitRepository) => (await repo.getStatus()).map(({ path: file, status, staged, isDirectory }) =>
  `${file} ${staged ? 'staged ' : ''}${status}${isDirectory ? ' folder' : ''}`);

it('lists a folder git tracks nothing in as one row, and a new file among tracked ones by its name', async () => {
  const { repo } = await repository(['vendor/x/a.js', 'vendor/y/b.js', 'src/new.ts']);

  expect(await rows(repo)).toEqual(['src/new.ts untracked', 'vendor/ untracked folder']);
});

it('lists every file where the user has told git to', async () => {
  const { root, repo } = await repository(['vendor/x/a.js', 'vendor/y/b.js']);
  await git(root, 'config', 'status.showUntrackedFiles', 'all');

  expect(await rows(repo)).toEqual(['vendor/x/a.js untracked', 'vendor/y/b.js untracked']);
});

it('lists what is in the folder when it is opened, leaving out what git ignores', async () => {
  const { repo } = await repository(['vendor/x/a.js', 'vendor/y/b.js', 'vendor/build.log']);

  expect(await repo.listUntracked('vendor/')).toEqual({ files: ['vendor/x/a.js', 'vendor/y/b.js'], truncated: false });
});

it('cuts the list of a folder with more files than are listed, and says so', async () => {
  const many = Array.from({ length: UNTRACKED_LISTED_LIMIT + 5 }, (_, index) => `vendor/f${String(index).padStart(5, '0')}.js`);
  const { repo } = await repository(many);

  const listed = await repo.listUntracked('vendor/');

  expect(listed.truncated).toBe(true);
  expect(listed.files).toEqual(many.slice(0, UNTRACKED_LISTED_LIMIT));
});

it('stages the whole folder from its row', async () => {
  const { repo } = await repository(['vendor/x/a.js', 'vendor/y/b.js']);

  await repo.stageFiles(['vendor/']);

  expect(await rows(repo)).toEqual(['vendor/x/a.js staged added', 'vendor/y/b.js staged added']);
});

it('stages one file of the folder, and lists the rest of it as it then stands', async () => {
  const { repo } = await repository(['vendor/x/a.js', 'vendor/y/b.js']);

  await repo.stageFiles(['vendor/x/a.js']);

  expect(await rows(repo)).toEqual(['vendor/x/a.js staged added', 'vendor/y/ untracked folder']);
});

// What git ignores in the folder is not what the row lists, and is left where it is
it('discards what the folder\'s row lists, and leaves what git ignores there', async () => {
  const { root, repo } = await repository(['vendor/x/a.js', 'vendor/y/b.js', 'vendor/build.log']);

  await repo.revertFile('vendor/');

  expect(await rows(repo)).toEqual([]);
  expect(fs.existsSync(path.join(root, 'vendor/x/a.js'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'vendor/build.log'))).toBe(true);
});

it('discards one file of the folder and keeps its row', async () => {
  const { root, repo } = await repository(['vendor/x/a.js', 'vendor/y/b.js']);

  await repo.revertFile('vendor/x/a.js');

  expect(fs.existsSync(path.join(root, 'vendor/x/a.js'))).toBe(false);
  expect(await rows(repo)).toEqual(['vendor/ untracked folder']);
});

it('discards a folder\'s row among the other changes discarded with it', async () => {
  const { root, repo } = await repository(['vendor/x/a.js', 'loose.txt']);
  write(root, 'src/a.ts', 'changed\n');

  await repo.revertFiles(['src/a.ts', 'loose.txt', 'vendor/']);

  expect(await rows(repo)).toEqual([]);
});

// The row itself does not move when a file is made deep inside the folder, and a window that has the folder open
// lists it again when told the folder changed
it('says the folder changed, and no status, when a file is made or deleted somewhere under its row', async () => {
  const { root, repo } = await repository(['vendor/x/a.js']);
  repo.setWatched(true);
  await repo.refreshSnapshot();

  write(root, 'vendor/x/deep/new.js');
  repo.noteChanged(['vendor/x/deep', 'vendor/x/deep/new.js']);

  expect(await repo.refreshSnapshot('noted')).toMatchObject({ status: false, diffs: true, files: ['vendor/'] });
  expect(await rows(repo)).toEqual(['vendor/ untracked folder']);
});


// A row's path is that path, letter for letter: read as a pattern, `app/[id]/` is `app/i/` and `app/d/` as well
it('discards the folder named and no other its name matches as a pattern', async () => {
  const { root, repo } = await repository(['app/[id]/page.tsx', 'app/i/page.tsx', 'app/d/page.tsx']);
  await git(root, 'add', 'app/i/page.tsx');
  await git(root, 'commit', '--quiet', '-m', 'one tracked, so each folder is a row');
  await git(root, 'rm', '--quiet', '--cached', 'app/i/page.tsx');
  await git(root, 'commit', '--quiet', '-m', 'and untracked again');
  write(root, 'app/keep.ts', 'kept\n');
  await git(root, 'add', 'app/keep.ts');
  await git(root, 'commit', '--quiet', '-m', 'app holds a tracked file');
  expect(await rows(repo)).toEqual(['app/[id]/ untracked folder', 'app/d/ untracked folder', 'app/i/ untracked folder']);

  await repo.revertFile('app/[id]/');

  expect(fs.existsSync(path.join(root, 'app/[id]'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'app/i/page.tsx')), 'app/i/ is another folder').toBe(true);
  expect(fs.existsSync(path.join(root, 'app/d/page.tsx')), 'and so is app/d/').toBe(true);
});

it('stages the file named and no other its name matches as a pattern', async () => {
  const { root, repo } = await repository(['src/[ab].ts', 'src/b.ts']);

  await repo.stageFiles(['src/[ab].ts']);

  expect((await git(root, 'diff', '--cached', '--name-only')).trim()).toBe('src/[ab].ts');
});

// Git neither looks inside a repository of its own nor removes one, and says nothing of either
it('lists nothing in a folder that is a repository of its own, and says it was not removed', async () => {
  const { root, repo } = await repository([]);
  fs.mkdirSync(path.join(root, 'nested'));
  await git(path.join(root, 'nested'), 'init', '--quiet');
  write(root, 'nested/inner.txt', 'inner\n');
  expect(await rows(repo)).toEqual(['nested/ untracked folder']);

  expect(await repo.listUntracked('nested/')).toEqual({ files: [], truncated: false });
  await expect(repo.revertFile('nested/')).rejects.toThrow('a repository of its own');
  expect(fs.existsSync(path.join(root, 'nested/inner.txt'))).toBe(true);
});

// A read of everything has no event naming what changed, and a folder's own time does not say what changed deep
// inside it
it('says a folder row may have changed whenever everything is read, so that what is open under it is read again', async () => {
  const { root, repo } = await repository(['vendor/x/deep/a.js']);
  await repo.refreshSnapshot('everything');
  write(root, 'vendor/x/deep/a.js', 'changed\n');

  expect(await repo.refreshSnapshot('everything')).toMatchObject({ status: false, diffs: true, files: ['vendor/'] });
});
