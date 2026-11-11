// The repository watcher reports that a checkout may have changed. Its events are hints, so these cases hand it
// events directly and use a real git for everything git decides: where a checkout's state lives, and what it ignores.
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { settles } from './_support/settles.ts';
import { GitWatcherService } from '../src/index.ts';
import type { SubscribeToDirectory, WatchedChange } from '../src/index.ts';
import { GitRepository } from '../src/index.ts';

interface FakeWatch {
  directory: string;
  ignore: string[];
  closed: boolean;
  events(...changes: WatchedChange[]): void;
  fail(error: Error): void;
}

/** Stands in for the platform's watcher: records each directory watched and lets a case deliver its events */
function watches() {
  const opened: FakeWatch[] = [];
  const subscribe: SubscribeToDirectory = async (directory, onChanges, { ignore }) => {
    const watch: FakeWatch = {
      directory, ignore, closed: false,
      events: (...changes) => onChanges(null, changes),
      fail: error => onChanges(error, []),
    };
    opened.push(watch);
    return { unsubscribe: async () => { watch.closed = true; } };
  };
  const open = () => opened.filter(watch => !watch.closed);
  return { subscribe, open, of: (directory: string) => open().find(watch => watch.directory === directory) };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function directory(prefix: string): string {
  const created = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(created, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 }));
  return created;
}
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args]);

/** A watcher over a directory, with the fake platform watcher it opens its watches through */
function watcherOf(workingDirectory: string) {
  const platform = watches();
  const watcher = new GitWatcherService(workingDirectory, { subscribe: platform.subscribe, followFile: () => ({ close: () => {}, look: () => {} }) });
  cleanups.push(() => watcher.stopWatching());
  const repository = new GitRepository(workingDirectory);
  const changed = vi.fn();
  watcher.setGitRepository(repository);
  watcher.setChangeCallback(changed);
  return { watcher, repository, changed, platform };
}
const start = (watcher: GitWatcherService) => watcher.startWatching(new AbortController().signal);

it('opens no watch when startup is cancelled before git has answered', async () => {
  const repo = directory('apack-watch-cancel-');
  await git(repo, 'init', '--quiet');
  const { watcher, platform } = watcherOf(repo);
  const cancellation = new AbortController();
  const startup = watcher.startWatching(cancellation.signal);
  cancellation.abort();
  await startup;
  expect(platform.open()).toEqual([]);
  expect(watcher.isActive()).toBe(false);
});

it('reports a change to the working tree, the index or a ref and one it cannot place, and nothing for a lock or an unrelated git file', async () => {
  const repo = directory('apack-watch-relevant-');
  await git(repo, 'init', '--quiet');
  const { watcher, changed, platform } = watcherOf(repo);
  await start(watcher);
  vi.useFakeTimers();
  const gitDir = platform.of(path.join(repo, '.git'))!;

  gitDir.events('index.lock', 'config', path.join('refs', 'heads', 'main.lock'));
  await vi.advanceTimersByTimeAsync(2000);
  expect(changed).not.toHaveBeenCalled();

  const deliveries = [
    () => platform.of(repo)!.events(path.join('src', 'file.ts')),
    () => gitDir.events('index'),
    () => gitDir.events(path.join('refs', 'remotes', 'origin', 'main')),
    // Where the platform could not say what changed, it may have been any of them
    () => gitDir.events(null),
  ];
  for (const deliver of deliveries) {
    changed.mockClear();
    deliver();
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).toHaveBeenCalledTimes(1);
  }
});

// A file in the working tree changes its own standing, so it can be read on its own. The index, HEAD and a ref
// each change every file's, and so may a change nobody could place
it('names the files that changed in the working tree, and none once anything else changed with them', async () => {
  const repo = directory('apack-watch-named-');
  await git(repo, 'init', '--quiet');
  const { watcher, changed, platform } = watcherOf(repo);
  await start(watcher);
  vi.useFakeTimers();
  const tree = platform.of(repo)!;
  const reported = async (deliver: () => void) => {
    changed.mockClear();
    deliver();
    await vi.advanceTimersByTimeAsync(2000);
    return changed.mock.calls.map(([paths]) => paths);
  };

  expect(await reported(() => { tree.events(path.join('src', 'file.ts')); tree.events('notes.md', path.join('src', 'file.ts')); }))
    .toEqual([['src/file.ts', 'notes.md']]);
  expect(await reported(() => { tree.events('notes.md'); platform.of(path.join(repo, '.git'))!.events('index'); })).toEqual([null]);
  expect(await reported(() => tree.events('notes.md', null))).toEqual([null]);
  expect(await reported(() => tree.events(...Array.from({ length: 40 }, (_, index) => `file-${index}.ts`))), 'too many to name').toEqual([null]);
  expect(await reported(() => tree.events('notes.md')), 'what one report could not name is not carried into the next').toEqual([['notes.md']]);
});

it('reports a change while changes keep arriving', async () => {
  const repo = directory('apack-watch-stream-');
  await git(repo, 'init', '--quiet');
  const { watcher, changed, platform } = watcherOf(repo);
  await start(watcher);
  vi.useFakeTimers();
  // Each change lands before the last one's quiet period ends, as a build or an agent's edits do
  for (let i = 0; i < 20; i += 1) {
    platform.of(repo)!.events(`file-${i}.ts`);
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(changed).toHaveBeenCalled();
});

it('holds a change until a write this app is making has finished, and drops it once stopped', async () => {
  const repo = directory('apack-watch-write-');
  await git(repo, 'init', '--quiet');
  const { watcher, repository, changed, platform } = watcherOf(repo);
  await start(watcher);
  vi.spyOn(repository, 'isWriteInProgress', 'get').mockReturnValue(true);
  const completions: Array<() => void> = [];
  vi.spyOn(repository, 'onWriteComplete').mockImplementation(callback => { completions.push(callback); });
  platform.of(repo)!.events('a.ts', 'b.ts');
  platform.of(repo)!.events('c.ts');
  expect(completions).toHaveLength(1);
  await watcher.stopWatching();
  vi.useFakeTimers();
  completions[0]!();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(changed).not.toHaveBeenCalled();
});

it('watches the refs a linked worktree shares with its main checkout', async () => {
  const main = directory('apack-watch-main-');
  await git(main, 'init', '--quiet');
  await git(main, 'commit', '--quiet', '--allow-empty', '-m', 'first');
  const worktree = `${main}-linked`;
  await git(main, 'worktree', 'add', '--quiet', worktree);
  cleanups.push(() => fs.rmSync(worktree, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 }));
  const { watcher, changed, platform } = watcherOf(worktree);
  await start(watcher);
  vi.useFakeTimers();

  const common = platform.of(path.join(main, '.git'));
  expect(common, 'the main checkout holds the refs').toBeDefined();
  expect(platform.of(path.join(main, '.git', 'worktrees', path.basename(worktree))), 'the worktree holds its own index').toBeDefined();
  common!.events(path.join('refs', 'heads', 'feature'));
  await vi.advanceTimersByTimeAsync(2000);
  expect(changed).toHaveBeenCalledTimes(1);
});

it('leaves the directories git ignores out of the working tree watch', async () => {
  const repo = directory('apack-watch-ignored-');
  await git(repo, 'init', '--quiet');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n');
  fs.mkdirSync(path.join(repo, 'out'));
  fs.writeFileSync(path.join(repo, 'out', 'bundle.js'), '');
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'tracked.ts'), '');
  const { watcher, platform } = watcherOf(repo);
  await start(watcher);
  // `build` is a directory this repository tracks, whatever it is called
  expect(platform.of(repo)!.ignore).toEqual(['.git', 'out']);
});

it('starts watching a directory that became a repository when asked to check', async () => {
  const plain = directory('apack-watch-init-');
  const { watcher, platform } = watcherOf(plain);
  await start(watcher);
  expect(platform.open()).toEqual([]);

  await git(plain, 'init', '--quiet');
  await watcher.check();
  expect(platform.open().map(watch => watch.directory).sort()).toEqual([plain, path.join(plain, '.git')]);
});

it('reports a failed watch as a change and opens it again when asked to check', async () => {
  const repo = directory('apack-watch-failed-');
  await git(repo, 'init', '--quiet');
  const { watcher, repository, changed, platform } = watcherOf(repo);
  await start(watcher);
  const tree = platform.of(repo)!;

  vi.useFakeTimers();
  tree.fail(new Error('the platform stopped delivering events'));
  await vi.advanceTimersByTimeAsync(2000);
  vi.useRealTimers();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(tree.closed).toBe(true);

  expect(repository.hasWatchFailed, 'which a window showing the checkout is told').toBe(true);

  await watcher.check();
  expect(platform.of(repo), 'a new watch on the working tree').toBeDefined();
  expect(repository.hasWatchFailed).toBe(false);
  // Being watched again is something every window shows, so it is reported as a change
  await expect.poll(() => changed.mock.calls.length).toBe(2);
});

// Closing a tree's watch and opening it again loses what the platform had not delivered, so a watch that can
// take its ignored directories afresh is kept open, and asked to look over its tree
it('keeps the working tree\'s watch open when the directories git ignores change, and has it check its tree', async () => {
  const repo = directory('apack-watch-recheck-');
  await git(repo, 'init', '--quiet');
  let opened = 0;
  const checked: string[][] = [];
  const subscribe: SubscribeToDirectory = async () => {
    opened++;
    return { unsubscribe: async () => {}, check: async ({ ignore }) => { checked.push(ignore); } };
  };
  const watcher = new GitWatcherService(repo, { subscribe, followFile: () => ({ close: () => {}, look: () => {} }) });
  cleanups.push(() => watcher.stopWatching());
  watcher.setGitRepository(new GitRepository(repo));
  watcher.setChangeCallback(() => {});
  await start(watcher);
  const openedAtStart = opened;

  fs.writeFileSync(path.join(repo, '.gitignore'), 'out/\n');
  fs.mkdirSync(path.join(repo, 'out'));
  fs.writeFileSync(path.join(repo, 'out', 'a.js'), '');
  await watcher.check();

  expect(opened, 'no watch was opened again').toBe(openedAtStart);
  expect(checked.some(ignore => ignore.includes('out')), 'the tree\'s watch was handed the new ignored directory').toBe(true);
});

// A flood of file events holds the watch on a tree up, and what a checkout, a commit or a fetch ends by
// writing is then late or lost. Git's index, HEAD and packed refs are each followed on their own as well
it('reports the index written by another git from the file itself, when the tree\'s watch says nothing', async () => {
  const repo = directory('apack-watch-follow-');
  await git(repo, 'init', '--quiet');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '--quiet', '-m', 'first');
  // The platform's watch on the tree is open and delivers nothing
  const subscribe: SubscribeToDirectory = async () => ({ unsubscribe: async () => {} });
  const watcher = new GitWatcherService(repo, { subscribe });
  cleanups.push(() => watcher.stopWatching());
  const changed = vi.fn();
  watcher.setGitRepository(new GitRepository(repo));
  watcher.setChangeCallback(changed);
  await start(watcher);
  // Lets the followers look at the files as they are, so the next change is one to them
  await new Promise<void>((resolve) => { setTimeout(resolve, 150); });

  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  await git(repo, 'add', '.');

  await settles(() => expect(changed).toHaveBeenCalledWith(null));
});

// Asking an untrusted repository where its state lives is a git it is refused, and the watcher asks at start
it('watches nothing in a repository that is not trusted, and starts once it is and it is asked to check', async () => {
  const repo = directory('apack-watch-trust-');
  await git(repo, 'init', '--quiet');
  await git(repo, 'config', 'core.sshCommand', '/usr/bin/true');
  let trusted = false;
  const platform = watches();
  const watcher = new GitWatcherService(repo, { subscribe: platform.subscribe, followFile: () => ({ close: () => {}, look: () => {} }) });
  cleanups.push(() => watcher.stopWatching());
  watcher.setGitRepository(new GitRepository(repo, { isTrusted: () => trusted }));
  watcher.setChangeCallback(() => {});

  await start(watcher);
  expect(platform.open()).toEqual([]);

  trusted = true;
  await watcher.check();
  expect(platform.open().map(watch => watch.directory)).toContain(repo);
});
