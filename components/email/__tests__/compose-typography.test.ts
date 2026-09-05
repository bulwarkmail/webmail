import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
import { TextStyle } from '@tiptap/extension-text-style';
import { FontFamily } from '@tiptap/extension-text-style/font-family';
import { FontSize } from '@tiptap/extension-text-style/font-size';
import Color from '@tiptap/extension-color';

import { styledBlockAttributes } from '../styled-block-attributes';
import { serializeEditorContent } from '../quoted-html';
import {
  ComposeTypography,
  COMPOSE_FONT_FAMILY_CSS,
  COMPOSE_FONT_SIZE_CSS,
  resolveComposeDefaults,
  sampleTypography,
  type ComposeDefaults,
} from '../compose-typography';

// The exact paragraph the composer runs (rich-text-editor.tsx builds
// StyledParagraph from the same styledBlockAttributes).
const ComposerParagraph = Paragraph.extend({
  addAttributes() {
    return { ...this.parent?.(), ...styledBlockAttributes };
  },
});

// The typography of the pipeline-built reply draft we must match invisibly:
// Georgia 15px in a warm ink. This is the exact <span> our draft_writer emits.
const DRAFT_FAMILY = "Georgia, 'Times New Roman', serif";
const DRAFT_SIZE = '15px';
const DRAFT_COLOR = '#34291f';
const draftSpan = (text: string) =>
  `<span style="font-family:${DRAFT_FAMILY};font-size:${DRAFT_SIZE};color:${DRAFT_COLOR}">${text}</span>`;

function makeEditor(content: string) {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ paragraph: false }),
      ComposerParagraph,
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      ComposeTypography,
    ],
    content,
  });
}

// Push resolved compose defaults into the editor exactly as rich-text-editor.tsx
// does on load: sample the drafted body, resolve against the user settings, set
// the defaults, and bring the existing body up to them.
function applyComposeTypography(
  editor: Editor,
  opts: { userFamily?: string | null; userSize?: string | null } = {}
): ComposeDefaults {
  const sample = sampleTypography(editor.state.doc);
  const resolved = resolveComposeDefaults({
    userFamily: opts.userFamily ?? null,
    userSize: opts.userSize ?? null,
    sample,
  });
  editor.commands.setComposeDefaults(resolved);
  editor.commands.applyComposeDefaultsToBody();
  return resolved;
}

// Faithful re-implementation of prosemirror-view's typed-input path: inserted
// text takes state.storedMarks when set, otherwise the marks at the cursor. This
// is precisely what pressing a key in the browser does, so asserting on its
// output proves what actually gets typed — and, via serializeEditorContent, what
// actually SENDS.
function typeText(editor: Editor, text: string) {
  const { state } = editor.view;
  const marks = state.storedMarks || state.selection.$from.marks();
  const node = state.schema.text(text, marks);
  editor.view.dispatch(state.tr.replaceSelectionWith(node, false));
}

// The style of the first <span> inside the paragraph that contains `text`.
function spanStyleOfParagraphWith(html: string, text: string): CSSStyleDeclaration {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const p = Array.from(doc.querySelectorAll('p')).find((el) => (el.textContent || '').includes(text));
  if (!p) throw new Error(`no <p> containing "${text}" in: ${html}`);
  const span = p.querySelector('span');
  if (!span) throw new Error(`no <span> in paragraph "${text}" in: ${html}`);
  const probe = doc.createElement('span');
  probe.setAttribute('style', span.getAttribute('style') || '');
  return probe.style;
}

function expectMatchesDraft(style: CSSStyleDeclaration) {
  // Browsers normalise the serialised form (quotes, rgb()), so compare parsed
  // CSS values rather than raw strings.
  expect(style.getPropertyValue('font-family').replace(/"/g, "'")).toBe(DRAFT_FAMILY);
  expect(style.getPropertyValue('font-size')).toBe(DRAFT_SIZE);
  expect(style.getPropertyValue('color')).toBe('rgb(52, 41, 31)'); // #34291f
}

describe('compose-typography helpers', () => {
  it('maps the setting enums to web-safe CSS (default = unset)', () => {
    expect(COMPOSE_FONT_FAMILY_CSS.default).toBeNull();
    expect(COMPOSE_FONT_FAMILY_CSS['serif-georgia']).toBe("Georgia, 'Times New Roman', serif");
    expect(COMPOSE_FONT_SIZE_CSS.default).toBeNull();
    expect(COMPOSE_FONT_SIZE_CSS.normal).toBe('14px');
    // 15px tier exists so a reply theme (all of ours are 15px) can be the compose default.
    expect(COMPOSE_FONT_SIZE_CSS.medium).toBe('15px');
  });

  it('samples the drafted body typography from the first styled run', () => {
    const editor = makeEditor(`<p>${draftSpan('Warm ink reply')}</p>`);
    const sample = sampleTypography(editor.state.doc);
    expect(sample.fontFamily?.replace(/"/g, "'")).toBe(DRAFT_FAMILY);
    expect(sample.fontSize).toBe(DRAFT_SIZE);
    expect(sample.color).toBe(DRAFT_COLOR);
    editor.destroy();
  });

  it('lets the drafted body win over the user settings (invisible edit)', () => {
    const resolved = resolveComposeDefaults({
      userFamily: 'Arial, Helvetica, sans-serif',
      userSize: '18px',
      sample: { fontFamily: DRAFT_FAMILY, fontSize: DRAFT_SIZE, color: DRAFT_COLOR },
    });
    expect(resolved).toEqual({ fontFamily: DRAFT_FAMILY, fontSize: DRAFT_SIZE, color: DRAFT_COLOR });
  });

  it('falls back to user settings when the draft carries no style (fresh mail)', () => {
    const resolved = resolveComposeDefaults({
      userFamily: 'Arial, Helvetica, sans-serif',
      userSize: '18px',
      sample: { fontFamily: null, fontSize: null, color: null },
    });
    expect(resolved).toEqual({ fontFamily: 'Arial, Helvetica, sans-serif', fontSize: '18px', color: null });
  });

  it('applies the user compose colour when the draft carries none (fresh mail)', () => {
    const resolved = resolveComposeDefaults({
      userFamily: null,
      userSize: '15px',
      userColor: '#34291f',
      sample: { fontFamily: null, fontSize: null, color: null },
    });
    expect(resolved).toEqual({ fontFamily: null, fontSize: '15px', color: '#34291f' });
  });

  it('lets the drafted body colour win over the user compose colour (invisible edit)', () => {
    const resolved = resolveComposeDefaults({
      userFamily: null,
      userSize: null,
      userColor: '#1967d2',
      sample: { fontFamily: DRAFT_FAMILY, fontSize: DRAFT_SIZE, color: DRAFT_COLOR },
    });
    expect(resolved.color).toBe(DRAFT_COLOR);
  });
});

describe('compose-typography — the invisible-edit gate', () => {
  it('a NEW paragraph typed after the draft carries the SAME family, size, and colour', () => {
    const editor = makeEditor(`<p>${draftSpan('Drafted warm-ink line')}</p>`);
    applyComposeTypography(editor);

    // Enter at the end of the draft, then type — exactly the owner's edit.
    editor.commands.focus('end');
    editor.commands.splitBlock();
    typeText(editor, 'Typed new paragraph');

    const html = serializeEditorContent(editor);
    expectMatchesDraft(spanStyleOfParagraphWith(html, 'Typed new paragraph'));

    // And the drafted line is untouched (still identical) — a true invisible edit.
    expectMatchesDraft(spanStyleOfParagraphWith(html, 'Drafted warm-ink line'));
    editor.destroy();
  });

  it('an inline-reply line inserted BETWEEN two drafted lines matches them', () => {
    const editor = makeEditor(
      `<p>${draftSpan('First drafted line')}</p><p>${draftSpan('Second drafted line')}</p>`
    );
    applyComposeTypography(editor);

    // Put the cursor at the end of the first line, split, and type between them.
    let firstEnd = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && (node.text || '').includes('First drafted line')) {
        firstEnd = pos + node.nodeSize;
        return false;
      }
      return true;
    });
    editor.commands.setTextSelection(firstEnd);
    editor.commands.splitBlock();
    typeText(editor, 'Inline reply line');

    const html = serializeEditorContent(editor);
    expectMatchesDraft(spanStyleOfParagraphWith(html, 'Inline reply line'));
    editor.destroy();
  });

  it('populates stored marks in a truly empty paragraph with no neighbouring marks', () => {
    // No styled draft to sample: the user's Compose-font / size settings apply,
    // and the extension still fills the stored marks so the first typed run in a
    // bare paragraph carries them (proves it does not merely rely on keepOnSplit).
    const editor = makeEditor('<p></p>');
    const userFamily = COMPOSE_FONT_FAMILY_CSS['serif-georgia'];
    const userSize = COMPOSE_FONT_SIZE_CSS.large; // 16px
    applyComposeTypography(editor, { userFamily, userSize });

    editor.commands.focus('end');
    // Nudge the selection so the plugin's appendTransaction runs for this cursor.
    editor.commands.setTextSelection(editor.state.selection.from);

    const stored = editor.view.state.storedMarks || editor.view.state.selection.$from.marks();
    const ts = stored.find((m) => m.type.name === 'textStyle');
    expect(ts?.attrs.fontFamily?.replace(/"/g, "'")).toBe("Georgia, 'Times New Roman', serif");
    expect(ts?.attrs.fontSize).toBe('16px');

    typeText(editor, 'Fresh message body');
    const style = spanStyleOfParagraphWith(serializeEditorContent(editor), 'Fresh message body');
    expect(style.getPropertyValue('font-family').replace(/"/g, "'")).toBe("Georgia, 'Times New Roman', serif");
    expect(style.getPropertyValue('font-size')).toBe('16px');
    editor.destroy();
  });

  it('does not override a colour the user picked by hand (fills only what is missing)', () => {
    const editor = makeEditor(`<p>${draftSpan('Drafted line')}</p>`);
    applyComposeTypography(editor);
    editor.commands.focus('end');
    editor.commands.splitBlock();

    // User explicitly sets a different colour for the new run.
    editor.commands.setColor('#1967d2');
    typeText(editor, 'Hand-coloured run');

    const style = spanStyleOfParagraphWith(serializeEditorContent(editor), 'Hand-coloured run');
    expect(style.getPropertyValue('color')).toBe('rgb(25, 103, 210)'); // the user's colour wins
    // …while family + size still come from the draft (invisible in every other way).
    expect(style.getPropertyValue('font-family').replace(/"/g, "'")).toBe(DRAFT_FAMILY);
    expect(style.getPropertyValue('font-size')).toBe(DRAFT_SIZE);
    editor.destroy();
  });
});
