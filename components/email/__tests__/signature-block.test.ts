import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

import { SignatureBlock, buildSignatureBlock, SIGNATURE_BLOCK_MARKER } from '../signature-block';
import { serializeEditorContent } from '../quoted-html';

describe('signature-block', () => {
  it('buildSignatureBlock wraps html in the marker div', () => {
    expect(buildSignatureBlock('<b>x</b>')).toBe(`<div ${SIGNATURE_BLOCK_MARKER}><b>x</b></div>`);
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
