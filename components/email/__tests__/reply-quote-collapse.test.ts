import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import { trailingParagraphBreakRule } from '../paragraph-breaks';
import { QuotedHtml, buildQuotedHtmlBlock, serializeEditorContent } from '../quoted-html';
import { SignatureBlock, buildSignatureBlock } from '../signature-block';
import { ReplyQuoteCollapse, markReplyQuoteHeader, userTextEnd } from '../reply-quote-collapse';

const HEADER = markReplyQuoteHeader('<div>On Monday, Bob wrote:<br></div>');
const ORIGINAL = '<p>Original message</p><img src="cid:logo"><blockquote>Earlier reply</blockquote>';
const QUOTE = buildQuotedHtmlBlock(ORIGINAL);
const ReplyParagraph = Paragraph.extend({
  parseHTML() {
    return [...(this.parent?.() ?? []), trailingParagraphBreakRule];
  },
});
let editor: Editor | undefined;

function mount(html = `<p>My response</p>${HEADER}${QUOTE}`) {
  editor = new Editor({
    extensions: [StarterKit.configure({ paragraph: false }), ReplyParagraph, QuotedHtml, SignatureBlock, ReplyQuoteCollapse],
    content: html,
  });
  // Settle StarterKit's trailing paragraph before comparing message data.
  editor.view.dispatch(editor.state.tr);
  document.body.appendChild(editor.view.dom);
  return editor;
}
function toggle() {
  return editor!.view.dom.querySelector<HTMLButtonElement>('[data-reply-quote-toggle]')!;
}
function quote() {
  return editor!.view.dom.querySelector<HTMLElement>('.quoted-html-island, blockquote')!;
}
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.innerHTML = '';
});

describe('reply quote visibility', () => {
  it('starts collapsed, hides attribution too, and toggles without changing serialized content', () => {
    const e = mount();
    const saved = serializeEditorContent(e);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(toggle()).toHaveAccessibleName('Show quoted text');
    expect(quote()).toHaveAttribute('data-reply-quote-collapsed', 'true');
    expect(e.view.dom.querySelector('[data-reply-quote-start]')).toHaveAttribute('data-reply-quote-collapsed', 'true');
    expect(saved).toContain('On Monday, Bob wrote:');
    expect(saved).toContain(ORIGINAL);
    expect(saved).not.toContain('data-reply-quote-toggle');
    expect(saved).not.toContain('display: none');
    expect(saved).not.toContain('data-reply-quote-collapsed');
    toggle().click();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(quote()).not.toHaveAttribute('data-reply-quote-collapsed');
    expect(serializeEditorContent(e)).toBe(saved);
    toggle().click();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(serializeEditorContent(e)).toBe(saved);
  });

  it('round-trips a collapsed quote through a native draft without dropping inline images', () => {
    const e = mount();
    const saved = serializeEditorContent(e);
    e.commands.setContent(saved);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(serializeEditorContent(e)).toBe(saved);
    expect(saved).toContain('src="cid:logo"');
  });

  it('collapses a plain-text original in rich-text mode and leaves an authored blockquote visible', () => {
    mount(`<p>Response</p><blockquote>My own quotation</blockquote>${HEADER}<blockquote>Original plain-text message</blockquote>`);
    const quotes = editor!.view.dom.querySelectorAll<HTMLElement>('blockquote');
    expect(quotes[0]).not.toHaveAttribute('data-reply-quote-collapsed');
    expect(quotes[1]).toHaveAttribute('data-reply-quote-collapsed', 'true');
  });

  it.each(['above', 'below'])('keeps the signature visible %s the quoted original', (position) => {
    const signature = buildSignatureBlock('<b>My signature</b>');
    const e = mount(`<p>Response</p>${position === 'above' ? signature : ''}${HEADER}${QUOTE}${position === 'below' ? signature : ''}`);
    const signatureNode = e.view.dom.querySelector<HTMLElement>('[data-signature-html]');
    expect(serializeEditorContent(e)).toContain('My signature');
    // Every hidden top-level block belongs to the attribution/original pair.
    const hidden = e.view.dom.querySelectorAll('[data-reply-quote-collapsed]');
    expect(hidden).toHaveLength(2);
    expect(signatureNode?.style.display ?? '').toBe('');
  });

  it('keeps edited quote content when collapsed and serialized', async () => {
    const e = mount();
    toggle().click();
    const inner = quote().shadowRoot!.firstElementChild as HTMLElement;
    inner.querySelector('p')!.textContent = 'Edited original';
    inner.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    toggle().click();
    expect(serializeEditorContent(e)).toContain('Edited original');
    expect(serializeEditorContent(e)).toContain('src="cid:logo"');
  });

  it('keeps the quote hidden when its node view updates while collapsed', () => {
    const e = mount();
    let quotePos = 0;
    e.state.doc.forEach((node, pos) => { if (node.type.name === 'quotedHtml') quotePos = pos; });
    const node = e.state.doc.nodeAt(quotePos)!;
    e.view.dispatch(e.state.tr.setNodeMarkup(quotePos, undefined, { ...node.attrs, html: '<p>Updated original</p>' }));
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(quote()).toHaveAttribute('data-reply-quote-collapsed', 'true');
    expect(serializeEditorContent(e)).toContain('Updated original');
  });

  it('does not add visibility toggles to Undo history', () => {
    const e = mount();
    e.commands.insertContentAt(1, 'Added ');
    toggle().click();
    toggle().click();
    e.commands.undo();
    expect(serializeEditorContent(e)).not.toContain('Added ');
    expect(serializeEditorContent(e)).toContain(ORIGINAL);
    e.commands.redo();
    expect(serializeEditorContent(e)).toContain('Added ');
  });

  it('reveals a quote reached with a text selection and moves the caret out when collapsed', () => {
    const e = mount();
    const start = Number(toggle().dataset.replyQuoteToggle);
    e.commands.setTextSelection(start + 1);
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    toggle().click();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(e.state.selection.to).toBeLessThanOrEqual(start);
  });

  it('retains keyboard focus on the toggle when expanding or collapsing', () => {
    mount();
    toggle().focus();
    toggle().click();
    expect(toggle()).toHaveFocus();
    toggle().click();
    expect(toggle()).toHaveFocus();
  });

  it('preserves expansion when the authored response changes before the quote', () => {
    const e = mount();
    toggle().click();
    e.commands.insertContentAt(1, 'More text. ');
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(quote()).not.toHaveAttribute('data-reply-quote-collapsed');
  });

  it.each([
    `<p>Forwarded message</p>${QUOTE}`,
    '<p>Old draft</p><blockquote>Unknown attribution</blockquote>',
    `${HEADER}<p>New authored paragraph</p><blockquote>Authored quote</blockquote>`,
    `${HEADER}<blockquote></blockquote>`,
  ])('leaves unmarked, ambiguous or empty quote content visible', (html) => {
    mount(html);
    expect(toggle()).toBeNull();
    expect(editor!.view.dom.querySelector('[data-reply-quote-collapsed]')).toBeNull();
  });

  it('preserves an unrecognized plugin header and recognizes a simple plugin paragraph', () => {
    const unknown = '<section><div><p>Custom header</p></div></section>';
    expect(markReplyQuoteHeader(unknown)).toBe(unknown);
    mount(`<p>Response</p>${markReplyQuoteHeader('<p><b>From:</b> Bob</p>')}${QUOTE}`);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });
});

// compose-p2-3: a click under the folded quote used to put the caret on the
// empty last line, below the hidden original, where the text went unseen.
describe('a click in a reply with a folded quote', () => {
  const click = (e: Editor, pos: number) => {
    let handled = false;
    e.view.someProp('handleClick', (handler) => { handled = handler(e.view, pos, new MouseEvent('click')) || handled; return handled; });
    return handled;
  };
  const lastPos = (e: Editor) => e.state.doc.content.size - 1;

  it('puts the caret at the end of the text above the quote', () => {
    const e = mount();
    expect(e.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(click(e, lastPos(e))).toBe(true);
    expect(e.state.selection.from).toBe(1 + 'My response'.length);
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the click where it was once the quote is shown', () => {
    const e = mount();
    toggle().click();
    expect(click(e, lastPos(e))).toBe(false);
  });

  it('keeps a click on a line the user can see below the quote', () => {
    const e = mount(`<p>My response</p>${HEADER}${QUOTE}<p>Postscript</p>`);
    expect(click(e, lastPos(e) - 2)).toBe(false);
  });

  it('keeps a click in the text above the quote', () => {
    const e = mount();
    expect(click(e, 3)).toBe(false);
  });

  it.each(['above', 'below'])('ends the text before a signature %s the quote', (position) => {
    const signature = buildSignatureBlock('<b>My signature</b>');
    const e = mount(`<p>My response</p>${position === 'above' ? signature : ''}${HEADER}${QUOTE}${position === 'below' ? signature : ''}`);
    expect(userTextEnd(e.state)).toBe(1 + 'My response'.length);
  });

  it('has no end of text in a body with neither quote nor signature', () => {
    const e = mount('<p>Just text</p>');
    expect(userTextEnd(e.state)).toBeNull();
  });
});
