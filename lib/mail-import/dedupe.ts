import { done, hasIdb, openDb, seenInMemory, SEEN_STORE } from "./checkpoints";
import type { ImportMessage } from "./sources";

/**
 * Remembers what an import put on the server, per folder, so a second run skips it.
 * Email/import doesn't skip duplicates and a checkpoint counts positions in one file as
 * it was: a running Thunderbird compacts a folder or adds to it, the file gets a new size
 * and date, the checkpoint no longer applies, and the file starts over. The same message
 * into another folder is not a duplicate: Thunderbird can have a copy in both.
 *
 * Only hashes are kept. A message is known by its Message-ID and size. Without a
 * Message-ID it is known by its bytes.
 */

export interface ImportDedupe {
  keyFor(item: Pick<ImportMessage, "data" | "size">, mailboxId: string): Promise<string>;
  has(key: string): Promise<boolean>;
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
  return {
    async keyFor(item, mailboxId) {
      const head = new TextDecoder("latin1").decode(await item.data.slice(0, HEADER_BYTES).arrayBuffer());
      const id = messageIdOf(head);
      const hash = id
        ? await sha256(new TextEncoder().encode(`id:${id}:${item.size}`))
        : await sha256(await item.data.arrayBuffer());
      return [scope, accountId, mailboxId, hash].join("\u0000");
    },
    async has(key) {
      if (seenInMemory.has(key)) return true;
      if (!hasIdb()) return false;
      try {
        const db = await openDb();
        return (await done(db.transaction(SEEN_STORE, "readonly").objectStore(SEEN_STORE).getKey(key))) !== undefined;
      } catch {
        return false;
      }
    },
    async add(keys) {
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
    },
  };
}
