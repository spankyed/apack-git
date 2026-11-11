// A watcher names the paths it saw change, and the repository reads those again in place of the whole status:
// git matches a few paths against what it tracks far faster than it walks a large checkout. Git stays what says
// what changed, so each case here holds the repository to it: after a change, what it holds from reading the
// named paths must be what a repository that has read nothing gets from a whole status. And since reading
// everything would pass that every time, each case also says which of the two was asked of git.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', '-c', 'protocol.file.allow=always', ...args]);
const write = (root: string, file: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
};
const remove = (root: string, file: string) => fs.rmSync(path.join(root, file), { recursive: true, force: true });

type Step = (root: string) => unknown;
/** A committed checkout, changed by `before`, that a watcher reports on and that has been read once */
async function watched(before?: Step, workingDirectory = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-noted-')));
  directories.push(root, `${root}-sub`);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  write(root, '.gitignore', '*.log\nignored/\n');
  write(root, 'kept.txt', 'one\n');
  write(root, 'src/a.ts', 'a\n');
  write(root, 'src/deep/b.ts', 'b\n');
  write(root, 'we[i]rd*.txt', 'x\n');
  write(root, 'docs/old.md', 'a file that will be renamed, long enough for git to follow it\n');
  write(root, 'caf\u00e9.txt', 'composed\n');
  if (process.platform !== 'win32') write(root, ':/inside.txt', 'x\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await before?.(root);
  const lines: string[] = [];
  const repo = new GitRepository(path.join(root, workingDirectory), { log: { command: line => lines.push(line) } });
  commands.set(repo, lines);
  repo.setWatched(true);
  await repo.refreshSnapshot();
  return { root, repo };
}

/** Every git command each repository made here ran, as it logs them */
const commands = new WeakMap<GitRepository, string[]>();

type Read = 'the paths' | 'everything';
/** What was asked of git for a status since: only the paths named, or everything */
function statusesAsked(repo: GitRepository) {
  const lines = commands.get(repo)!;
  const from = lines.length;
  return (): Read[] => lines.slice(from).filter(line => line.startsWith('git status '))
    .map(line => line.includes(' -- ') ? 'the paths' : 'everything');
}
/** What a repository that has read nothing says the checkout holds */
const truth = (repo: GitRepository) => new GitRepository(repo.getWorkingDir()).readSnapshot();

async function submodule(root: string) {
  await git(root, 'init', '--quiet', `${root}-sub`);
  write(`${root}-sub`, 's.txt', 's\n');
  await git(`${root}-sub`, 'add', '.');
  await git(`${root}-sub`, 'commit', '--quiet', '-m', 'sub');
  await git(root, 'submodule', '--quiet', 'add', `${root}-sub`, 'vendor/sub');
  await git(root, 'commit', '--quiet', '-m', 'a submodule');
}
async function conflict(root: string) {
  await git(root, 'checkout', '--quiet', '-b', 'side');
  write(root, 'kept.txt', 'side\n');
  await git(root, 'commit', '--quiet', '-am', 'side');
  await git(root, 'checkout', '--quiet', 'main');
  write(root, 'kept.txt', 'main\n');
  await git(root, 'commit', '--quiet', '-am', 'main');
  await git(root, 'merge', '--quiet', 'side').catch(() => {});
}

/** `read` is what was asked of git, in order: more than one status when the first did not settle it */
interface Case { before?: Step; change: Step; noted: string[] | null; read: Read | Read[] }
const cases: Record<string, Case> = {
  'a tracked file edited': { change: root => write(root, 'kept.txt', 'two\n'), noted: ['kept.txt'], read: 'the paths' },
  'a file made in a new directory': {
    change: root => write(root, 'fresh/deep/new.ts', ''), noted: ['fresh', 'fresh/deep', 'fresh/deep/new.ts'], read: 'the paths',
  },
  'a tracked file deleted': { change: root => remove(root, 'src/a.ts'), noted: ['src/a.ts'], read: 'the paths' },
  'a directory deleted, named by itself': { change: root => remove(root, 'src'), noted: ['src'], read: 'the paths' },
  'a file git ignores written': { change: root => write(root, 'build.log', 'noise\n'), noted: ['build.log'], read: 'the paths' },
  'a file under a directory git ignores written': { change: root => write(root, 'ignored/out/a.js', ''), noted: ['ignored/out/a.js'], read: 'the paths' },
  'a name holding characters git reads as a pattern': { change: root => write(root, 'we[i]rd*.txt', 'y\n'), noted: ['we[i]rd*.txt'], read: 'the paths' },
  // A path is asked for by its name and nothing else: `:/` before a name asks git for that name at the top of
  // the checkout. Where git ignores case the path is already marked as a name, so this is held where it does not
  ...(process.platform !== 'win32' && {
    'a file in a directory whose name is an instruction to git': {
      before: root => git(root, 'config', 'core.ignorecase', 'false'),
      change: root => write(root, ':/inside.txt', 'y\n'), noted: [':/inside.txt'], read: 'the paths' as const,
    },
  }),
  // What is read again goes among what is held where git would list it
  'a file edited beside others already changed': {
    before: (root) => { write(root, 'src/a.ts', 'aa\n'); write(root, 'zzz.txt', ''); write(root, 'another.txt', ''); },
    change: root => write(root, 'kept.txt', 'two\n'), noted: ['kept.txt'], read: 'the paths',
  },
  'an edit put back as it was': {
    before: root => write(root, 'kept.txt', 'two\n'), change: root => write(root, 'kept.txt', 'one\n'), noted: ['kept.txt'], read: 'the paths',
  },
  'a staged file edited again': {
    before: async (root) => { write(root, 'kept.txt', 'two\n'); await git(root, 'add', 'kept.txt'); },
    change: root => write(root, 'kept.txt', 'three\n'), noted: ['kept.txt'], read: 'the paths',
  },
  'several files, one of them new': {
    change: (root) => { write(root, 'kept.txt', 'two\n'); write(root, 'src/deep/b.ts', 'bb\n'); write(root, 'another.txt', ''); },
    noted: ['kept.txt', 'src/deep/b.ts', 'another.txt'], read: 'the paths',
  },
  // Git lists a conflict after every other changed path and before the untracked ones, whatever their names
  'a file edited while another is in conflict and one is new': {
    before: async (root) => { await conflict(root); write(root, 'aaa-new.txt', ''); },
    change: root => write(root, 'src/a.ts', 'aa\n'), noted: ['src/a.ts'], read: 'the paths',
  },
  'a conflicted file edited': { before: conflict, change: root => write(root, 'kept.txt', 'settled?\n'), noted: ['kept.txt'], read: 'the paths' },
  // Git does not look inside another repository: it has one entry for it, at its directory
  'a file inside a submodule edited': { before: submodule, change: root => write(root, 'vendor/sub/s.txt', 'changed\n'), noted: ['vendor/sub/s.txt'], read: 'the paths' },
  'a repository made inside the checkout': {
    change: async (root) => { await git(root, 'init', '--quiet', path.join(root, 'nested')); write(root, 'nested/inside.txt', ''); },
    noted: ['nested', 'nested/.git/HEAD', 'nested/inside.txt'], read: 'the paths',
  },

  // A folder git tracks nothing in is one row, and git answers for a file in it with the file: what is asked
  // about is the folder
  'a file made in a folder that is already one row': {
    before: root => write(root, 'fresh/a.ts', ''),
    change: root => write(root, 'fresh/deep/b.ts', ''), noted: ['fresh/deep', 'fresh/deep/b.ts'], read: 'the paths',
  },
  'the last file deleted from a folder that is one row': {
    before: root => write(root, 'fresh/a.ts', ''),
    change: root => remove(root, 'fresh/a.ts'), noted: ['fresh/a.ts'], read: 'the paths',
  },
  'a folder that is one row deleted': {
    before: root => write(root, 'fresh/deep/a.ts', ''),
    change: root => remove(root, 'fresh'), noted: ['fresh'], read: 'the paths',
  },
  // A new file may be in a folder git tracks nothing in, so its folder is asked about as well
  'a file made in a folder git tracks files in': {
    change: root => write(root, 'src/new.ts', ''), noted: ['src/new.ts'], read: ['the paths', 'the paths'],
  },
  'a folder made in a folder git tracks files in': {
    change: root => write(root, 'src/fresh/new.ts', ''), noted: ['src/fresh', 'src/fresh/new.ts'], read: ['the paths', 'the paths'],
  },
  // Only the file was named, and its folder is one git tracks nothing in: how far up that goes is the whole
  // status's to say
  'a file made two new folders down, named alone': {
    change: root => write(root, 'fresh/deep/new.ts', ''), noted: ['fresh/deep/new.ts'], read: ['the paths', 'the paths', 'everything'],
  },
  'a file made in a new folder where the user has git list every file': {
    before: root => git(root, 'config', 'status.showUntrackedFiles', 'all'),
    change: root => write(root, 'fresh/deep/new.ts', ''), noted: ['fresh/deep/new.ts'], read: 'the paths',
  },

  // Each of these can move the standing of a file that was not named, so the whole status is read
  'what git ignores changed': {
    before: root => write(root, 'notes.tmp', ''), change: root => write(root, '.gitignore', '*.log\nignored/\n*.tmp\n'), noted: ['.gitignore'], read: 'everything',
  },
  'a file edited while a rename is staged': {
    before: root => git(root, 'mv', 'docs/old.md', 'docs/new.md'), change: root => write(root, 'kept.txt', 'two\n'), noted: ['kept.txt'], read: 'everything',
  },
  // Git pairs a file added without its content with a deleted one as a rename, which it cannot do asked about one of them
  'a file deleted while another is added without its content': {
    before: async (root) => { fs.copyFileSync(path.join(root, 'docs/old.md'), path.join(root, 'docs/moved.md')); await git(root, 'add', '-N', 'docs/moved.md'); },
    change: root => remove(root, 'docs/old.md'), noted: ['docs/old.md'], read: 'everything',
  },
  'more files than are read on their own': {
    change: (root) => { for (let index = 0; index < 40; index++) write(root, `many/file-${index}.txt`, ''); },
    noted: Array.from({ length: 40 }, (_, index) => `many/file-${index}.txt`), read: 'everything',
  },
  'a change the watcher could not name': { change: root => write(root, 'kept.txt', 'two\n'), noted: null, read: 'everything' },
};

it.each(Object.entries(cases))('holds what a whole status says after %s', async (_name, { before, change, noted, read }) => {
  const { root, repo } = await watched(before);
  const asked = statusesAsked(repo);

  await change(root);
  repo.noteChanged(noted);
  await repo.refreshSnapshot('noted');

  expect(await repo.readSnapshot()).toEqual(await truth(repo));
  expect(asked()).toEqual([read].flat());
});

// The file system takes two spellings of a name for one file where it ignores case or composes letters, and so
// does git there. A watcher reports the spelling a file was written under, which need not be the one git holds
const foldsNames = process.platform === 'darwin';
it.runIf(foldsNames).each([
  ['in another case', 'KEPT.TXT', 'kept.txt', 'one\n'],
  ['with its letters decomposed', 'cafe\u0301.txt', 'caf\u00e9.txt', 'composed\n'],
])('reads a file named %s as the file git holds', async (_how, spelled, file, committed) => {
  const { root, repo } = await watched();
  const asked = statusesAsked(repo);

  write(root, file, 'changed\n');
  repo.noteChanged([spelled]);
  await repo.refreshSnapshot('noted');
  expect((await repo.readSnapshot()).files.map(changed => changed.path), 'its change is listed under the name git holds').toEqual([file]);

  // What git lists no longer is taken out of what is held, under the same name
  write(root, file, committed);
  repo.noteChanged([spelled]);
  await repo.refreshSnapshot('noted');
  expect((await repo.readSnapshot()).files).toEqual([]);
  expect(await repo.readSnapshot()).toEqual(await truth(repo));
  expect(asked()).toEqual(['the paths', 'the paths']);
});

// Git names a path from the top of the checkout, and a watcher from the directory it watches
it('reads the paths named under a working directory that is not the top of the checkout', async () => {
  const { root, repo } = await watched(root => write(root, 'src/deep/b.ts', 'bb\n'), 'src');
  const asked = statusesAsked(repo);

  // One file is put back as it was committed, so git lists it no longer, and one is made
  write(root, 'src/deep/b.ts', 'b\n');
  write(root, 'src/new.ts', '');
  repo.noteChanged(['deep/b.ts', 'new.ts']);
  const changed = await repo.refreshSnapshot('noted');

  expect(changed.files).toEqual(['src/new.ts', 'src/deep/b.ts']);
  expect(await repo.readSnapshot()).toEqual(await truth(repo));
  // The new file's folder is asked about as well, which here is the working directory itself
  expect(asked()).toEqual(['the paths', 'the paths']);
});

it('says which file changed, and runs no git when nothing was noted since the last read', async () => {
  const { root, repo } = await watched();
  const asked = statusesAsked(repo);
  const NOTHING = { status: false, diffs: false, history: false, stashes: false, worktrees: false };

  write(root, 'kept.txt', 'two\n');
  expect(await repo.refreshSnapshot('noted'), 'no watcher said anything changed').toEqual(NOTHING);
  expect(asked()).toEqual([]);

  repo.noteChanged(['kept.txt']);
  expect(await repo.refreshSnapshot('noted')).toEqual({ ...NOTHING, status: true, diffs: true, files: ['kept.txt'] });
  expect(await repo.refreshSnapshot('noted')).toEqual(NOTHING);
  expect(asked()).toEqual(['the paths']);
});

// A check with no event to go by is what finds a change no watcher reported
it('reads everything when it is asked to with nothing noted', async () => {
  const { root, repo } = await watched();
  write(root, 'kept.txt', 'two\n');

  expect((await repo.refreshSnapshot()).files).toEqual(['kept.txt']);
});

// A read of a few paths is put into the snapshot it starts from. One begun while a whole read is still running
// has to start from what that one finds, not from what was held before it
it('reads what is noted during a whole read after it, into what it found', async () => {
  const { root, repo } = await watched();
  write(root, 'src/a.ts', 'aa\n');
  repo.markSnapshotStale();
  const whole = repo.readSnapshot();

  write(root, 'kept.txt', 'two\n');
  repo.noteChanged(['kept.txt']);
  const after = await repo.readSnapshot();
  await whole;

  expect(after.files.map(file => file.path)).toEqual(['kept.txt', 'src/a.ts']);
  expect(after).toEqual(await truth(repo));
});
