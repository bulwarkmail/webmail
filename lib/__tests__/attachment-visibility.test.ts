import { describe, it, expect } from 'vitest';
import { collectReferencedCids, isEmbeddedInBody } from '@/lib/attachment-visibility';

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
