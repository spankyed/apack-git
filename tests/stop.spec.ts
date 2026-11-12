// A fetch or a push stopped by whoever asked for it ends with git and what git started, answers at once that it
// was stopped, and leaves no lock behind. The remote here is one that never answers: git's ssh command is a
// process that waits for as long as its fixture is there, and ends by itself when the fixture is deleted.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { settles } from './_support/settles.ts';
import { GitRepository, runUnbounded } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/**
 * Whether a process is still running. One that has ended and that nothing has reaped yet still answers a signal: a
 * container whose first process reaps nothing (CI's runs `tail -f /dev/null`) keeps an orphan so for ever, and on
 * Linux it is told by its state
 */
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
};

/** A repository whose remote never answers, with every git it starts, and the pid of the ssh command git runs */
async function remoteThatNeverAnswers() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-stop-')));
  const fixture = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-stop-ssh-')));
  directories.push(root, fixture);
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '--quiet', '-m', 'first']);
  await run('git', ['-C', root, 'remote', 'add', 'origin', 'ssh://example.invalid/repo.git']);
  await run('git', ['-C', root, 'config', 'branch.main.remote', 'origin']);
  await run('git', ['-C', root, 'config', 'branch.main.merge', 'refs/heads/main']);
  // Node rather than a shell script, so that the pid it writes is one this process can ask after on every platform
  const pidFile = path.join(fixture, 'pid');
  const helper = path.join(fixture, 'ssh.cjs');
  fs.writeFileSync(helper, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => { if (!require('fs').existsSync(${JSON.stringify(fixture)})) process.exit(0) }, 100);`);
  const quoted = (file: string) => `"${file.replaceAll('\\', '/')}"`;
  const started: ChildProcess[] = [];
  const repo = new GitRepository(root, {
    environment: () => ({ ...process.env, GIT_SSH_COMMAND: `${quoted(process.execPath)} ${quoted(helper)}` }),
    run: (file, args, options) => {
      const running = runUnbounded(file, args, options);
      started.push(running.child);
      return running;
    },
  });
  // Read once it holds a pid: the file is there a moment before what is written to it
  const ssh = () => settles(() => {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!(pid > 0)) throw new Error('not written yet');
    return pid;
  });
  return { root, repo, ssh, pidFile, started };
}
const locks = (root: string) => {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.lock')) found.push(path.relative(root, full));
    }
  };
  walk(path.join(root, '.git'));
  return found;
};

it('stops a push that is waiting on the remote, ending git and the ssh it started, and leaves no lock', async () => {
  const { root, repo, ssh, started } = await remoteThatNeverAnswers();
  const stop = new AbortController();

  const pushing = repo.pushBranch(undefined, stop.signal).then(() => undefined, (error: Error & { code?: string }) => error);
  const helper = await ssh();
  stop.abort();
  const stopped = await pushing;

  expect(stopped).toMatchObject({ code: 'aborted' });
  const push = started.find(child => child.spawnargs.includes('push'))!;
  expect(push.exitCode !== null || push.signalCode !== null, 'git has gone').toBe(true);
  await settles(() => { if (alive(helper)) throw new Error('the ssh git started is still running'); });
  expect(locks(root)).toEqual([]);
  expect((await repo.readSnapshot()).branch).toBe('main');
});

it('stops a fetch the same way, and answers that it was stopped rather than that it failed', async () => {
  const { root, repo, ssh } = await remoteThatNeverAnswers();
  const stop = new AbortController();

  const fetching = repo.fetch(stop.signal);
  const helper = await ssh();
  stop.abort();

  expect(await fetching).toMatchObject({ success: false, code: 'aborted' });
  await settles(() => { if (alive(helper)) throw new Error('the ssh git started is still running'); });
  expect(locks(root)).toEqual([]);
});

it('starts no git for a fetch stopped before its turn came', async () => {
  const { repo, pidFile, started } = await remoteThatNeverAnswers();
  const stop = new AbortController();
  stop.abort();

  expect(await repo.fetch(stop.signal)).toMatchObject({ success: false, code: 'aborted' });
  expect(started.filter(child => child.spawnargs.includes('fetch'))).toEqual([]);
  expect(fs.existsSync(pidFile)).toBe(false);
});
