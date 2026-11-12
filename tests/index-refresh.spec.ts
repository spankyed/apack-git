// Git keeps in its index what it last saw of each file, and a status that may not write the index reads again
// every file whose time moved, on every run. No read here may write it but the one asked to at a quiet moment.
// Every case runs a real git, and reads what the index holds of a file from git itself.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { settles } from './_support/settles.ts';
import { GitRepository } from '../src/index.ts';
import { removeDirectory } from './_support/remove.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout;

/** A repository with `a.txt` committed, and its watcher's place taken by the spec */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-index-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  // Trusted, since a case here writes a hook of its own for git to run
  return { root, repo: new GitRepository(root, { isTrusted: () => true }) };
}
/** Moves the file's time and leaves its content, as a checkout or a formatter that changed nothing does */
function touch(root: string, seconds: number) {
  fs.utimesSync(path.join(root, 'a.txt'), seconds, seconds);
  return String(seconds);
}
/** The time the index holds for the file, in seconds */
const timeInIndex = async (root: string) => /mtime: (\d+):/.exec(await git(root, 'ls-files', '--debug', '--', 'a.txt'))?.[1];
const YEAR_2001 = 978_307_200;
const YEAR_2002 = 1_009_843_200;

it('leaves the index as it is on a check, however stale it is', async () => {
  const { root, repo } = await repository();
  const before = await timeInIndex(root);
  touch(root, YEAR_2001);

  await repo.refreshSnapshot('everything');

  expect(await timeInIndex(root)).toBe(before);
});

it('lets git write what it learns into the index on the one check asked to', async () => {
  const { root, repo } = await repository();
  const touched = touch(root, YEAR_2001);

  const changed = await repo.refreshSnapshot('everything', { refreshIndex: true });

  expect(await timeInIndex(root)).toBe(touched);
  expect((await repo.readSnapshot()).files, 'and the file is still unchanged to it').toEqual([]);
  expect(changed.status, 'which is a first check, with everything new').toBe(true);
});

// Writing holds git's lock, so it is not taken again until something says the index may be stale: a change too
// wide to name, or to git's own state
it('does not write it again until a wide change is noted', async () => {
  const { root, repo } = await repository();
  touch(root, YEAR_2001);
  await repo.refreshSnapshot('everything', { refreshIndex: true });
  const later = touch(root, YEAR_2002);

  await repo.refreshSnapshot('everything', { refreshIndex: true });
  expect(await timeInIndex(root), 'nothing said it was stale').toBe(String(YEAR_2001));

  repo.noteChanged(['a.txt']);
  await repo.refreshSnapshot('everything', { refreshIndex: true });
  expect(await timeInIndex(root), 'a change to one named file is not that').toBe(String(YEAR_2001));

  repo.noteChanged(null);
  await repo.refreshSnapshot('everything', { refreshIndex: true });
  expect(await timeInIndex(root)).toBe(later);
});

// Git skips the write, silently, when another git holds the index. The check still answers, and the next one
// asked to writes it
it('answers when another git holds the index, and writes it once that git has let go', async () => {
  const { root, repo } = await repository();
  const before = await timeInIndex(root);
  const touched = touch(root, YEAR_2001);
  const lock = path.join(root, '.git', 'index.lock');
  fs.writeFileSync(lock, '');

  await repo.refreshSnapshot('everything', { refreshIndex: true });
  expect((await repo.readSnapshot()).branch).toBe('main');
  expect(fs.existsSync(lock), 'the lock is the other git\'s').toBe(true);
  fs.rmSync(lock);
  expect(await timeInIndex(root)).toBe(before);

  await repo.refreshSnapshot('everything', { refreshIndex: true });
  expect(await timeInIndex(root)).toBe(touched);
});

// The status that may write the index takes its turn among the writes made here, and every read asked after it
// waits for it: behind a commit whose hook is slow, that is the panel answering nothing until the commit ends
it('does not wait behind a write made here, and leaves the index for the next such check', async () => {
  const { root, repo } = await repository();
  const hook = path.join(root, '.git/hooks/pre-commit');
  // Held until this case lets it go, and gone by itself with the repository
  fs.writeFileSync(hook, '#!/bin/sh\ntouch .git/started\nwhile [ ! -f .git/go ] && [ -d .git ]; do sleep 0.05; done\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(root, 'b.txt'), 'two\n');
  await repo.stageFiles(['b.txt']);
  const committing = repo.commit('second');
  // The commit reads the index itself as it begins: the file's time is moved once its hook is running
  await settles(() => { if (!fs.existsSync(path.join(root, '.git/started'))) throw new Error('the hook has not started'); });
  const touched = touch(root, YEAR_2001);

  await repo.refreshSnapshot('everything', { refreshIndex: true });
  expect((await repo.readSnapshot()).files.map(file => file.path), 'answered while the commit is still running').toEqual(['b.txt']);
  expect(await timeInIndex(root), 'and the index is not written beside it').not.toBe(touched);

  fs.writeFileSync(path.join(root, '.git/go'), '');
  await committing;
  await repo.refreshSnapshot('everything', { refreshIndex: true });
  expect(await timeInIndex(root), 'the next check asked to writes it').toBe(touched);
});
