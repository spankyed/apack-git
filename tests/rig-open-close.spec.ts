// A tree's watch closed while its directories are being deleted, in each order the two can happen in. A
// watcher that takes this badly takes the host's process with it, or leaves watches open that nothing closes.
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanUp, platformWatch } from './_support/rig.ts';

afterEach(cleanUp);

function tree(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-rig-close-')));
  for (const directory of ['a/b/c', 'a/d', 'e/f/g/h', 'i']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, 'file.txt'), '');
  }
  return root;
}
const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 80, retryDelay: 100 });

const ORDERS: Record<string, (root: string, subscribe: ReturnType<typeof platformWatch>['subscribe']) => Promise<void>> = {
  'deleted, then closed': async (root, subscribe) => {
    const subscription = await subscribe(root, () => {}, { ignore: [] });
    remove(root);
    await subscription.unsubscribe();
  },
  'closed, then deleted': async (root, subscribe) => {
    const subscription = await subscribe(root, () => {}, { ignore: [] });
    await subscription.unsubscribe();
    remove(root);
  },
  'deleted while closing': async (root, subscribe) => {
    const subscription = await subscribe(root, () => {}, { ignore: [] });
    const closing = subscription.unsubscribe();
    remove(root);
    await closing;
  },
  'a directory inside deleted, then closed, then the rest deleted': async (root, subscribe) => {
    const subscription = await subscribe(root, () => {}, { ignore: [] });
    remove(path.join(root, 'e'));
    await subscription.unsubscribe();
    remove(root);
  },
  'deleted while being opened': async (root, subscribe) => {
    const opening = subscribe(root, () => {}, { ignore: [] }).then(subscription => subscription.unsubscribe(), () => {});
    remove(root);
    await opening;
  },
  'checked while being deleted, then closed': async (root, subscribe) => {
    const subscription = await subscribe(root, () => {}, { ignore: [] });
    const checking = subscription.check?.({ ignore: [] });
    remove(path.join(root, 'a'));
    await checking;
    remove(root);
    await subscription.unsubscribe();
  },
};

it.each(Object.keys(ORDERS))('survives its tree %s, and leaves no watch open', async (order) => {
  const platform = platformWatch();
  for (let round = 0; round < 40; round++) {
    const root = tree();
    try {
      await ORDERS[order]!(root, platform.subscribe);
    } finally {
      remove(root);
    }
    expect(platform.watched(), `round ${round}`).toEqual([]);
  }
});
