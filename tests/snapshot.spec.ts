// What the commit panel shows of a checkout is one read of git, and "did the repository change" is that read
// compared with the last. Every case runs a real git, since what is being held is how git's own output is read.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository, runUnbounded } from '../src/index.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args]);
const write = (root: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};

/** A repository on `main` with one commit holding `kept.txt`, `gone.txt` and `old name.txt` */
async function repository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-snapshot-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  write(root, 'kept.txt', 'one\n');
  write(root, 'gone.txt', 'here\n');
  write(root, 'old name.txt', 'a file that will be renamed, long enough for git to follow it\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  return { root, repo: new GitRepository(root) };
}

it('reads every kind of change, with paths that hold spaces and a folder git tracks nothing in as one row', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'one\ntwo\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  await git(root, 'mv', 'old name.txt', 'new name.txt');
  write(root, 'staged.txt', 'new\n');
  await git(root, 'add', 'staged.txt');
  write(root, 'fresh/deep/a.txt', '');
  write(root, 'fresh/b.txt', '');

  const { files, branch, hasUpstream } = await repo.readSnapshot();
  const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path);
  expect([...files].sort(byPath)).toEqual([
    { path: 'fresh/', status: 'untracked', staged: false, isDirectory: true },
    { path: 'gone.txt', status: 'deleted', staged: false, originalPath: undefined },
    { path: 'kept.txt', status: 'modified', staged: false, originalPath: undefined },
    { path: 'new name.txt', status: 'renamed', staged: true, originalPath: 'old name.txt' },
    { path: 'staged.txt', status: 'added', staged: true, originalPath: undefined },
  ]);
  expect(branch).toBe('main');
  expect(hasUpstream).toBe(false);
});

it('reads a file changed in the index and again in the working tree as both', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'staged\n');
  await git(root, 'add', 'kept.txt');
  write(root, 'kept.txt', 'staged, then edited\n');
  expect((await repo.readSnapshot()).files).toEqual([
    { path: 'kept.txt', status: 'modified', staged: true, originalPath: undefined },
    { path: 'kept.txt', status: 'modified', staged: false, originalPath: undefined },
  ]);
});

it('reads a conflict as one row that is not staged, and says how the two sides disagree', async () => {
  const { root, repo } = await repository();
  await git(root, 'checkout', '--quiet', '-b', 'other');
  write(root, 'kept.txt', 'theirs\n');
  await git(root, 'commit', '--quiet', '-am', 'theirs');
  await git(root, 'checkout', '--quiet', 'main');
  write(root, 'kept.txt', 'ours\n');
  await git(root, 'commit', '--quiet', '-am', 'ours');
  await git(root, 'merge', '--quiet', 'other').catch(() => {});
  expect((await repo.readSnapshot()).files).toEqual([{ path: 'kept.txt', status: 'unmerged', staged: false, conflict: 'both-modified' }]);
});

it('names the branch of a repository with no commit yet, and HEAD when none is checked out', async () => {
  const unborn = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-snapshot-unborn-')));
  directories.push(unborn);
  await git(unborn, 'init', '--quiet', '--initial-branch=trunk');
  expect((await new GitRepository(unborn).readSnapshot()).branch).toBe('trunk');

  const { root, repo } = await repository();
  await git(root, 'checkout', '--quiet', '--detach');
  expect((await repo.readSnapshot()).branch).toBe('HEAD');
});

it('counts the commits a branch is ahead of and behind the remote branch it tracks', async () => {
  const { root } = await repository();
  const clone = `${root}-clone`;
  directories.push(clone);
  await run('git', ['clone', '--quiet', root, clone]);
  write(root, 'kept.txt', 'moved on\n');
  await git(root, 'commit', '--quiet', '-am', 'second');
  await git(clone, 'fetch', '--quiet');
  write(clone, 'local.txt', '');
  await git(clone, 'add', '.');
  await git(clone, 'commit', '--quiet', '-m', 'local');

  expect(await new GitRepository(clone).readSnapshot()).toMatchObject({ hasUpstream: true, ahead: 1, behind: 1 });
});

const NOTHING = { status: false, diffs: false, history: false, stashes: false, worktrees: false };

it('says which part of the repository changed, and nothing when none did', async () => {
  const { root, repo } = await repository();
  await repo.refreshSnapshot();
  expect(await repo.refreshSnapshot(), 'nothing happened').toEqual(NOTHING);

  write(root, 'kept.txt', 'edited\n');
  expect(await repo.refreshSnapshot(), 'a file was edited').toEqual({ ...NOTHING, status: true, diffs: true, files: ['kept.txt'] });

  // A worktree is listed with the commit it is on, so the worktrees change with the history
  await git(root, 'commit', '--quiet', '-am', 'second');
  expect(await repo.refreshSnapshot(), 'the edit was committed')
    .toEqual({ status: true, diffs: true, history: true, stashes: false, worktrees: true, files: ['kept.txt'] });

  // The status is the same; only a ref moved
  await git(root, 'branch', 'side');
  expect(await repo.refreshSnapshot(), 'a branch was made').toEqual({ ...NOTHING, history: true, worktrees: true });
  expect(await repo.refreshSnapshot()).toEqual(NOTHING);
});

it('says every part changed the first time it is asked, having nothing to compare with', async () => {
  const { repo } = await repository();
  expect(await repo.refreshSnapshot()).toEqual({ status: true, diffs: true, history: true, stashes: true, worktrees: true });
});

// Dropping a stash below the newest leaves `refs/stash` where it was: only the count git reports moves, which
// `git status --show-stash` has printed since git 2.35
it('says the stashes changed when one is made and when one below the newest is dropped, and nothing else', async () => {
  const { root, repo } = await repository();
  await repo.refreshSnapshot();

  for (const message of ['one', 'two']) {
    write(root, 'kept.txt', `an edit to stash as ${message}\n`);
    await git(root, 'stash', 'push', '--quiet', '-m', message);
    expect(await repo.refreshSnapshot(), `stash ${message} was made`).toEqual({ ...NOTHING, stashes: true });
  }
  await git(root, 'stash', 'drop', '--quiet', 'stash@{1}');
  expect(await repo.refreshSnapshot(), 'the older stash was dropped').toEqual({ ...NOTHING, stashes: true });
  expect(await repo.refreshSnapshot()).toEqual(NOTHING);
});

it('says the worktrees changed when one is added on no new branch, when it is moved and when it is locked', async () => {
  const { root, repo } = await repository();
  await repo.refreshSnapshot();
  const worktree = `${root}-detached`;
  const moved = `${root}-moved`;
  directories.push(worktree, moved);

  await git(root, 'worktree', 'add', '--quiet', '--detach', worktree);
  expect(await repo.refreshSnapshot(), 'a worktree was added').toEqual({ ...NOTHING, worktrees: true });
  await git(root, 'worktree', 'move', worktree, moved);
  expect(await repo.refreshSnapshot(), 'it was moved').toEqual({ ...NOTHING, worktrees: true });
  await git(root, 'worktree', 'lock', moved);
  expect(await repo.refreshSnapshot(), 'it was locked').toEqual({ ...NOTHING, worktrees: true });
  expect(await repo.refreshSnapshot()).toEqual(NOTHING);
});

// A pull request belongs to the branch that is checked out, so which branch that is counts as history even
// when the commit under it is the same one
it('says the history changed when another branch on the same commit is checked out', async () => {
  const { root, repo } = await repository();
  await git(root, 'branch', 'side');
  await repo.refreshSnapshot();

  await git(root, 'checkout', '--quiet', 'side');
  expect(await repo.refreshSnapshot()).toEqual({ ...NOTHING, status: true, history: true, worktrees: true });
});

// Git's record of a changed file names what it holds in HEAD and in the index. A second edit to a file already
// changed moves neither, and a diff of it left open would be of the file as it was
it('says a diff changed when a file already changed is edited again, and names the file', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'edited\n');
  write(root, 'other.txt', 'new\n');
  await repo.refreshSnapshot();

  write(root, 'kept.txt', 'edited a second time\n');
  expect(await repo.refreshSnapshot(), 'the list of changed files is the same').toEqual({ ...NOTHING, diffs: true, files: ['kept.txt'] });
  expect(await repo.refreshSnapshot()).toEqual(NOTHING);

  await git(root, 'add', 'kept.txt');
  expect(await repo.refreshSnapshot(), 'it was staged').toEqual({ ...NOTHING, status: true, diffs: true, files: ['kept.txt'] });
});

it('names no file when more changed than a window is told of one by one', async () => {
  const { root, repo } = await repository();
  await repo.refreshSnapshot();

  for (let index = 0; index <= 100; index++) write(root, `new-${index}.txt`, '');
  expect(await repo.refreshSnapshot()).toEqual({ ...NOTHING, status: true, diffs: true });
});

// A window's own ask can read a change before the check that its file event started has run. The check is
// what tells every other window, so it compares with what was last checked, not with what was last read.
it('says the repository changed when a read saw the change before the check did', async () => {
  const { root, repo } = await repository();
  await repo.refreshSnapshot();

  write(root, 'kept.txt', 'edited\n');
  expect((await repo.readSnapshot()).files.map(file => file.path)).toEqual(['kept.txt']);
  expect(await repo.refreshSnapshot(), 'no check has seen the edit yet').toEqual({ ...NOTHING, status: true, diffs: true, files: ['kept.txt'] });
  expect(await repo.refreshSnapshot()).toEqual(NOTHING);
});

it('reuses a snapshot only while a watcher reports the checkout, and reads again once told it may have changed', async () => {
  const { root, repo } = await repository();
  const paths = async () => (await repo.readSnapshot()).files.map(file => file.path);

  expect(await paths()).toEqual([]);
  write(root, 'unseen.txt', '');
  expect(await paths(), 'nothing watches, so git is asked').toEqual(['unseen.txt']);

  repo.setWatched(true);
  expect(await paths()).toEqual(['unseen.txt']);
  write(root, 'later.txt', '');
  expect(await paths(), 'the watcher has reported nothing').toEqual(['unseen.txt']);
  repo.markSnapshotStale();
  expect(await paths()).toEqual(['later.txt', 'unseen.txt']);
});

// A read takes what was noted when it begins and holds the new picture only when it ends: between the two the
// held picture is the one from before, with nothing left noted against it
it('answers a read asked while another is under way with what that one finds, not with the picture before it', async () => {
  const { root } = await repository();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let holding = false;
  // Git runs as it does, and its answer to a status is kept back while `holding`
  const repo = new GitRepository(root, { run: (file, args, options) => {
    const running = runUnbounded(file, args, options);
    if (!holding || !args.includes('status')) return running;
    return Object.assign(running.then(async (answer) => { await held; return answer; }), { child: running.child });
  } });
  repo.setWatched(true);
  expect((await repo.readSnapshot()).files).toEqual([]);

  write(root, 'new.txt', 'new\n');
  repo.noteChanged(null);
  holding = true;
  const check = repo.refreshSnapshot('noted');
  // The check's read has begun, and has not answered
  await new Promise((turn) => { setImmediate(turn); });
  const asked = repo.readSnapshot();
  release();

  expect((await asked).files.map(file => file.path)).toEqual(['new.txt']);
  expect(await check).toMatchObject({ status: true });
});

it('lists no untracked file for a user who has told git to show none', async () => {
  const { root, repo } = await repository();
  write(root, 'kept.txt', 'edited\n');
  write(root, 'fresh.txt', '');
  await git(root, 'config', 'status.showUntrackedFiles', 'no');
  expect((await repo.readSnapshot()).files.map(file => file.path)).toEqual(['kept.txt']);

  // Told to list every file, git lists the files of a folder it tracks nothing in, and the panel shows them
  await git(root, 'config', 'status.showUntrackedFiles', 'all');
  write(root, 'fresh/deep.txt', '');
  expect((await repo.readSnapshot()).files.map(file => file.path).sort()).toEqual(['fresh.txt', 'fresh/deep.txt', 'kept.txt']);
});

// That its watches failed is something the panel shows with the status, so a check reports the status changing;
// a checkout that starts being watched for the first time is as it was
it('says the status changed when its watches fail and when they come back', async () => {
  const { repo } = await repository();
  await repo.refreshSnapshot();
  repo.setWatched(true);
  expect(await repo.refreshSnapshot(), 'watched for the first time').toEqual(NOTHING);
  repo.setWatched(false, true);
  expect(await repo.refreshSnapshot(), 'its watches failed').toEqual({ ...NOTHING, status: true });
  expect(await repo.refreshSnapshot()).toEqual(NOTHING);
  repo.setWatched(true);
  expect(await repo.refreshSnapshot(), 'and came back').toEqual({ ...NOTHING, status: true });
});

it('lists the directories git ignores, and no ignored file', async () => {
  const { root, repo } = await repository();
  write(root, '.gitignore', 'out/\n*.log\n');
  write(root, 'out/bundle.js', '');
  write(root, 'debug.log', '');
  expect(await repo.listIgnoredDirectories()).toEqual(['out']);
});
