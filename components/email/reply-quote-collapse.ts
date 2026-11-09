"use client";

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const REPLY_QUOTE_START_ATTRIBUTE = 'data-reply-quote-start';
const START_ATTRIBUTE = REPLY_QUOTE_START_ATTRIBUTE;
const HEADER_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, table, ul, ol, pre, blockquote';

/** Mark only attribution generated for a reply. Unknown plugin markup stays visible. */
export function markReplyQuoteHeader(html: string): string {
  if (typeof document === 'undefined') return html;
  // A template is inert: attribution containing an image must not load it here.
  const template = document.createElement('template');
  template.innerHTML = html;
  const first = template.content.firstElementChild;
  if (!first) return `<p ${START_ATTRIBUTE}="true">${html}</p>`;
  // The default attribution is a div of inline content, parsed as a paragraph
  // by the editor. Make that paragraph explicit so its marker round-trips.
  if (first.tagName === 'DIV' && !first.querySelector(HEADER_BLOCKS)) {
    const paragraph = document.createElement('p');
    for (const attribute of first.attributes) paragraph.setAttribute(attribute.name, attribute.value);
    paragraph.innerHTML = first.innerHTML;
    first.replaceWith(paragraph);
    paragraph.setAttribute(START_ATTRIBUTE, 'true');
  } else if (first.matches(HEADER_BLOCKS)) {
    first.setAttribute(START_ATTRIBUTE, 'true');
  } else {
    return html;
  }
  // A leading text node would otherwise remain visible outside the group.
  if (template.content.firstChild?.nodeType === Node.TEXT_NODE
    && template.content.firstChild.textContent?.trim()) return html;
  return template.innerHTML;
}

interface QuoteRange { from: number; to: number }
interface QuoteState { expanded: Set<number> }
const quoteKey = new PluginKey<QuoteState>('replyQuoteCollapse');

function quoteRanges(doc: PMNode): QuoteRange[] {
  const ranges: QuoteRange[] = [];
  let start: number | null = null;
  doc.forEach((node, pos) => {
    if (node.type.name === 'signatureBlock' || node.attrs['data-signature-block']) start = null;
    if (node.attrs.replyQuoteStart) start = pos;
    else if (start !== null && (node.type.name === 'quotedHtml' || node.type.name === 'blockquote')) {
      if (node.textContent.trim() || String(node.attrs.html ?? '').trim()) {
        ranges.push({ from: start, to: pos + node.nodeSize });
      }
      start = null;
    } else if (start !== null) {
      // Do not hide unrelated authored blocks while searching for a quote.
      start = null;
    }
  });
  return ranges;
}

const isSignature = (node: PMNode) => node.type.name === 'signatureBlock' || Boolean(node.attrs['data-signature-block']);

function collapsedRanges(state: EditorState): QuoteRange[] {
  const expanded = quoteKey.getState(state)?.expanded ?? new Set<number>();
  return quoteRanges(state.doc).filter((range) => !expanded.has(range.from));
}

/**
 * Where the user's own text ends: the end of the last paragraph above the
 * folded quote or the signature, whichever comes first. Null when the body
 * has neither, so the end of the body is the end of the text.
 */
export function userTextEnd(state: EditorState): number | null {
  const ranges = quoteRanges(state.doc);
  let boundary: number | null = collapsedRanges(state)[0]?.from ?? null;
  state.doc.forEach((node, pos) => {
    if (isSignature(node) && (boundary === null || pos < boundary)) boundary = pos;
  });
  if (boundary === null) return null;
  // The empty line and the line break a reply keeps between the user's text
  // and the quote aren't the end of the text: a click there wrote on a new
  // line under the first (compose-p3-13). The end is after the last
  // character typed; an empty reply starts on its first line.
  let end: number | null = null;
  let firstEmpty: number | null = null;
  state.doc.forEach((node, pos) => {
    if (pos + node.nodeSize > boundary! || !node.isTextblock || isSignature(node)) return;
    if (ranges.some((range) => pos >= range.from && pos < range.to)) return;
    let close = pos + node.nodeSize - 1;
    let index = node.childCount - 1;
    while (index >= 0 && node.child(index).type.name === 'hardBreak') {
      close -= node.child(index).nodeSize;
      index -= 1;
    }
    if (index >= 0) end = close;
    else if (firstEmpty === null) firstEmpty = pos + 1;
  });
  return end ?? firstEmpty;
}

/**
 * A click that lands under a folded quote (on the empty line the editor keeps
 * at the end) would write below the hidden original, where the user can't see
 * it. It goes to the end of their own text above the quote instead
 * (compose-p2-3). Lines the user can see below the quote keep their click.
 */
function clickBelowCollapsedQuote(state: EditorState, pos: number): boolean {
  const ranges = collapsedRanges(state);
  const first = ranges[0];
  if (!first || pos < first.from) return false;
  const $pos = state.doc.resolve(pos);
  const topPos = $pos.depth > 0 ? $pos.before(1) : pos;
  let hiddenOrEmpty = true;
  state.doc.forEach((node, nodePos) => {
    if (nodePos < first.from || nodePos > topPos) return;
    if (ranges.some((range) => nodePos >= range.from && nodePos < range.to)) return;
    if (!node.isTextblock || isSignature(node) || node.content.size > 0) hiddenOrEmpty = false;
  });
  return hiddenOrEmpty;
}

/**
 * A click on the blank lines between the user's text and a folded quote (the
 * line break and the empty line a reply keeps there) goes to the end of the
 * text, so the next word continues it instead of starting a line of its own
 * (compose-p3-13).
 */
function clickInGapAboveQuote(state: EditorState, pos: number, end: number): boolean {
  const first = collapsedRanges(state)[0];
  if (!first || pos <= end || pos >= first.from) return false;
  let blank = true;
  state.doc.nodesBetween(end, first.from, (node) => {
    if (node.isText ? !!node.text?.trim() : node.isLeaf && node.type.name !== 'hardBreak') blank = false;
    return blank;
  });
  return blank;
}

/** Visibility is a view decoration, never a document edit or an undo step. */
export const ReplyQuoteCollapse = Extension.create<{ show: string; hide: string }>({
  name: 'replyQuoteCollapse',

  addOptions() {
    return { show: 'Show quoted text', hide: 'Hide quoted text' };
  },

  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading', 'table', 'bulletList', 'orderedList', 'codeBlock', 'blockquote'],
      attributes: {
        replyQuoteStart: {
          default: false,
          parseHTML: (el) => el.getAttribute(START_ATTRIBUTE) === 'true',
          renderHTML: (attrs) => attrs.replyQuoteStart ? { [START_ATTRIBUTE]: 'true' } : {},
        },
      },
    }];
  },

  addProseMirrorPlugins() {
    const labels = this.options;
    return [new Plugin<QuoteState>({
      key: quoteKey,
      state: {
        init: () => ({ expanded: new Set<number>() }),
        apply: (tr, previous) => {
          const expanded = new Set<number>();
          for (const pos of previous.expanded) {
            const mapped = tr.mapping.mapResult(pos);
            if (!mapped.deleted) expanded.add(mapped.pos);
          }
          const toggle = tr.getMeta(quoteKey) as { from: number; expanded: boolean } | undefined;
          if (toggle) {
            if (toggle.expanded) expanded.add(toggle.from);
            else expanded.delete(toggle.from);
          } else if (tr.selectionSet) {
            // Arrow keys, Find and editor commands must not leave the caret
            // inside invisible text. Revealing it changes no message content.
            for (const range of quoteRanges(tr.doc)) {
              if (tr.selection.from < range.to && tr.selection.to > range.from) expanded.add(range.from);
            }
          }
          return { expanded };
        },
      },
      props: {
        handleDOMEvents: {
          // A click between the blocks or under the last one hits the editor
          // itself, and the browser put the caret at the end of the message,
          // below the folded quote: what came next was hidden under it
          // (compose-p3-13). Under the user's text, it goes to the text's end.
          mousedown(view, event) {
            if (event.button !== 0 || event.target !== view.dom || collapsedRanges(view.state).length === 0) return false;
            const end = userTextEnd(view.state);
            if (end === null) return false;
            let below: number;
            try {
              below = view.coordsAtPos(end).bottom;
            } catch {
              return false;
            }
            if (event.clientY <= below) return false;
            event.preventDefault();
            view.focus();
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
            return true;
          },
        },
        handleClick(view, pos) {
          const end = userTextEnd(view.state);
          if (end === null) return false;
          if (!clickBelowCollapsedQuote(view.state, pos) && !clickInGapAboveQuote(view.state, pos, end)) return false;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
          return true;
        },
        decorations(state) {
          const expanded = quoteKey.getState(state)?.expanded ?? new Set<number>();
          const decorations: Decoration[] = [];
          for (const range of quoteRanges(state.doc)) {
            const open = expanded.has(range.from);
            decorations.push(Decoration.widget(range.from, (view) => {
              const button = document.createElement('button');
              button.type = 'button';
              button.textContent = '•••';
              button.className = 'my-1 inline-block cursor-pointer rounded-full bg-foreground/10 px-3 py-[3px] text-[0.6875rem] leading-none tracking-[2px] text-muted-foreground hover:bg-foreground/20 hover:text-foreground';
              button.title = open ? labels.hide : labels.show;
              button.setAttribute('aria-label', button.title);
              button.setAttribute('aria-expanded', String(open));
              button.addEventListener('click', () => {
                const tr = view.state.tr.setMeta(quoteKey, { from: range.from, expanded: !open });
                if (open) tr.setSelection(Selection.near(tr.doc.resolve(range.from), -1));
                const restoreFocus = document.activeElement === button;
                view.dispatch(tr);
                if (restoreFocus) {
                  const toggles = view.dom.querySelectorAll<HTMLButtonElement>('[data-reply-quote-toggle]');
                  toggles.forEach((toggle) => {
                    if (Number(toggle.dataset.replyQuoteToggle) === range.from) toggle.focus();
                  });
                }
              });
              button.dataset.replyQuoteToggle = String(range.from);
              return button;
            }, { key: `reply-quote-${range.from}-${open}`, side: -1, stopEvent: () => true }));
            if (!open) {
              state.doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
                if (parent === state.doc) {
                  decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-reply-quote-collapsed': 'true' }));
                }
                return false;
              });
            }
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
