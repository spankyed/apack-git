// One piece of a file's change is staged, or taken back out of what is staged, by itself. Every case runs a real
// git: the pieces are the ones git cut, and what is staged afterwards is read from git.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout;
const lines = (count: number, changed: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, index) => changed[index + 1] ?? `line ${index + 1}`).join('\n') + '\n';

/** A repository with a forty-line file committed, and two edits far apart in it that are not staged */
async function repositoryWithTwoEdits(file = 'a.txt') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-hunks-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, file), lines(40));
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  fs.writeFileSync(path.join(root, file), lines(40, { 3: 'the top edit', 35: 'the bottom edit' }));
  return { root, repo: new GitRepository(root) };
}
const staged = (root: string, file = 'a.txt') => git(root, 'show', `:${file}`);

it('cuts a file\'s change into its pieces, each where it is on both sides', async () => {
  const { repo } = await repositoryWithTwoEdits();

  expect((await repo.getHunks('a.txt', false)).map(({ patch: _patch, id: _id, ...where }) => where)).toEqual([
    { oldStart: 1, oldLines: 6, newStart: 1, newLines: 6 },
    { oldStart: 32, oldLines: 7, newStart: 32, newLines: 7 },
  ]);
  expect(await repo.getHunks('a.txt', true), 'nothing is staged').toEqual([]);
});

it('stages one piece and leaves the other in the working tree', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  const [, bottom] = await repo.getHunks('a.txt', false);

  await repo.applyHunk('a.txt', false, bottom!.id);

  expect(await staged(root)).toBe(lines(40, { 35: 'the bottom edit' }));
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'the file itself is untouched').toBe(lines(40, { 3: 'the top edit', 35: 'the bottom edit' }));
  expect((await repo.getHunks('a.txt', false)).map(hunk => hunk.newStart), 'one piece is left to stage').toEqual([1]);
  expect((await repo.getHunks('a.txt', true)).map(hunk => hunk.newStart), 'and one to unstage').toEqual([32]);
});

it('takes one piece back out of what is staged', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  await git(root, 'add', 'a.txt');
  const [top] = await repo.getHunks('a.txt', true);

  await repo.applyHunk('a.txt', true, top!.id);

  expect(await staged(root)).toBe(lines(40, { 35: 'the bottom edit' }));
});

// A piece read before the file changed again was cut from lines that are no longer there
it('refuses a piece read before the file changed, and stages nothing', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  const [top] = await repo.getHunks('a.txt', false);
  fs.writeFileSync(path.join(root, 'a.txt'), lines(40, { 3: 'edited again', 35: 'the bottom edit' }));

  await expect(repo.applyHunk('a.txt', false, top!.id)).rejects.toThrow('has changed since this change was read');

  expect(await staged(root)).toBe(lines(40));
});

it('stages a piece of a file whose name git has to quote', async () => {
  const { root, repo } = await repositoryWithTwoEdits('nämé with space.txt');
  const [top] = await repo.getHunks('nämé with space.txt', false);

  await repo.applyHunk('nämé with space.txt', false, top!.id);

  expect(await staged(root, 'nämé with space.txt')).toBe(lines(40, { 3: 'the top edit' }));
});

it('keeps the last line as it is when it has no line break', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  fs.writeFileSync(path.join(root, 'a.txt'), `${lines(40, { 3: 'the top edit' })}added with no break`);
  const [, last] = await repo.getHunks('a.txt', false);

  await repo.applyHunk('a.txt', false, last!.id);

  expect(await staged(root)).toBe(`${lines(40)}added with no break`);
});

// Only the whole of such a file is staged: a piece of a file that is new, gone, renamed or binary is not a piece
it('offers no pieces of a file that is new, deleted, renamed or binary', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));
  await git(root, 'add', 'new.txt', 'image.bin');
  await git(root, 'commit', '--quiet', '-m', 'more');
  fs.writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 9, 9, 0, 255]));
  fs.writeFileSync(path.join(root, 'added.txt'), 'added\n');
  await git(root, 'rm', '--quiet', 'new.txt');
  await git(root, 'add', 'added.txt');
  await git(root, 'mv', 'a.txt', 'moved.txt');

  expect(await repo.getHunks('image.bin', false)).toEqual([]);
  expect(await repo.getHunks('added.txt', true)).toEqual([]);
  expect(await repo.getHunks('new.txt', true)).toEqual([]);
  expect(await repo.getHunks('moved.txt', true)).toEqual([]);
});

// Alone, a piece is looked for where the whole diff numbered it, which is off by what the pieces above it added:
// git then settles on the nearest lines that read the same
it('stages a piece into its own lines when another block above it reads the same', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  const block = (name: string, version: string) => [`${name}:`, '  steps:', '    - checkout', '    - setup', `      version: ${version}`, '    - install', '    - test', ''];
  const file = (extra: string[], second: string) => [...extra, 'jobs:', '', ...block('docs', '20'), ...block('e2e', second)].join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'ci.yml'), file([], '20'));
  await git(root, 'add', 'ci.yml');
  await git(root, 'commit', '--quiet', '-m', 'ci');
  // Eight lines added at the top, which is the distance between the two blocks, and one line changed in the second
  fs.writeFileSync(path.join(root, 'ci.yml'), file(Array.from({ length: 8 }, (_, index) => `# note ${index}`), '22'));
  const pieces = await repo.getHunks('ci.yml', false);
  expect(pieces).toHaveLength(2);

  await repo.applyHunk('ci.yml', false, pieces[1]!.id);

  expect(await staged(root, 'ci.yml')).toBe(file([], '22'));
});

it('takes a piece back out of its own lines when another block above it reads the same', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  const block = (name: string, version: string) => [`${name}:`, '  steps:', '    - checkout', '    - setup', `      version: ${version}`, '    - install', '    - test', ''];
  const file = (extra: string[], first: string, second: string) => [...extra, 'jobs:', '', ...block('docs', first), ...block('e2e', second)].join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'ci.yml'), file([], '20', '20'));
  await git(root, 'add', 'ci.yml');
  await git(root, 'commit', '--quiet', '-m', 'ci');
  const notes = Array.from({ length: 8 }, (_, index) => `# note ${index}`);
  fs.writeFileSync(path.join(root, 'ci.yml'), file(notes, '20', '22'));
  await git(root, 'add', 'ci.yml');
  const pieces = await repo.getHunks('ci.yml', true);

  await repo.applyHunk('ci.yml', true, pieces[1]!.id);

  expect(await staged(root, 'ci.yml')).toBe(file(notes, '20', '20'));
});

// A file need not be UTF-8, and a patch decoded as text and encoded again is not the patch git made
it('stages the bytes the file holds when they are not UTF-8', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  const latin1 = (text: string) => Buffer.from(text, 'latin1');
  fs.writeFileSync(path.join(root, 'legacy.properties'), latin1('one=1\ntwo=2\nthree=3\n'));
  await git(root, 'add', 'legacy.properties');
  await git(root, 'commit', '--quiet', '-m', 'legacy');
  fs.writeFileSync(path.join(root, 'legacy.properties'), latin1('one=1\ntwo=2\ngreeting=caf\xe9\nthree=3\n'));
  const [piece] = await repo.getHunks('legacy.properties', false);

  await repo.applyHunk('legacy.properties', false, piece!.id);

  const { stdout } = await run('git', ['-C', root, 'show', ':legacy.properties'], { encoding: 'latin1' });
  expect(stdout).toBe('one=1\ntwo=2\ngreeting=caf\xe9\nthree=3\n');
});

// What the user told `git diff` is not what `git apply` reads a patch by
it.each([
  ['diff.noprefix', 'true'],
  ['diff.mnemonicPrefix', 'true'],
  ['diff.context', '0'],
  ['diff.relative', 'true'],
])('stages a piece where it belongs with %s=%s in the user\'s git config', async (key, value) => {
  const { root, repo } = await repositoryWithTwoEdits();
  fs.mkdirSync(path.join(root, 'src'));
  // A file of the same name and lines one folder down, which a patch with no prefix would name the top one for
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), lines(40));
  await git(root, 'add', 'src/a.txt');
  await git(root, 'commit', '--quiet', '-m', 'second');
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), lines(40, { 20: 'the inner edit' }));
  await git(root, 'config', key, value);
  const [piece] = await repo.getHunks('src/a.txt', false);

  await repo.applyHunk('src/a.txt', false, piece!.id);

  expect(await staged(root, 'src/a.txt')).toBe(lines(40, { 20: 'the inner edit' }));
  expect(await staged(root), 'the file above it is untouched').toBe(lines(40));
});

// The other pieces of a file are still on a window's screen after one is staged, read before it was
it('stages a second piece read before the first was staged', async () => {
  const { root, repo } = await repositoryWithTwoEdits();
  fs.writeFileSync(path.join(root, 'a.txt'), lines(40, { 3: 'the top edit\nand a line more', 35: 'the bottom edit' }));
  const [top, bottom] = await repo.getHunks('a.txt', false);

  await repo.applyHunk('a.txt', false, top!.id);
  await repo.applyHunk('a.txt', false, bottom!.id);

  expect(await staged(root)).toBe(lines(40, { 3: 'the top edit\nand a line more', 35: 'the bottom edit' }));
  await expect(repo.applyHunk('a.txt', false, top!.id), 'a piece already staged is no longer one git cuts').rejects.toThrow('has changed since this change was read');
});

it('cuts the pieces of the file named, and not of others its name matches as a pattern', async () => {
  const { root, repo } = await repositoryWithTwoEdits('[ab].txt');
  for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(root, name), lines(40));
  await git(root, 'add', 'a.txt', 'b.txt');
  await git(root, 'commit', '--quiet', '-m', 'more');
  for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(root, name), lines(40, { 20: 'another edit' }));

  expect((await repo.getHunks('[ab].txt', false)).map(hunk => hunk.newStart)).toEqual([1, 32]);
});
