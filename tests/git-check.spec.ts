// The git a host hands in is asked, once and before the first command, whether it can be used: that it is there,
// that on macOS it is not the placeholder for the developer tools, and that it is no older than the engine's floor.
// When it cannot, every command is refused with why, and git is run for none of them.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GIT_FLOOR, GitRepository, GitUnusableError, gitVersionOf, olderThan, runUnbounded, type RunProcess } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

async function repository() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-check-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  return root;
}
/** Runs each process as it would run, but answers `git --version` and `xcode-select -p` as told, counting what it ran */
function standIn({ version, developerTools = true }: { version?: string; developerTools?: boolean }) {
  const ran: string[] = [];
  const runner: RunProcess = (file, args, options) => {
    ran.push([path.basename(file), ...args].join(' '));
    if (version !== undefined && args[0] === '--version') return Object.assign(Promise.resolve({ stdout: `git version ${version}\n`, stderr: '' }), { child: undefined as never });
    if (file === 'xcode-select' && !developerTools) return Object.assign(Promise.reject(Object.assign(new Error('no tools'), { code: 2 })), { child: undefined as never });
    return runUnbounded(file, args, options);
  };
  return { runner, ran };
}
const refusal = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it was not refused'); }, (error: unknown) => error as GitUnusableError);

it('refuses every command when git is older than the floor, naming the version, and runs none of them', async () => {
  const root = await repository();
  const { runner, ran } = standIn({ version: '2.30.1' });
  const repo = new GitRepository(root, { run: runner });

  const refused = await refusal(repo.readSnapshot());

  expect(refused).toBeInstanceOf(GitUnusableError);
  expect(refused.unusable).toMatchObject({ code: 'git-too-old', version: '2.30.1' });
  expect(await refusal(repo.getCurrentBranch())).toMatchObject({ code: 'git-too-old' });
  expect(ran, 'git was asked its version once, and nothing else').toEqual(['git --version']);
});

it('says there is no git where the host said git is', async () => {
  const root = await repository();
  const nowhere = path.join(root, 'no-git-here');

  const refused = await refusal(new GitRepository(root, { git: nowhere }).isGitRepository());

  expect(refused.unusable).toEqual({ code: 'git-not-found', git: nowhere });
});

it('runs every command with the git it was handed once that git is found usable', async () => {
  const root = await repository();
  const found = (await run('git', ['--exec-path'])).stdout.trim();
  const git = path.join(found, process.platform === 'win32' ? 'git.exe' : 'git');
  const { runner, ran } = standIn({});
  const repo = new GitRepository(root, { git, run: runner });

  expect(await repo.isGitRepository()).toBe(true);
  expect((await repo.readSnapshot()).files.map(file => file.path)).toEqual(['a.txt']);
  expect(ran.filter(line => line.endsWith('--version'))).toHaveLength(1);
  expect(ran.every(line => line.startsWith(path.basename(git)))).toBe(true);
});

// The placeholder cannot be produced on a Mac that has the tools, so whether they are installed is stood in for
it.runIf(process.platform === 'darwin')('says the developer tools are missing, rather than running the placeholder that offers them', async () => {
  const root = await repository();
  const { runner, ran } = standIn({ developerTools: false });

  const refused = await refusal(new GitRepository(root, { git: '/usr/bin/git', run: runner }).isGitRepository());

  expect(refused.unusable).toEqual({ code: 'developer-tools-missing', git: '/usr/bin/git' });
  expect(ran, 'git was never run').toEqual(['xcode-select -p']);
});

it('reads the version whatever a build adds after it, and compares by the numbers', () => {
  expect(gitVersionOf('git version 2.39.5 (Apple Git-154)\n')).toBe('2.39.5');
  expect(gitVersionOf('git version 2.47.1.windows.1\n')).toBe('2.47.1');
  expect(gitVersionOf('git version 2.43.0\n')).toBe('2.43.0');
  expect(olderThan('2.9.0', '2.35.0')).toBe(true);
  expect(olderThan(GIT_FLOOR, GIT_FLOOR)).toBe(false);
  expect(olderThan('2.34.1', GIT_FLOOR)).toBe(true);
  expect(olderThan('3.0', '2.35.0')).toBe(false);
});
