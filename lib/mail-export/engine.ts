import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Mailbox } from "@/lib/jmap/types";
import { mboxEntry } from "./mbox-writer";
import { ZipWriter, type ZipEntryStream } from "./zip-writer";
import type { ExportFile, ExportSink } from "./sinks";

/**
 * Exports folders as mbox (mboxrd) or as a ZIP of .eml files, streamed into a
 * sink so the mailbox never sits in memory.
 *
 * - One folder as mbox is a plain .mbox file; anything else is a ZIP: one
 *   `<path>.mbox` per folder, or `<path>/<n> <subject>.eml` per message, with
 *   empty folders kept as directories. A message in several folders is
 *   written once per folder, as IMAP programs do.
 * - Messages come in batches through Blob/get (many per request) where the
 *   server offers it, larger ones and the rest as downloads. At most
 *   maxConcurrentRequests - 2 requests run at once (Stalwart 1.0 counts
 *   downloads against it), and the export keeps itself well under the
 *   server's 1000 requests a minute. A 429 pauses the export alone, never
 *   the rest of the app (downloads don't go through the client-wide limit).
 */

export type ExportFormat = "mbox" | "eml";
export type ExportPhase = "running" | "paused" | "done" | "cancelled" | "failed";

export interface ExportFolder {
  /** The mailbox id in its account (not the store's namespaced id). */
  mailboxId: string;
  /** Path of names from the top, e.g. ["Archive", "2020"]. */
  path: string[];
}

export interface ExportProgress {
  phase: ExportPhase;
  exported: number;
  failed: number;
  failures: { label: string; reason: string }[];
  total: number;
  fraction: number;
  pausedUntil?: number;
  file?: ExportFile;
  error?: string;
}

export interface ExportOptions {
  client: IJMAPClient;
  accountId: string;
  folders: ExportFolder[];
  format: ExportFormat;
  sink: ExportSink;
  signal: AbortSignal;
  onProgress: (progress: ExportProgress) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  reportEveryMs?: number;
  /** Requests per minute the export allows itself (the server's limit is 1000 for everything). */
  requestsPerMinute?: number;
}

interface MessageRef {
  id: string;
  blobId: string;
  size: number;
  keywords: Record<string, boolean>;
  receivedAt?: string;
  subject: string;
}

/** Messages up to this size travel inside Blob/get; bigger ones are downloaded. */
const BATCH_MESSAGE_MAX = 1024 * 1024;
/** Bytes per Blob/get, like the client's BLOB_BATCH_BYTES. */
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_COUNT = 100;
const MAX_FAILURES_LISTED = 20;
const RETRY_DELAYS_MS = [500, 2000, 5000];

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

function cancelled(): DOMException {
  return new DOMException("Export cancelled", "AbortError");
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function decodeBase64(base64: string): Uint8Array {
  const fromBase64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (fromBase64) return fromBase64(base64);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A name that is safe as a file or folder name on every system. */
export function safeName(name: string, fallback: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+|\.+$/g, "");
  const cut = Array.from(clean).slice(0, max).join("").trim();
  return cut || fallback;
}

/**
 * The account's folders as export paths, parents first in the order the app
 * shows them; two folders with the same name next to each other get " (2)".
 */
export function folderTree(mailboxes: Mailbox[]): ExportFolder[] {
  const idOf = (m: Mailbox) => m.originalId || m.id;
  const byParent = new Map<string, Mailbox[]>();
  const ids = new Set(mailboxes.map((m) => m.id));
  for (const m of mailboxes) {
    const parent = m.parentId && ids.has(m.parentId) ? m.parentId : "";
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)!.push(m);
  }
  const ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];
  const rank = (m: Mailbox) => { const i = m.role ? ROLE_ORDER.indexOf(m.role) : -1; return i === -1 ? ROLE_ORDER.length : i; };
  const out: ExportFolder[] = [];
  const visit = (parent: string, path: string[]) => {
    const children = (byParent.get(parent) ?? []).slice().sort((a, b) => rank(a) - rank(b) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
    const used = new Set<string>();
    for (const m of children) {
      const base = safeName(m.name, "Folder");
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      used.add(name.toLowerCase());
      out.push({ mailboxId: idOf(m), path: [...path, name] });
      visit(m.id, [...path, name]);
    }
  };
  visit("", []);
  return out;
}

/** Keeps the export under a number of requests per minute. */
class RateGate {
  private times: number[] = [];
  constructor(private readonly perMinute: number, private readonly now: () => number, private readonly sleep: (ms: number) => Promise<void>) {}
  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.times = this.times.filter((x) => t - x < 60_000);
      if (this.times.length < this.perMinute) { this.times.push(t); return; }
      await this.sleep(60_000 - (t - this.times[0]) + 10);
    }
  }
}

export async function runExport(options: ExportOptions): Promise<ExportProgress> {
  const { client, accountId, signal, sink } = options;
  const now = options.now ?? Date.now;
  const sleep = (ms: number) => (options.sleep ?? defaultSleep)(ms, signal);
  const gate = new RateGate(options.requestsPerMinute ?? 600, now, sleep);
  const lanes = Math.max(1, (client.getMaxConcurrentRequests?.() ?? 4) - 2);
  const progress: ExportProgress = { phase: "running", exported: 0, failed: 0, failures: [], total: 0, fraction: 0 };
  let lastReport = 0;
  const report = (force = false) => {
    const t = now();
    if (!force && t - lastReport < (options.reportEveryMs ?? 150)) return;
    lastReport = t;
    progress.fraction = progress.total > 0 ? Math.min(1, (progress.exported + progress.failed) / progress.total) : 0;
    options.onProgress({ ...progress, failures: [...progress.failures] });
  };
  const fail = (label: string, reason: string) => {
    progress.failed++;
    if (progress.failures.length < MAX_FAILURES_LISTED) progress.failures.push({ label, reason });
  };
  const pause = async (ms: number) => {
    progress.phase = "paused";
    progress.pausedUntil = now() + ms;
    report(true);
    await sleep(ms);
    progress.phase = "running";
    progress.pausedUntil = undefined;
    report(true);
  };

  /** Runs a request, waiting out the server's refusals. */
  const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw cancelled();
      await gate.take();
      try {
        return await run();
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw cancelled();
        const name = (error as { name?: string } | null)?.name;
        if (name === "RateLimitError") {
          await pause(Math.max(1000, (error as { retryAfterMs?: number }).retryAfterMs ?? 60_000));
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        const busy = /maxConcurrentRequests/.test(message);
        if ((busy || /network|Failed to fetch|timed out/i.test(message)) && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw error;
      }
    }
  };

  const download = (ref: MessageRef): Promise<Uint8Array> => withRetry(async () => {
    if (client.fetchBlobForTransfer) return client.fetchBlobForTransfer(ref.blobId, accountId, signal);
    return new Uint8Array(await (await client.fetchBlob(ref.blobId, "message.eml", "message/rfc822", accountId)).arrayBuffer());
  });

  /** The raw messages of one batch, in order; null where a message couldn't be fetched. */
  const fetchBatch = async (batch: MessageRef[]): Promise<(Uint8Array | Error)[]> => {
    const out = new Map<string, Uint8Array>();
    if (batch.length > 1 || (batch.length === 1 && batch[0].size <= BATCH_MESSAGE_MAX)) {
      try {
        const result = client.getBlobsAsBase64
          ? await withRetry(() => client.getBlobsAsBase64!(batch.map((r) => r.blobId), accountId, { sized: true }))
          : null;
        if (result) for (const [blobId, base64] of result.data) out.set(blobId, decodeBase64(base64));
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw cancelled();
        // Fall back to downloads for this batch.
      }
    }
    const results: (Uint8Array | Error)[] = [];
    for (const ref of batch) {
      const got = out.get(ref.blobId);
      if (got) { results.push(got); continue; }
      try {
        results.push(await download(ref));
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw cancelled();
        results.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return results;
  };

  const batchesOf = (refs: MessageRef[]): MessageRef[][] => {
    const batches: MessageRef[][] = [];
    let current: MessageRef[] = [];
    let bytes = 0;
    for (const ref of refs) {
      if (ref.size > BATCH_MESSAGE_MAX) { batches.push([ref]); continue; }
      if (current.length > 0 && (bytes + ref.size > BATCH_BYTES || current.length >= BATCH_COUNT)) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      current.push(ref);
      bytes += ref.size;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  };

  try {
    // Every folder's messages, oldest first, so the totals are known up front.
    const lists: MessageRef[][] = [];
    for (const folder of options.folders) {
      const list = await withRetry(() => client.queryEmailFields(
        { inMailbox: folder.mailboxId },
        ["blobId", "keywords", "receivedAt", "size", "subject"],
        accountId,
        Number.MAX_SAFE_INTEGER,
        { transfer: true },
      ));
      const refs = list
        .filter((e) => typeof e.blobId === "string")
        .map((e) => ({
          id: String(e.id),
          blobId: String(e.blobId),
          size: typeof e.size === "number" ? e.size : 0,
          keywords: (e.keywords as Record<string, boolean> | undefined) ?? {},
          receivedAt: typeof e.receivedAt === "string" ? e.receivedAt : undefined,
          subject: typeof e.subject === "string" ? e.subject : "",
        }))
        .reverse();
      lists.push(refs);
      progress.total += refs.length;
      report();
    }

    const single = options.folders.length === 1 && options.format === "mbox";
    const zip = single ? null : new ZipWriter((chunk) => sink.write(chunk));

    for (let f = 0; f < options.folders.length; f++) {
      const folder = options.folders[f];
      const refs = lists[f];
      const dir = folder.path.join("/");
      let stream: ZipEntryStream | null = null;
      if (zip && options.format === "mbox" && refs.length > 0) stream = await zip.openStream(`${dir}.mbox`);
      if (zip && options.format === "eml" && refs.length === 0 && dir) await zip.addDirectory(dir);
      const write = async (bytes: Uint8Array) => (stream ? stream.write(bytes) : sink.write(bytes));

      const batches = batchesOf(refs);
      let seq = 0;
      // Fetch a few batches ahead, write them in order.
      const pending: Promise<(Uint8Array | Error)[]>[] = [];
      let next = 0;
      const fill = () => {
        while (pending.length < lanes && next < batches.length) {
          const p = fetchBatch(batches[next++]);
          p.catch(() => {});
          pending.push(p);
        }
      };
      fill();
      for (let b = 0; b < batches.length; b++) {
        const results = await pending.shift()!;
        fill();
        for (let i = 0; i < results.length; i++) {
          const ref = batches[b][i];
          const raw = results[i];
          seq++;
          if (raw instanceof Error) {
            fail(ref.subject, raw.message);
            continue;
          }
          if (options.format === "mbox") {
            for (const part of mboxEntry(raw, ref.keywords, ref.receivedAt)) await write(part);
          } else {
            const name = `${String(seq).padStart(5, "0")} ${safeName(ref.subject, "message", 60)}.eml`;
            await zip!.addFile(dir ? `${dir}/${name}` : name, raw, ref.receivedAt ? new Date(ref.receivedAt) : new Date());
          }
          progress.exported++;
          report();
        }
        if (signal.aborted) throw cancelled();
      }
      if (stream) await stream.close();
    }
    if (zip) await zip.finish();
    progress.file = await sink.close();
    progress.phase = "done";
    progress.fraction = 1;
  } catch (error) {
    await sink.abort().catch(() => {});
    progress.pausedUntil = undefined;
    if (isAbort(error) || signal.aborted) {
      progress.phase = "cancelled";
    } else {
      progress.phase = "failed";
      progress.error = error instanceof Error ? error.message : String(error);
    }
  }
  report(true);
  return progress;
}
