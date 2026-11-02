import { scrubFramePath, scrubFunctionName } from './scrub';

/** One stack frame, already scrubbed. */
export interface Frame {
  /** The file as scrubFramePath leaves it: `/_next/static/chunks/x.js`. */
  path: string;
  line?: number;
  column?: number;
  fn?: string;
  /** The debug ID of the file, when its bundle registered one (./debug-ids.ts). */
  debugId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_FRAMES = 30;

// V8 (Chrome, Edge, Node): "    at fn (file:1:2)", "    at file:1:2",
// "    at async fn (file:1:2)", "    at new Foo (file:1:2)".
const V8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// SpiderMonkey and JavaScriptCore (Firefox, Safari): "fn@file:1:2", "@file:1:2".
const GECKO = /^\s*([^@]*)@(.+?):(\d+):(\d+)\s*$/;

function number(value: string): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : undefined;
}

/** The frames of a stack, the frame that threw first, at most MAX_FRAMES. */
export function parseStack(stack: unknown): Frame[] {
  if (typeof stack !== 'string') return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    const match = V8.exec(line) ?? GECKO.exec(line);
    if (!match) continue;
    const [, fn, file, lineNo, column] = match;
    // "at fn (native)" and eval chains carry no file worth keeping.
    frames.push({
      path: scrubFramePath(file),
      line: number(lineNo),
      column: number(column),
      fn: scrubFunctionName(fn?.replace(/^async /, '')),
    });
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/** Frames handed in from outside (a browser's report), checked and scrubbed again. */
export function sanitizeFrames(input: unknown): Frame[] {
  if (!Array.isArray(input)) return [];
  const out: Frame[] = [];
  for (const raw of input.slice(0, MAX_FRAMES)) {
    if (!raw || typeof raw !== 'object') continue;
    const frame = raw as Record<string, unknown>;
    const line = typeof frame.line === 'number' ? number(String(frame.line)) : undefined;
    const column = typeof frame.column === 'number' ? number(String(frame.column)) : undefined;
    const debugId = typeof frame.debugId === 'string' && UUID.test(frame.debugId) ? frame.debugId.toLowerCase() : undefined;
    out.push({ path: scrubFramePath(frame.path), line, column, fn: scrubFunctionName(frame.fn), ...(debugId ? { debugId } : {}) });
  }
  return out;
}
