import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { relatedBodyStructure } from '../jmap/outgoing-body';

/**
 * #1451: given textBody/htmlBody/attachments, Stalwart puts a pasted image
 * (inline, with a Content-ID) into the outer multipart/mixed, so recipients
 * and our own Sent view don't show it. When the HTML shows an image by cid:
 * the message is created with an explicit bodyStructure that keeps the image
 * in a multipart/related beside the HTML part.
 */

const IMAGE = { blobId: 'blob-img', name: 'image.png', type: 'image/png', size: 10, disposition: 'inline' as const, cid: 'img1@webmail' };
const PDF = { blobId: 'blob-pdf', name: 'report.pdf', type: 'application/pdf', size: 20 };
const HTML = '<p>Hello <img src="cid:img1@webmail"></p>';

const IMAGE_PART = { blobId: 'blob-img', name: 'image.png', type: 'image/png', disposition: 'inline', cid: 'img1@webmail' };
const PDF_PART = { blobId: 'blob-pdf', name: 'report.pdf', type: 'application/pdf', disposition: 'attachment' };
const ALTERNATIVE = {
  type: 'multipart/alternative',
  subParts: [
    { partId: 'text', type: 'text/plain' },
    { type: 'multipart/related', subParts: [{ partId: 'html', type: 'text/html' }, IMAGE_PART] },
  ],
};

describe('relatedBodyStructure', () => {
  it('puts a referenced inline image into multipart/related beside the HTML', () => {
    expect(relatedBodyStructure(HTML, [IMAGE])).toEqual(ALTERNATIVE);
  });

  it('wraps the body in multipart/mixed when there are regular attachments too', () => {
    expect(relatedBodyStructure(HTML, [PDF, IMAGE])).toEqual({
      type: 'multipart/mixed',
      subParts: [ALTERNATIVE, PDF_PART],
    });
  });

  it('matches a cid given in angle brackets or another case', () => {
    const structure = relatedBodyStructure('<img src="CID:Img1@Webmail">', [{ ...IMAGE, cid: '<img1@webmail>' }]);
    expect(structure?.type).toBe('multipart/alternative');
  });

  it('leaves the structure to the server when nothing is shown by cid', () => {
    expect(relatedBodyStructure(undefined, [IMAGE])).toBeNull();
    expect(relatedBodyStructure('<p>no images</p>', [IMAGE, PDF])).toBeNull();
    expect(relatedBodyStructure(HTML, [PDF])).toBeNull();
    expect(relatedBodyStructure(HTML, [{ ...IMAGE, disposition: 'attachment' }])).toBeNull();
  });

  it('keeps an inline part the HTML does not reference with the attachments', () => {
    const unused = { ...IMAGE, blobId: 'blob-unused', cid: 'unused@webmail' };
    const structure = relatedBodyStructure(HTML, [IMAGE, unused]);
    expect(structure?.type).toBe('multipart/mixed');
    expect(structure?.subParts?.[1]).toMatchObject({ blobId: 'blob-unused', cid: 'unused@webmail' });
  });
});

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
    username: 'user@example.com',
  });
  return client;
}

type Call = [string, Record<string, unknown>, string];

function mockServer(): Array<Record<string, unknown>> {
  const creates: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse((init as { body: string }).body) as { methodCalls: Call[] };
    const methodResponses: unknown[] = [];
    for (const [method, args, callId] of body.methodCalls) {
      if (method === 'Mailbox/get') {
        methodResponses.push([method, { list: [{ id: 'mb-drafts', role: 'drafts' }, { id: 'mb-sent', role: 'sent' }] }, callId]);
      } else if (method === 'Identity/get') {
        methodResponses.push([method, { list: [{ id: 'identity-1', email: 'user@example.com' }] }, callId]);
      } else if (method === 'Email/set') {
        const create = args.create as Record<string, Record<string, unknown>> | undefined;
        const key = create ? Object.keys(create)[0] : undefined;
        if (key && create) creates.push(create[key]);
        methodResponses.push([method, key ? { created: { [key]: { id: 'email-1' } } } : {}, callId]);
      } else if (method === 'EmailSubmission/set') {
        methodResponses.push([method, { created: { '1': { id: 'sub-1' } } }, callId]);
      }
    }
    const payload = { methodResponses };
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
      json: () => Promise.resolve(payload),
    } as Response;
  });
  return creates;
}

describe('pasted images in drafts and sent mail (#1451)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('createDraft keeps a pasted image inside the HTML body', async () => {
    const creates = mockServer();
    await createClient().createDraft(
      ['bob@example.com'], 'Subject', 'Hello',
      undefined, undefined, undefined, undefined, undefined,
      [PDF, IMAGE], undefined, HTML,
    );

    expect(creates[0].bodyStructure).toEqual({ type: 'multipart/mixed', subParts: [ALTERNATIVE, PDF_PART] });
    expect(creates[0].bodyValues).toEqual({ text: { value: 'Hello' }, html: { value: HTML } });
    // bodyStructure excludes the convenience properties (RFC 8621 §4.6).
    expect(creates[0]).not.toHaveProperty('textBody');
    expect(creates[0]).not.toHaveProperty('htmlBody');
    expect(creates[0]).not.toHaveProperty('attachments');
  });

  it('sendEmail keeps a pasted image inside the HTML body', async () => {
    const creates = mockServer();
    await createClient().sendEmail(
      ['bob@example.com'], 'Subject', 'Hello',
      undefined, undefined, 'identity-1', 'user@example.com', undefined, undefined, HTML,
      [IMAGE],
    );

    expect(creates[0].bodyStructure).toEqual(ALTERNATIVE);
    expect(creates[0].bodyValues).toEqual({ text: { value: 'Hello' }, html: { value: HTML } });
    expect(creates[0]).not.toHaveProperty('textBody');
    expect(creates[0]).not.toHaveProperty('htmlBody');
    expect(creates[0]).not.toHaveProperty('attachments');
  });

  it('sendEmail without cid images still lets the server build the structure', async () => {
    const creates = mockServer();
    await createClient().sendEmail(
      ['bob@example.com'], 'Subject', 'Hello',
      undefined, undefined, 'identity-1', 'user@example.com', undefined, undefined, '<p>Hello</p>',
      [PDF],
    );

    expect(creates[0]).not.toHaveProperty('bodyStructure');
    expect(creates[0].htmlBody).toEqual([{ partId: 'html', type: 'text/html' }]);
    expect(creates[0].attachments).toEqual([PDF_PART]);
  });
});
