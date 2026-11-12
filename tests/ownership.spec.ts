// Git will not read a repository another user owns until the user adds it to `safe.directory`. The engine says
// that is why, with the path git named, and adds it when asked. Git's own switch for its tests stands in for
// another owner, handed to the engine in the environment its gits start from; every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, UnsafeOwnershipError } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

/** A repository with one commit, and a global configuration of its own that trusting writes to */
async function ownedByAnother() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-ownership-')));
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-ownership-home-')));
  directories.push(root, home);
  const global = path.join(home, '.gitconfig');
  fs.writeFileSync(global, '');
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, 'commit', '--quiet', '-m', 'first']);
  const environment = () => ({ ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: global });
  return { root, global, repo: new GitRepository(root, { environment }) };
}
const refusal = (attempt: Promise<unknown>) => attempt.then(() => { throw new Error('it was not refused'); }, (error: unknown) => error);

it('says a repository another user owns is one git will not read, naming it as git does', async () => {
  const { repo } = await ownedByAnother();

  const refused = await refusal(repo.isGitRepository());

  expect(refused).toBeInstanceOf(UnsafeOwnershipError);
  expect((refused as UnsafeOwnershipError).code).toBe('unsafe-ownership');
  expect((refused as UnsafeOwnershipError).directory).toMatch(/apack-ownership-/);
});

it('reads it once it is trusted, and writes only the user\'s safe.directory to do so', async () => {
  const { root, global, repo } = await ownedByAnother();
  const { directory } = await refusal(repo.isGitRepository()) as UnsafeOwnershipError;

  await repo.trustOwnership(directory);

  expect(await repo.isGitRepository()).toBe(true);
  expect((await repo.readSnapshot()).branch).toBe('main');
  expect(fs.readFileSync(global, 'utf8')).toContain('[safe]');
  expect(fs.existsSync(path.join(root, '.git', 'config')) && fs.readFileSync(path.join(root, '.git', 'config'), 'utf8')).not.toContain('safe');
});

it('answers that a folder in no repository is none, and not that it is refused', async () => {
  const empty = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-ownership-none-')));
  directories.push(empty);
  const repo = new GitRepository(empty, { environment: () => ({ ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CEILING_DIRECTORIES: path.dirname(empty) }) });

  expect(await repo.isGitRepository()).toBe(false);
});
