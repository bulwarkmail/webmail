import { done, hasIdb, openDb, seenInMemory, SEEN_STORE } from "./checkpoints";
import { withoutStateHeaders } from "./mbox-status";
import type { ImportMessage } from "./sources";

/**
 * Remembers what an import put on the server, per folder, so a second run skips it.
 * Email/import doesn't skip duplicates and a checkpoint counts positions in one file as
 * it was: a running Thunderbird compacts a folder or adds to it, the file gets a new size
 * and date, the checkpoint no longer applies, and the file starts over. The same message
 * into another folder is not a duplicate: Thunderbird can have a copy in both.
 *
 * Only hashes are kept. A message is known by its bytes without the state headers, which
 * are all compacting changes. Going by its Message-ID would drop a real message: mailers
 * reuse one, say a reminder sent again with the same length and another Date.
 */

export interface ImportDedupe {
  /** The key to remember this message by, and whether an earlier import already did. */
  check(item: Pick<ImportMessage, "data" | "size">, mailboxId: string): Promise<{ key: string; seen: boolean }>;
  add(keys: string[]): Promise<void>;
}

const HEADER_BYTES = 64 * 1024;

/** The Message-ID of a message's header block, without the brackets, or null. */
export function messageIdOf(headerBlock: string): string | null {
  const headers = headerBlock.split(/\r?\n\r?\n/, 1)[0];
  const match = /^message-id:[ \t]*(?:\r?\n[ \t]+)?<([^>\r\n]+)>/im.exec(headers);
  return match ? match[1].trim() : null;
}

async function sha256(data: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function localDedupe(scope: string, accountId: string): ImportDedupe {
  const keyOf = (mailboxId: string, hash: string) => [scope, accountId, mailboxId, hash].join("\u0000");

  const has = async (key: string): Promise<boolean> => {
    if (seenInMemory.has(key)) return true;
    if (!hasIdb()) return false;
    try {
      const db = await openDb();
      return (await done(db.transaction(SEEN_STORE, "readonly").objectStore(SEEN_STORE).getKey(key))) !== undefined;
    } catch {
      return false;
    }
  };

  const add = async (keys: string[]): Promise<void> => {
    if (!hasIdb()) {
      for (const key of keys) seenInMemory.set(key, scope);
      return;
    }
    try {
      const db = await openDb();
      const store = db.transaction(SEEN_STORE, "readwrite").objectStore(SEEN_STORE);
      await Promise.all(keys.map((key) => done(store.put({ key, scope }))));
    } catch {
      for (const key of keys) seenInMemory.set(key, scope);
    }
  };

  /**
   * What a record from before this format is under, so nothing already imported goes in
   * again. It can't be turned into the new form: the bytes aren't stored. A hit moves the
   * message to the new key, so a real message is only at risk from a record that old.
   */
  const legacyKey = async (bytes: ArrayBuffer, size: number, mailboxId: string): Promise<string> => {
    const id = messageIdOf(new TextDecoder("latin1").decode(bytes.slice(0, HEADER_BYTES)));
    return keyOf(mailboxId, id ? await sha256(new TextEncoder().encode(`id:${id}:${size}`)) : await sha256(bytes));
  };

  return {
    async check(item, mailboxId) {
      const bytes = await item.data.arrayBuffer();
      const stripped = await new Blob(withoutStateHeaders([new Uint8Array(bytes)]) as BlobPart[]).arrayBuffer();
      const key = keyOf(mailboxId, `v2:${await sha256(stripped)}`);
      if (await has(key)) return { key, seen: true };
      if (await has(await legacyKey(bytes, item.size, mailboxId))) {
        await add([key]);
        return { key, seen: true };
      }
      return { key, seen: false };
    },
    add,
  };
}
