// A file as a commit has it is read through one git that stays open while files are being read, where each read
// would otherwise start a process. Every case reads a real repository.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { settles } from './_support/settles.ts';
import { GitObjectReader, GitRepository, type WatchProcess } from '../src/index.ts';

/**
 * What a host hands in to watch a git kept open. A host watches the work the process does; this one, for a
 * stand-in git that does none, goes by how long it has written nothing
 */
const watchProcess: WatchProcess = (_pid, onStalled, idleMs = 1_000) => {
  let timer = setTimeout(onStalled, idleMs);
  return {
    output: () => { clearTimeout(timer); timer = setTimeout(onStalled, idleMs); },
    stop: () => clearTimeout(timer),
  };
};

const directories: string[] = [];
/** What holds a git open in a repository's directory, which is closed before the directory is deleted */
const readers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(readers.splice(0).map(reader => reader.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 });
});

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout;
const write = (root: string, file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

/** A repository with these files committed on `main` */
async function repository(files: Record<string, string | Buffer>) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-objects-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  return root;
}
function reader(root: string, lingerMs?: number) {
  const made = new GitObjectReader(root, () => process.env, undefined, lingerMs);
  readers.push(made);
  return made;
}

function opened(root: string) {
  const made = new GitRepository(root);
  readers.push(made);
  return made;
}

it('reads many files at once, each answered with its own content, through one git', async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`src/f${index}.txt`, `file ${index}\n`.repeat(index + 1)]));
  const root = await repository(files);
  const objects = reader(root);

  const read = await Promise.all(Object.keys(files).map(async file => [file, (await objects.read(`HEAD:${file}`))?.toString('utf8')]));

  expect(Object.fromEntries(read)).toEqual(files);
});

it('hands back a file\'s bytes as they are, an empty file and one with no line break at its end included', async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x0a, 0x0a, 0x89, 0x50, 0x4e, 0x47, 0x0d]);
  const root = await repository({ 'image.png': bytes, 'empty.txt': '', 'no-break.txt': 'last line' });
  const objects = reader(root);

  expect(await objects.read('HEAD:image.png')).toEqual(bytes);
  expect((await objects.read('HEAD:empty.txt'))?.toString()).toBe('');
  expect((await objects.read('HEAD:no-break.txt'))?.toString()).toBe('last line');
});

it('answers nothing for a file the commit does not have, for a directory, and for a commit git does not know', async () => {
  const root = await repository({ 'src/a.txt': 'one\n' });
  const objects = reader(root);

  expect(await objects.read('HEAD:missing.txt')).toBeUndefined();
  expect(await objects.read('HEAD:src')).toBeUndefined();
  expect(await objects.read('no-such-branch:src/a.txt')).toBeUndefined();
  expect((await objects.read('HEAD:src/a.txt'))?.toString(), 'and goes on answering').toBe('one\n');
});

// The git that stays open resolves a name when it is asked for, so a commit made since is read
it('reads a branch where it is now, after a commit made by another git', async () => {
  const root = await repository({ 'a.txt': 'one\n' });
  const repo = opened(root);
  expect(await repo.getFileContent('a.txt', 'HEAD')).toBe('one\n');

  write(root, 'a.txt', 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');

  expect(await repo.getFileContent('a.txt', 'HEAD')).toBe('two\n');
  expect(await repo.getFileContentFromBranch('a.txt', 'main')).toBe('two\n');
});

// The staged version is the index's, which a git that stays open reads once: it is asked of a git of its own
it('reads the staged version as it is now, after a file was staged by another git', async () => {
  const root = await repository({ 'a.txt': 'one\n' });
  const repo = opened(root);
  expect(await repo.getFileContent('a.txt', 'HEAD')).toBe('one\n');
  expect(await repo.getFileContent('a.txt', 'index')).toBe('one\n');

  write(root, 'a.txt', 'staged\n');
  await git(root, 'add', 'a.txt');

  expect(await repo.getFileContent('a.txt', 'index')).toBe('staged\n');
  expect(await repo.getFileContent('a.txt', 'HEAD'), 'and the commit is as it was').toBe('one\n');
});

// Windows allows no line break in a file's name, so there is none there to read
it.skipIf(process.platform === 'win32')('reads a file whose name one line cannot carry, by a git of its own', async () => {
  const root = await repository({ 'a\nb.txt': 'odd\n', 'with:colon.txt': 'colon\n' });
  const repo = opened(root);

  expect(await repo.getFileContent('a\nb.txt', 'HEAD')).toBe('odd\n');
  expect(await repo.getFileContentFromBranch('with:colon.txt', 'main')).toBe('colon\n');
});

it('lets its git go once nothing has been read for a while, and opens another for the next read', async () => {
  const root = await repository({ 'a.txt': 'one\n' });
  const objects = reader(root, 20);

  await objects.read('HEAD:a.txt');
  expect(objects.isOpen).toBe(true);
  await settles(() => { if (objects.isOpen) throw new Error('its git is still open'); });

  expect((await objects.read('HEAD:a.txt'))?.toString()).toBe('one\n');
});

it('fails what was being read when its git is ended, and reads again after', async () => {
  const root = await repository({ 'a.txt': 'one\n' });
  const objects = reader(root);
  await objects.read('HEAD:a.txt');

  const reading = objects.read('HEAD:a.txt');
  const closed = objects.close();

  await expect(reading).rejects.toThrow('closed');
  await closed;
  expect((await objects.read('HEAD:a.txt'))?.toString()).toBe('one\n');
});

// Windows will not delete a directory a process is in, and there `git` is two processes, the second of which
// outlives the first by a moment: this fails there when closing settles before both have gone. Elsewhere a
// directory is deleted whatever is in it
it('has no git left in the repository once it is closed, so its directory is deleted at once', async () => {
  const root = await repository({ 'a.txt': 'one\n' });
  const repo = opened(root);
  await repo.getFileContent('a.txt', 'HEAD');
  const objects = reader(root);
  await objects.read('HEAD:a.txt');

  await Promise.all([repo.close(), objects.close()]);

  fs.rmSync(root, { recursive: true });
  expect(fs.existsSync(root)).toBe(false);
});

// Reads are answered in order, so a git that stops answering holds every read asked after it
// The git that stops answering is stood in for by a shell script named `git`, which Windows does not run by that name
it.skipIf(process.platform === 'win32')('ends a git that owes an answer and does no work, failing what it owed, and reads again after', async () => {
  const root = await repository({ 'a.txt': 'one\n' });
  const bin = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-objects-bin-')));
  directories.push(bin);
  // A git that reads what it is asked and answers nothing; it ends when its input closes
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec cat > /dev/null\n');
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  let stalls = true;
  const objects = new GitObjectReader(root, () => (stalls ? { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } : process.env), watchProcess, undefined, 200);
  readers.push(objects);

  const first = objects.read('HEAD:a.txt');
  const second = objects.read('HEAD:a.txt');
  await expect(first).rejects.toThrow('stopped answering');
  await expect(second).rejects.toThrow('stopped answering');

  stalls = false;
  expect((await objects.read('HEAD:a.txt'))?.toString()).toBe('one\n');
});
