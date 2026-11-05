// Where the user's own text is in a message being written, and a textarea
// edit that keeps its undo. No editor code at run time: the text checkers
// load with the plugins on every page, and the editor itself (ProseMirror)
// comes with the composer. composer-edit.ts makes the edits in the editor.

import type { Node as PMNode } from '@tiptap/pm/model';

export const ATOM_BOUNDARIES = new Set(['signatureBlock', 'quotedHtml']);
const QUOTE_NODES = new Set(['quotedHtml', 'blockquote']);
export const SIGNATURE_MARKER_ATTR = 'data-signature-block';

export interface OwnTextOptions {
  /** Reply or forward: the line above the quote is the quote's header. */
  replyLike?: boolean;
  /** The localised "---------- Forwarded message ----------" line. */
  forwardedSeparator?: string;
}

export interface OwnRange {
  /** Start and end of the user's own text in the document. */
  from: number;
  to: number;
  /** Whether a signature or quote follows. */
  bounded: boolean;
}

function isEmptyBlock(node: PMNode): boolean {
  if (node.textContent.trim()) return false;
  let hasLeaf = false;
  node.descendants((child) => {
    if (child.type.name === 'image' || child.type.name === 'table') hasLeaf = true;
    return !hasLeaf;
  });
  return !hasLeaf;
}

function isBoundary(node: PMNode, opts: OwnTextOptions): boolean {
  if (ATOM_BOUNDARIES.has(node.type.name) || node.type.name === 'blockquote') return true;
  const marker = node.attrs?.[SIGNATURE_MARKER_ATTR];
  if (marker === 'separator' || marker === 'start') return true;
  if (opts.forwardedSeparator && node.textContent.trim().startsWith(opts.forwardedSeparator.trim())) return true;
  return false;
}

/** Where the user's own text is in a document. */
export function ownRange(doc: PMNode, opts: OwnTextOptions = {}): OwnRange {
  const children: { node: PMNode; pos: number }[] = [];
  doc.forEach((node, offset) => { children.push({ node, pos: offset }); });
  let boundary = children.findIndex((c) => isBoundary(c.node, opts));
  const bounded = boundary !== -1;
  if (!bounded) boundary = children.length;
  // A reply's quote header sits right above the quote.
  if (bounded && opts.replyLike && QUOTE_NODES.has(children[boundary].node.type.name)
    && boundary > 0 && !isEmptyBlock(children[boundary - 1].node)) {
    boundary -= 1;
  }
  // Blank lines between the text and what follows stay where they are.
  let last = boundary - 1;
  while (last >= 0 && isEmptyBlock(children[last].node)) last--;
  if (last < 0) {
    // Nothing written yet: the first empty paragraph, if there is one, is
    // where the text goes.
    if (boundary > 0) {
      const first = children[0];
      return { from: first.pos, to: first.pos + first.node.nodeSize, bounded };
    }
    const at = children[boundary]?.pos ?? 0;
    return { from: at, to: at, bounded };
  }
  const end = children[last];
  return { from: 0, to: end.pos + end.node.nodeSize, bounded };
}

// ─── Plain text (the textarea composer) ───────────────────────

export interface PlainOwnOptions extends OwnTextOptions {
  /** The identity's signature as plain text. */
  signature?: string;
}

/** Where the user's own text is in a plain-text body. */
export function plainOwnRange(body: string, opts: PlainOwnOptions = {}): { from: number; to: number } {
  const cut: number[] = [body.length];
  const sepMatch = /(^|\n)-- ?\n/.exec(body);
  if (sepMatch) cut.push(sepMatch.index + (sepMatch[1] ? 1 : 0));
  if (opts.signature?.trim()) {
    const at = body.indexOf(opts.signature.trim());
    if (at !== -1) cut.push(at);
  }
  if (opts.forwardedSeparator) {
    const at = body.indexOf(opts.forwardedSeparator.trim());
    if (at !== -1) cut.push(at);
  }
  const quote = /(^|\n)>/.exec(body);
  if (quote) {
    let at = quote.index + (quote[1] ? 1 : 0);
    if (opts.replyLike) {
      // The non-empty line above the quote is its header.
      const before = body.slice(0, Math.max(0, at - 1));
      const lineStart = before.lastIndexOf('\n') + 1;
      if (before.slice(lineStart).trim()) at = lineStart;
    }
    cut.push(at);
  }
  const boundary = Math.min(...cut);
  const own = body.slice(0, boundary).replace(/\s+$/, '');
  return { from: 0, to: own.length };
}

/**
 * Replace a range of a textarea through the browser's editing command, so
 * it lands in the textarea's undo history and fires `input` like typing
 * does. Falls back to setRangeText (no undo) where the command is missing.
 */
export function replaceTextareaRange(textarea: HTMLTextAreaElement, from: number, to: number, text: string): boolean {
  textarea.focus();
  textarea.setSelectionRange(from, to);
  let done = false;
  try {
    done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  } catch {
    done = false;
  }
  if (!done) {
    textarea.setRangeText(text, from, to, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

/** Text the user is writing in: focus there is put back by its owner, with its caret. */
function isTextEntry(element: Element): boolean {
  return element instanceof HTMLTextAreaElement
    || element instanceof HTMLInputElement
    || (element instanceof HTMLElement && element.isContentEditable);
}

/**
 * Replace the whole value of a one-line field (the subject) as typing over
 * it would: through the browser's editing command, so Ctrl+Z in the field
 * takes it back and `input` fires as for typing. False when the field isn't
 * on screen (a docked reply hides its subject line), so it can't take focus:
 * the caller sets the value itself then, without an undo step. A button or
 * a plugin frame that had focus gets it back; text fields are left to the
 * caller, which knows their caret.
 */
export function replaceInputText(input: HTMLInputElement, text: string): boolean {
  if (!input.isConnected || input.disabled || input.getClientRects().length === 0) return false;
  if (input.value === text) return true;
  const previous = document.activeElement;
  input.focus({ preventScroll: true });
  input.setSelectionRange(0, input.value.length);
  let done = false;
  try {
    done = typeof document.execCommand === 'function'
      // An empty insertText leaves the selection in some browsers.
      && document.execCommand(text ? 'insertText' : 'delete', false, text);
  } catch {
    done = false;
  }
  if (!done || input.value !== text) {
    input.setRangeText(text, 0, input.value.length, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (previous instanceof HTMLElement && previous !== input && previous !== document.body && previous.isConnected && !isTextEntry(previous)) {
    previous.focus({ preventScroll: true });
  }
  return true;
}
