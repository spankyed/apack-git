// A host's environment can name another repository than the one a repository here was opened on: git sets
// `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` for the hooks it runs, so a host started from one inherits them.
// Every command reads and writes the repository it was opened on whatever the host's environment names.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitRepository, runUnbounded, type RunProcess } from '../src/index.ts';

/**
 * What git lists among its local variables that says how git behaves rather than which repository it is in, and
 * that a host hands in on purpose: the app's GitHub sign-in is a credential helper given as `GIT_CONFIG_COUNT`
 */
const KEPT = new Set(['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']);

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

async function repository(name: string) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `apack-git-env-${name}-`)));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, `${name}.txt`), `${name}\n`);
  return root;
}

it('reads and writes the repository it was opened on when the host inherited a hook\'s repository', async () => {
  const opened = await repository('opened');
  const hooks = await repository('hooks');
  const inherited = {
    ...process.env,
    GIT_DIR: path.join(hooks, '.git'),
    GIT_WORK_TREE: hooks,
    GIT_INDEX_FILE: path.join(hooks, '.git', 'index'),
  };
  const repo = new GitRepository(opened, { environment: () => inherited });

  expect((await repo.readStatus()).map(file => file.path)).toEqual(['opened.txt']);
  await repo.stageFiles(['opened.txt']);

  expect((await run('git', ['-C', opened, 'diff', '--cached', '--name-only'])).stdout.trim()).toBe('opened.txt');
  expect((await run('git', ['-C', hooks, 'diff', '--cached', '--name-only'])).stdout.trim(), 'the hook\'s repository is untouched').toBe('');
});

it('runs git with none of the local variables git lists, but its configuration', async () => {
  const opened = await repository('opened');
  const listed = (await run('git', ['rev-parse', '--local-env-vars'])).stdout.split('\n').filter(Boolean);
  expect(listed, 'git listed its local variables').toContain('GIT_DIR');
  const environments: NodeJS.ProcessEnv[] = [];
  const recording: RunProcess = (file, args, options) => {
    environments.push(options.env);
    return runUnbounded(file, args, options);
  };
  const host = { ...process.env, ...Object.fromEntries(listed.filter(name => !KEPT.has(name)).map(name => [name, '/somewhere-else'])), GIT_CONFIG_COUNT: '0' };

  await new GitRepository(opened, { run: recording, environment: () => host }).readStatus();

  expect(environments.length).toBeGreaterThan(0);
  for (const env of environments) {
    expect(listed.filter(name => !KEPT.has(name) && env[name] !== undefined), 'a variable that names another repository reached git').toEqual([]);
    expect(env.GIT_CONFIG_COUNT, 'the host\'s configuration reached git').toBe('0');
  }
});
