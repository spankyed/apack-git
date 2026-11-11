// Why a git command failed is read from what git printed, once, and whoever shows the failure is told why. Every
// case here fails a real git the way a user's does: a remote that moved on, one that is gone, one that asks for a
// sign-in, a merge that conflicts, a checkout that would overwrite work.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { run } from './_support/process.ts';
import { GitRepository, classifyGitError } from '../src/index.ts';

const directories: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((closed) => { server.close(closed); server.closeAllConnections(); });
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 });
});

const git = async (cwd: string, ...args: string[]) =>
  (await run('git', ['-C', cwd, '-c', 'user.name=spec', '-c', 'user.email=spec@example.com', ...args])).stdout.trim();
function scratch(prefix: string): string {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}
const write = (root: string, file: string, content: string) => fs.writeFileSync(path.join(root, file), content);

/** A repository with one commit on `main`, and no credential helper of the machine's to ask */
async function repository() {
  const root = scratch('apack-failures-');
  await git(root, 'init', '--quiet', '--initial-branch=main');
  await git(root, 'config', 'credential.helper', '');
  write(root, 'a.txt', 'one\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'first');
  return root;
}

/** The repository pushed to a bare remote, and a second clone of that remote */
async function sharedWithAnotherClone() {
  const root = await repository();
  const remote = scratch('apack-failures-remote-');
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');
  const other = `${remote}-clone`;
  directories.push(other);
  await run('git', ['clone', '--quiet', remote, other]);
  return { root, remote, other };
}

const refusal = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it did not fail'); }, (error: Error & { code?: string }) => ({ code: error.code, message: error.message }));

it('says a push was refused because the remote branch has moved on', async () => {
  const { root, other } = await sharedWithAnotherClone();
  write(other, 'b.txt', 'theirs\n');
  await git(other, 'add', '.');
  await git(other, 'commit', '--quiet', '-m', 'theirs');
  await git(other, 'push', '--quiet');
  write(root, 'c.txt', 'ours\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'ours');

  expect(await refusal(new GitRepository(root).pushBranch())).toMatchObject({ code: 'non-fast-forward' });
});

/** Both the repository and its remote with a commit the other lacks, each changing `a.txt` */
async function bothMovedOn() {
  const { root, other } = await sharedWithAnotherClone();
  write(other, 'a.txt', 'theirs\n');
  await git(other, 'commit', '--quiet', '-am', 'theirs');
  await git(other, 'push', '--quiet');
  write(root, 'a.txt', 'ours\n');
  await git(root, 'commit', '--quiet', '-am', 'ours');
  return root;
}

// Git says a merge stopped on a conflict on its output and nothing on its error stream
it('says a pull stopped on a conflict', async () => {
  const root = await bothMovedOn();
  await git(root, 'config', 'pull.rebase', 'false');
  await git(root, 'config', 'pull.ff', 'true');

  expect(await refusal(new GitRepository(root).pullBranch())).toMatchObject({ code: 'conflict' });
});

// Set to pull only by fast-forward, git refuses a branch both sides have added to before it merges anything
it('says a pull was refused because both sides moved on and git may only fast-forward', async () => {
  const root = await bothMovedOn();
  await git(root, 'config', 'pull.ff', 'only');

  expect(await refusal(new GitRepository(root).pullBranch())).toMatchObject({ code: 'diverged' });
});

it('says the remote could not be reached when it is gone', async () => {
  const { root, remote } = await sharedWithAnotherClone();
  fs.rmSync(remote, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 });

  expect(await refusal(new GitRepository(root).pushBranch())).toMatchObject({ code: 'remote-unreachable' });
});

/** A remote over HTTP that answers every request as one wanting a sign-in */
async function remoteWantingASignIn(): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="spec"' }).end();
  });
  servers.push(server);
  await new Promise<void>((listening) => { server.listen(0, '127.0.0.1', listening); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
}

it('says the remote asked for a sign-in git does not have, and which remote that was', async () => {
  const root = await repository();
  await git(root, 'remote', 'add', 'origin', await remoteWantingASignIn());
  const repo = new GitRepository(root);

  expect(await refusal(repo.pushBranch())).toMatchObject({ code: 'authentication' });
  expect(await repo.getRemoteUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/repo\.git$/);
});

it('makes a branch git does not know, and refuses a checkout that would overwrite work', async () => {
  const root = await repository();
  const repo = new GitRepository(root);

  await repo.checkoutBranch('topic');
  expect((await repo.readSnapshot()).branch, 'a name git did not know became a branch').toBe('topic');

  write(root, 'a.txt', 'topic\n');
  await git(root, 'commit', '--quiet', '-am', 'on topic');
  await git(root, 'checkout', '--quiet', 'main');
  write(root, 'a.txt', 'not committed\n');

  expect(await refusal(repo.checkoutBranch('topic'))).toMatchObject({
    code: 'local-changes', message: expect.stringContaining('Cannot switch branches'),
  });
  expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'and the work is as it was').toBe('not committed\n');
});

// What git prints for the failures a spec cannot bring about without a real host, as recorded from one
it.each([
  ['a key the host refused, which git follows with a line about the remote',
    'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.', 'authentication'],
  ['a token the host knows and will not let push',
    "remote: Permission to octo/repo.git denied to someone.\nfatal: unable to access 'https://github.com/octo/repo.git/': The requested URL returned error: 403", 'permission'],
  ['a host that does not resolve',
    "fatal: unable to access 'https://example.invalid/repo.git/': Could not resolve host: example.invalid", 'remote-unreachable'],
  ['something git says that names none of them', 'fatal: bad object HEAD', undefined],
] as const)('reads %s', (_what, printed, code) => {
  expect(classifyGitError(printed)).toBe(code);
});

// A name that is no branch and is a tracked folder is, to `git checkout <name>`, that folder: checked out over
// whatever was changed in it
it('makes a branch of a name that is also a tracked folder, and leaves the work in that folder alone', async () => {
  const root = await repository();
  fs.mkdirSync(path.join(root, 'docs'));
  write(root, 'docs/guide.md', 'committed\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '--quiet', '-m', 'docs');
  write(root, 'docs/guide.md', 'not committed\n');
  const repo = new GitRepository(root);

  await repo.checkoutBranch('docs');

  expect((await repo.readSnapshot()).branch).toBe('docs');
  expect(fs.readFileSync(path.join(root, 'docs/guide.md'), 'utf8')).toBe('not committed\n');
});

it('makes a branch whose name holds a word git prints for another failure', async () => {
  const root = await repository();
  const repo = new GitRepository(root);

  await repo.checkoutBranch('fix/CONFLICT-markers');

  expect((await repo.readSnapshot()).branch).toBe('fix/CONFLICT-markers');
});

// A reason is a line git writes, from its start: the same words in a name, in a hook's output or in another
// step's line are not git's reason
it.each([
  ['a tag the remote moved, which a pull could not move here',
    ' ! [rejected]        latest     -> latest  (would clobber existing tag)', undefined],
  ['a branch the remote would not move',
    " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'origin'", 'non-fast-forward'],
  ['a conflict, under git\'s warning about a config file of the user\'s it could not read',
    "warning: unable to access '/Users/someone/.config/git/attributes': Permission denied\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.", 'conflict'],
  ['a checkout refused over a file called CONFLICTS.md',
    'error: Your local changes to the following files would be overwritten by checkout:\n\tCONFLICTS.md\nPlease commit your changes or stash them before you switch branches.\nAborting', 'local-changes'],
  ['untracked files in the way, which git names and no sentence here does',
    'error: The following untracked working tree files would be overwritten by checkout:\n\tnotes.txt\nPlease move or remove them before you switch branches.\nAborting', undefined],
  ['a hook whose own output holds words git uses',
    "remote: running tests\nremote: login test: Authentication failed for user 'x' as expected, Connection refused handled\nremote: 1 test failed\n ! [remote rejected] main -> main (pre-receive hook declined)", undefined],
  ['a certificate git would not trust, which is not the network being down',
    "fatal: unable to access 'https://example.com/repo.git/': SSL certificate problem: self signed certificate", undefined],
] as const)('reads %s', (_what, printed, code) => {
  expect(classifyGitError(printed)).toBe(code);
});
