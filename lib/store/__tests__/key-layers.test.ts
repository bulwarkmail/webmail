import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { deleteKeyDatabase, getAccountRecord, openAccountKey, replaceAccountKey, rewrapAccountKey, type WrapLayer } from '../client/keys';

/** A layer that shows on the bytes: a marker in front. */
function layer(name: string, marker: number): WrapLayer {
  return {
    name,
    wrap: async (data) => Uint8Array.from([marker, ...data]),
    unwrap: async (data) => {
      if (data[0] !== marker) throw new Error('not mine');
      return data.slice(1);
    },
  };
}

const broken: WrapLayer = {
  name: 'safeStorage',
  wrap: async () => { throw new Error('The OS said no'); },
  unwrap: async () => { throw new Error('The OS said no'); },
};

const shell = layer('safeStorage', 7);
const lock = layer('applock', 8);

beforeEach(async () => {
  await deleteKeyDatabase();
});

describe('a record with fewer layers than this app now puts on', () => {
  it('gets them at its next open, keeps its key, and asks for the mail to be re-encrypted', async () => {
    const { keyHex } = await openAccountKey('a');
    const opened = await openAccountKey('a', [shell]);
    expect(opened.keyHex).toBe(keyHex);
    expect(opened.wrapFailed).toBeFalsy();
    const stored = await getAccountRecord('a');
    expect(stored?.layers).toEqual(['safeStorage']);
    expect(stored?.wrapped[0]).toBe(7);
    // The record before this still sits in the browser's own files: that key has to go.
    expect(stored?.rekey).toBe(true);
    expect((await openAccountKey('a', [shell])).keyHex).toBe(keyHex);
  });

  it('a new record has what it needs from the start, and nothing to re-encrypt', async () => {
    await openAccountKey('a', [shell]);
    const stored = await getAccountRecord('a');
    expect(stored?.layers).toEqual(['safeStorage']);
    expect(stored?.rekey).toBeUndefined();
  });

  it("says so when the OS won't take it, and still opens what's there", async () => {
    const { keyHex } = await openAccountKey('a');
    const opened = await openAccountKey('a', [broken]);
    expect(opened.keyHex).toBe(keyHex);
    expect(opened.wrapFailed).toBe(true);
    expect((await getAccountRecord('a'))?.layers).toEqual([]);
  });

  it("won't make a new record without the layer", async () => {
    await expect(openAccountKey('a', [broken])).rejects.toThrow('The OS said no');
    expect(await getAccountRecord('a')).toBeNull();
  });

  it('a layer added under the lock goes in the right order', async () => {
    const { keyHex } = await openAccountKey('a', [lock]);
    const opened = await openAccountKey('a', [shell, lock]);
    expect(opened.keyHex).toBe(keyHex);
    const stored = await getAccountRecord('a');
    expect(stored?.layers).toEqual(['safeStorage', 'applock']);
    expect(stored?.wrapped[0]).toBe(8);
    expect(stored?.wrapped[1]).toBe(7);
  });
});

describe('re-wrapping', () => {
  it('more layers ask for a re-encryption, fewer do not', async () => {
    await openAccountKey('a', [shell]);
    await rewrapAccountKey('a', [shell], [shell, lock]);
    expect((await getAccountRecord('a'))?.rekey).toBe(true);
    await replaceAccountKey('a', 'b'.repeat(64), '/anew.db', [shell, lock]);
    await rewrapAccountKey('a', [shell, lock], [shell]);
    expect((await getAccountRecord('a'))?.rekey).toBeUndefined();
  });

  it('can be told to, for a new lock key: the old one may still sit on disk', async () => {
    await openAccountKey('a', [lock]);
    const lock2 = layer('applock', 9);
    await rewrapAccountKey('a', [lock], [lock2], { rekey: true });
    expect((await getAccountRecord('a'))?.rekey).toBe(true);
  });
});

describe('a new key and file', () => {
  it('replaces the record whole, under the layers asked for', async () => {
    const before = await openAccountKey('a', [shell]);
    await rewrapAccountKey('a', [shell], [shell, lock]);
    const next = 'c'.repeat(64);
    await replaceAccountKey('a', next, '/anew.db', [shell, lock]);
    const stored = await getAccountRecord('a');
    expect(stored?.file).toBe('/anew.db');
    expect(stored?.rekey).toBeUndefined();
    expect(stored?.layers).toEqual(['safeStorage', 'applock']);
    const opened = await openAccountKey('a', [shell, lock]);
    expect(opened.keyHex).toBe(next);
    expect(opened.keyHex).not.toBe(before.keyHex);
    expect(opened.record.file).toBe('/anew.db');
  });
});
