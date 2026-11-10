import { describe, it, expect } from 'vitest';
import { collectReferencedCids, isEmbeddedInBody, rewriteCidReferences } from '@/lib/attachment-visibility';

describe('collectReferencedCids', () => {
  it('finds cid: references wherever the body uses them', () => {
    const html = '<img src="cid:logoImage"><td background="cid:bg1">'
      + '<div style="background-image:url(cid:styled)"></div>'
      + "<img src='cid:singleQuoted'>";
    const cids = collectReferencedCids(html);
    expect(cids.has('logoImage')).toBe(true);
    expect(cids.has('bg1')).toBe(true);
    expect(cids.has('styled')).toBe(true);
    expect(cids.has('singleQuoted')).toBe(true);
  });

  it('takes references exactly as written - the renderer resolves them the same way', () => {
    const cids = collectReferencedCids('<img src="cid:part%40host">');
    expect(cids.has('part%40host')).toBe(true);
    expect(cids.has('part@host')).toBe(false);
  });

  it('is empty for plain-text rendering (null) and bodies without references', () => {
    expect(collectReferencedCids(null).size).toBe(0);
    expect(collectReferencedCids(undefined).size).toBe(0);
    expect(collectReferencedCids('').size).toBe(0);
    expect(collectReferencedCids('<p>no images here</p>').size).toBe(0);
  });
});

describe('isEmbeddedInBody', () => {
  const body = collectReferencedCids('<img src="cid:signaturImage"><img src="cid:logoImage">');

  // The wild shape that started this: octet-stream, no disposition, no name,
  // rendered in the body via cid:.
  it('hides sloppy octet-stream parts the body renders', () => {
    expect(isEmbeddedInBody({ cid: 'signaturImage', type: 'application/octet-stream' }, body)).toBe(true);
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'application/octet-stream', disposition: null }, body)).toBe(true);
  });

  it('hides referenced parts with no type at all', () => {
    expect(isEmbeddedInBody({ cid: 'logoImage' }, body)).toBe(true);
  });

  it('tolerates angle brackets around the JMAP cid', () => {
    expect(isEmbeddedInBody({ cid: '<logoImage>', type: 'application/octet-stream' }, body)).toBe(true);
  });

  it('keeps the legacy rule: declared inline images hide even without a reference', () => {
    expect(isEmbeddedInBody({ cid: 'unreferenced', type: 'image/png', disposition: 'inline' }, body)).toBe(true);
  });

  it('keeps an explicit attachment visible even when the body references it', () => {
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'image/png', disposition: 'attachment' }, body)).toBe(false);
  });

  it('keeps a referenced part with a real non-image type visible - the chip is its only download', () => {
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'application/pdf' }, body)).toBe(false);
  });

  it('never hides unreferenced parts without an inline declaration', () => {
    expect(isEmbeddedInBody({ cid: 'orphan', type: 'application/octet-stream' }, body)).toBe(false);
    expect(isEmbeddedInBody({ cid: 'orphan', type: 'image/png' }, body)).toBe(false);
  });

  it('never hides parts without a cid', () => {
    expect(isEmbeddedInBody({ type: 'image/png', disposition: 'inline' }, body)).toBe(false);
    expect(isEmbeddedInBody({ cid: null, type: 'application/octet-stream' }, body)).toBe(false);
  });

  it('hides nothing when the message renders as plain text', () => {
    const none = collectReferencedCids(null);
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'application/octet-stream' }, none)).toBe(false);
  });
});

describe('isEmbeddedInBody with an attached copy of an embedded image', () => {
  // Seen from Exchange Online: every image of the body twice, once inline and
  // once as an attachment with the same Content-ID, type and size.
  const body = collectReferencedCids('<p>Regards</p><img src="cid:image001.png"><img src="cid:image002.png">');
  const inline1 = { cid: 'image001.png', type: 'image/png', size: 23567, disposition: 'inline' };
  const inline2 = { cid: 'image002.png', type: 'image/png', size: 26526, disposition: 'inline' };
  const copy1 = { cid: 'image001.png', type: 'image/png', size: 23567, disposition: 'attachment' };
  const copy2 = { cid: 'image002.png', type: 'image/png', size: 26526, disposition: 'attachment' };
  const invoice = { cid: null, type: 'application/pdf', size: 51200, disposition: 'attachment' };
  const parts = [inline1, inline2, copy1, copy2, invoice];

  it('hides the copies along with the images they repeat, and keeps the real file', () => {
    expect(parts.filter((part) => !isEmbeddedInBody(part, body, parts))).toEqual([invoice]);
  });

  it('keeps a copy when it gets no parts to compare with', () => {
    expect(isEmbeddedInBody(copy1, body)).toBe(false);
  });

  it('keeps a copy whose Content-ID the body does not show', () => {
    expect(isEmbeddedInBody(copy1, collectReferencedCids('<img src="cid:image002.png">'), parts)).toBe(false);
    expect(isEmbeddedInBody(copy1, collectReferencedCids(null), parts)).toBe(false);
  });

  it('keeps a referenced attachment when no other part embeds that image', () => {
    expect(isEmbeddedInBody(copy1, body, [copy1, copy2, invoice])).toBe(false);
  });

  it('keeps an attachment that differs from the embedded image in Content-ID, size or type', () => {
    const elsewhere = { ...inline1, cid: 'image003.png' };
    expect(isEmbeddedInBody(copy1, body, [elsewhere, copy1])).toBe(false);
    const bigger = { ...copy1, size: 23568 };
    expect(isEmbeddedInBody(bigger, body, [inline1, bigger])).toBe(false);
    const jpeg = { ...copy1, type: 'image/jpeg' };
    expect(isEmbeddedInBody(jpeg, body, [inline1, jpeg])).toBe(false);
  });

  it('keeps a copy with no size, an empty one and one that is no image', () => {
    const noSize = { ...copy1, size: undefined };
    expect(isEmbeddedInBody(noSize, body, [{ ...inline1, size: undefined }, noSize])).toBe(false);
    const empty = { ...copy1, size: 0 };
    expect(isEmbeddedInBody(empty, body, [{ ...inline1, size: 0 }, empty])).toBe(false);
    const octet = { cid: 'image001.png', type: 'application/octet-stream', size: 23567, disposition: 'attachment' };
    expect(isEmbeddedInBody(octet, body, [{ ...octet, disposition: 'inline' }, octet])).toBe(false);
  });

  it('never lets two attachments make each other copies', () => {
    const again = { ...copy1 };
    expect(isEmbeddedInBody(copy1, body, [copy1, again])).toBe(false);
    expect(isEmbeddedInBody(again, body, [copy1, again])).toBe(false);
  });

  it('counts an image the body embeds without a disposition, with angle brackets and any case', () => {
    const embedded = { cid: '<image001.png>', type: 'IMAGE/PNG', size: 23567 };
    const copy = { ...copy1, cid: '<image001.png>' };
    expect(isEmbeddedInBody(copy, body, [embedded, copy])).toBe(true);
  });
});

describe('rewriteCidReferences', () => {
  it('swaps a cid: reference for its URL and an unknown one for the placeholder', () => {
    expect(rewriteCidReferences('<img src="cid:logo"><img src="cid:gone">', { logo: 'blob:x/1' }, 'data:,p'))
      .toBe('<img src="blob:x/1"><img src="data:,p">');
  });

  it('ends an unquoted reference at the tag instead of swallowing the markup after it', () => {
    const html = '<img src=cid:logo><p>Hello</p>';
    expect(rewriteCidReferences(html, { logo: 'blob:x/1' }, 'data:,p')).toBe('<img src=blob:x/1><p>Hello</p>');
    expect(collectReferencedCids(html)).toEqual(new Set(['logo']));
  });

  it('never resolves a reference through the object prototype', () => {
    expect(rewriteCidReferences('<img src="cid:constructor">', {}, 'data:,p')).toBe('<img src="data:,p">');
  });
});
