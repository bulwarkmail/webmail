/**
 * A streaming mbox splitter that works on bytes, never on decoded text.
 *
 * Messages are separated by a line starting with `From ` that follows an
 * empty line (or opens the file). That one rule reads mboxo, mboxrd, mboxcl
 * and mboxcl2 files:
 *
 * - `>From ` lines lose one `>` (the mboxrd rule; on an mboxo file this also
 *   unquotes a line that was `>From ` originally, which is rare and harmless).
 * - A `Content-Length` header (mboxcl, mboxcl2) is used only when the message
 *   it measures ends exactly where another message starts. Until then, `From `
 *   lines inside the body are held as possible separators; if the length turns
 *   out wrong, they split the message after all (Dovecot does the same).
 * - CRLF files work: an empty line is LF or CRLF, line endings are kept.
 *
 * Bytes are passed through untouched (8-bit bodies, signatures): only the
 * envelope line and one `>` of quoted lines are removed, and the empty line
 * in front of each separator, which belongs to the mbox format.
 */

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

export interface MboxMessage {
  /** The message bytes, in order. Pass them to `new Blob(parts)`. */
  parts: Uint8Array[];
  /** Total bytes in `parts`. */
  size: number;
  /** The envelope line without its line ending, decoded as Latin-1. */
  fromLine: string;
  /** Byte offset of the envelope line in the file. */
  offset: number;
  /** Larger than `maxMessageBytes`: `parts` is empty, the message was skipped. */
  tooLarge: boolean;
}

export interface MboxSplitterOptions {
  /** Stop keeping the bytes of a message past this size (it is reported `tooLarge`). */
  maxMessageBytes?: number;
}

interface Segment {
  bytes: Uint8Array;
  /** This segment is the empty line in front of a held separator. */
  heldEmpty?: boolean;
  /** This segment is a held separator line (its text in `fromLine`). */
  heldFrom?: { line: string; offset: number };
}

function startsWithFrom(line: Uint8Array, at: number): boolean {
  if (line.length - at < FROM.length) return false;
  for (let i = 0; i < FROM.length; i++) if (line[at + i] !== FROM[i]) return false;
  return true;
}

function isEmptyLine(line: Uint8Array): boolean {
  return line.length === 1 ? line[0] === LF : line.length === 2 && line[0] === CR && line[1] === LF;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 8192)));
  }
  return out;
}

function stripEol(line: Uint8Array): Uint8Array {
  let end = line.length;
  if (end > 0 && line[end - 1] === LF) end--;
  if (end > 0 && line[end - 1] === CR) end--;
  return line.subarray(0, end);
}

/**
 * Whether a `From ` line looks like an envelope line ("From sender date"),
 * which carries a time. Guards against a body line "From now on..." after an
 * empty line in a file whose writer didn't quote it.
 */
export function isEnvelopeLine(text: string): boolean {
  // Sender, then a date that ends in the year: "... Tue May  5 10:11:12 2020",
  // optionally with a zone before the year or "remote from host" after it.
  return /^From \S+\s.*\b\d{1,2}:\d{2}(?::\d{2})?\s+(?:[+-]\d{4}\s+|[A-Z]{2,5}\s+)?\d{4}(?:\s+remote from \S+)?\s*$/.test(text);
}

const CONTENT_LENGTH = /^content-length:[ \t]*(\d+)[ \t]*\r?$/im;

export class MboxSplitter {
  private readonly maxBytes: number;
  /** Bytes of the line not finished yet (the chunk ended inside it). */
  private carry: Uint8Array[] = [];
  private carryOffset = 0;
  /** Offset of the next byte pushed. */
  private offset = 0;

  private current: {
    fromLine: string;
    offset: number;
    segments: Segment[];
    size: number;
    tooLarge: boolean;
    /** Header block finished (first empty line seen). */
    inBody: boolean;
    headerBytes: Uint8Array[];
    /** End offset Content-Length says the body has, while it is unconfirmed. */
    expectedEnd?: number;
    holding: boolean;
  } | null = null;
  /** An empty line held back: it is dropped if a separator follows it. */
  private pendingEmpty: { bytes: Uint8Array; offset: number } | null = null;
  private out: MboxMessage[] = [];

  constructor(options: MboxSplitterOptions = {}) {
    this.maxBytes = options.maxMessageBytes ?? Number.POSITIVE_INFINITY;
  }

  /** Feed the next chunk of the file. Returns the messages it completed. */
  push(chunk: Uint8Array): MboxMessage[] {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== LF) continue;
      const piece = chunk.subarray(start, i + 1);
      if (this.carry.length > 0) {
        this.carry.push(piece);
        const line = concat(this.carry);
        this.carry = [];
        this.line(line, this.carryOffset);
      } else {
        this.line(piece, this.offset + start);
      }
      start = i + 1;
    }
    if (start < chunk.length) {
      if (this.carry.length === 0) this.carryOffset = this.offset + start;
      this.carry.push(chunk.subarray(start));
    }
    this.offset += chunk.length;
    return this.take();
  }

  /** The file ended. Returns the last messages. */
  end(): MboxMessage[] {
    if (this.carry.length > 0) {
      const line = concat(this.carry);
      this.carry = [];
      this.line(line, this.carryOffset);
    }
    if (this.current?.expectedEnd !== undefined) {
      this.settleLength(this.offset === this.current.expectedEnd || this.pendingEmptyEndsAt(this.current.expectedEnd));
    }
    // The empty line closing the last message belongs to the format.
    this.pendingEmpty = null;
    this.finish();
    return this.take();
  }

  private take(): MboxMessage[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  private pendingEmptyEndsAt(offset: number): boolean {
    return !!this.pendingEmpty && this.pendingEmpty.offset === offset;
  }

  private line(line: Uint8Array, offset: number): void {
    const cur = this.current;
    // Content-Length said the body ends here: is there a separator?
    if (cur?.expectedEnd !== undefined && offset >= cur.expectedEnd) {
      const atEnd = offset === cur.expectedEnd;
      const afterEmpty = this.pendingEmptyEndsAt(cur.expectedEnd);
      if (atEnd && isEmptyLine(line)) {
        // An empty line right at the end: decide on the line after it.
      } else {
        const confirmed = (atEnd || afterEmpty) && startsWithFrom(line, 0) && isEnvelopeLine(latin1(stripEol(line)));
        this.settleLength(confirmed);
      }
    }

    const empty = isEmptyLine(line);
    if (startsWithFrom(line, 0) && (this.current === null || this.pendingEmpty !== null)) {
      const text = latin1(stripEol(line));
      if (this.current === null || isEnvelopeLine(text)) {
        if (this.current?.holding) {
          // Inside the length Content-Length claims: keep it as a possible separator.
          this.flushPendingEmpty(true);
          this.addSegment({ bytes: line, heldFrom: { line: text, offset } });
          return;
        }
        this.pendingEmpty = null;
        this.finish();
        this.start(text, offset);
        return;
      }
    }

    if (this.current === null) return; // Bytes before the first envelope line.

    if (empty) {
      this.flushPendingEmpty(false);
      this.pendingEmpty = { bytes: line, offset };
      if (!this.current.inBody) this.endHeaders(offset + line.length);
      return;
    }
    this.flushPendingEmpty(false);
    // mboxrd: one ">" less on ">From ", ">>From ", ...
    let at = 0;
    while (at < line.length && line[at] === GT) at++;
    const bytes = at > 0 && startsWithFrom(line, at) ? line.subarray(1) : line;
    if (!this.current.inBody) this.current.headerBytes.push(bytes);
    this.addSegment({ bytes });
  }

  private flushPendingEmpty(held: boolean): void {
    if (!this.pendingEmpty) return;
    this.addSegment({ bytes: this.pendingEmpty.bytes, heldEmpty: held || undefined });
    this.pendingEmpty = null;
  }

  private addSegment(segment: Segment): void {
    const cur = this.current!;
    cur.size += segment.bytes.length;
    if (cur.size > this.maxBytes) {
      cur.tooLarge = true;
      cur.segments = [];
      return;
    }
    if (cur.tooLarge) return;
    // Plain lines next to each other in one chunk become one segment.
    const last = cur.segments[cur.segments.length - 1];
    const b = segment.bytes;
    if (last && !last.heldEmpty && !last.heldFrom && !segment.heldEmpty && !segment.heldFrom
      && last.bytes.buffer === b.buffer && last.bytes.byteOffset + last.bytes.length === b.byteOffset) {
      last.bytes = new Uint8Array(b.buffer, last.bytes.byteOffset, last.bytes.length + b.length);
      return;
    }
    cur.segments.push({ ...segment });
  }

  private start(fromLine: string, offset: number): void {
    this.current = { fromLine, offset, segments: [], size: 0, tooLarge: false, inBody: false, headerBytes: [], holding: false };
  }

  private endHeaders(bodyStart: number): void {
    const cur = this.current!;
    cur.inBody = true;
    const match = CONTENT_LENGTH.exec(latin1(concat(cur.headerBytes)));
    cur.headerBytes = [];
    if (match) {
      cur.expectedEnd = bodyStart + Number(match[1]);
      cur.holding = true;
    }
  }

  /**
   * Content-Length was checked: when it was right, the held separators were
   * body lines; when it was wrong, they split the message.
   */
  private settleLength(confirmed: boolean): void {
    const cur = this.current!;
    cur.expectedEnd = undefined;
    cur.holding = false;
    if (confirmed || cur.tooLarge || !cur.segments.some((s) => s.heldFrom)) {
      for (const s of cur.segments) { s.heldEmpty = undefined; s.heldFrom = undefined; }
      return;
    }
    // Split at each held separator. The last part becomes the current message.
    const parts: { fromLine: string; offset: number; segments: Segment[] }[] = [
      { fromLine: cur.fromLine, offset: cur.offset, segments: [] },
    ];
    for (const s of cur.segments) {
      if (s.heldEmpty) continue;
      if (s.heldFrom) {
        parts.push({ fromLine: s.heldFrom.line, offset: s.heldFrom.offset, segments: [] });
        continue;
      }
      parts[parts.length - 1].segments.push(s);
    }
    for (const part of parts.slice(0, -1)) {
      this.out.push(toMessage(part.fromLine, part.offset, part.segments, false));
    }
    const last = parts[parts.length - 1];
    this.current = {
      fromLine: last.fromLine,
      offset: last.offset,
      segments: last.segments,
      size: last.segments.reduce((n, s) => n + s.bytes.length, 0),
      tooLarge: false,
      inBody: true,
      headerBytes: [],
      holding: false,
    };
  }

  private finish(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    this.out.push(toMessage(cur.fromLine, cur.offset, cur.segments, cur.tooLarge, cur.size));
  }
}

function toMessage(fromLine: string, offset: number, segments: Segment[], tooLarge: boolean, size?: number): MboxMessage {
  const parts = tooLarge ? [] : mergeAdjacent(segments.map((s) => s.bytes));
  return {
    parts,
    size: size ?? parts.reduce((n, p) => n + p.length, 0),
    fromLine,
    offset,
    tooLarge,
  };
}

/** Joins subarrays that sit next to each other in the same buffer, so a Blob gets few parts. */
function mergeAdjacent(parts: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.buffer === p.buffer && last.byteOffset + last.length === p.byteOffset) {
      out[out.length - 1] = new Uint8Array(p.buffer, last.byteOffset, last.length + p.length);
    } else {
      out.push(p);
    }
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The header block of a message (up to the first empty line, at most 64 KB), as Latin-1 text. */
export function readHeaderBlock(parts: Uint8Array[], limit = 64 * 1024): string {
  const bytes: Uint8Array[] = [];
  let n = 0;
  for (const p of parts) {
    bytes.push(p.subarray(0, Math.max(0, limit - n)));
    n += p.length;
    if (n >= limit) break;
  }
  const text = latin1(concat(bytes));
  const end = text.search(/\r?\n\r?\n/);
  return end === -1 ? text : text.slice(0, end);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The date of an envelope line, "From sender Tue May  5 10:11:12 2020" (asctime,
 * read as UTC, optionally with a zone before the year), as a JMAP UTCDate.
 */
export function envelopeDate(fromLine: string): string | undefined {
  const m = /(?:^|\s)(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+([a-z]{3})\w*\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(?:([+-]\d{4})\s+)?(\d{4})/i.exec(fromLine);
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return undefined;
  let time = Date.UTC(Number(m[7]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5] ?? 0));
  if (m[6]) {
    const sign = m[6][0] === "-" ? -1 : 1;
    time -= sign * (Number(m[6].slice(1, 3)) * 60 + Number(m[6].slice(3))) * 60_000;
  }
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}
