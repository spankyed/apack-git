// A commit a repository's hook refused is said as the hook's: its name and the code it exited with, read from git's
// own event stream, and what it printed. Every git and hook is a real one, in a repository trusted to run them.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, HookRefusedError } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A repository with `a.txt` staged and a `pre-commit` hook that exits with `code` after printing a line */
async function withHook(code: number) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-hooks-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  // Node rather than a shell script, so the hook runs alike on every platform
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, `#!/usr/bin/env node\nprocess.stderr.write('lint failed: 2 problems\\n');\nprocess.exit(${code});\n`, { mode: 0o755 });
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
  expect(refused).toMatchObject({ code: 'hook-refused', hook: 'pre-commit', exitCode: 3 });
  expect((refused as HookRefusedError).output).toContain('lint failed: 2 problems');
  expect((await run('git', ['-C', root, 'rev-list', '--all'])).stdout, 'and nothing was committed').toBe('');
});

it('names the hooks a command ran in the log of commands, and a commit they let through goes through', async () => {
  const { root, repo, logged } = await withHook(0);

  await repo.commit('first');

  expect((await run('git', ['-C', root, 'log', '--format=%s'])).stdout.trim()).toBe('first');
  expect(logged.find(line => line.startsWith('git commit'))).toMatch(/hooks pre-commit 0/);
});
