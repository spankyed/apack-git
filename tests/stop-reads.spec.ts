// A read whoever asked for no longer wants — a blame, a page of history, a diff — is stopped through its signal while
// its git runs: the process ends, and the read rejects as `aborted`. The git under each is a stand-in that runs until
// it is ended, so the case is about the read being stopped and not about how long a real one takes.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, runUnbounded, type RunProcess } from '../src/index.ts';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

/**
 * A process that does nothing until it is ended, or for a minute when nothing ends it: a read its signal does not
 * reach then fails on its own, and leaves no process behind
 */
const FOREVER = [process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']] as const;

/**
 * A repository with a commit of `a.txt` and a change to it, whose git `command` is the stand-in: it is aborted
 * through `stop` once that has started, and `started` is its process
 */
async function repositoryStoppedAt(command: string) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-stop-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '--quiet', '-m', 'one']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const stop = new AbortController();
  let started: ChildProcess | undefined;
  const standIn: RunProcess = (file, args, options) => {
    if (!args.includes(command)) return runUnbounded(file, args, options);
    const running = runUnbounded(FOREVER[0], [...FOREVER[1]], options);
    started = running.child;
    running.child.once('spawn', () => stop.abort());
    return running;
  };
  const repo = new GitRepository(root, { run: standIn });
  repositories.push(repo);
  return { repo, signal: stop.signal, started: () => started };
}

const ended = (child: ChildProcess | undefined) =>
  new Promise<boolean>((resolve) => {
    if (!child) return resolve(false);
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    child.once('exit', () => resolve(true));
  });

const READS: [string, string, (repo: GitRepository, signal: AbortSignal) => Promise<unknown>][] = [
  ['a blame', 'blame', (repo, signal) => repo.blame('a.txt', { signal })],
  ['a page of history', 'log', (repo, signal) => repo.history({ signal })],
  ["a page of one file's history", 'log', (repo, signal) => repo.history({ path: 'a.txt', signal })],
  ['a diff', 'diff', (repo, signal) => repo.readDiff('a.txt', false, { signal })],
];

it.each(READS)('stops %s while its git runs, ending the process and rejecting as aborted', async (_, command, read) => {
  const { repo, signal, started } = await repositoryStoppedAt(command);

  const stopped = await read(repo, signal).then(() => undefined, (error: unknown) => error);

  expect(stopped).toMatchObject({ code: 'aborted' });
  expect(await ended(started()), 'its process ended').toBe(true);
});
