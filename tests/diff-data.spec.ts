// How many lines each changed file adds and removes, and which files a commit or a stash changed, for a text
// change, a binary change and a rename, against counts known from the edits made. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A repository with a text file of ten lines, a binary file and a file of twenty lines to be renamed */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-diff-data-')));
  directories.push(root);
  const git = async (...args: string[]) => (await run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();
  const write = (file: string, content: string | Buffer) => fs.writeFileSync(path.join(root, file), content);
  await git('init', '--quiet', '--initial-branch=main');
  write('text.txt', Array.from({ length: 10 }, (_, line) => `line ${line}\n`).join(''));
  write('image.bin', Buffer.from([0, 1, 2, 3]));
  write('old-name.txt', Array.from({ length: 20 }, (_, line) => `kept ${line}\n`).join(''));
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  return { root, git, write, repo: new GitRepository(root) };
}

/** Changes three lines of the text file into two and adds one, the binary, and renames the third with one line more */
async function edit({ root, git, write }: Awaited<ReturnType<typeof repository>>) {
  const lines = fs.readFileSync(path.join(root, 'text.txt'), 'utf8').split('\n');
  lines.splice(2, 3, 'changed a', 'changed b');
  lines.splice(8, 0, 'added');
  write('text.txt', lines.join('\n'));
  write('image.bin', Buffer.from([0, 9, 9, 9, 9]));
  await git('mv', 'old-name.txt', 'new-name.txt');
  fs.appendFileSync(path.join(root, 'new-name.txt'), 'one more\n');
}

it('counts what each changed file adds and removes, staged and not', async () => {
  const setup = await repository();
  await edit(setup);
  await setup.git('add', 'new-name.txt');

  const counts = await setup.repo.lineCounts();

  expect(counts).toEqual(expect.arrayContaining([
    { path: 'text.txt', added: 3, removed: 3, binary: false, staged: false },
    { path: 'image.bin', added: 0, removed: 0, binary: true, staged: false },
    { path: 'new-name.txt', added: 1, removed: 0, binary: false, staged: true },
  ]));
  expect(counts).toHaveLength(3);
});

it('lists what a commit changed, with each file\'s count and a rename as one', async () => {
  const setup = await repository();
  await edit(setup);
  await setup.git('add', '-A');
  await setup.git('commit', '--quiet', '-m', 'second');

  const changes = await setup.repo.changesIn(await setup.git('rev-parse', 'HEAD'));

  expect(changes).toEqual(expect.arrayContaining([
    { path: 'text.txt', status: 'modified', added: 3, removed: 3, binary: false },
    { path: 'image.bin', status: 'modified', added: 0, removed: 0, binary: true },
    { path: 'new-name.txt', status: 'renamed', originalPath: 'old-name.txt', added: 1, removed: 0, binary: false },
  ]));
  expect(changes).toHaveLength(3);
  expect(await setup.repo.changesIn(await setup.git('rev-parse', 'HEAD~1')), 'and a first commit, all it holds').toHaveLength(3);
});

it('lists what a stash holds without applying it, its untracked files among them', async () => {
  const setup = await repository();
  await edit(setup);
  setup.write('untracked.txt', 'a\nb\n');
  await setup.git('stash', 'push', '--quiet', '--include-untracked');
  const before = await setup.git('status', '--porcelain');

  const changes = await setup.repo.readStashChanges(0);

  expect(changes.map(({ path: file, status, added, removed }) => [file, status, added, removed])).toEqual([
    ['image.bin', 'modified', 0, 0],
    ['new-name.txt', 'renamed', 1, 0],
    ['text.txt', 'modified', 3, 3],
    ['untracked.txt', 'added', 2, 0],
  ]);
  expect(await setup.git('status', '--porcelain'), 'and the working tree is as it was').toBe(before);
});

// A tool asks for the diff of several files in one go, whether git tracks them or not
it('writes one diff of several files, a changed one and one git does not track, and nothing of one unchanged', async () => {
  const { write, repo } = await repository();
  write('text.txt', 'replaced\n');
  write('fresh.txt', 'a new line\n');

  const diff = await repo.readDiffs(['text.txt', 'fresh.txt', 'old-name.txt']);

  expect(diff).toContain('diff --git a/text.txt b/text.txt');
  expect(diff).toMatch(/^-line 0$/m);
  expect(diff).toMatch(/^\+replaced$/m);
  expect(diff).toContain('diff --git a/fresh.txt b/fresh.txt');
  expect(diff).toContain('+++ b/fresh.txt');
  expect(diff).toMatch(/^\+a new line$/m);
  expect(diff).not.toContain('old-name.txt');
});

// A file git does not track has no diff of git's own, so the engine writes one; it must be a patch git can apply
it('shows a file git does not track as a patch that rebuilds it, whether it ends its last line or not', async () => {
  const { root, git, write, repo } = await repository();
  const contents = { 'ended.txt': 'one\ntwo\n', 'unended.txt': 'one\ntwo', 'single.txt': 'only\n', 'empty.txt': '' };
  for (const [file, content] of Object.entries(contents)) write(file, content);

  const diffs = Object.fromEntries(await Promise.all(Object.keys(contents).map(async file => [file, await repo.readDiff(file)])));
  for (const file of Object.keys(contents)) fs.rmSync(path.join(root, file));
  for (const [file, content] of Object.entries(contents)) {
    fs.writeFileSync(path.join(root, `${file}.patch`), diffs[file]!);
    await git('apply', `${file}.patch`);
    expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toBe(content);
  }
  expect(diffs['ended.txt'], 'two lines are two').toContain('@@ -0,0 +1,2 @@\n+one\n+two\n');
});

it('shows a file inside a folder git does not track, and an absolute path inside the repository, as added', async () => {
  const { root, write, repo } = await repository();
  fs.mkdirSync(path.join(root, 'folder'));
  write('folder/inner.txt', 'inside\n');
  write('fresh.txt', 'a new line\n');

  const diff = await repo.readDiffs(['folder/inner.txt', path.join(root, 'fresh.txt')]);

  expect(diff).toContain('+++ b/folder/inner.txt\n@@ -0,0 +1 @@\n+inside\n');
  expect(diff, 'named as git names it, not by where it is on disk').toContain('+++ b/fresh.txt\n@@ -0,0 +1 @@\n+a new line\n');
});
