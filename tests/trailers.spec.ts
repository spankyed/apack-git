// The trailers at the end of a commit message, as git reads them, and a message without the ones a host names: what
// a panel lists under the message being written, and what it commits when some of them are not to be kept.
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.js';
import { removeDirectory } from './_support/remove.js';
import { GitRepository } from '../src/index.js';

let repo: GitRepository;
let root: string;
beforeEach(async () => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-trailers-')));
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  repo = new GitRepository(root);
});
afterEach(async () => { await repo.close(); await removeDirectory(root); });

const coAuthors = ({ key }: { key: string }) => key.toLowerCase() === 'co-authored-by';

it('reads the trailers of the last paragraph in order, keys as written and continued lines unfolded', async () => {
  const message = 'feat: a thing\n\nWhy it is done.\n\nCo-Authored-By: A <a@example.com>\nReviewed-by: B\n  and C\n';

  expect(await repo.trailersIn(message)).toEqual([
    { key: 'Co-Authored-By', value: 'A <a@example.com>' },
    { key: 'Reviewed-by', value: 'B and C' },
  ]);
});

it('reads none where git reads none: a subject alone, and a line among prose', async () => {
  expect(await repo.trailersIn('Co-authored-by: A')).toEqual([]);
  expect(await repo.trailersIn('feat: a thing\n\nThe body says why.\nCo-authored-by: A\n')).toEqual([]);
});

it('removes the trailers picked, with the lines that continue them, and leaves every other line as written', async () => {
  const message = 'feat: a thing\n\nWhy it is done.\n\nCo-authored-by: A <a@example.com>\n  continued\nSigned-off-by: B <b@example.com>\nco-authored-by: C\n';

  expect(await repo.withoutTrailers(message, coAuthors)).toBe('feat: a thing\n\nWhy it is done.\n\nSigned-off-by: B <b@example.com>\n');
});

it('takes the blank lines that set the trailers apart when none is left', async () => {
  const message = 'feat: a thing\n\nWhy it is done.\n\nCo-authored-by: A\nCo-authored-by: A\n\n';

  expect(await repo.withoutTrailers(message, coAuthors)).toBe('feat: a thing\n\nWhy it is done.');
});

it('leaves a line that only reads like a trailer, in a paragraph git takes as prose', async () => {
  const message = 'feat: a thing\n\nThe body says why.\nCo-authored-by: A\n';

  expect(await repo.withoutTrailers(message, coAuthors)).toBe(message);
});

it("keeps the prose and comments of a paragraph git takes for its own trailer, and the message's line endings", async () => {
  const message = 'feat: a thing\r\n\r\nSigned-off-by: B\r\nsome words\r\n# a comment\r\nCo-authored-by: A\r\n';

  expect(await repo.trailersIn(message)).toEqual([{ key: 'Signed-off-by', value: 'B' }, { key: 'Co-authored-by', value: 'A' }]);
  expect(await repo.withoutTrailers(message, coAuthors)).toBe('feat: a thing\r\n\r\nSigned-off-by: B\r\nsome words\r\n# a comment\r\n');
});

it("leaves a line of the trailers' paragraph that git does not read as one, though it has a colon", async () => {
  const message = 'feat: a thing\n\nSigned-off-by: B\nSome words: here\nCo-authored-by: A\n';

  expect(await repo.withoutTrailers(message, () => true)).toBe('feat: a thing\n\nSome words: here\n');
});

it('commits what it answers, and the commit reads back without what was removed', async () => {
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\n');
  await repo.stageFiles(['a.txt']);

  await repo.commit(await repo.withoutTrailers('feat: a thing\n\nCo-authored-by: A\nSigned-off-by: B\n', coAuthors));

  expect(await repo.commitMessage('HEAD')).toBe('feat: a thing\n\nSigned-off-by: B');
  expect(await repo.trailersIn(await repo.commitMessage('HEAD'))).toEqual([{ key: 'Signed-off-by', value: 'B' }]);
});
