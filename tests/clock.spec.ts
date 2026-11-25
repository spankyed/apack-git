// Deterministic time and timer control through `RepositoryClock`: debounce, post-write quiet window, flood bursts,
// catch-up, object reader linger, read cache TTL, lock patience, slow-status budget, checkpoint/journal expiry,
// NTP wall-clock jumps, and safe degradation once a host clock is closed (`ClockClosedError`). Zero `vi.useFakeTimers()`.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.js';
import { removeDirectory } from './_support/remove.js';
import {
  GitObjectReader, GitRepository, GitWatcherService, runUnbounded,
  type DirectorySubscription, type RepositoryClock, type SubscribeToDirectory, type WatchedChange,
} from '../src/index.js';
import { CHECKPOINT_MAX_AGE_MS } from '../src/checkpoints.js';

/** Compile-time check that `@apackdev/clock`'s `Clock` shape (with `sleep`) is assignable to `RepositoryClock` */
type ApackClockShape = {
  now(): number;
  monotonic(): number;
  after(ms: number, run: () => void): () => void;
  sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;
};
const _checkStructuralCompatibility: RepositoryClock = null as unknown as ApackClockShape;
void _checkStructuralCompatibility;

class FakeClockClosedError extends Error {
  constructor() {
    super('The clock is closed; nothing new may be asked of it');
    this.name = 'ClockClosedError';
  }
}

interface Scheduled {
  due: number;
  seq: number;
  cancelled: boolean;
  run: () => void;
}

/** Deterministic clock matching `@apackdev/clock`'s `controller.clock` structurally */
class FakeClock {
  private wallMs: number;
  private monoMs: number;
  private seq = 0;
  private closed = false;
  private readonly timers: Scheduled[] = [];

  constructor({ wall = 1_750_000_000_000, monotonic = 0 }: { wall?: number; monotonic?: number } = {}) {
    this.wallMs = wall;
    this.monoMs = monotonic;
  }

  readonly clock: RepositoryClock = {
    now: () => this.wallMs,
    monotonic: () => this.monoMs,
    after: (ms, callback) => {
      if (this.closed) throw new FakeClockClosedError();
      const entry: Scheduled = { due: this.monoMs + Math.max(0, ms), seq: this.seq++, cancelled: false, run: callback };
      this.timers.push(entry);
      return () => { entry.cancelled = true; };
    },
  };

  /** Advances both monotonic and wall time by `ms` and fires all due timers in order */
  advance(ms: number): void {
    const target = this.monoMs + ms;
    for (;;) {
      const next = this.timers
        .filter(timer => !timer.cancelled && timer.due <= target)
        .sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (!next) break;
      const step = next.due - this.monoMs;
      this.monoMs = next.due;
      this.wallMs += step;
      next.cancelled = true;
      next.run();
    }
    const remaining = target - this.monoMs;
    this.monoMs = target;
    this.wallMs += remaining;
  }

  /** Simulates an NTP jump on wall time alone without moving monotonic time or firing timers */
  jumpWall(deltaMs: number): void {
    this.wallMs += deltaMs;
  }

  /** Simulates `ClockController.close()`: cancels pending timers and makes subsequent `after()` throw `ClockClosedError` */
  close(): void {
    this.closed = true;
    for (const timer of this.timers) timer.cancelled = true;
  }

  get pendingTimers(): number {
    return this.timers.filter(timer => !timer.cancelled).length;
  }
}

const directories: string[] = [];
const repositories: GitRepository[] = [];
const readers: GitObjectReader[] = [];
const watchers: GitWatcherService[] = [];
afterEach(async () => {
  for (const watcher of watchers.splice(0)) await watcher.stopWatching();
  for (const reader of readers.splice(0)) await reader.close();
  for (const repo of repositories.splice(0)) await repo.close();
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout.trim();

async function repository(clock?: RepositoryClock) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-clock-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  const repo = new GitRepository(root, { ...(clock && { clock }) });
  repositories.push(repo);
  return { root, repo };
}

it('drives watcher debounce, max-wait, catch-up and flood bursts deterministically despite NTP wall-clock jumps', async () => {
  const fake = new FakeClock({ monotonic: 0 });
  const { root, repo } = await repository(fake.clock);
  const deliveries = new Map<string, { onChange: (error: Error | null, changes: WatchedChange[]) => void; onEvent?: () => void }>();
  const subscribe: SubscribeToDirectory = async (directory, onChange, options): Promise<DirectorySubscription> => {
    deliveries.set(directory, { onChange, onEvent: options.onEvent });
    return { unsubscribe: async () => { deliveries.delete(directory); } };
  };
  const noFollow = () => ({ look: () => {}, close: () => {} });
  const reports: (string[] | 'index' | null)[] = [];
  const watcher = new GitWatcherService(root, { subscribe, followFile: noFollow, catchUpAfterMs: 2_000, clock: fake.clock });
  watchers.push(watcher);
  watcher.setGitRepository(repo);
  watcher.setChangeCallback(paths => reports.push(paths));

  await watcher.startWatching(new AbortController().signal);
  const emit = (rel: string) => {
    deliveries.get(root)?.onEvent?.();
    deliveries.get(root)?.onChange(null, [rel]);
  };

  // Debounce: 199 ms is quiet-pending, 200 ms fires, even after a +/- 1-hour wall-clock jump
  emit('a.txt');
  fake.jumpWall(3_600_000);
  fake.advance(199);
  expect(reports).toEqual([]);
  fake.jumpWall(-7_200_000);
  fake.advance(1);
  expect(reports).toEqual([['a.txt']]);

  // Max-wait: continuous edits every 100 ms flush at 1,000 ms
  reports.length = 0;
  for (let step = 0; step < 10; step++) {
    emit(`f${step}.txt`);
    fake.advance(100);
  }
  expect(reports).toHaveLength(1);
  expect(reports[0]).toHaveLength(10);

  // Catch-up timer fires at catchUpAfterMs (2,000 ms after startWatching) + QUIET_MS (200 ms)
  reports.length = 0;
  fake.advance(800); // 200 + 1,000 + 800 = 2,000 ms since startWatching -> schedules null
  expect(reports).toEqual([]);
  fake.advance(200);
  expect(reports).toEqual([null]);

  // Post-write quiet window: an event arriving during a write waits for onWriteComplete, then fires after QUIET_AFTER_WRITE_MS (50 ms)
  reports.length = 0;
  let finishWrite: (() => void) | undefined;
  const fakeRepo = {
    resolveGitDirectories: () => repo.resolveGitDirectories(),
    listIgnoredDirectories: () => repo.listIgnoredDirectories(),
    setWatched: () => {},
    hasWatchFailed: false,
    isWriteInProgress: true,
    onWriteComplete: (callback: () => void) => { finishWrite = callback; },
  } as unknown as GitRepository;
  watcher.setGitRepository(fakeRepo);
  emit('b.txt');
  fake.advance(500);
  expect(reports).toEqual([]);
  (fakeRepo as unknown as { isWriteInProgress: boolean }).isWriteInProgress = false;
  finishWrite?.();
  fake.advance(49);
  expect(reports).toEqual([]);
  fake.advance(1);
  expect(reports).toEqual([['b.txt']]);
  watcher.setGitRepository(repo);

  // Flood starting at monotonic time 0 (1,000+ events) widens to null after FLOOD_QUIET_MS (500 ms)
  await watcher.stopWatching();
  const fakeZero = new FakeClock({ monotonic: 0 });
  const floodReports: (string[] | 'index' | null)[] = [];
  const floodWatcher = new GitWatcherService(root, { subscribe, followFile: noFollow, catchUpAfterMs: 60_000, clock: fakeZero.clock });
  watchers.push(floodWatcher);
  floodWatcher.setGitRepository(repo);
  floodWatcher.setChangeCallback(paths => floodReports.push(paths));
  await floodWatcher.startWatching(new AbortController().signal);

  for (let i = 0; i < 1000; i++) deliveries.get(root)?.onEvent?.();
  fakeZero.advance(499);
  expect(floodReports).toEqual([]);
  fakeZero.advance(1); // flood settles -> schedules null with QUIET_MS (200 ms)
  fakeZero.advance(200);
  expect(floodReports).toEqual([null]);

  // Closing the host clock while events arrive never throws ClockClosedError
  fakeZero.close();
  expect(() => {
    deliveries.get(root)?.onEvent?.();
    deliveries.get(root)?.onChange(null, ['a.txt']);
  }).not.toThrow();
});

it('closes an idle GitObjectReader at lingerMs on the injected clock and closes cleanly if the clock is closed', async () => {
  const fake = new FakeClock();
  const { root } = await repository();
  const reader = new GitObjectReader(root, () => process.env, undefined, 5_000, undefined, 'git', fake.clock);
  readers.push(reader);

  expect((await reader.read('HEAD:a.txt'))?.toString('utf8')).toBe('one\n');
  expect(reader.isOpen).toBe(true);

  fake.advance(4_999);
  expect(reader.isOpen).toBe(true);

  // Another read resets the linger window
  expect((await reader.read('HEAD:a.txt'))?.toString('utf8')).toBe('one\n');
  fake.advance(4_999);
  expect(reader.isOpen).toBe(true);
  fake.advance(1);
  expect(reader.isOpen).toBe(false);

  // If the clock is closed while a read finishes, the reader closes immediately instead of throwing or leaking
  fake.close();
  expect((await reader.read('HEAD:a.txt'))?.toString('utf8')).toBe('one\n');
  expect(reader.isOpen).toBe(false);
});

it('expires read cache entries on monotonic time, unaffected by wall-clock jumps', async () => {
  const fake = new FakeClock();
  let revParseCalls = 0;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-clock-cache-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const repo = new GitRepository(root, {
    clock: fake.clock,
    run: (file, args, options) => {
      if (args.includes('symbolic-ref') && args.includes('refs/remotes/origin/HEAD')) revParseCalls++;
      return runUnbounded(file, args, options);
    },
  });
  repositories.push(repo);

  expect(await repo.findBaseBranch()).toBe('main');
  expect(revParseCalls).toBe(1);

  // A +1-hour NTP jump does not invalidate the 5 s monotonic cache
  fake.jumpWall(3_600_000);
  fake.advance(4_999);
  expect(await repo.findBaseBranch()).toBe('main');
  expect(revParseCalls).toBe(1);

  // Advancing monotonic time past 5,000 ms expires the entry
  fake.advance(2);
  expect(await repo.findBaseBranch()).toBe('main');
  expect(revParseCalls).toBe(2);
});

it('expires checkpoints and prunes journal entries deterministically when clock.now() advances past CHECKPOINT_MAX_AGE_MS', async () => {
  const fake = new FakeClock({ wall: 1_750_000_000_000 });
  const { root, repo } = await repository(fake.clock);

  const first = await repo.checkpoint();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  await repo.stageFiles(['a.txt']);
  await repo.commit('second');
  expect((await repo.undoables()).length).toBe(1);

  // Advance wall time past CHECKPOINT_MAX_AGE_MS (7 days)
  fake.advance(CHECKPOINT_MAX_AGE_MS + 60_000);

  // Journal entry is pruned on read, and the next checkpoint expires the old checkpoint ref
  expect(await repo.undoables()).toEqual([]);
  const second = await repo.checkpoint();
  expect(second.id).not.toBe(first.id);
  await expect(repo.changedSince(first.id)).rejects.toMatchObject({ code: 'no-longer-kept' });
});

it('measures slowStatus and lock patience on clock.monotonic(), ignores synthetic future wall time on OS lock mtime, and settles cleanly once the clock is closed', async () => {
  // Start wall time 7 days ahead of real OS time to prove OS `index.lock` mtime is not compared against synthetic `clock.now()`
  const fake = new FakeClock({ wall: Date.now() + CHECKPOINT_MAX_AGE_MS });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-clock-slow-')));
  directories.push(root);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const repo = new GitRepository(root, {
    clock: fake.clock,
    statusBudgetMs: 1_000,
    lockPatienceMs: 5_000,
    run: (file, args, options) => {
      const running = runUnbounded(file, args, options);
      if (args.includes('status')) fake.advance(1_500);
      return running;
    },
  });
  repositories.push(repo);

  const snapshot = await repo.readSnapshot();
  expect(snapshot.slowStatus).toMatchObject({ ms: 1_500, budgetMs: 1_000 });

  // Hold index.lock and advance the fake clock once the lock wait timer is armed: settles as `locked` via the fake clock
  const lockFile = path.join(root, '.git', 'index.lock');
  fs.writeFileSync(lockFile, '');
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    const staging = repo.stageFiles(['a.txt']);
    // Wait for git to fail with index.lock and `lockReleased` to arm `clock.after`
    for (let i = 0; i < 50 && fake.pendingTimers === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(fake.pendingTimers).toBe(1);
    fake.advance(5_000);
    await expect(staging).rejects.toMatchObject({ code: 'locked' });

    // Once the host clock is closed, a new lock wait settles immediately as `locked` rather than throwing ClockClosedError
    fake.close();
    await expect(repo.stageFiles(['a.txt'])).rejects.toMatchObject({ code: 'locked' });
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
});
