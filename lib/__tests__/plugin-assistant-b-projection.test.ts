import { describe, expect, it } from 'vitest';
import type { Email } from '../jmap/types';
import { emailToReadView } from '../plugin-projection';
import { cidAltTexts, normaliseCid } from '../plugin-sandbox/assistant/b.projection';

// An inline image of a message names its Content-ID and the alt text the
// sender wrote for it, so the assistant can name the picture.

const html = [
  '<p>Hi Alice, here is the logo idea:</p>',
  '<p><img width="240" src="cid:logo1@aa" alt="Orange logo with a stripe"></p>',
  "<img src='CID:chart%40aa' title='Sales &amp; costs'>",
  '<img src="cid:plain@aa" alt="">',
  '<img src="https://tracker.example.com/p.gif" alt="tracker" width="1" height="1">',
].join('');

const email = {
  id: 'm1', threadId: 't1', mailboxIds: { inbox: true }, keywords: {}, subject: 'Logo', receivedAt: '2026-05-01T10:00:00Z',
  htmlBody: [{ partId: '1', blobId: 'b-html', size: 1, type: 'text/html' }],
  bodyValues: { 1: { value: html } },
  attachments: [
    { partId: '2', blobId: 'blob-logo', name: 'logo.png', type: 'image/png', size: 10, disposition: 'inline', cid: '<logo1@aa>' },
    { partId: '3', blobId: 'blob-chart', name: 'chart.png', type: 'image/png', size: 10, cid: 'chart@aa' },
    { partId: '4', blobId: 'blob-plain', name: 'plain.png', type: 'image/png', size: 10, cid: 'plain@aa' },
    { partId: '5', blobId: 'blob-pdf', name: 'agenda.pdf', type: 'application/pdf', size: 10, disposition: 'attachment' },
  ],
} as unknown as Email;

describe('cid and alt on EmailReadView.attachments', () => {
  it('gives inline images their Content-ID and alt text, and leaves plain attachments alone', () => {
    const view = emailToReadView(email);
    expect(view.attachments).toEqual([
      { blobId: 'blob-logo', name: 'logo.png', type: 'image/png', size: 10, inline: true, cid: 'logo1@aa', alt: 'Orange logo with a stripe' },
      { blobId: 'blob-chart', name: 'chart.png', type: 'image/png', size: 10, inline: true, cid: 'chart@aa', alt: 'Sales & costs' },
      { blobId: 'blob-plain', name: 'plain.png', type: 'image/png', size: 10, inline: true, cid: 'plain@aa' },
      { blobId: 'blob-pdf', name: 'agenda.pdf', type: 'application/pdf', size: 10, inline: false },
    ]);
  });

  it('reads alt texts only of cid images, never of remote ones', () => {
    expect([...cidAltTexts(email).entries()]).toEqual([['logo1@aa', 'Orange logo with a stripe'], ['chart@aa', 'Sales & costs']]);
    expect(normaliseCid('<Logo1%40AA>')).toBe('logo1@aa');
  });

  it('copes with a message without HTML', () => {
    const plain = { ...email, htmlBody: [], bodyValues: {} } as unknown as Email;
    expect(emailToReadView(plain).attachments[0]).toEqual({ blobId: 'blob-logo', name: 'logo.png', type: 'image/png', size: 10, inline: true, cid: 'logo1@aa' });
  });
});
