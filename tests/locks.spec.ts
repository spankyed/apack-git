// A git in a terminal, or an agent's, holds a repository's index for the moments it writes it, and git refuses at
// once a write made here in those moments. The write waits for the lock to be let go of and then runs. When the
// lock is not let go of, it says plainly what holds the repository. Every case runs a real git against a real
// lock file, which is all another git's lock is.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { GitRepository, runUnbounded, type RepositoryTies, type RunProcess } from '../src/index.ts';
import { removeDirectory } from './_support/remove.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args]);

/** A repository with one commit and an edit to `a.txt` that is not staged */
async function repository(ties: RepositoryTies = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-locks-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  // Longer than what was committed: an edit of the same size made in the clock tick the index recorded is one
  // git tells apart only by the index being no newer than the file, and a case here replaces the index
  fs.writeFileSync(path.join(root, 'a.txt'), 'two, and longer\n');
  const seam: Seam = { run: runUnbounded };
  return { root, seam, repo: new GitRepository(root, { ...ties, run: (file, args, options) => seam.run(file, args, options) }) };
}
/** Takes a lock as another git would, optionally as one taken some time ago */
function locked(root: string, file: string, takenMsAgo = 0) {
  const lock = path.join(root, '.git', `${file}.lock`);
  fs.writeFileSync(lock, '');
  const taken = new Date(Date.now() - takenMsAgo);
  fs.utimesSync(lock, taken, taken);
  return lock;
}
/** What runs git for a repository made here: replaced by a case to count runs, or to stand in for git's refusal */
type Seam = { run: RunProcess };
/**
 * Counts the times git was run with these arguments, and has the other git let go once git has refused them:
 * `at once`, before the repository has looked at the lock, or `a turn later`, when it is already waiting on it
 */
function watched(seam: Seam, command: string[], onRefused: () => void = () => {}, when: 'at once' | 'a turn later' = 'a turn later') {
  const run = seam.run;
  let runs = 0;
  seam.run = (file, args, options) => {
    // Every git is run with two arguments of the engine's own before the command's
    if (args.slice(2).join(' ') !== command.join(' ')) return run(file, args, options);
    runs++;
    const running = run(file, args, options);
    const refused = running.catch((error: unknown) => {
      if (runs === 1 && when === 'at once') onRefused();
      else if (runs === 1) setImmediate(onRefused);
      throw error;
    });
    return Object.assign(refused, { child: running.child });
  };
  return () => runs;
}
/** Git refusing `command` because of a lock, without a git being run */
function refusing(seam: Seam, command: string, lock: string, onRun: () => void) {
  const run = seam.run;
  seam.run = (file, args, options) => {
    if (args[2] !== command) return run(file, args, options);
    onRun();
    const failed = Promise.reject(Object.assign(new Error(`git ${command} failed`), { code: 128, stderr: `fatal: Unable to create '${lock}': File exists.\n` }));
    return Object.assign(failed, { child: new EventEmitter() as unknown as ChildProcess });
  };
}
const stagedFiles = async (repo: GitRepository) => (await repo.readStatus()).filter(file => file.staged).map(file => file.path);

// The other git usually lets go within moments of refusing this one: before the repository has looked at the
// lock, or just after it began to wait
it.each(['at once', 'a turn later'] as const)('stages a file once the git that held the index has let go of it, %s', async (when) => {
  const { root, repo, seam } = await repository();
  const lock = locked(root, 'index');
  const runs = watched(seam, ['add', '--', ':(top,literal)a.txt'], () => fs.rmSync(lock), when);

  await repo.stageFiles(['a.txt']);

  expect(runs(), 'refused once, then run again').toBe(2);
  expect(await stagedFiles(repo)).toEqual(['a.txt']);
});

// Git lets go of the index by renaming its lock over it, and of a lock it gives up by deleting it
it('stages a file once the lock was renamed away, as git does when it has written the index', async () => {
  const { root, repo, seam } = await repository();
  const lock = locked(root, 'index');
  fs.copyFileSync(path.join(root, '.git', 'index'), lock);
  const runs = watched(seam, ['add', '--', ':(top,literal)a.txt'], () => fs.renameSync(lock, path.join(root, '.git', 'index')));

  await repo.stageFiles(['a.txt']);

  expect(runs()).toBe(2);
  expect(await stagedFiles(repo)).toEqual(['a.txt']);
});

it('waits the same for a lock on a ref', async () => {
  const { root, repo, seam } = await repository();
  const lock = locked(root, path.join('refs', 'heads', 'topic'));
  const runs = watched(seam, ['checkout', '-b', 'topic'], () => fs.rmSync(lock));

  await repo.checkoutBranch('topic');

  expect(runs(), 'making the branch was refused once, then run again').toBe(2);
  expect((await repo.readSnapshot()).branch).toBe('topic');
});

it('says what holds the repository when the lock is not let go of, and leaves the file as it was', async () => {
  const { root, repo, seam } = await repository({ lockPatienceMs: 150 });
  const lock = locked(root, 'index');
  const runs = watched(seam, ['add', '--', ':(top,literal)a.txt']);

  await expect(repo.stageFiles(['a.txt'])).rejects.toThrow(`has not let go of it: ${lock} is still there`);

  expect(runs(), 'git was not run again while the lock was held').toBe(1);
  expect(fs.existsSync(lock), 'and the lock is the other git\'s to remove').toBe(true);
  fs.rmSync(lock);
  expect(await stagedFiles(repo)).toEqual([]);
});

// A lock older than the patience is not held by a git that is about to finish. Two repositories are refused at
// the same moment, one by a lock taken an hour ago and one by a lock just taken: the first is answered while
// the second is still waiting, however long either git took to run
it('gives up at once on a lock taken longer ago than it would wait', async () => {
  const [old, fresh] = await Promise.all([repository({ lockPatienceMs: 600_000 }), repository({ lockPatienceMs: 600_000 })]);
  locked(old.root, 'index', 3_600_000);
  const freshLock = locked(fresh.root, 'index');

  const waiting = fresh.repo.stageFiles(['a.txt']).then(() => 'the fresh lock was let go of');
  const refused = old.repo.stageFiles(['a.txt']).then(() => 'staged', (error: Error) => error.message);

  expect(await Promise.race([refused, waiting])).toContain('has not let go of it');

  fs.rmSync(freshLock);
  expect(await waiting).toBe('the fresh lock was let go of');
  expect(await stagedFiles(fresh.repo)).toEqual(['a.txt']);
});

// A stash is several steps to git: it saves the changes, then puts the working tree back, and it is the second
// that needs the index. Refused there, it has already stashed, and run again it would stash twice. Git's own
// refusal at that step is stood in for here, there being no way to have a real one arrive between the two
it('does not run a stash again, and says what holds the repository', async () => {
  const { root, repo, seam } = await repository({ lockPatienceMs: 600_000 });
  const lock = path.join(root, '.git', 'index.lock');
  let stashes = 0;
  refusing(seam, 'stash', lock, () => { stashes++; });

  await expect(repo.stashPush('work in progress')).rejects.toThrow(`has not let go of it: ${lock} is still there`);

  expect(stashes).toBe(1);
});

// Git can go on naming a lock that nothing here can see: one in a directory this process may not read, or one
// another git takes again every time it is let go of. Each look finds it gone, so only the patience ends it
it('gives up on a lock git goes on naming though nothing is there', async () => {
  const { root, repo, seam } = await repository({ lockPatienceMs: 100 });
  const lock = path.join(root, '.git', 'index.lock');
  let adds = 0;
  refusing(seam, 'add', lock, () => { adds++; });

  await expect(repo.stageFiles(['a.txt'])).rejects.toThrow('has not let go of it');

  expect(adds, 'run again while the patience lasted').toBeGreaterThan(1);
});
