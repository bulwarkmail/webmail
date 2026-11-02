/**
 * The PST worker (built by scripts/build-pst-worker.mjs into public/). It
 * opens an Outlook .pst/.ost File without loading it whole, walks its mail
 * folders and hands over one message at a time as MIME, only as many as the
 * page asked for, so a large file never piles up in memory.
 *
 *   page → worker  { type: "open", file, skipBefore, skipAlso, maxMessageBytes }
 *                  { type: "pull", count }
 *   worker → page  { type: "opened", total }
 *                  { type: "item", item, fraction }   (item.mime is transferred)
 *                  { type: "done" } | { type: "error", code, message }
 */

import { PSTFile } from "pst-extractor";
import { Buffer } from "buffer";
import { registerPstFile } from "./shims/fs";
import { walkPst, type PstItem } from "./items";

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
// Attachment bytes are read into a Buffer over our own memory (extract.ts).
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
let items: Generator<PstItem> | null = null;
let total = 0;
let done = 0;
let pst: { close(): void } | null = null;

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/encrypt/i.test(message)) return "encrypted";
  if (/not a pst|invalid|unrecognised|unrecognized|magic|!BDN/i.test(message)) return "not_pst";
  return "unreadable";
}

scope.onmessage = (event: MessageEvent) => {
  const data = event.data as { type: string; file?: File; skipBefore?: number; skipAlso?: number[]; maxMessageBytes?: number; count?: number };
  try {
    if (data.type === "open" && data.file) {
      registerPstFile("import.pst", data.file);
      pst = new PSTFile("import.pst") as unknown as { close(): void };
      const walk = walkPst(pst, { skipBefore: data.skipBefore ?? 0, skipAlso: new Set(data.skipAlso ?? []), maxMessageBytes: data.maxMessageBytes ?? Number.POSITIVE_INFINITY });
      items = walk.items;
      total = walk.total;
      scope.postMessage({ type: "opened", total });
      return;
    }
    if (data.type === "pull" && items) {
      for (let n = 0; n < (data.count ?? 1); n++) {
        const next = items.next();
        if (next.done) {
          items = null;
          pst?.close();
          scope.postMessage({ type: "done" });
          return;
        }
        done++;
        const item = next.value;
        const fraction = total > 0 ? Math.min(1, done / total) : 0;
        if (item.kind === "message") {
          const buffer = item.mime.buffer.byteLength === item.mime.byteLength ? item.mime.buffer : item.mime.slice().buffer;
          scope.postMessage({ type: "item", item: { ...item, mime: buffer }, fraction }, [buffer as ArrayBuffer]);
        } else {
          scope.postMessage({ type: "item", item, fraction });
        }
      }
      return;
    }
    if (data.type === "close") {
      items = null;
      pst?.close();
      pst = null;
    }
  } catch (error) {
    scope.postMessage({ type: "error", code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
  }
};
