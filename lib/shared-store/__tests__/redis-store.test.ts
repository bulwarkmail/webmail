import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { describe, it } from 'vitest';
import { createRedisStore } from '../redis';
import type { SharedStore } from '../types';
import { runStoreContract } from './contract';

/**
 * The contract against a real Redis-protocol server. Runs only when
 * IT_SHARED_STORE_URL is set (e.g. a Valkey on the test VM through an SSH
 * tunnel), so the unit run in CI stays offline. Keys get a random prefix and
 * are removed afterwards.
 */
const url = process.env.IT_SHARED_STORE_URL;

if (!url) {
  describe('shared store contract: redis', () => {
    it.skip('needs IT_SHARED_STORE_URL', () => {});
  });
} else {
  const prefix = `bulwark-test:${randomBytes(4).toString('hex')}:`;
  const opened: SharedStore[] = [];
  runStoreContract({
    name: `redis (${prefix})`,
    makeStores: (n) => {
      const stores = Array.from({ length: n }, () => createRedisStore({ url, keyPrefix: prefix }));
      opened.push(...stores);
      return stores;
    },
    cleanup: async () => {
      await Promise.all(opened.map((s) => s.close()));
      const admin = new Redis(url);
      let cursor = '0';
      do {
        const [next, keys] = await admin.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) await admin.del(...keys);
      } while (cursor !== '0');
      admin.disconnect();
    },
  });
}
