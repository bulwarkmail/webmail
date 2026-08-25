import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';

import {
  SignatureBlock,
  buildSignatureBlock,
  containsEmbeddedSignature,
  unlockSignatureBlock,
  SIGNATURE_BLOCK_MARKER,
  SIGNATURE_RANGE_MARKER,
} from '../signature-block';
import { serializeEditorContent } from '../quoted-html';
import { sanitizeSignatureHtml } from '@/lib/email-sanitization';
import { styledBlockAttributes } from '../styled-block-attributes';

// The exact paragraph the composer runs (rich-text-editor.tsx builds
// StyledParagraph from the same styledBlockAttributes), so marker-survival
// and line-spacing assertions test the schema users actually get.
const ComposerParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      ...styledBlockAttributes,
    };
  },
});

const bracketed = (inner: string) =>
  `<p>Hi</p><p ${SIGNATURE_RANGE_MARKER}="separator">-- </p>`
  + `${buildSignatureBlock(inner)}<p ${SIGNATURE_RANGE_MARKER}="end"></p>`;

function makeEditor(content: string) {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ paragraph: false }), ComposerParagraph, SignatureBlock],
    content,
  });
}

function findSignaturePos(editor: Editor): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'signatureBlock') { found = pos; return false; }
    return true;
  });
  return found;
}

describe('signature-block', () => {
  it('buildSignatureBlock wraps html in the marker div', () => {
    expect(buildSignatureBlock('<b>x</b>')).toBe(`<div ${SIGNATURE_BLOCK_MARKER}><b>x</b></div>`);
  });

  describe('containsEmbeddedSignature', () => {
    it('detects the bracketed signature range a saved draft carries', () => {
      const draftBody = `<p>Hi</p><p ${SIGNATURE_RANGE_MARKER}="separator">-- </p>`
        + `${buildSignatureBlock('<b>Alice</b>')}<p ${SIGNATURE_RANGE_MARKER}="end"></p>`;
      expect(containsEmbeddedSignature(draftBody)).toBe(true);
    });

    it('detects a bare signature atom whose marker paragraphs were dropped', () => {
      expect(containsEmbeddedSignature(`<p>Hi</p>${buildSignatureBlock('<b>Alice</b>')}`)).toBe(true);
    });

    it('returns false for a body with no signature', () => {
      expect(containsEmbeddedSignature('<p>Hi</p><blockquote>quoted</blockquote>')).toBe(false);
    });
  });

  it('survives a draft round-trip so the send path sees it as already embedded', () => {
    // What the composer saves for a "below quote" reply draft: body + the
    // marked-up signature. Re-opening parses it back and serialization must
    // still carry the markers, or the send path appends a second signature.
    const draftBody = `<p>Reply text</p><p ${SIGNATURE_RANGE_MARKER}="separator">-- </p>`
      + `${buildSignatureBlock('<b>Alice</b>')}<p ${SIGNATURE_RANGE_MARKER}="end"></p>`;
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, SignatureBlock],
      content: draftBody,
    });
    try {
      const out = serializeEditorContent(editor);
      expect(containsEmbeddedSignature(out)).toBe(true);
      expect(out).toContain('<b>Alice</b>');
      expect(out).toContain('Reply text');
      // Exactly one signature block - no duplication across the round-trip.
      expect(out.split(SIGNATURE_BLOCK_MARKER).length - 1).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  it('preserves an inline-styled signature through parse + serialize (no schema flattening)', () => {
    const styled =
      '<table style="background:#0a0e16;border-radius:8px"><tbody><tr>' +
      '<td style="color:#c6f24e;font-family:\'Courier New\'">MV</td>' +
      '</tr></tbody></table>';
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, SignatureBlock],
      content: `<p>Hello</p>${buildSignatureBlock(styled)}`,
    });
    try {
      const out = serializeEditorContent(editor);
      // Original inline styling survives - it is NOT re-parsed into the schema.
      expect(out).toContain('background:#0a0e16');
      expect(out).toContain('border-radius:8px');
      expect(out).toContain('color:#c6f24e');
      expect(out).toContain(SIGNATURE_BLOCK_MARKER);
      // Surrounding body is preserved.
      expect(out).toContain('Hello');
      // The signature did not get the editor's generic table styling.
      expect(out).not.toContain('rgb(204, 204, 204)');
    } finally {
      editor.destroy();
    }
  });
});

describe('unlockSignatureBlock (#822)', () => {
  it('dissolves the atom into regular editable content between the markers', () => {
    const editor = makeEditor(bracketed('<b>Alice</b><p>CEO</p>'));
    try {
      const pos = findSignaturePos(editor);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(unlockSignatureBlock(editor, pos)).toBe(true);

      const out = serializeEditorContent(editor);
      // The atom is gone, the signature text is ordinary schema content now.
      expect(out).not.toContain(SIGNATURE_BLOCK_MARKER);
      expect(out).toContain('Alice');
      expect(out).toContain('CEO');
      // The bracketing markers survive, so the identity-switch splice and the
      // send path's already-embedded detection keep working.
      expect(out).toContain(`${SIGNATURE_RANGE_MARKER}="separator"`);
      expect(out).toContain(`${SIGNATURE_RANGE_MARKER}="end"`);
      expect(containsEmbeddedSignature(out)).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  it('unlocked content is genuinely editable', () => {
    const editor = makeEditor(bracketed('<p>Old signature line</p>'));
    try {
      unlockSignatureBlock(editor, findSignaturePos(editor));
      // Type INSIDE the former signature text - not merely anywhere in the doc.
      let textPos = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text?.includes('Old signature line')) { textPos = pos; return false; }
        return true;
      });
      expect(textPos).toBeGreaterThanOrEqual(0);
      editor.commands.insertContentAt(textPos + 4, 'EDITED ');
      expect(serializeEditorContent(editor)).toContain('Old EDITED signature line');
    } finally {
      editor.destroy();
    }
  });

  it('returns false and leaves the doc alone for a non-signature position', () => {
    const editor = makeEditor(bracketed('<b>Alice</b>'));
    try {
      const before = serializeEditorContent(editor);
      expect(unlockSignatureBlock(editor, 0)).toBe(false);
      expect(serializeEditorContent(editor)).toBe(before);
    } finally {
      editor.destroy();
    }
  });

  it('undo restores the locked atom', () => {
    const editor = makeEditor(bracketed('<b>Alice</b>'));
    try {
      unlockSignatureBlock(editor, findSignaturePos(editor));
      expect(serializeEditorContent(editor)).not.toContain(SIGNATURE_BLOCK_MARKER);
      editor.commands.undo();
      expect(serializeEditorContent(editor)).toContain(SIGNATURE_BLOCK_MARKER);
    } finally {
      editor.destroy();
    }
  });

  it('an empty signature unlocks to an empty paragraph instead of vanishing weirdly', () => {
    const editor = makeEditor(bracketed(''));
    try {
      expect(unlockSignatureBlock(editor, findSignaturePos(editor))).toBe(true);
      expect(serializeEditorContent(editor)).not.toContain(SIGNATURE_BLOCK_MARKER);
    } finally {
      editor.destroy();
    }
  });

  // The classic signature shape: one <div> per line. Divs render margin-less
  // in mail clients but have no schema node, so a naive parse re-wraps every
  // line into a default-margin paragraph and the signature falls apart into
  // spaced paragraphs (second #822 report, live test).
  it('keeps tight line spacing for div-per-line signatures', () => {
    const editor = makeEditor(bracketed('<div>Jane Doe</div><div>IT-Management</div>'));
    try {
      unlockSignatureBlock(editor, findSignaturePos(editor));
      const out = serializeEditorContent(editor);
      // Both lines carry the vertical margin reset, none is a bare default paragraph.
      expect(out.match(/margin-top: 0px; margin-bottom: 0px/g)?.length).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  // Longhand margins must not defeat the reset: only the missing verticals
  // are zeroed, explicit spacing and indents survive.
  it('keeps indents while resetting missing vertical margins', () => {
    const editor = makeEditor(bracketed('<div style="margin-left: 12px">Indented line</div>'));
    try {
      unlockSignatureBlock(editor, findSignaturePos(editor));
      const out = serializeEditorContent(editor);
      expect(out).toContain('margin-left: 12px');
      expect(out).toContain('margin-top: 0px');
      expect(out).toContain('margin-bottom: 0px');
    } finally {
      editor.destroy();
    }
  });

  // Wrapper divs have no schema node and are dropped by the parse; their
  // inherited styles (the font/color the whole signature lives in) must move
  // onto the generated line paragraphs, with the line's own styles winning.
  // A wrapper `font` SHORTHAND must not be hoisted as-is: setting it on the
  // paragraph after the line's own styles would reset the line's
  // font-family/size longhands (review note on #862).
  it('never lets a wrapper font shorthand clobber the line\'s own font', () => {
    const editor = makeEditor(bracketed(
      '<div style="font: 12px Arial"><div style="font-family: Courier">Code line</div></div>'
    ));
    try {
      unlockSignatureBlock(editor, findSignaturePos(editor));
      const out = serializeEditorContent(editor);
      expect(out).toContain('font-family: Courier');
      expect(out).not.toMatch(/font: 12px/);
    } finally {
      editor.destroy();
    }
  });

  it('hoists inherited wrapper styles onto the line paragraphs', () => {
    const editor = makeEditor(bracketed(
      '<div style="font-family: Arial; color: rgb(51, 51, 51)">'
      + '<div>Name</div><div style="color: rgb(255, 0, 0)">Title</div></div>'
    ));
    try {
      unlockSignatureBlock(editor, findSignaturePos(editor));
      const out = serializeEditorContent(editor);
      expect(out.match(/font-family: Arial/g)?.length).toBe(2);
      expect(out).toContain('color: rgb(51, 51, 51)');
      expect(out).toContain('color: rgb(255, 0, 0)');
    } finally {
      editor.destroy();
    }
  });

  it('keeps <br> line runs together and respects explicit margins', () => {
    const editor = makeEditor(bracketed(
      '<div>Tel: 1 <b>•</b> Fax: 2<br>Mobil: 3</div><p style="margin:4px 0">Legal</p>'
    ));
    try {
      unlockSignatureBlock(editor, findSignaturePos(editor));
      const out = serializeEditorContent(editor);
      // The br stays a line break inside one paragraph, not a paragraph split.
      expect(out).toMatch(/Fax: 2<br>Mobil: 3/);
      // An explicit margin is not overridden by the margin-0 default.
      expect(out).toContain('margin: 4px 0');
    } finally {
      editor.destroy();
    }
  });
});

describe('unlockSignatureBlock keeps the classic Outlook-style signature intact', () => {
  // One <p> with <br> line runs, font-size on the block, colored bold spans -
  // the shape that shipped broken twice: schema parse must keep it a single
  // paragraph with hard breaks, through the real pipeline (sanitize -> embed
  // -> initial parse -> unlock).
  const SIG = `<p style="font-size:9pt;">Mit freundlichem Gruß<br><br>
<span style="color:#1f497d; font-weight:bold">Jane Doe</span><br>
IT-Management<br><br>
Tel: 111 • Fax: 222<br><br>
Der Inhalt dieser E-Mail ist vertraulich.
</p>`;

  it('stays one paragraph with all hard breaks after the unlock', () => {
    const sanitized = sanitizeSignatureHtml(SIG);
    const body = `<p></p><p ${SIGNATURE_RANGE_MARKER}="separator">-- </p>`
      + `${buildSignatureBlock(sanitized)}<p ${SIGNATURE_RANGE_MARKER}="end"></p>`;
    const editor = makeEditor(body);
    try {
      const pos = findSignaturePos(editor);
      expect(unlockSignatureBlock(editor, pos)).toBe(true);
      const out = serializeEditorContent(editor);
      // Leading paragraph + separator + ONE signature paragraph + end marker.
      expect((out.match(/<p/g) || []).length).toBe(4);
      expect((out.match(/<br/g) || []).length).toBe(7);
      expect(out).toContain('font-size: 9pt');
      expect(out).toContain('Jane Doe');
    } finally {
      editor.destroy();
    }
  });
});
