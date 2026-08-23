import { describe, it, expect } from 'vitest';
import {
  collectSignatureAssetIds,
  buildJmapSignatureFallback,
  applyResolvedSignatureAssets,
  upsertExtendedSignature,
  getExtendedSignature,
  removeExtendedSignature,
} from '../extended-signatures';
import { rewriteInlineImagesHtml } from '../inline-images';
import { sanitizeSignatureHtml } from '../email-sanitization';

const ASSET_A = '550e8400-e29b-41d4-a716-446655440000';
const ASSET_B = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('extended-signatures', () => {
  it('collects unique asset ids from HTML', () => {
    const html = `<p>Jane Doe</p><img data-signature-asset="${ASSET_A}"><img data-signature-asset="${ASSET_A}"><img data-signature-asset="${ASSET_B}">`;
    expect(collectSignatureAssetIds(html)).toEqual([ASSET_A, ASSET_B]);
  });

  it('builds a JMAP fallback without asset images', () => {
    const html = `<p>Jane Doe</p><p><img data-signature-asset="${ASSET_A}" alt=""></p>`;
    const fallback = buildJmapSignatureFallback(html);
    expect(fallback).toContain('Jane Doe');
    expect(fallback).not.toContain('data-signature-asset');
    expect(fallback).not.toContain('<img');
  });

  it('preserves data-signature-asset through sanitization', () => {
    const html = `<p>Sig</p><img data-signature-asset="${ASSET_A}" alt="logo">`;
    const clean = sanitizeSignatureHtml(html);
    expect(clean).toContain(`data-signature-asset="${ASSET_A}"`);
    expect(clean).toContain('<img');
  });

  it('applies resolved assets and drops failed ones', () => {
    const html = `<img data-signature-asset="${ASSET_A}"><img data-signature-asset="${ASSET_B}">`;
    const resolved = new Map([[ASSET_A, { dataUrl: 'data:image/png;base64,aa', cid: 'cid-a@webmail' }]]);
    const out = applyResolvedSignatureAssets(html, resolved, new Set([ASSET_B]));
    expect(out).toContain('data:image/png;base64,aa');
    expect(out).toContain('data-cid="cid-a@webmail"');
    expect(out).not.toContain(ASSET_B);
  });

  it('upserts and removes extended signatures in the settings map', () => {
    let map = upsertExtendedSignature({}, 'acct-1', 'h', `<img data-signature-asset="${ASSET_A}">`);
    expect(getExtendedSignature(map, 'acct-1', 'h')?.assets).toEqual([ASSET_A]);
    map = removeExtendedSignature(map, 'acct-1', 'h');
    expect(getExtendedSignature(map, 'acct-1', 'h')).toBeNull();
  });
});

describe('rewriteInlineImagesHtml', () => {
  it('rewrites data-cid to cid: and strips signature asset attrs', () => {
    const html = `<img src="data:image/png;base64,xx" data-cid="abc@webmail" data-signature-asset="${ASSET_A}">`;
    const { html: out, attachments } = rewriteInlineImagesHtml(html, [
      {
        cid: 'abc@webmail',
        blobId: 'blob-1',
        type: 'image/png',
        name: 'sig.png',
        size: 12,
        dataUrl: 'data:image/png;base64,xx',
        signatureAssetId: ASSET_A,
      },
    ]);
    expect(out).toContain('src="cid:abc@webmail"');
    expect(out).not.toContain('data-cid');
    expect(out).not.toContain('data-signature-asset');
    expect(attachments).toEqual([
      {
        blobId: 'blob-1',
        name: 'sig.png',
        type: 'image/png',
        size: 12,
        disposition: 'inline',
        cid: 'abc@webmail',
      },
    ]);
  });
});
