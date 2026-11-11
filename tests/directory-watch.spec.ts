// What a subscriber reports of what its platform's watcher tells it. The platform is stood in for: whether it
// delivers at all is the platform's to answer, and a case waiting on it would pass only on a quiet machine.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { settles } from './_support/settles.ts';
import {
  nodeSubscriber, perDirectorySubscriber, type WatchDirectory, type WatchedChange, type WatchTree,
} from '../src/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const directory = path.resolve('checkout');

/** Stands in for `fs.watch`: a case says what the platform reports */
function platformWatch() {
  const platform = { closed: false, reports: (_filename: string | null) => {}, fails: (_error: Error) => {} };
  const watch: WatchTree = (_directory, _options, listener) => {
    platform.reports = filename => listener('change', filename);
    return { on: (_event, onError) => { platform.fails = onError; }, close: () => { platform.closed = true; } };
  };
  return { platform, watch };
}

/** What a subscriber told its caller, in order */
function told() {
  const calls: Array<{ error: Error | null; changes: WatchedChange[] }> = [];
  return { calls, onChanges: (error: Error | null, changes: WatchedChange[]) => { calls.push({ error, changes }); } };
}

it('reports a change by where it was, and none in a directory it was told to ignore', async () => {
  const { platform, watch } = platformWatch();
  const { calls, onChanges } = told();
  // Named the way git names them, whatever the platform separates a path with
  await nodeSubscriber(watch)(directory, onChanges, { ignore: ['node_modules', 'packages/app/dist'] });

  const reported = [
    path.join('src', 'a.ts'),
    // A sibling whose name only starts the same way is not the ignored directory
    path.join('node_modules_kept', 'index.js'),
    path.join('packages', 'app', 'src', 'a.ts'),
  ];
  const ignored = ['node_modules', path.join('node_modules', 'left-pad', 'index.js'), path.join('packages', 'app', 'dist', 'bundle.js')];
  for (const filename of [...ignored, ...reported]) platform.reports(filename);

  expect(calls.map(call => call.changes)).toEqual(reported.map(filename => [filename]));
});

it('reports a change the platform could not place as one, and its error as an error', async () => {
  const { platform, watch } = platformWatch();
  const { calls, onChanges } = told();
  await nodeSubscriber(watch)(directory, onChanges, { ignore: ['node_modules'] });

  platform.reports(null);
  const error = new Error('EPERM: operation not permitted, watch');
  platform.fails(error);

  expect(calls).toEqual([{ error: null, changes: [null] }, { error, changes: [] }]);
});

it('closes the platform’s watch when unsubscribed', async () => {
  const { platform, watch } = platformWatch();
  const subscription = await nodeSubscriber(watch)(directory, () => {}, { ignore: [] });
  expect(platform.closed).toBe(false);
  await subscription.unsubscribe();
  expect(platform.closed).toBe(true);
});

/** A tree on disk, made of these directories and files, which the per-directory subscriber reads for real */
function tree(...paths: string[]) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-watch-')));
  roots.push(root);
  const make = (relative: string) => {
    const absolute = path.join(root, relative);
    if (relative.endsWith('/')) fs.mkdirSync(absolute, { recursive: true });
    else { fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, ''); }
  };
  paths.forEach(make);
  return { root, make, remove: (relative: string) => fs.rmSync(path.join(root, relative), { recursive: true, force: true }) };
}

/** Stands in for `fs.watch` on one directory at a time: a case says what each directory's watch reports */
function directoryWatches(root: string) {
  const open = new Map<string, { listener: (eventType: string, filename: string | null) => void; fail: (error: Error) => void }>();
  const refused = new Map<string, string>();
  /** Every watch opened, in order, by the directory it was opened on */
  const opened: string[] = [];
  const watch: WatchDirectory = (directory, _options, listener) => {
    const relative = path.relative(root, directory);
    const code = refused.get(relative);
    if (code) throw Object.assign(new Error(`${code}: watch '${directory}'`), { code });
    const entry = { listener, fail: (_error: Error) => {} };
    open.set(relative, entry);
    opened.push(relative);
    // A watch closed after another was opened on the same path closes only itself
    return { on: (_event, onError) => { entry.fail = onError; }, close: () => { if (open.get(relative) === entry) open.delete(relative); } };
  };
  return {
    watch, refused, opened,
    watched: () => [...open.keys()].sort(),
    reports: (directory: string, eventType: 'rename' | 'change', filename: string | null) => open.get(directory)!.listener(eventType, filename),
    fails: (directory: string, error: Error) => open.get(directory)!.fail(error),
  };
}
/** Waits for what a subscriber does once it has looked at the disk */
const eventually = (check: () => void) => settles(check);

it('holds a watch on every directory of the tree but the ones it was told to ignore and what is under them', async () => {
  const { root } = tree('src/deep/a.ts', 'docs/', 'node_modules/pkg/lib/index.js', 'packages/app/dist/out/');
  const platform = directoryWatches(root);

  await perDirectorySubscriber(platform.watch)(root, () => {}, { ignore: ['node_modules', 'packages/app/dist'] });

  expect(platform.watched()).toEqual(['', 'docs', 'packages', path.join('packages', 'app'), 'src', path.join('src', 'deep')]);
});

it('reports a change by where it is in the tree, whichever directory\'s watch saw it', async () => {
  const { root } = tree('src/deep/a.ts', 'node_modules/pkg/index.js');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: ['node_modules'] });

  platform.reports(path.join('src', 'deep'), 'change', 'a.ts');
  platform.reports('', 'change', 'top.txt');
  // The ignored directory's own entry in its parent changing is not a change to report
  platform.reports('', 'change', 'node_modules');
  platform.reports('src', 'change', null);

  expect(calls).toEqual([
    { error: null, changes: [path.join('src', 'deep', 'a.ts')] },
    { error: null, changes: ['top.txt'] },
    { error: null, changes: [null] },
  ]);
});

// What was made in a new directory before its watch was in place was reported by nothing: the directory is
// reported again once it and everything under it is watched, and whoever hears that asks about all of it
it('watches a directory that appears, with what it already holds, and reports it again once it is watched', async () => {
  const { root, make } = tree('src/a.ts');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: [] });

  make('fresh/inner/b.ts');
  platform.reports('', 'rename', 'fresh');

  await eventually(() => expect(calls).toEqual([{ error: null, changes: ['fresh'] }, { error: null, changes: ['fresh'] }]));
  expect(platform.watched()).toEqual(['', 'fresh', path.join('fresh', 'inner'), 'src']);
});

it('lets go of the watches on a directory that is gone, and on everything that was under it', async () => {
  const { root, remove } = tree('src/deep/deeper/a.ts', 'docs/');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: [] });

  remove('src');
  platform.reports('', 'rename', 'src');

  await eventually(() => expect(platform.watched()).toEqual(['', 'docs']));
  expect(calls).toEqual([{ error: null, changes: ['src'] }]);
});

// `rm -rf dist && mkdir dist`: by the time either event is looked into, a directory is there, and it is not
// the one the watch is on. The platform reports nothing of the new one to the old one's watch
it('watches a directory deleted and made again at once in place of the one that was there', async () => {
  const { root, make, remove } = tree('dist/old/a.js', 'src/');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: [] });

  remove('dist');
  make('dist/fresh/b.js');
  platform.reports('', 'rename', 'dist');
  platform.reports('', 'rename', 'dist');

  await eventually(() => expect(platform.watched()).toEqual(['', 'dist', path.join('dist', 'fresh'), 'src']));
  expect(platform.opened.filter(directory => directory === 'dist'), 'a second watch, on the directory there now').toHaveLength(2);
  // Reported again once the new one is watched, for what was made in it before then
  await eventually(() => expect(calls.filter(call => call.changes[0] === 'dist')).toHaveLength(3));
});

it('leaves a directory alone that is still the one its watch is on', async () => {
  const { root } = tree('src/deep/');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: [] });

  // A directory's own entry is reported when something in it is made or deleted
  platform.reports('', 'rename', 'src');

  await eventually(() => expect(calls).toEqual([{ error: null, changes: ['src'] }]));
  expect(platform.opened).toEqual(['', 'src', path.join('src', 'deep')]);
});

it('lets go of a directory\'s watches when a file is found where it was', async () => {
  const { root, make, remove } = tree('out/deep/');
  const platform = directoryWatches(root);
  await perDirectorySubscriber(platform.watch)(root, () => {}, { ignore: [] });

  remove('out');
  make('out');
  platform.reports('', 'rename', 'out');

  await eventually(() => expect(platform.watched()).toEqual(['']));
});

// Nothing reports on a directory made again where the watched one was
it('says the watch ended when the watched directory itself is deleted', async () => {
  const { root, remove } = tree('src/a.ts');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: [] });

  remove('');
  platform.reports('', 'rename', path.basename(root));

  await eventually(() => expect(calls.at(-1)?.error?.message).toBe(`${root} was deleted`));
});

// The platform allows only so many watches. A tree that is not all watched is not watched
it('fails, holding no watch, when the platform runs out of watches while the tree is first read', async () => {
  const { root } = tree('src/deep/', 'docs/');
  const platform = directoryWatches(root);
  platform.refused.set(path.join('src', 'deep'), 'ENOSPC');

  await expect(perDirectorySubscriber(platform.watch)(root, () => {}, { ignore: [] })).rejects.toThrow('ENOSPC');

  expect(platform.watched()).toEqual([]);
});

it('says so when the platform runs out of watches for a directory that appears later', async () => {
  const { root, make } = tree('src/');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: [] });

  platform.refused.set('fresh', 'ENOSPC');
  make('fresh/');
  platform.reports('', 'rename', 'fresh');

  await eventually(() => expect(calls.at(-1)?.error?.message).toContain('ENOSPC'));
});

it('passes over a directory that is gone by the time it is watched', async () => {
  const { root } = tree('src/', 'docs/');
  const platform = directoryWatches(root);
  platform.refused.set('docs', 'ENOENT');

  await perDirectorySubscriber(platform.watch)(root, () => {}, { ignore: [] });

  expect(platform.watched()).toEqual(['', 'src']);
});

it('closes every watch when unsubscribed, and reports nothing after', async () => {
  const { root } = tree('src/deep/');
  const platform = directoryWatches(root);
  const { calls, onChanges } = told();
  const subscription = await perDirectorySubscriber(platform.watch)(root, onChanges, { ignore: [] });
  const late = platform.reports.bind(null, 'src', 'change', 'a.ts');

  await subscription.unsubscribe();
  expect(platform.watched()).toEqual([]);
  expect(calls).toEqual([]);
  expect(late).toThrow();
});
