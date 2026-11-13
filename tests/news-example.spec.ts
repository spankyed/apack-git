// The example program a host can start from (`examples/news.mjs`), run as a person runs it over a real repository:
// it says what the repository is, and an edit made while it watches is news of that file. It runs the built
// package, as a host does, so `npm run build` comes first; CI builds before it tests.
import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from './_support/process.ts';
import { removeDirectory } from './_support/remove.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const directories: string[] = [];
const programs: ChildProcess[] = [];
afterEach(async () => {
  for (const program of programs.splice(0)) {
    if (program.exitCode === null && program.signalCode === null) {
      const exited = new Promise(resolve => program.once('exit', resolve));
      program.kill();
      await exited;
    }
  }
  for (const directory of directories.splice(0)) await removeDirectory(directory);
});

it('says what the repository is, and an edit made while it watches is news of that file', async () => {
  expect(fs.existsSync(path.join(ROOT, 'dist', 'index.js')), 'the example runs the built package: npm run build first').toBe(true);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-news-')));
  directories.push(root);
  await run('git', ['-C', root, 'init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');

  const program = spawn(process.execPath, [path.join(ROOT, 'examples', 'news.mjs'), root], { stdio: ['ignore', 'pipe', 'pipe'] });
  programs.push(program);
  let printed = '';
  const waiters: Array<() => void> = [];
  const take = (data: Buffer) => { printed += data.toString(); for (const waiter of waiters.splice(0)) waiter(); };
  program.stdout!.on('data', take);
  program.stderr!.on('data', take);
  const printedLine = (pattern: RegExp) => new Promise<void>((resolve, reject) => {
    const look = () => {
      if (pattern.test(printed)) resolve();
      else if (program.exitCode !== null) reject(new Error(`It ended before printing ${pattern}:\n${printed}`));
      else waiters.push(look);
    };
    program.once('exit', look);
    look();
  });

  await printedLine(/watching; Ctrl-C to stop/);
  expect(printed).toMatch(/on main, no upstream, 1 changed file/);

  fs.appendFileSync(path.join(root, 'a.txt'), 'b\n');
  await printedLine(/news \([^)]*\): [^\n]*diffs[^\n]* — a\.txt/);
});
