// Copies of the working tree, kept in a store outside the repository: taken, compared and put back without the
// repository's index, refs, objects or status moving, and leaving out what the user's git ignores. Every git is a
// real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, KEPT_FILE_LIMIT } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const temporary = (name: string) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-checkpoint-${name}-`)));
  directories.push(directory);
  return directory;
};

/** A repository with a tracked file, a staged change, an untracked file and an ignored one, and its store's place */
async function repository() {
  const root = temporary('repo');
  const store = path.join(temporary('store'), 'store');
  const home = temporary('home');
  const global = path.join(home, '.gitconfig');
  const userExcludes = path.join(home, 'excludes');
  fs.writeFileSync(userExcludes, 'ignored-by-the-user.txt\n');
  fs.writeFileSync(global, `[core]\n\texcludesFile = ${userExcludes.replaceAll('\\', '/')}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global };
  const git = (...args: string[]) => run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env });
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.log\n');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'bee\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  fs.writeFileSync(path.join(root, 'b.txt'), 'bee, staged\n');
  await git('add', 'b.txt');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one, changed\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  fs.writeFileSync(path.join(root, 'ignored.log'), 'ignored\n');
  fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'excluded.txt\n');
  fs.writeFileSync(path.join(root, 'excluded.txt'), 'excluded\n');
  fs.writeFileSync(path.join(root, 'ignored-by-the-user.txt'), 'theirs\n');
  const repo = new GitRepository(root, { environment: () => env, checkpointDirectory: () => store });
  /** What the repository holds of its own that no checkpoint may move */
  const own = async () => ({
    index: fs.readFileSync(path.join(root, '.git', 'index')).toString('base64'),
    status: (await git('status', '--porcelain=v2', '--untracked-files=all')).stdout,
    refs: (await git('for-each-ref')).stdout,
    objects: (await git('count-objects', '-v')).stdout,
  });
  return { root, store, repo, git, own };
}
const read = (root: string, file: string) => fs.readFileSync(path.join(root, file), 'utf8');

it('takes a copy, says what changed since, and puts it back, leaving the repository\'s own as they were', async () => {
  const { root, store, repo, own } = await repository();
  const before = await own();

  const { id, notKept } = await repo.checkpoint();
  fs.writeFileSync(path.join(root, 'a.txt'), 'one, changed again\n');
  fs.rmSync(path.join(root, 'new.txt'));
  fs.writeFileSync(path.join(root, 'made-since.txt'), 'made since\n');

  expect(notKept).toEqual([]);
  expect(await repo.changedSince(id)).toEqual([
    { path: 'a.txt', change: 'modified' },
    { path: 'made-since.txt', change: 'added' },
    { path: 'new.txt', change: 'deleted' },
  ]);

  await repo.restoreCheckpoint(id);

  expect(read(root, 'a.txt')).toBe('one, changed\n');
  expect(read(root, 'new.txt')).toBe('new\n');
  expect(fs.existsSync(path.join(root, 'made-since.txt')), 'what was made since is gone').toBe(false);
  expect(await own(), 'the index bytes, status, refs and objects are as they were').toEqual(before);
  expect(fs.existsSync(path.join(store, 'HEAD')), 'and what was written is in the store').toBe(true);
});

it('leaves out what the tree, the repository and the user ignore, and never touches it', async () => {
  const { root, repo } = await repository();

  const { id } = await repo.checkpoint();
  for (const file of ['ignored.log', 'excluded.txt', 'ignored-by-the-user.txt']) fs.writeFileSync(path.join(root, file), 'changed since\n');

  expect(await repo.changedSince(id)).toEqual([]);
  await repo.restoreCheckpoint(id);
  expect(read(root, 'ignored.log')).toBe('changed since\n');
  expect(read(root, 'excluded.txt')).toBe('changed since\n');
  expect(read(root, 'ignored-by-the-user.txt')).toBe('changed since\n');
});

it('keeps only the paths it is given, and puts back only those', async () => {
  const { root, repo } = await repository();

  const { id } = await repo.checkpoint(['a.txt']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'later\n');
  fs.writeFileSync(path.join(root, 'new.txt'), 'later\n');

  expect(await repo.changedSince(id, ['a.txt'])).toEqual([{ path: 'a.txt', change: 'modified' }]);
  await repo.restoreCheckpoint(id, ['a.txt']);
  expect(read(root, 'a.txt')).toBe('one, changed\n');
  expect(read(root, 'new.txt'), 'and nothing it was not given').toBe('later\n');
});

it('leaves out a file larger than it keeps, names it, and never puts it back or removes it', async () => {
  const { root, repo } = await repository();
  fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(KEPT_FILE_LIMIT + 1, 1));

  const { id, notKept } = await repo.checkpoint();
  fs.writeFileSync(path.join(root, 'large.bin'), 'small now\n');

  expect(notKept).toEqual(['large.bin']);
  expect(await repo.changedSince(id)).toEqual([]);
  await repo.restoreCheckpoint(id);
  expect(read(root, 'large.bin')).toBe('small now\n');
});

it('says a checkpoint it no longer has is gone', async () => {
  const { store, repo } = await repository();
  const { id } = await repo.checkpoint();
  await run('git', ['--git-dir', store, 'update-ref', '-d', `refs/checkpoints/${id}`]);

  await expect(repo.restoreCheckpoint(id)).rejects.toThrow(/no longer kept/);
});

it('drops checkpoints past their age when the next is taken', async () => {
  const { store, repo } = await repository();
  const { id: old } = await repo.checkpoint();
  // Made fifteen days ago, as the store's own commit for it says
  const fifteenDaysAgo = `${Math.floor(Date.now() / 1000) - 15 * 24 * 60 * 60} +0000`;
  const tree = (await run('git', ['--git-dir', store, 'rev-parse', `${old}^{tree}`])).stdout.trim();
  const aged = (await run('git', ['--git-dir', store, 'commit-tree', tree, '-m', '{"notKept":[]}'], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a', GIT_COMMITTER_DATE: fifteenDaysAgo, GIT_AUTHOR_DATE: fifteenDaysAgo },
  })).stdout.trim();
  await run('git', ['--git-dir', store, 'update-ref', `refs/checkpoints/${aged}`, aged]);

  const { id: fresh } = await repo.checkpoint();

  const refs = (await run('git', ['--git-dir', store, 'for-each-ref', '--format=%(refname:lstrip=2)', 'refs/checkpoints/'])).stdout.split('\n').filter(Boolean);
  expect(refs).not.toContain(aged);
  expect(refs).toEqual(expect.arrayContaining([old, fresh]));
});
