// Making a repository: a clone with its progress, one stopped midway that leaves nothing behind, a repository
// started from nothing, and its remotes added, renamed, re-addressed and removed. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { settles } from './_support/settles.ts';
import { GitError, GitRepository, type GitProgress } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });
const temporary = (name: string) => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-clone-${name}-`)));
  directories.push(directory);
  return directory;
};

it('clones with its progress, into a repository that opens trusted by what it names', async () => {
  const remote = temporary('remote');
  await run('git', ['-C', remote, 'init', '--quiet', '--initial-branch=main']);
  for (let file = 0; file < 50; file++) fs.writeFileSync(path.join(remote, `${file}.txt`), `${file}\n`.repeat(200));
  await run('git', ['-C', remote, 'add', '.']);
  await run('git', ['-C', remote, 'commit', '--quiet', '-m', 'files']);
  const into = path.join(temporary('into'), 'cloned');
  const progress: GitProgress[] = [];

  const repo = await GitRepository.clone(`file://${remote.replaceAll('\\', '/')}`, into, { onProgress: step => progress.push(step) });

  expect(progress.some(step => /objects/i.test(step.stage))).toBe(true);
  expect((await repo.readTrust()).asks, 'its settings name nothing that runs a program').toEqual([]);
  expect((await repo.readSnapshot()).branch).toBe('main');
});

it('leaves no directory behind a clone stopped midway', async () => {
  const fixture = temporary('ssh');
  const pidFile = path.join(fixture, 'pid');
  // A remote that never answers: git's ssh command waits for as long as its fixture is there
  const helper = path.join(fixture, 'ssh.cjs');
  fs.writeFileSync(helper, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => { if (!require('fs').existsSync(${JSON.stringify(fixture)})) process.exit(0) }, 100);`);
  const quoted = (file: string) => `"${file.replaceAll('\\', '/')}"`;
  const into = path.join(temporary('into'), 'stopped');
  const stop = new AbortController();

  const cloning = GitRepository.clone('ssh://example.invalid/repo.git', into, {
    ties: { environment: () => ({ ...process.env, GIT_SSH_COMMAND: `${quoted(process.execPath)} ${quoted(helper)}` }) },
    signal: stop.signal,
  }).then(() => undefined, (error: unknown) => error);
  await settles(() => { if (!(Number(fs.readFileSync(pidFile, 'utf8')) > 0)) throw new Error('not yet'); });
  stop.abort();

  expect(((await cloning) as GitError).code).toBe('aborted');
  expect(fs.existsSync(into)).toBe(false);
});

it('starts a repository, and adds, re-addresses, renames and removes its remotes', async () => {
  const repo = await GitRepository.init(path.join(temporary('new'), 'fresh'), { initialBranch: 'main' });

  expect(await repo.isGitRepository()).toBe(true);
  await repo.addRemote('origin', 'https://example.com/one.git');
  await repo.setRemoteUrl('origin', 'ssh://example.com/push.git', { push: true });
  expect((await repo.refsModel()).remotes).toEqual([{ name: 'origin', fetchUrl: 'https://example.com/one.git', pushUrl: 'ssh://example.com/push.git' }]);
  await repo.renameRemote('origin', 'upstream');
  expect((await repo.refsModel()).remotes.map(remote => remote.name)).toEqual(['upstream']);
  await repo.removeRemote('upstream');
  expect((await repo.refsModel()).remotes).toEqual([]);
  await expect(repo.addRemote('origin', '--upload-pack=x')).rejects.toThrow('Invalid address');
  await expect(repo.addRemote('origin', 'ext::sh -c evil')).rejects.toThrow('Invalid address');
});

it('refuses to clone into an existing non-empty directory without deleting its contents', async () => {
  const existing = temporary('non-empty');
  fs.writeFileSync(path.join(existing, 'precious.txt'), 'keep me\n');

  await expect(GitRepository.clone('https://example.invalid/repo.git', existing)).rejects.toThrow('not an empty directory');
  expect(fs.readFileSync(path.join(existing, 'precious.txt'), 'utf8')).toBe('keep me\n');
});

it('refuses dangerous protocols and pre-aborted clones without touching disk', async () => {
  const into = path.join(temporary('aborted'), 'nested', 'repo');
  const stop = new AbortController();
  stop.abort();

  await expect(GitRepository.clone('https://example.invalid/repo.git', into, { signal: stop.signal })).rejects.toMatchObject({ code: 'aborted' });
  expect(fs.existsSync(path.dirname(into))).toBe(false);
  await expect(GitRepository.clone('ext::sh -c touch% /tmp/x', into)).rejects.toThrow('Invalid address');
  await expect(GitRepository.init(into, { initialBranch: '--evil' })).rejects.toThrow('Invalid branch name');
});
