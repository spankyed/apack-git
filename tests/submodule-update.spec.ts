// Bringing submodules to the commits their parent records: one a clone has not set up yet, one a pull moved, and one
// whose own changes the checkout would overwrite, which is refused and left as it is. Every git is a real one, with
// the submodule's repository on this machine.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.js';
import { removeDirectory } from './_support/remove.js';
import { GitError, GitRepository } from '../src/index.js';

const directories: string[] = [];
const repositories: GitRepository[] = [];
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.close();
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

// A submodule on this machine is cloned over `file://`, which git allows only when told to
const git = async (cwd: string, ...args: string[]) => (await run('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args])).stdout.trim();
const LOCAL_SUBMODULES = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };

/**
 * Two libraries, a parent that records them as submodules at `libs/library` and `libs/other`, and a clone of the
 * parent that has set neither up. `advance` moves both libraries on by a commit changing `s.txt`, has the parent
 * record them and the clone pull that, and answers the commit `libs/library` is recorded at now
 */
async function cloned() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-submodules-')));
  directories.push(root);
  const library = path.join(root, 'library');
  const other = path.join(root, 'other');
  const parent = path.join(root, 'parent');
  await run('git', ['init', '--quiet', '--initial-branch=main', parent]);
  for (const [repository, at] of [[library, 'libs/library'], [other, 'libs/other']] as const) {
    await run('git', ['init', '--quiet', '--initial-branch=main', repository]);
    fs.writeFileSync(path.join(repository, 's.txt'), 'one\n');
    await git(repository, 'add', '.');
    await git(repository, 'commit', '--quiet', '-m', 'one');
    await git(parent, 'submodule', '--quiet', 'add', repository, at);
  }
  await git(parent, 'commit', '--quiet', '-m', 'the libraries');
  const work = path.join(root, 'work');
  await git(root, 'clone', '--quiet', parent, work);
  const repo = new GitRepository(work, { environment: () => ({ ...process.env, ...LOCAL_SUBMODULES }) });
  repositories.push(repo);
  const advance = async () => {
    for (const [repository, at] of [[library, 'libs/library'], [other, 'libs/other']] as const) {
      fs.writeFileSync(path.join(repository, 's.txt'), 'two\n');
      await git(repository, 'commit', '--quiet', '-am', 'two');
      await git(path.join(parent, at), 'pull', '--quiet', 'origin', 'main');
    }
    await git(parent, 'commit', '--quiet', '-am', 'the libraries moved on');
    await git(work, 'pull', '--quiet', '--no-rebase');
    return git(library, 'rev-parse', 'HEAD');
  };
  return { work, repo, library, advance };
}

it('sets up a submodule the clone has not, at the commit its parent records', async () => {
  const { work, repo, library } = await cloned();
  expect(fs.existsSync(path.join(work, 'libs/library/s.txt'))).toBe(false);

  await repo.updateSubmodules();

  expect(fs.readFileSync(path.join(work, 'libs/library/s.txt'), 'utf8')).toBe('one\n');
  expect(await git(path.join(work, 'libs/library'), 'rev-parse', 'HEAD')).toBe(await git(library, 'rev-parse', 'HEAD'));
});

it('brings the submodule named, which a pull moved, to the commit now recorded, and leaves the others', async () => {
  const { work, repo, advance } = await cloned();
  await repo.updateSubmodules();
  const recorded = await advance();
  const moved = async () => (await repo.readStatus()).filter(file => file.submodule?.commit).map(file => file.path);
  expect(await moved()).toEqual(['libs/library', 'libs/other']);

  await repo.updateSubmodules(['libs/library']);

  expect(await git(path.join(work, 'libs/library'), 'rev-parse', 'HEAD')).toBe(recorded);
  expect(await moved(), 'the status lists the one updated no more').toEqual(['libs/other']);
});

it("refuses a submodule whose own changes the checkout would overwrite, and leaves them as they are", async () => {
  const { work, repo, advance } = await cloned();
  await repo.updateSubmodules();
  await advance();
  fs.writeFileSync(path.join(work, 'libs/library/s.txt'), 'mine\n');

  const refused = await repo.updateSubmodules().then(() => undefined, (error: unknown) => error);

  expect(refused).toBeInstanceOf(GitError);
  expect(refused).toMatchObject({ code: 'local-changes' });
  expect(fs.readFileSync(path.join(work, 'libs/library/s.txt'), 'utf8')).toBe('mine\n');
});

it('is stopped through its signal, saying so', async () => {
  const { repo } = await cloned();
  const stop = new AbortController();
  stop.abort();

  const stopped = await repo.updateSubmodules([], { signal: stop.signal }).then(() => undefined, (error: unknown) => error);

  expect(stopped).toMatchObject({ code: 'aborted' });
});
