// A repository's own configuration and hooks can name programs for git to run, and opening a folder is enough
// to run one. Until a host says the repository is trusted, the engine reads what it would run without running
// it, and runs no git there but that reading. Every program here is a real one that leaves a file behind when
// it runs, and git is a real git.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository, UntrustedError, settingRunsNothing } from '../src/index.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, ...args])).stdout.trim();

/** A repository with one commit and an edit to `a.txt`, and beside it a program that says it ran by making a file */
async function repository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-trust-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-trust-programs-')));
  directories.push(root, outside);
  await git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const ran = path.join(outside, 'ran');
  const program = path.join(outside, 'program.sh');
  // Whatever it is asked to be, it says it ran and answers as that program may: nothing changed, the file as it is
  fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${ran}'\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
  fs.chmodSync(program, 0o755);
  return { root, program, ran: () => fs.existsSync(ran) };
}
const refused = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it was not refused'); }, (error: unknown) => error as UntrustedError);

it('runs git as it always has in a repository that names nothing to run, trusted or not', async () => {
  const { root } = await repository();
  await git(root, 'config', 'pull.rebase', 'true');
  await git(root, 'config', 'branch.main.description', 'the main line');
  const repo = new GitRepository(root);

  expect(await repo.readTrust()).toEqual({ trusted: false, asks: [], repository: path.join(root, '.git') });
  expect((await repo.readSnapshot()).files.map(file => file.path)).toEqual(['a.txt']);
});

it('does not run the file monitor a repository names until it is trusted, and names the setting', async () => {
  const { root, program, ran } = await repository();
  await git(root, 'config', 'core.fsmonitor', program);
  let trusted = false;
  const repo = new GitRepository(root, { isTrusted: () => trusted });

  const error = await refused(repo.readSnapshot());

  expect(error).toBeInstanceOf(UntrustedError);
  expect(error.code).toBe('untrusted');
  expect(error.asks).toEqual([{ kind: 'setting', key: 'core.fsmonitor', value: program, file: path.join(root, '.git', 'config') }]);
  expect(ran(), 'the program was not run').toBe(false);

  trusted = true;
  expect((await repo.readSnapshot()).files.map(file => file.path)).toEqual(['a.txt']);
  expect(ran(), 'and is run as git runs it once the repository is trusted').toBe(true);
});

it('does not run a conversion program named in a file the repository\'s configuration includes', async () => {
  const { root, program, ran } = await repository();
  const included = path.join(root, '.git', 'extra.config');
  fs.writeFileSync(included, `[diff "words"]\n\ttextconv = ${program}\n`);
  await git(root, 'config', 'include.path', 'extra.config');
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.txt diff=words\n');
  const repo = new GitRepository(root);

  const error = await refused(repo.getDiff('a.txt'));

  expect(error.asks).toEqual([{ kind: 'setting', key: 'diff.words.textconv', value: program, file: included }]);
  expect(ran()).toBe(false);
  expect(await refused(repo.getFileContent('a.txt', 'HEAD')), 'nor is the git kept open for reading files started').toBeInstanceOf(UntrustedError);
});

it('does not run a hook the repository holds, at a write or at a read that moves a ref', async () => {
  const { root, program, ran } = await repository();
  const hook = path.join(root, '.git', 'hooks', 'reference-transaction');
  fs.copyFileSync(program, hook);
  fs.chmodSync(hook, 0o755);
  let trusted = false;
  const repo = new GitRepository(root, { isTrusted: () => trusted });

  const error = await refused(repo.stageFiles(['a.txt']));
  expect(error.asks).toEqual([{ kind: 'hook', name: 'reference-transaction', file: hook }]);
  await refused(repo.commit('second'));
  expect(ran()).toBe(false);

  trusted = true;
  await repo.stageFiles(['a.txt']);
  await repo.commit('second');
  expect(ran(), 'run by git once trusted').toBe(true);
});

it('takes the samples git writes into a new repository for what they are, and a hook that cannot be run for none', async () => {
  const { root } = await repository();
  fs.writeFileSync(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
  if (process.platform !== 'win32') fs.chmodSync(path.join(root, '.git', 'hooks', 'pre-commit'), 0o644);
  const asks = (await new GitRepository(root).readTrust()).asks;

  // Where there is no executable bit, a file under a hook's name is a hook
  expect(asks.map(ask => ask.kind === 'hook' && ask.name)).toEqual(process.platform === 'win32' ? ['pre-commit'] : []);
});

// Nothing versioned can add a setting or a hook, but a script run in the folder can
it('refuses from the moment a hook or a setting appears, and no longer once it is gone', async () => {
  const { root, program } = await repository();
  const repo = new GitRepository(root);
  expect((await repo.readSnapshot()).files).toHaveLength(1);

  const hook = path.join(root, '.git', 'hooks', 'post-index-change');
  fs.copyFileSync(program, hook);
  fs.chmodSync(hook, 0o755);
  expect(await refused(repo.readSnapshot())).toBeInstanceOf(UntrustedError);

  fs.rmSync(hook);
  await git(root, 'config', 'core.sshCommand', program);
  expect((await refused(repo.readSnapshot())).asks).toEqual([{ kind: 'setting', key: 'core.sshcommand', value: program, file: path.join(root, '.git', 'config') }]);

  await git(root, 'config', '--unset', 'core.sshCommand');
  expect((await repo.readSnapshot()).files).toHaveLength(1);
});

it('names a repository by where its git state really lives, which a linked worktree shares', async () => {
  const { root, program } = await repository();
  await git(root, 'config', 'core.fsmonitor', program);
  const linked = `${root}-linked`;
  directories.push(linked);
  await git(root, 'worktree', 'add', '--quiet', '--detach', linked);
  const asked: string[] = [];
  const isTrusted = (repository: string) => { asked.push(repository); return true; };

  await new GitRepository(root, { isTrusted }).readSnapshot();
  await new GitRepository(linked, { isTrusted }).readSnapshot();

  expect([...new Set(asked)]).toEqual([path.join(root, '.git')]);
});

it('says nothing is trusted and nothing asked where there is no repository', async () => {
  const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-trust-none-')));
  directories.push(empty);

  expect(await new GitRepository(empty).readTrust()).toEqual({ trusted: false, asks: [] });
});

it.each([
  ['core.repositoryformatversion', '0'], ['core.ignorecase', 'true'], ['user.email', 'a@b.c'], ['remote.origin.url', 'https://example.com/r.git'],
  ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], ['branch.feature/x.y.merge', 'refs/heads/main'], ['branch.main.apack-base', 'develop'],
  ['status.showuntrackedfiles', 'all'], ['pull.ff', 'only'], ['submodule.lib.url', '../lib'], ['submodule.lib.update', 'rebase'],
  ['credential.helper', ''], ['core.fsmonitor', 'false'], ['color.diff.new', 'green'], ['alias.co', 'checkout'], ['url.git@host:.insteadof', 'https://host/'],
  ['include.path', 'other.config'], ['extensions.worktreeconfig', 'true'], ['lfs.repositoryformatversion', '0'],
])('knows %s runs nothing', (key, value) => {
  expect(settingRunsNothing(key, value)).toBe(true);
});

it.each([
  ['core.fsmonitor', '/tmp/watch.sh'], ['core.fsmonitor', 'true'], ['core.hookspath', '/tmp/hooks'], ['core.sshcommand', 'ssh -o x'], ['core.pager', 'less'],
  ['core.editor', 'vim'], ['core.askpass', '/tmp/ask'], ['core.gitproxy', '/tmp/proxy'], ['credential.helper', 'store'],
  ['credential.https://example.com.helper', '!f() { :; }; f'], ['diff.external', '/tmp/diff'], ['diff.pdf.textconv', 'pdftotext'], ['diff.pdf.command', 'x'],
  ['merge.ours.driver', 'true'], ['filter.lfs.clean', 'git-lfs clean -- %f'], ['filter.lfs.process', 'git-lfs filter-process'], ['gpg.program', '/tmp/gpg'],
  ['gpg.ssh.program', '/tmp/sign'], ['remote.origin.uploadpack', '/tmp/pack'], ['remote.origin.receivepack', '/tmp/pack'], ['remote.origin.vcs', 'x'],
  ['submodule.lib.update', '!rm -rf /'], ['protocol.ext.allow', 'always'], ['sequence.editor', 'x'], ['uploadpack.packobjectshook', 'x'],
  ['trailer.sign.command', 'x'], ['interactive.difffilter', 'x'], ['pager.status', 'x'], ['mergetool.x.cmd', 'x'], ['a.setting.nobody.listed', '1'], ['nosection', '1'],
])('asks about %s = %s', (key, value) => {
  expect(settingRunsNothing(key, value)).toBe(false);
});
