import { dateFromHeaderBlock } from "@/lib/eml-import";
import { MboxSplitter, envelopeDate, readHeaderBlock, type MboxMessage } from "./mbox";
import { mboxState, withoutStateHeaders } from "./mbox-status";
import { EXPORT_ENVELOPE_SENDER } from "@/lib/mail-export/mbox-writer";
import { listZipEntries, readZipEntry, streamZipEntry } from "./zip-reader";

/**
 * What the import reads from each file: messages with their folder, state and
 * date, in a stable order (the index the checkpoint counts), read piece by
 * piece so a large file never has to fit in memory.
 */

export type ImportFormat = "eml" | "zip" | "mbox" | "pst";

export type SkipReason =
  /** Larger than the server takes (maxSizeUpload). */
  | "too_large"
  /** Deleted in Thunderbird, still in the file until the folder is compacted. */
  | "deleted"
  /** PST contacts and distribution lists. */
  | "contact"
  /** PST appointments, meeting requests and tasks. */
  | "calendar"
  /** Other PST items (notes, journal entries) and files in a ZIP that aren't mail. */
  | "other"
  /** Messages attached to a PST message, which pst-extractor can't read. */
  | "embedded"
  /** PST items after a broken one in the same folder, which pst-extractor can't reach. */
  | "unreadable"
  /** Imported by an earlier run of the same import. */
  | "resumed";

export interface ImportMessage {
  kind: "message";
  index: number;
  /** Folder path inside the file; [] is the top. */
  folder: string[];
  data: Blob;
  size: number;
  keywords: Record<string, true>;
  receivedAt?: string;
  /** Names the message in the summary when it fails: its subject or entry name. */
  label: string;
  /** Messages attached to this one that couldn't be read. */
  embeddedSkipped?: number;
  /** The special folder (inbox, sent, drafts, trash, junk) the top folder of `folder` is, when the file says so. */
  folderRole?: string;
}

export interface ImportSkip {
  kind: "skipped";
  index: number;
  reason: SkipReason;
  label?: string;
}

export type ImportItem = ImportMessage | ImportSkip;

export interface SourceOptions {
  /** Messages larger than this are skipped as too_large without reading them in. */
  maxMessageBytes: number;
  /** Items before this index were handled by an earlier run: report them as `resumed`. */
  skipBefore: number;
  /** Items after `skipBefore` an earlier run handled too (it stopped with gaps). */
  skipAlso?: Set<number>;
  /** Called as the file is read: the part done, 0 to 1. */
  onProgress?: (fraction: number) => void;
  /** Called once the number of messages in the file is known. */
  onTotal?: (count: number) => void;
  signal?: AbortSignal;
}

export type ItemSource = AsyncGenerator<ImportItem, void, undefined>;

/** Whether an earlier run of the same import handled item `index`. */
export function isResumed(options: Pick<SourceOptions, "skipBefore" | "skipAlso">, index: number): boolean {
  return index < options.skipBefore || !!options.skipAlso?.has(index);
}

const READ_CHUNK = 1 << 20;
const MIME = "message/rfc822";

const PST_MAGIC = [0x21, 0x42, 0x44, 0x4e]; // "!BDN"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];

function startsWith(head: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => head[i] === b);
}

/** The format of a file, from its first bytes; the name only breaks ties. */
export async function sniffFormat(file: Blob & { name?: string }): Promise<ImportFormat> {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  if (startsWith(head, PST_MAGIC)) return "pst";
  if (startsWith(head, ZIP_MAGIC) || startsWith(head, ZIP_EMPTY)) return "zip";
  // mbox opens with an envelope line, maybe after a byte order mark or empty lines.
  let at = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (head[at] === 0x0d || head[at] === 0x0a) at++;
  const first = String.fromCharCode(...head.subarray(at, at + 5));
  if (first === "From ") return "mbox";
  if (/\.(mbox|mbx)$/i.test(file.name ?? "")) return "mbox";
  return "eml";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
}

function emlLabel(name: string): string {
  return name.split(/[\\/]/).pop() || name;
}

const encodedWord = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;

/** The Subject of a header block, for the summary; encoded words decoded when possible. */
export function subjectOf(headerBlock: string): string {
  const m = /^subject:[ \t]*(.*(?:\r?\n[ \t].*)*)/im.exec(headerBlock);
  if (!m) return "";
  const raw = m[1].replace(/\r?\n[ \t]+/g, " ").trim();
  return raw.replace(/\?=\s+=\?/g, "?==?").replace(encodedWord, (all, charset: string, enc: string, text: string) => {
    try {
      const bytes = enc.toLowerCase() === "b"
        ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
        : Uint8Array.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))), (c) => c.charCodeAt(0));
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return all;
    }
  }).slice(0, 200);
}

export async function* emlSource(file: File, options: SourceOptions): ItemSource {
  options.onTotal?.(1);
  if (isResumed(options, 0)) {
    yield { kind: "skipped", index: 0, reason: "resumed" };
    options.onProgress?.(1);
    return;
  }
  if (file.size > options.maxMessageBytes) {
    yield { kind: "skipped", index: 0, reason: "too_large", label: file.name };
    options.onProgress?.(1);
    return;
  }
  const head = new TextDecoder("latin1").decode(await file.slice(0, 64 * 1024).arrayBuffer());
  yield {
    kind: "message",
    index: 0,
    folder: [],
    data: file.slice(0, file.size, MIME),
    size: file.size,
    // Thunderbird writes X-Mozilla-Status into the .eml files it saves; none means read, as before.
    keywords: mboxState(head.split(/\r?\n\r?\n/, 1)[0]).keywords,
    receivedAt: dateFromHeaderBlock(head),
    label: emlLabel(file.name),
  };
  options.onProgress?.(1);
}

/** A date between 1980 and a day from now, else undefined. */
function plausible(date: string | undefined, now = Date.now()): string | undefined {
  if (!date) return undefined;
  const t = Date.parse(date);
  return t >= Date.UTC(1980, 0, 1) && t - now <= 24 * 60 * 60 * 1000 ? date : undefined;
}

/**
 * When an mbox message arrived. The envelope line is trusted only where it
 * is the arrival time for sure: Bulwark's own export (receivedAt) and lines
 * with a time zone (Google Takeout). Elsewhere it may be when the message
 * was copied into the folder (Thunderbird's `From - <date>`, local time),
 * so the Date header comes first and the envelope line is the fallback.
 */
export function arrivalTime(fromLine: string, headers: string): string | undefined {
  const envelope = plausible(envelopeDate(fromLine));
  const trusted = fromLine.startsWith(`From ${EXPORT_ENVELOPE_SENDER} `) || /\s[+-]\d{4}\s+\d{4}\s*$/.test(fromLine);
  return trusted ? envelope ?? dateFromHeaderBlock(headers) : dateFromHeaderBlock(headers) ?? envelope;
}

function mboxItem(message: MboxMessage, index: number, folder: string[]): ImportItem {
  const label = message.tooLarge ? message.fromLine : "";
  if (message.tooLarge) return { kind: "skipped", index, reason: "too_large", label };
  const headers = readHeaderBlock(message.parts);
  const state = mboxState(headers);
  const subject = subjectOf(headers);
  if (state.expunged) return { kind: "skipped", index, reason: "deleted", label: subject };
  const parts = withoutStateHeaders(message.parts);
  return {
    kind: "message",
    index,
    folder,
    data: new Blob(parts as BlobPart[], { type: MIME }),
    size: parts.reduce((n, p) => n + p.length, 0),
    keywords: state.keywords,
    receivedAt: arrivalTime(message.fromLine, headers),
    label: subject,
  };
}

/** Splits chunks into messages; `startIndex` continues the numbering inside a ZIP. */
async function* mboxFromChunks(
  chunks: AsyncIterable<Uint8Array>,
  folder: string[],
  options: SourceOptions,
  startIndex: number,
  onIndex: (next: number) => void,
  /** Called with each message's offset in the stream, for a progress that moves message by message. */
  onOffset?: (offset: number) => void,
): ItemSource {
  const splitter = new MboxSplitter({ maxMessageBytes: options.maxMessageBytes });
  let index = startIndex;
  const emit = function* (messages: MboxMessage[]): Generator<ImportItem> {
    for (const m of messages) {
      onOffset?.(m.offset);
      const i = index++;
      yield isResumed(options, i) ? { kind: "skipped", index: i, reason: "resumed" } : mboxItem(m, i, folder);
    }
  };
  for await (const chunk of chunks) {
    throwIfAborted(options.signal);
    yield* emit(splitter.push(chunk));
  }
  yield* emit(splitter.end());
  onIndex(index);
}

async function* fileChunks(file: Blob, onProgress?: (fraction: number) => void): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < file.size; at += READ_CHUNK) {
    const end = Math.min(file.size, at + READ_CHUNK);
    yield new Uint8Array(await file.slice(at, end).arrayBuffer());
    onProgress?.(end / Math.max(1, file.size));
  }
}

export async function* mboxSource(file: File, options: SourceOptions): ItemSource {
  // Reads run ahead in 1 MB pieces; the messages handed over say how far the import really is.
  yield* mboxFromChunks(fileChunks(file), [], options, 0, () => {}, (offset) => options.onProgress?.(offset / Math.max(1, file.size)));
  options.onProgress?.(1);
}

/** `Archive/2020.mbox` → ["Archive", "2020"]; `Inbox/a.eml` → ["Inbox"]. */
function zipFolder(name: string, isMbox: boolean): string[] {
  const parts = name.split("/").filter((p) => p && p !== "." && p !== "..");
  if (isMbox) {
    const last = parts.pop() ?? "";
    const folder = last.replace(/\.(mbox|mbx)$/i, "");
    return folder ? [...parts, folder] : parts;
  }
  parts.pop();
  return parts;
}

export async function* zipSource(file: File, options: SourceOptions): ItemSource {
  const entries = (await listZipEntries(file)).filter((e) => !e.directory && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.name));
  const isMbox = (name: string) => /\.(mbox|mbx)$/i.test(name);
  const isEml = (name: string) => /\.eml$/i.test(name);
  if (!entries.some((e) => isMbox(e.name))) options.onTotal?.(entries.filter((e) => isEml(e.name)).length);
  const totalBytes = entries.reduce((n, e) => n + e.compressedSize, 0) || 1;
  let doneBytes = 0;
  let index = 0;
  for (const entry of entries) {
    throwIfAborted(options.signal);
    if (entry.encrypted) {
      const i = index++;
      yield isResumed(options, i) ? { kind: "skipped", index: i, reason: "resumed" } : { kind: "skipped", index: i, reason: "other", label: emlLabel(entry.name) };
    } else if (isMbox(entry.name)) {
      const before = doneBytes;
      const chunks = (async function* () {
        let seen = 0;
        for await (const chunk of streamZipEntry(file, entry)) {
          seen += chunk.length;
          options.onProgress?.((before + entry.compressedSize * Math.min(1, seen / Math.max(1, entry.size))) / totalBytes);
          yield chunk;
        }
      })();
      yield* mboxFromChunks(chunks, zipFolder(entry.name, true), options, index, (next) => { index = next; });
    } else if (isEml(entry.name)) {
      const i = index++;
      if (isResumed(options, i)) {
        yield { kind: "skipped", index: i, reason: "resumed" };
      } else if (entry.size > options.maxMessageBytes) {
        yield { kind: "skipped", index: i, reason: "too_large", label: emlLabel(entry.name) };
      } else {
        let bytes: Uint8Array;
        try {
          bytes = await readZipEntry(file, entry);
        } catch {
          // Encrypted, or damaged: left out and named in the summary.
          yield { kind: "skipped", index: i, reason: "other", label: emlLabel(entry.name) };
          continue;
        }
        const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64 * 1024));
        yield {
          kind: "message",
          index: i,
          folder: zipFolder(entry.name, false),
          data: new Blob([bytes as BlobPart], { type: MIME }),
          size: bytes.length,
          keywords: mboxState(head.split(/\r?\n\r?\n/, 1)[0]).keywords,
          receivedAt: dateFromHeaderBlock(head),
          label: emlLabel(entry.name),
        };
      }
    } else {
      const i = index++;
      yield isResumed(options, i) ? { kind: "skipped", index: i, reason: "resumed" } : { kind: "skipped", index: i, reason: "other", label: emlLabel(entry.name) };
    }
    doneBytes += entry.compressedSize;
    options.onProgress?.(doneBytes / totalBytes);
  }
}

/** Whether the file has folders of its own, so the dialog offers to recreate them. */
export async function hasFolders(file: File, format: ImportFormat): Promise<boolean> {
  if (format === "pst") return true;
  if (format !== "zip") return false;
  try {
    return (await listZipEntries(file)).some((e) => e.name.includes("/") || /\.(mbox|mbx)$/i.test(e.name));
  } catch {
    return false;
  }
}
