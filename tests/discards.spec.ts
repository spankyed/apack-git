// A discard keeps what it removes, and that can be put back. Every case runs a real git, since what is held to is
// what git's own status says before and after, and that the user's index and refs are as they were.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository, KEPT_FILE_LIMIT } from '../src/index.ts';
import { removeDirectory } from './_support/remove.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout;
const write = (root: string, file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/** A repository with `kept.txt` and `src/a.ts` committed, and `ignored/` ignored */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-discards-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  write(root, 'kept.txt', 'one\n');
  write(root, 'src/a.ts', 'export const a = 1;\n');
  write(root, '.gitignore', 'ignored/\n*.log\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  return { root, repo: new GitRepository(root) };
}
/** What git says of the checkout, with what the user's index holds, their refs and their stashes */
async function standing(root: string) {
  return {
    status: await git(root, 'status', '--porcelain=v2', '--untracked-files=all'),
    staged: await git(root, 'ls-files', '--stage'),
    refs: await git(root, 'for-each-ref'),
    stashes: await git(root, 'stash', 'list'),
  };
}
/**
 * The user's index, byte for byte. Discarding a tracked file is git checking it out, which writes the index's
 * record of that file as git does: where only untracked paths are discarded, nothing here may write it at all
 */
const indexBytes = (root: string) => fs.readFileSync(path.join(root, '.git', 'index')).toString('base64');

it('puts back a changed file it discarded, with what is staged and the refs as they were throughout', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'one\nand an edit nobody committed\n');
  const before = await standing(root);

  const kept = await repo.revertFile('kept.txt');

  expect(read(root, 'kept.txt')).toBe('one\n');
  expect(kept).toEqual({ id: expect.stringMatching(/^[0-9a-f]{40,64}$/), notKept: [] });
  expect((await standing(root)).refs, 'the copy is referred to by nothing').toBe(before.refs);

  expect(await repo.restoreDiscarded(kept.id!)).toEqual({ restored: ['kept.txt'], left: [] });

  expect(read(root, 'kept.txt')).toBe('one\nand an edit nobody committed\n');
  expect(await standing(root)).toEqual(before);
});

it('puts back an untracked file it deleted', async () => {
  const { root, repo } = await repository();
  write(root, 'notes/draft.md', '# a draft\n');
  await repo.readSnapshot();
  // Git lists the folder it tracks nothing in as one row, and a file in it is discarded by its own path
  const before = await standing(root);
  const index = indexBytes(root);

  const kept = await repo.revertFile('notes/draft.md');

  expect(fs.existsSync(path.join(root, 'notes/draft.md'))).toBe(false);
  expect(indexBytes(root), 'keeping the copy wrote nothing to the index').toBe(index);
  await repo.restoreDiscarded(kept.id!);

  expect(read(root, 'notes/draft.md')).toBe('# a draft\n');
  expect(await standing(root)).toEqual(before);
  expect(indexBytes(root), 'and nor did putting it back').toBe(index);
});

it('puts back an untracked folder it removed, which had left what git ignores there where it was', async () => {
  const { root, repo } = await repository();
  write(root, 'vendor/lib/one.js', '// one\n');
  write(root, 'vendor/lib/deep/two.js', '// two\n');
  write(root, 'vendor/readme.md', 'read me\n');
  write(root, 'vendor/build.log', 'ignored by its name\n');
  fs.chmodSync(path.join(root, 'vendor/lib/one.js'), 0o755);
  const before = await standing(root);

  const kept = await repo.revertFile('vendor/');

  expect(fs.existsSync(path.join(root, 'vendor/lib'))).toBe(false);
  expect(read(root, 'vendor/build.log'), 'what git ignores is not removed').toBe('ignored by its name\n');
  expect(await repo.restoreDiscarded(kept.id!)).toEqual({
    restored: ['vendor/lib/deep/two.js', 'vendor/lib/one.js', 'vendor/readme.md'], left: [],
  });

  expect(read(root, 'vendor/lib/deep/two.js')).toBe('// two\n');
  if (process.platform !== 'win32') expect(fs.statSync(path.join(root, 'vendor/lib/one.js')).mode & 0o111, 'still a program').not.toBe(0);
  expect(await standing(root)).toEqual(before);
});

it('keeps several discarded at once as one, a staged change included', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'staged\n');
  await git(root, 'add', 'kept.txt');
  write(root, 'kept.txt', 'staged\nand changed again\n');
  write(root, 'src/a.ts', 'export const a = 2;\n');
  write(root, 'fresh.txt', 'new\n');
  const before = await standing(root);

  const kept = await repo.revertFiles(['kept.txt', 'src/a.ts', 'fresh.txt']);

  expect(read(root, 'kept.txt'), 'back to what is staged').toBe('staged\n');
  expect(await repo.restoreDiscarded(kept.id!)).toEqual({ restored: ['fresh.txt', 'kept.txt', 'src/a.ts'], left: [] });
  expect(await standing(root)).toEqual(before);
});

it('leaves alone what was changed or made again since the discard, and says which', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'the edit that was discarded\n');
  write(root, 'fresh.txt', 'the file that was discarded\n');
  write(root, 'src/a.ts', 'export const a = 2;\n');
  const kept = await repo.revertFiles(['kept.txt', 'fresh.txt', 'src/a.ts']);

  write(root, 'kept.txt', 'written since\n');
  write(root, 'fresh.txt', 'made again since\n');

  expect(await repo.restoreDiscarded(kept.id!)).toEqual({ restored: ['src/a.ts'], left: ['fresh.txt', 'kept.txt'] });
  expect(read(root, 'kept.txt')).toBe('written since\n');
  expect(read(root, 'fresh.txt')).toBe('made again since\n');
  expect(read(root, 'src/a.ts')).toBe('export const a = 2;\n');
});

it('says which files are too large to keep, before the discard and after it, and keeps the rest', async () => {
  const { root, repo } = await repository();
  write(root, 'big/video.bin', Buffer.alloc(KEPT_FILE_LIMIT + 1));
  write(root, 'big/small.txt', 'small\n');

  expect(await repo.discardNotKept(['big/'])).toEqual(['big/video.bin']);
  const kept = await repo.revertFile('big/');

  expect(kept.notKept).toEqual(['big/video.bin']);
  expect(await repo.restoreDiscarded(kept.id!)).toEqual({ restored: ['big/small.txt'], left: [] });
  expect(fs.existsSync(path.join(root, 'big/video.bin')), 'the one over the bound is gone').toBe(false);
});

it('keeps nothing, and says so, when a deletion is what is discarded', async () => {
  const { root, repo } = await repository();
  fs.rmSync(path.join(root, 'kept.txt'));

  expect(await repo.revertFile('kept.txt')).toEqual({ notKept: [] });
  expect(read(root, 'kept.txt')).toBe('one\n');
});

// A row's path is from the top of the checkout, which the working directory may be under
it('keeps and puts back from a working directory under the top of the checkout', async () => {
  const { root } = await repository();
  const repo = new GitRepository(path.join(root, 'src'));
  write(root, 'src/a.ts', 'export const a = 3;\n');
  write(root, 'src/new/b.ts', 'export const b = 1;\n');
  const before = await standing(root);

  const kept = await repo.revertFiles(['src/a.ts', 'src/new/']);

  expect(read(root, 'src/a.ts')).toBe('export const a = 1;\n');
  expect(fs.existsSync(path.join(root, 'src/new'))).toBe(false);
  expect(await repo.restoreDiscarded(kept.id!)).toEqual({ restored: ['src/a.ts', 'src/new/b.ts'], left: [] });
  expect(await standing(root)).toEqual(before);
});

it('says what a discard kept is gone once git has pruned it, and refuses an id that is not one', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'an edit\n');
  const kept = await repo.revertFile('kept.txt');
  await git(root, 'prune', '--expire=now');

  await expect(repo.restoreDiscarded(kept.id!)).rejects.toThrow('no longer kept');
  await expect(repo.restoreDiscarded('--upload-pack=x')).rejects.toThrow('Invalid id');
  expect(read(root, 'kept.txt')).toBe('one\n');
});

it('leaves no index of its own behind', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'an edit\n');
  const kept = await repo.revertFile('kept.txt');
  await repo.restoreDiscarded(kept.id!);

  expect(fs.readdirSync(path.join(root, '.git')).filter(name => name.startsWith('apack-kept-'))).toEqual([]);
});
