import { withBasePath } from "@/lib/browser-navigation";
import { LITE_BUILD_ID } from "@/lib/lite";
import type { PstItem } from "./pst/items";
import type { ImportItem, ItemSource, SourceOptions } from "./sources";

/**
 * Reads an Outlook .pst/.ost file through the PST worker (public/pst-worker.js,
 * built by scripts/build-pst-worker.mjs), which is only fetched now. pst-extractor
 * is synchronous, so it can't run on the page; the worker reads the file in
 * pieces and hands over a few messages at a time as the import asks for them.
 */

/** Errors carry a code the dialog explains: encrypted, not_pst, unreadable, worker. */
export class PstReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(`pst:${code}: ${message}`);
    this.name = "PstReadError";
  }
}

/**
 * The worker's URL. Its name has no hash, so the build goes in the query:
 * Stalwart serves Lite's files as immutable, and an old worker must not
 * meet a new page.
 */
export function pstWorkerUrl(): string {
  const build = LITE_BUILD_ID || `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0"}-${process.env.NEXT_PUBLIC_GIT_COMMIT ?? "dev"}`;
  return withBasePath(`/pst-worker.js?v=${encodeURIComponent(build)}`);
}

/** A PstItem as posted: the MIME bytes arrive as a transferred ArrayBuffer. */
type WireItem =
  | (Omit<Extract<PstItem, { kind: "message" }>, "mime"> & { mime: ArrayBuffer })
  | Extract<PstItem, { kind: "skipped" }>;

type WorkerMessage =
  | { type: "opened"; total: number }
  | { type: "item"; item: WireItem; fraction: number }
  | { type: "done" }
  | { type: "error"; code: string; message: string }
  | { type: "abort" };

/** Messages asked for ahead of the import, so the worker keeps busy without filling memory. */
const AHEAD = 4;

/** How long the worker may stay silent while a message is awaited before the import gives up (it may have run out of memory). */
const WATCHDOG_MS = 120_000;

export async function* openPstSource(file: File, options: SourceOptions, tuning: { watchdogMs?: number } = {}): ItemSource {
  const worker = new Worker(pstWorkerUrl());
  const queue: WorkerMessage[] = [];
  let wake: (() => void) | null = null;
  const push = (message: WorkerMessage) => {
    queue.push(message);
    wake?.();
  };
  worker.onmessage = (event: MessageEvent) => push(event.data as WorkerMessage);
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault?.();
    push({ type: "error", code: "worker", message: event.message || "The PST reader didn't start" });
  };
  const onAbort = () => push({ type: "abort" });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  // A worker killed for memory sends no error: don't wait for it forever.
  const next = async (): Promise<WorkerMessage> => {
    while (queue.length === 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(() => push({ type: "error", code: "unreadable", message: "The PST reader stopped answering" }), tuning.watchdogMs ?? WATCHDOG_MS);
      });
      clearTimeout(timer);
    }
    wake = null;
    return queue.shift()!;
  };

  try {
    worker.postMessage({ type: "open", file, skipBefore: options.skipBefore, skipAlso: [...(options.skipAlso ?? [])], maxMessageBytes: options.maxMessageBytes });
    const opened = await next();
    if (opened.type === "abort") throw new DOMException("Import cancelled", "AbortError");
    if (opened.type === "error") throw new PstReadError(opened.code, opened.message);
    if (opened.type !== "opened") throw new PstReadError("unreadable", "unexpected reply");
    options.onTotal?.(opened.total);

    let asked = AHEAD;
    worker.postMessage({ type: "pull", count: AHEAD });
    for (;;) {
      const message = await next();
      if (message.type === "abort") throw new DOMException("Import cancelled", "AbortError");
      if (message.type === "error") throw new PstReadError(message.code, message.message);
      if (message.type === "done") break;
      if (message.type !== "item") continue;
      asked--;
      if (asked < AHEAD / 2) {
        worker.postMessage({ type: "pull", count: AHEAD });
        asked += AHEAD;
      }
      options.onProgress?.(message.fraction);
      const item = message.item;
      let out: ImportItem;
      if (item.kind === "message") {
        const mime = item.mime;
        out = {
          kind: "message",
          index: item.index,
          folder: item.folder,
          data: new Blob([mime], { type: "message/rfc822" }),
          size: mime.byteLength,
          keywords: item.keywords,
          receivedAt: item.receivedAt,
          label: item.label,
          embeddedSkipped: item.embeddedSkipped,
          folderRole: item.folderRole,
        };
      } else {
        out = item;
      }
      yield out;
    }
    options.onProgress?.(1);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}
