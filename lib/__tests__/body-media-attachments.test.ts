import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addBodyMediaToAttachments } from '../jmap/body-media-attachments';
import { JMAPClient } from '../jmap/client';
import type { EmailBodyPart } from '../jmap/types';

// The part lists Stalwart 1.0.1 returned for Apple Mail messages (#1478).
const part = (partId: string, type: string, extra: Partial<EmailBodyPart> = {}): EmailBodyPart =>
  ({ partId, blobId: `blob-${partId}`, size: 100, type, ...extra });

const photo = part('2', 'image/webp', { disposition: 'inline', name: 'photo.webp' });

/** Plain text: mixed { text, image, text }. The picture is only in the body lists. */
function applePlain() {
  const body = [part('1', 'text/plain'), photo, part('3', 'text/plain')];
  return { textBody: body, htmlBody: [...body], attachments: [] as EmailBodyPart[] };
}

/** Rich text: alternative { text, mixed { html, image, html } }. Stalwart lists the picture as an attachment too. */
function appleHtml() {
  const jpg = part('4', 'image/jpeg', { disposition: 'inline', name: 'photo.jpg' });
  return {
    textBody: [part('1', 'text/plain')],
    htmlBody: [part('3', 'text/html'), jpg, part('5', 'text/html')],
    attachments: [jpg],
  };
}

describe('addBodyMediaToAttachments (#1478)', () => {
  it('lists a picture that only sits between the text parts, once', () => {
    const email = addBodyMediaToAttachments(applePlain());
    expect(email.attachments).toEqual([
      { partId: '2', blobId: 'blob-2', size: 100, type: 'image/webp', name: 'photo.webp', disposition: 'inline' },
    ]);
  });

  it('leaves a picture that is already an attachment alone', () => {
    const email = addBodyMediaToAttachments(appleHtml());
    expect(email.attachments.map((a) => a.partId)).toEqual(['4']);
  });

  it('adds audio and video too, but never text or other parts', () => {
    const email = addBodyMediaToAttachments({
      textBody: [part('1', 'text/plain'), part('2', 'audio/mpeg'), part('3', 'video/mp4'), part('4', 'text/calendar'), part('5', 'application/pdf')],
      htmlBody: [],
      attachments: [part('9', 'application/zip')],
    });
    expect(email.attachments.map((a) => a.partId)).toEqual(['9', '2', '3']);
  });

  it('keeps a Content-ID only when the HTML links to it', () => {
    const linked = part('2', 'image/png', { disposition: 'inline', cid: '<a@x>' });
    const unlinked = part('3', 'image/png', { disposition: 'inline', cid: 'b@x' });
    const email = addBodyMediaToAttachments({
      textBody: [],
      htmlBody: [part('1', 'text/html'), linked, unlinked],
      attachments: [] as EmailBodyPart[],
      bodyValues: { '1': { value: '<img src="cid:a@x">' } },
    });
    expect(email.attachments.map((a) => [a.partId, a.cid])).toEqual([['2', '<a@x>'], ['3', undefined]]);
  });

  it('copes with missing lists', () => {
    expect(addBodyMediaToAttachments({} as { attachments?: EmailBodyPart[] }).attachments).toBeUndefined();
  });
});

describe('JMAPClient lists Apple Mail pictures as attachments (#1478)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch'); });
  afterEach(() => { fetchSpy.mockRestore(); });

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  async function client(): Promise<JMAPClient> {
    fetchSpy.mockResolvedValueOnce(json({
      capabilities: { 'urn:ietf:params:jmap:core': {} },
      accounts: { 'acct-1': { name: 'test', isPersonal: true, accountCapabilities: {} } },
      primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acct-1' },
      apiUrl: 'https://mail.example.com/jmap/api',
      downloadUrl: 'https://mail.example.com/jmap/download/{accountId}/{blobId}/{name}',
      uploadUrl: 'https://mail.example.com/jmap/upload/{accountId}/',
      eventSourceUrl: 'https://mail.example.com/jmap/eventsource',
    }));
    const c = new JMAPClient('https://mail.example.com', 'user@test.com', 'pass123');
    await c.connect();
    fetchSpy.mockReset();
    return c;
  }

  it('getEmail', async () => {
    const c = await client();
    fetchSpy.mockResolvedValueOnce(json({ methodResponses: [['Email/get', { list: [{ id: 'm1', ...applePlain(), bodyValues: {} }] }, '0']] }));
    const email = await c.getEmail('m1');
    expect(email?.attachments?.map((a) => a.name)).toEqual(['photo.webp']);
  });

  it('getEmailAttachments asks for the body lists and returns the picture', async () => {
    const c = await client();
    fetchSpy.mockResolvedValueOnce(json({ methodResponses: [['Email/get', { list: [{ id: 'm1', ...applePlain() }] }, '0']] }));
    const map = await c.getEmailAttachments(['m1']);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body));
    expect(sent.methodCalls[0][1].properties).toEqual(expect.arrayContaining(['attachments', 'textBody', 'htmlBody']));
    expect(map.get('m1')?.map((a) => a.name)).toEqual(['photo.webp']);
  });
});
