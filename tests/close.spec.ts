// Closing a repository leaves no git of its running: the one kept open for reading files is ended, and what was
// asked of the repository before runs to its end first. Every case runs a real git.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, runUnbounded } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A repository with one commit, and every git it starts */
async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-close-')));
  directories.push(root);
  const git = (...args: string[]) => run('git', ['-C', root, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args]);
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  const started: ChildProcess[] = [];
  const repo = new GitRepository(root, {
    run: (file, args, options) => {
      const running = runUnbounded(file, args, options);
      started.push(running.child);
      return running;
    },
  });
  return { root, repo, started };
}

it('settles once the commands it was asked have run to their end, those waiting their turn included', async () => {
  const { root, repo, started } = await repository();
  fs.writeFileSync(path.join(root, 'a.txt'), 'two, and longer\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'new\n');

  // Two writes, the second waiting for the first, and a read beside them: none is waited for here
  const asked = [repo.stageFiles(['a.txt']), repo.stageFiles(['b.txt']), repo.readSnapshot()];
  await repo.close();

  expect(started.length).toBeGreaterThanOrEqual(3);
  expect(started.filter(child => child.exitCode === null && child.signalCode === null), 'every git it started has exited').toEqual([]);
  await Promise.all(asked);
  expect((await repo.getStatus()).filter(file => file.staged).map(file => file.path).sort()).toEqual(['a.txt', 'b.txt']);
  await repo.close();
});

it('is used again as before once it is closed', async () => {
  const { repo } = await repository();
  await repo.close();

  expect(await repo.getFileContent('a.txt', 'HEAD')).toBe('one\n');
  await repo.close();
});
