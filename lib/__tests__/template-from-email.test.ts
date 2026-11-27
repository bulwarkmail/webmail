import { describe, expect, it, vi } from 'vitest';
import type { Attachment, Email } from '@/lib/jmap/types';
import { embedCidImages, isOwnMail, templateDraftFromEmail } from '../template-from-email';

const part = (cid: string, blobId: string): Attachment => ({ partId: blobId, blobId, size: 10, type: 'image/png', cid, disposition: 'inline' });

const htmlEmail = (html: string, extra: Partial<Email> = {}): Email => ({
  id: 'e1',
  subject: 'Quarterly update',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  to: [{ name: 'Bob', email: 'bob@example.com' }],
  cc: [{ email: 'carol@example.com' }],
  htmlBody: [{ partId: '1', blobId: 'body', size: html.length, type: 'text/html' }],
  textBody: [],
  bodyValues: { 1: { value: html } },
  attachments: [],
  ...extra,
} as unknown as Email);

describe('embedCidImages', () => {
  it('puts each image in the body as a data: URL, one download per part', async () => {
    const loadImage = vi.fn(async (p: Attachment) => `data:image/png;base64,${p.blobId}`);
    const { html, dropped } = await embedCidImages(
      '<p><img src="cid:logo@x"><img src="cid:logo@x"><img src="https://example.com/a.png"></p>',
      [part('<logo@x>', 'b-logo')],
      loadImage,
    );
    expect(html).toBe('<p><img src="data:image/png;base64,b-logo"><img src="data:image/png;base64,b-logo"><img src="https://example.com/a.png"></p>');
    expect(dropped).toBe(0);
    expect(loadImage).toHaveBeenCalledTimes(1);
  });

  it('matches a cid written URL-encoded in the body', async () => {
    const { html } = await embedCidImages('<img src="cid:a%40b">', [part('a@b', 'b1')], async () => 'data:image/png;base64,AA');
    expect(html).toBe('<img src="data:image/png;base64,AA">');
  });

  it('leaves out an image whose part is missing or fails to load, and counts it', async () => {
    const { html, dropped } = await embedCidImages(
      '<p>a<img src="cid:gone">b<img src="cid:broken">c</p>',
      [part('broken', 'b-broken')],
      async () => {
        throw new Error('network');
      },
    );
    expect(html).toBe('<p>abc</p>');
    expect(dropped).toBe(2);
  });

  it('returns a body without cid: images as it is', async () => {
    const loadImage = vi.fn();
    const body = '<p>Hello</p>';
    expect(await embedCidImages(body, [], loadImage)).toEqual({ html: body, dropped: 0 });
    expect(loadImage).not.toHaveBeenCalled();
  });
});

describe('templateDraftFromEmail', () => {
  const noImages = async () => null;

  it('keeps the subject and the sanitized HTML body, with its images', async () => {
    const email = htmlEmail('<p onclick="x()">Hi<img src="cid:pic"></p><script>alert(1)</script>', {
      attachments: [part('pic', 'b-pic')],
    });
    const draft = await templateDraftFromEmail(email, { ownMail: false, loadImage: async () => 'data:image/png;base64,AA' });
    expect(draft.subject).toBe('Quarterly update');
    expect(draft.isHTML).toBe(true);
    expect(draft.body).toBe('<p>Hi<img src="data:image/png;base64,AA"></p>');
    expect(draft.droppedImages).toBe(0);
  });

  it('keeps a text-only message as text', async () => {
    const email = htmlEmail('', {
      htmlBody: [],
      textBody: [{ partId: '2', blobId: 't', size: 5, type: 'text/plain' }],
      bodyValues: { 2: { value: 'Line one\nLine two' } },
    } as Partial<Email>);
    const draft = await templateDraftFromEmail(email, { ownMail: false, loadImage: noImages });
    expect(draft).toMatchObject({ body: 'Line one\nLine two', isHTML: false, droppedImages: 0 });
  });

  it('leaves out the Re:/Fwd: prefixes and the quoted original of a reply', async () => {
    const email = htmlEmail('<p>Works for me.</p><p>On Mon, Bob wrote:</p><div data-quoted-html="true"><p>Lunch?</p></div>', {
      subject: 'AW: Fwd: Re: Lunch',
    });
    const draft = await templateDraftFromEmail(email, { ownMail: false, loadImage: noImages });
    expect(draft.subject).toBe('Lunch');
    expect(draft.body).toBe('<p>Works for me.</p>');
  });

  it('leaves out the quoted original of a text reply', async () => {
    const email = htmlEmail('', {
      subject: 'Re: Lunch',
      htmlBody: [],
      textBody: [{ partId: '2', blobId: 't', size: 5, type: 'text/plain' }],
      bodyValues: { 2: { value: 'Works for me.\n\nOn Mon, Bob wrote:\n> Lunch?' } },
    } as Partial<Email>);
    const draft = await templateDraftFromEmail(email, { ownMail: false, loadImage: noImages });
    expect(draft).toMatchObject({ subject: 'Lunch', body: 'Works for me.', isHTML: false });
  });

  it("keeps the recipients of the user's own mail only", async () => {
    const own = await templateDraftFromEmail(htmlEmail('<p>x</p>'), { ownMail: true, loadImage: noImages });
    expect(own.to).toEqual(['Bob <bob@example.com>']);
    expect(own.cc).toEqual(['carol@example.com']);
    expect(own.bcc).toBeUndefined();
    const received = await templateDraftFromEmail(htmlEmail('<p>x</p>'), { ownMail: false, loadImage: noImages });
    expect(received.to).toBeUndefined();
    expect(received.cc).toBeUndefined();
  });
});

describe('isOwnMail', () => {
  const from = (address: string) => ({ from: [{ email: address }] });

  it('is own mail in Sent or Drafts, or from one of the user\'s addresses', () => {
    expect(isOwnMail(from('someone@example.com'), ['sent'], [])).toBe(true);
    expect(isOwnMail(from('someone@example.com'), ['drafts'], [])).toBe(true);
    expect(isOwnMail(from('Me@Example.com'), ['inbox'], ['me@example.com'])).toBe(true);
    expect(isOwnMail(from('someone@example.com'), ['inbox'], ['me@example.com'])).toBe(false);
  });
});
