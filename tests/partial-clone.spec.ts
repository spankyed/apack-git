// A partial clone was given less than everything, and git fetches what it lacks when a read needs it. A read here
// is understood to be local: it waits behind nothing and cannot be stopped. So a read fetches nothing, and says
// what it lacked, unless whoever asked says it may; on a git too old to be told not to, it waits in line with the
// commands that reach the remote. Every git is a real one, and the remote is a folder.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

const temporary = (name: string) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-partial-${name}-`)));
  directories.push(directory);
  return directory;
};
const git = (root: string, ...args: string[]) => run('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);

/**
 * A clone with no file content but what its checkout needed, of a remote where `a.txt` was `one` and is `two`: the
 * first version is in no tree the clone checked out, so the clone does not have it
 */
async function partialClone() {
  const remote = temporary('remote');
  await git(remote, 'init', '--quiet', '--initial-branch=main');
  await git(remote, 'config', 'uploadpack.allowFilter', 'true');
  fs.writeFileSync(path.join(remote, 'a.txt'), 'one\n');
  await git(remote, 'add', '.');
  await git(remote, 'commit', '--quiet', '-m', 'one');
  fs.writeFileSync(path.join(remote, 'a.txt'), 'two\n');
  await git(remote, 'commit', '--quiet', '-am', 'two');
  const parent = temporary('clone');
  const root = path.join(parent, 'clone');
  await run('git', ['clone', '--quiet', '--filter=blob:none', `file://${remote.replaceAll('\\', '/')}`, root]);
  const old = (await git(root, 'rev-parse', 'HEAD~1:a.txt')).stdout.trim();
  /** Whether the clone has the first version's content now, asked without fetching it */
  const has = () => run('git', ['-C', root, 'cat-file', '-e', old], { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).then(() => true, () => false);
  return { remote, root, old, has, repo: new GitRepository(root) };
}

/**
 * Whether the git here can be told not to fetch, asked of it: one that cannot fetches whatever a read needs. Which
 * releases can is a table of each line's (`refusesLazyFetch`), so it is found here by what git does instead
 */
const refusesToFetch = await (async () => {
  const { root, old } = await partialClone();
  try {
    // Read with lazy fetching off: a git that honours the switch fails, and one that does not fetches it and answers
    return await run('git', ['-C', root, 'cat-file', 'blob', old], { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).then(() => false, () => true);
  } finally {
    await Promise.all(directories.splice(0).map(removeDirectory));
  }
})();
const refusal = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it was not refused'); }, (error: unknown) => error);

it.runIf(refusesToFetch)('answers a read of content the clone never fetched as missing, and fetches nothing', async () => {
  // The remote is there to be fetched from, so a read that reached it would answer with the content
  const { has, repo } = await partialClone();

  const refused = await refusal(repo.getFileContentFromBranch('a.txt', 'HEAD~1'));

  expect(refused).toBeInstanceOf(GitError);
  expect((refused as GitError).code).toBe('content-missing');
  expect(await has(), 'and the content is still not here').toBe(false);
});

it.runIf(refusesToFetch)('answers a file the commit does not have as no file, as it does outside a partial clone', async () => {
  const { repo } = await partialClone();

  expect(await repo.getFileContentFromBranch('not-there.txt', 'HEAD~1')).toBe('');
  expect(await repo.getFileContentFromBranch('a.txt', 'HEAD'), 'and one it has, as it has it').toBe('two\n');
});

it('fetches what is missing when whoever asked says it may', async () => {
  const { has, repo } = await partialClone();

  expect(await repo.fetchingMissing(() => repo.getFileContentFromBranch('a.txt', 'HEAD~1'))).toBe('one\n');
  expect(await has(), 'and the clone has it now').toBe(true);
});

it.runIf(!refusesToFetch)('on a git that cannot be told not to fetch, waits for a fetch already reaching the remote before it reads', async () => {
  const { root, repo } = await partialClone();
  const fixture = temporary('ssh');
  // A remote whose ssh command waits for as long as its fixture's marker is there, and ends when it is not
  const marker = path.join(fixture, 'keep');
  fs.writeFileSync(marker, '');
  const helper = path.join(fixture, 'ssh.cjs');
  fs.writeFileSync(helper, `setInterval(() => { if (!require('fs').existsSync(${JSON.stringify(marker)})) process.exit(1) }, 50);`);
  await git(root, 'remote', 'add', 'stalled', 'ssh://example.invalid/repo.git');
  await git(root, 'config', 'branch.main.remote', 'stalled');
  const quoted = (file: string) => `"${file.replaceAll('\\', '/')}"`;
  const waiting = new GitRepository(root, { environment: () => ({ ...process.env, GIT_SSH_COMMAND: `${quoted(process.execPath)} ${quoted(helper)}` }) });

  const fetching = waiting.fetch();
  const read = waiting.getFileContentFromBranch('a.txt', 'HEAD~1');
  let answered = false;
  void read.then(() => { answered = true; }, () => { answered = true; });
  // Long enough for a read that waited behind nothing to have answered many times over
  await new Promise(resolve => setTimeout(resolve, 1_500));
  expect(answered, 'the read waits while the fetch holds the line').toBe(false);

  fs.rmSync(marker);
  await fetching;
  expect(await read, 'and reads, fetching what it lacks, once it has gone').toBe('one\n');
  await waiting.close();
  await repo.close();
});
