// Three things the engine says of what it runs: which branch a branch was made from, where that was written
// down; how far along a push or a pull is; and each command with how long it took. Every case runs a real git.
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { GitRepository, progressReader, withoutProgress } from '../src/index.ts';
import { removeDirectory } from './_support/remove.ts';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout.trim();
function scratch(prefix: string): string {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}
const commit = async (root: string, file: string, message: string) => {
  fs.writeFileSync(path.join(root, file), `${message}\n`);
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', message);
};

/** A repository with `main`, and `develop` one commit ahead of it and checked out */
async function repositoryOnDevelop() {
  const root = scratch('apack-base-');
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await commit(root, 'a.txt', 'first');
  await git(root, 'checkout', '--quiet', '-b', 'develop');
  await commit(root, 'b.txt', 'on develop');
  return root;
}

// The commits alone cannot tell these apart: a branch made from `develop` and one made from `main` and merged up
// to `develop` hold the same history
it('knows the branch a branch was made from when it made the branch itself', async () => {
  const root = await repositoryOnDevelop();
  const repo = new GitRepository(root);

  await repo.createBranch('topic');

  expect((await repo.readSnapshot()).branch).toBe('topic');
  expect(await repo.rememberedBaseOf('topic')).toBe('develop');
});

it('knows it from git\'s own record when the branch was made in a terminal with a name to start from', async () => {
  const root = await repositoryOnDevelop();
  await git(root, 'checkout', '--quiet', '-b', 'topic', 'main');
  await commit(root, 'c.txt', 'on topic');

  expect(await new GitRepository(root).rememberedBaseOf('topic')).toBe('main');
});

it('knows it from what VS Code wrote down when it made the branch', async () => {
  const root = await repositoryOnDevelop();
  await git(root, 'checkout', '--quiet', '-b', 'topic');
  await git(root, 'config', 'branch.topic.vscode-merge-base', 'origin/main');

  expect(await new GitRepository(root).rememberedBaseOf('topic')).toBe('main');
});

it('answers nothing when the branch that was written down is gone', async () => {
  const root = await repositoryOnDevelop();
  await git(root, 'checkout', '--quiet', '-b', 'topic');
  await git(root, 'config', 'branch.topic.apack-base', 'deleted-since');
  await commit(root, 'c.txt', 'on topic');

  expect(await new GitRepository(root).rememberedBaseOf('topic')).toBeUndefined();
});

// Where nothing wrote down what a branch was made from, a pull request is based on the branch the remote's HEAD
// names, or else the first of the usual names there is a branch by. The answer is kept a few seconds, and found
// again once the host says the refs may have moved
it('answers the branch a pull request is based on, and finds it again once told the refs changed', async () => {
  // Kept for a while, and here no while passes
  vi.useFakeTimers({ toFake: ['Date'] });
  const root = scratch('apack-base-');
  await git(root, 'init', '--quiet', '--initial-branch=develop');
  await commit(root, 'a.txt', 'first');
  const repo = new GitRepository(root);
  const base = () => repo.findBaseBranch({ preferUpstream: false });
  expect(await base(), 'there is no main or master').toBe('develop');
  expect(await repo.findBaseBranch(), 'asked the default way, with no upstream to prefer').toBe('develop');

  await git(root, 'branch', 'main');
  expect(await base(), 'nothing has said the refs changed').toBe('develop');
  repo.invalidateCache(['.git/refs/heads/main']);
  expect(await base()).toBe('main');
  expect(await repo.findBaseBranch(), 'and found again asked either way').toBe('main');

  await git(root, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  repo.clearCache();
  expect(await base(), 'the remote\'s HEAD comes first').toBe('trunk');
});

// A branch made from another is nearer to it than to the branch that one was made from, in commits
it('counts the commits here since a branch, and lists the branches merged here whose tip is near', async () => {
  const root = scratch('apack-base-');
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await commit(root, 'a.txt', 'first');
  await git(root, 'branch', 'old');
  await git(root, 'branch', 'unmerged');
  await commit(root, 'a.txt', 'second');
  await git(root, 'checkout', '--quiet', '-b', 'feature-a');
  await commit(root, 'a.txt', 'on feature-a');
  await git(root, 'checkout', '--quiet', '-b', 'feature-b');
  await commit(root, 'a.txt', 'on feature-b');
  await git(root, 'checkout', '--quiet', 'unmerged');
  await commit(root, 'b.txt', 'on unmerged');
  await git(root, 'checkout', '--quiet', 'feature-b');
  const repo = new GitRepository(root);

  expect(await repo.readCommitDistance('main')).toBe(2);
  expect(await repo.readCommitDistance('feature-a')).toBe(1);
  expect(await repo.readCommitDistance('no-such-branch'), 'git cannot say').toBe(Infinity);

  expect((await repo.findNearbyMergedBranches(2)).sort(), 'old is further back, and unmerged is not merged').toEqual(['feature-a', 'feature-b', 'main']);
  expect((await repo.findNearbyMergedBranches(10)).sort(), 'fewer commits than that: every branch merged here').toEqual(['feature-a', 'feature-b', 'main', 'old']);
});

/** A repository with one commit and a bare remote it has not pushed to */
async function repositoryWithRemote() {
  const root = scratch('apack-progress-');
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await commit(root, 'a.txt', 'first');
  const remote = scratch('apack-progress-remote-');
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(root, 'remote', 'add', 'origin', remote);
  return { root, remote };
}

it('says how far along a push is, stage by stage, up to all of it', async () => {
  const { root } = await repositoryWithRemote();
  const said: { stage: string; percent: number }[] = [];

  await new GitRepository(root).pushBranch(progress => said.push(progress));

  expect(said.at(-1)).toEqual({ stage: 'Writing objects', percent: 100 });
  expect(new Set(said.map(progress => progress.stage))).toContain('Counting objects');
  expect(said.every(progress => progress.percent >= 0 && progress.percent <= 100)).toBe(true);
});

it('says how far along a pull is', async () => {
  const { root, remote } = await repositoryWithRemote();
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');
  const other = `${remote}-clone`;
  directories.push(other);
  await run('git', ['clone', '--quiet', remote, other]);
  await commit(other, 'b.txt', 'theirs');
  await git(other, 'push', '--quiet');
  const said: { stage: string; percent: number }[] = [];

  await new GitRepository(root).pullBranch(progress => said.push(progress));

  expect(said.length).toBeGreaterThan(0);
  expect(fs.existsSync(path.join(root, 'b.txt')), 'and the pull was made').toBe(true);
});

// Asked for progress, git writes it to the stream it says why it failed on
it('says why a push failed without the progress git printed before it', async () => {
  const { root, remote } = await repositoryWithRemote();
  await removeDirectory(remote);

  const failure = await new GitRepository(root).pushBranch(() => {}).then(() => undefined, (error: Error) => error.message);

  expect(failure).toBeTruthy();
  expect(failure).not.toMatch(/\d+% \(\d+\/\d+\)/);
});

// What git prints for a checkout of many files, which a spec's few files are too quick to bring about
it('reads progress git writes over itself, a line cut in two included, and reports each step once', () => {
  const said: string[] = [];
  const read = progressReader(progress => said.push(`${progress.stage} ${progress.percent}`));

  read('Updating files:  33% (1/3)\rUpdating fil');
  read('es:  66% (2/3)\rUpdating files: 100% (3/3)\rUpdating files: 100% (3/3), done.\n');
  read('remote: Counting objects:  50% (1/2)        \r');

  expect(said).toEqual(['Updating files 33', 'Updating files 66', 'Updating files 100', 'Counting objects 50']);
});

it('keeps what git said of a failure and drops the progress around it', () => {
  expect(withoutProgress('Enumerating objects: 3, done.\nCounting objects:  50% (1/2)\rCounting objects: 100% (2/2), done.\nfatal: unable to access the remote\n'))
    .toBe('fatal: unable to access the remote');
});

it('says each command with how long it took and why it failed to the log it is handed', async () => {
  const { root, remote } = await repositoryWithRemote();
  const logged: string[] = [];
  const repo = new GitRepository(root, { log: { command: line => logged.push(line) } });

  await repo.readCurrentBranch();
  await removeDirectory(remote);
  await repo.pushBranch().catch(() => {});

  // Beside the engine's own reads of what the repository would have git run
  expect(logged.find(line => line.includes('--abbrev-ref'))).toMatch(/^git rev-parse --abbrev-ref HEAD: ok in \d+ ms$/);
  expect(logged.at(-1)).toMatch(/^git push --progress -u origin HEAD: failed \(remote-unreachable\) in \d+ ms$/);
});

// A base is given to git as the name of a branch here, so it has to be one
it('does not answer a branch only the remote has, nor a commit reached from a branch', async () => {
  const root = await repositoryOnDevelop();
  const remote = scratch('apack-base-remote-');
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '--quiet', 'origin', 'main', 'develop');
  await git(root, 'fetch', '--quiet', 'origin');
  await git(root, 'checkout', '--quiet', '-b', 'from-remote', 'origin/develop');
  await git(root, 'branch', '--quiet', '-D', 'develop');
  await commit(root, 'c.txt', 'on from-remote');

  expect(await new GitRepository(root).rememberedBaseOf('from-remote'), 'the remote\'s develop is not a branch here').toBeUndefined();

  await git(root, 'checkout', '--quiet', '-b', 'from-a-commit', 'main~0');
  await commit(root, 'd.txt', 'on from-a-commit');
  expect(await new GitRepository(root).rememberedBaseOf('from-a-commit')).toBeUndefined();
});

it('keeps a remote hook\'s own lines in what is said of a failure, and reports none of them as progress', () => {
  const printed = 'remote: Counting objects: 100% (2/2), done.\nremote: Total coverage is below 80%: push refused\nremote: Coverage: 75% (300/400)\nTotal 3 (delta 0), reused 0 (delta 0), pack-reused 0\n ! [remote rejected] main -> main (pre-receive hook declined)\n';

  expect(withoutProgress(printed)).toBe('remote: Total coverage is below 80%: push refused\nremote: Coverage: 75% (300/400)\n ! [remote rejected] main -> main (pre-receive hook declined)');
  const reported: string[] = [];
  progressReader(progress => reported.push(progress.stage))(printed);
  expect(reported).toEqual(['Counting objects']);
});
