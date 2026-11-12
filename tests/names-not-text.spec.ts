// A file whose name is not text, which Linux allows and macOS and Windows do not: it is listed and refused by name,
// and the rest of the tree is listed, staged and discarded as it would be without it. Every git is a real one.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';
import { GitError, GitRepository } from '../src/index.ts';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeDirectory(directory); });

it.runIf(process.platform === 'linux')('lists a file whose name is not text as refused, and works on the rest as before', async () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-names-')));
  const store = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-names-store-')));
  directories.push(root, store);
  const git = async (...args: string[]) => (await run('git', ['-C', root, ...args])).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'one\n');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'first');
  fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'two\n');
  // `bad\xff.txt`: 0xff is never part of a UTF-8 character
  fs.writeFileSync(Buffer.concat([Buffer.from(`${root}/bad`), Buffer.from([0xff]), Buffer.from('.txt')]), 'bad\n');
  const repo = new GitRepository(root, { checkpointDirectory: () => path.join(store, 'store') });

  const files = (await repo.readSnapshot()).files;
  const refused = files.find(file => file.nameNotText);
  expect(refused).toMatchObject({ status: 'untracked', nameNotText: true });
  expect(files.filter(file => !file.nameNotText).map(file => file.path)).toEqual(['a.txt', 'b.txt']);

  const refusal = await repo.stageFiles([refused!.path]).then(() => undefined, (error: unknown) => error);
  expect((refusal as GitError).code).toBe('name-not-text');

  await repo.stageFiles(['a.txt']);
  await repo.revertFile('b.txt');
  expect(await git('diff', '--cached', '--name-only')).toBe('a.txt');
  expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('one\n');
  expect((await repo.readSnapshot()).files.filter(file => file.nameNotText), 'and the file is still listed').toHaveLength(1);
});
