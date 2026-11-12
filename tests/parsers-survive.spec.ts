// Every reader of what git prints, run over a fixed set of seeds: over bytes of any kind none throws and every one
// ends, over records generated as git writes them each gives back what was written, and over a repository whose
// files have generated names the snapshot names each as it is.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { seeded } from './_support/rig.ts';
import { GitRepository, classifyGitError, gitVersionOf, parseStatus, progressReader, withoutProgress } from '../src/index.ts';
import { recordsOf } from '../src/arguments.ts';
import { IncrementalBlame } from '../src/blame.ts';
import { parseNumstat } from '../src/diff-data.ts';
import { ownershipRefusal } from '../src/errors.ts';
import { historyRecords } from '../src/history.ts';
import { conflictRegions, parseStashList, parseWorktreeList } from '../src/reads.ts';
import { parseRefs } from '../src/refs.ts';

const SEEDS = Array.from({ length: 25 }, (_, at) => at + 1);

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** Characters git's output is made of, and what can turn up in a name, a message or a hook's words */
const ALPHABET = ['\0', '\n', '\t', ' ', '#', '?', '!', 'u', '1', '2', 'R', 'C', 'M', 'A', 'D', '.', '-', '+', '/', ':', '@', '{', '}', '*', '\x1e', '\r', '�', 'é', '日', 'a', 'z', '0', '9', 'N', 'S', 'U', '<', '>', '=', '|', '%', 'ahead ', 'behind ', 'branch.', 'worktree ', 'HEAD ', 'filename ', 'author ', '<<<<<<< ', '=======', '>>>>>>> '];

function noise(seed: number): string {
  const random = seeded(seed);
  return Array.from({ length: random.below(3000) }, () => random.pick(ALPHABET)).join('');
}

/** A name a file could have in a listing: anything but NUL */
function name(random: ReturnType<typeof seeded>, extra: readonly string[] = []): string {
  const letters = ['a', 'B', ' ', '#', 'é', '日', '-', '_', '.', '(', ')', "'", '"', '[', ']', ...extra];
  return `n${Array.from({ length: 1 + random.below(12) }, () => random.pick(letters)).join('')}`;
}

describe('over bytes of any kind', () => {
  it.each(SEEDS)('none throws, and every one ends (seed %i)', (seed) => {
    const bytes = noise(seed);
    parseStatus(bytes);
    parseNumstat(bytes);
    conflictRegions(bytes);
    parseStashList(bytes);
    parseWorktreeList(bytes, '/somewhere');
    parseRefs(bytes, bytes);
    historyRecords(bytes);
    recordsOf(bytes, 3);
    classifyGitError(bytes);
    ownershipRefusal(bytes);
    gitVersionOf(bytes);
    withoutProgress(bytes);
    const progress = progressReader(() => {});
    const blame = new IncrementalBlame();
    // In pieces, as a pipe hands them on, cut anywhere
    const random = seeded(seed);
    for (let at = 0; at < bytes.length;) {
      const piece = bytes.slice(at, at + 1 + random.below(64));
      progress(piece);
      blame.take(piece);
      at += piece.length;
    }
  });
});

describe('over records written as git writes them', () => {
  it.each(SEEDS)('a status gives back each path and how it changed (seed %i)', (seed) => {
    const random = seeded(seed);
    const files = Array.from({ length: 1 + random.below(30) }, (_, at) => `${name(random, ['\n', '\t'])}${at}`);
    const records = files.map((file, at) => (at % 3 === 0 ? `? ${file}` : `1 .M N... 100644 100644 100644 ${'0'.repeat(40)} ${'0'.repeat(40)} ${file}`));

    const read = parseStatus(['# branch.oid (initial)', '# branch.head main', ...records, ''].join('\0'));

    expect(read.files.map(file => [file.path, file.status])).toEqual(files.map((file, at) => [file, at % 3 === 0 ? 'untracked' : 'modified']));
  });

  it.each(SEEDS)('a count gives back each file, its lines and a rename (seed %i)', (seed) => {
    const random = seeded(seed);
    const counts = Array.from({ length: 1 + random.below(20) }, (_, at) => ({ path: `${name(random, ['\t', '\n'])}${at}`, added: random.below(1000), removed: random.below(1000), renamed: random.below(4) === 0 }));
    const printed = counts.map(({ path: file, added, removed, renamed }) => (renamed ? `${added}\t${removed}\t\0from-${file}\0${file}` : `${added}\t${removed}\t${file}`)).join('\0');

    expect(parseNumstat(`${printed}\0`)).toEqual(counts.map(({ path: file, added, removed, renamed }) => ({ path: file, added, removed, binary: false, ...(renamed && { originalPath: `from-${file}` }) })));
  });

  it.each(SEEDS)('stashes, refs, a history and a blame give back what was written (seed %i)', (seed) => {
    const random = seeded(seed);
    const hash = () => Array.from({ length: 40 }, () => random.pick([...'0123456789abcdef'])).join('');
    const messages = Array.from({ length: 1 + random.below(5) }, () => name(random, ['\n', ':']));
    expect(parseStashList(messages.map((message, at) => `stash@{${at}}\0${message}\0date`).join('\0') + '\0').map(stash => stash.message)).toEqual(messages);

    const branches = Array.from({ length: 1 + random.below(5) }, (_, at) => ({ name: `b${at}-${name(random).replace(/[ ."'()[\]]/g, '')}`, commit: hash() }));
    const listing = branches.map(({ name: branch, commit }) => `refs/heads/${branch}\0${branch}\0${commit}\0 \0\0\0`).join('\n');
    expect(parseRefs(listing, '').branches.map(({ name: branch, commit }) => ({ name: branch, commit }))).toEqual(branches);

    const commits = Array.from({ length: 1 + random.below(6) }, () => ({ hash: hash(), subject: name(random, ['\n']) }));
    const log = commits.map(({ hash: commit, subject }) => [commit, '', 'a', 'a@a', 'date', subject, ''].join('\0')).join('\0');
    expect(historyRecords(`${log}\0`).map(({ hash: commit, subject }) => ({ hash: commit, subject }))).toEqual(commits);

    const blame = new IncrementalBlame();
    const author = name(random);
    const incremental = `${hash()} 1 1 3\nauthor ${author}\nauthor-mail <x@x>\nauthor-time 0\nsummary s\nfilename f.txt\n`;
    for (let at = 0; at < incremental.length;) {
      const piece = 1 + random.below(9);
      blame.take(incremental.slice(at, at + piece));
      at += piece;
    }
    expect(blame.lines.map(({ line, author: by, originalPath }) => [line, by, originalPath])).toEqual([1, 2, 3].map(line => [line, author, 'f.txt']));
  });
});

describe('over a repository whose files have generated names', () => {
  // A name each platform allows: Windows refuses some characters, and a name ending in a dot or a space
  const allowed = process.platform === 'win32' ? [] : ['\t', ':', '?', '*', '|', '\\'];
  it.each(SEEDS.slice(0, 5))('the snapshot names each file as it is (seed %i)', async (seed) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-names-gen-')));
    directories.push(root);
    await run('git', ['-C', root, 'init', '--quiet']);
    const random = seeded(seed);
    const names = [...new Set(Array.from({ length: 1 + random.below(20) }, (_, at) => `${name(random, allowed).replace(/[. ]+$/, '')}${at}`))];
    for (const file of names) fs.writeFileSync(path.join(root, file), 'x\n');

    const listed = (await new GitRepository(root).readSnapshot()).files.map(file => file.path);

    expect(listed.sort()).toEqual([...names].sort());
  });
});
