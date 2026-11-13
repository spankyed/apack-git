// A commit a repository's hook refused is said as the hook's: its name and the code it exited with, read from git's
// own event stream, and what it printed. Every git and hook is a real one, in a repository trusted to run them.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, HookRefusedError } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A repository with `a.txt` staged and a `pre-commit` hook: by default one that exits with `code` after printing a line */
async function withHook(code: number, script = `process.stderr.write('lint failed: 2 problems\\n');\nprocess.exit(${code});\n`) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-hooks-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  // Node rather than a shell script, so the hook runs alike on every platform
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await run('git', ['-C', root, 'add', 'a.txt']);
  const logged: string[] = [];
  const repo = new GitRepository(root, { isTrusted: () => true, log: { command: line => logged.push(line) } });
  return { root, repo, logged };
}

it('says a commit a pre-commit hook refused was refused by that hook, with its exit code and what it printed', async () => {
  const { root, repo } = await withHook(3);

  const refused = await repo.commit('first').then(() => undefined, (error: unknown) => error);

  expect(refused).toBeInstanceOf(HookRefusedError);
  const hookRefused = refused as HookRefusedError;
  expect(hookRefused.code).toBe('hook-refused');
  expect(hookRefused.hook).toBe('pre-commit');
  expect(hookRefused.exitCode).toBe(3);
  expect(hookRefused.output).toContain('lint failed: 2 problems');
  expect((await run('git', ['-C', root, 'rev-list', '--all'])).stdout, 'and nothing was committed').toBe('');
});

it('names the hooks a command ran in the log of commands, and a commit they let through goes through', async () => {
  const { root, repo, logged } = await withHook(0);

  await repo.commit('first');

  expect((await run('git', ['-C', root, 'log', '--format=%s'])).stdout.trim()).toBe('first');
  expect(logged.find(line => line.startsWith('git commit'))).toMatch(/hooks pre-commit 0/);
});

// What a watcher sees while a write made here runs is held until the write has finished (`GitWatcherService`)
it('says a write is running until it has finished, and calls what waits for it then, or at once when none is', async () => {
  // The hook holds the commit until it is told to go on, and ends by itself when the server it waits on goes
  const server = net.createServer();
  // The hook's going resets the connection where the platform says so (Windows), which is the ending it is meant to have
  const hooked = new Promise<net.Socket>((resolve) => { server.once('connection', (socket) => { socket.on('error', () => {}); resolve(socket); }); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as net.AddressInfo;
  const { repo } = await withHook(0, `require('node:net').connect(${port}, '127.0.0.1').on('data', () => process.exit(0)).on('close', () => process.exit(1)).on('error', () => process.exit(1));\n`);
  let socket: net.Socket | undefined;
  try {
    const committing = repo.commit('first');
    const first = await Promise.race([hooked, committing.then(() => 'ended' as const, () => 'ended' as const)]);
    if (first === 'ended') {
      await committing;
      throw new Error('it committed without the hook running');
    }
    socket = first;
    expect(repo.isWriteInProgress).toBe(true);
    let finished = false;
    repo.onWriteComplete(() => { finished = true; });
    expect(finished).toBe(false);

    socket.write('go');
    await committing;
    expect(finished).toBe(true);
    expect(repo.isWriteInProgress).toBe(false);

    let atOnce = false;
    repo.onWriteComplete(() => { atOnce = true; });
    expect(atOnce).toBe(true);
  } finally {
    socket?.destroy();
    await new Promise((resolve) => { server.close(resolve); });
  }
});
