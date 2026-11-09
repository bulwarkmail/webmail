import { describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Attachment, Email } from '@/lib/jmap/types';
import { MAIL_DATE, boardingPass, eventTicket, zipPass } from '@/lib/structured-mail/__tests__/pkpass-fixtures';
import { pkpassSource } from '../pkpass-source';
import { CARD_SOURCES } from '../sources';

const PASS_ATT: Attachment = { partId: '2', blobId: 'blob-pass', size: 3000, name: 'BoardingPass.pkpass', type: 'application/octet-stream' };
const PDF_ATT: Attachment = { partId: '3', blobId: 'blob-pdf', size: 3000, name: 'invoice.pdf', type: 'application/pdf' };

function mail(fields: Partial<Email>): Email {
  return { id: 'm1', threadId: 't', mailboxIds: {}, keywords: {}, size: 1, receivedAt: MAIL_DATE.toISOString(), ...fields } as Email;
}

function clientFor(blobs: Record<string, Uint8Array | Error>) {
  const fetchBlobArrayBuffer = vi.fn(async (blobId: string) => {
    const blob = blobs[blobId];
    if (!blob) throw new Error(`no blob ${blobId}`);
    if (blob instanceof Error) throw blob;
    return blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer;
  });
  return { client: { fetchBlobArrayBuffer } as unknown as IJMAPClient, fetchBlobArrayBuffer };
}

function run(email: Email, client: IJMAPClient | null, signal = new AbortController().signal) {
  return pkpassSource({ email, mailDate: MAIL_DATE, blob: { client, accountId: 'acc-7' }, signal });
}

describe('pkpassSource', () => {
  it('is registered as a card source', () => {
    expect(CARD_SOURCES).toContain(pkpassSource);
  });

  it('downloads the pass attachment from the message account and returns its card', async () => {
    const { client, fetchBlobArrayBuffer } = clientFor({ 'blob-pass': await zipPass(boardingPass()) });
    const cards = await run(mail({ attachments: [PDF_ATT, PASS_ATT] }), client);
    expect(cards).toMatchObject([{ kind: 'flight', source: 'pkpass', reference: 'PK7Q2Z' }]);
    expect(fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    expect(fetchBlobArrayBuffer).toHaveBeenCalledWith('blob-pass', 'BoardingPass.pkpass', 'application/octet-stream', 'acc-7', 5 * 1024 * 1024 + 1);
  });

  it('downloads nothing that is not a pass, and at most three passes', async () => {
    const bytes = await zipPass(eventTicket());
    const passes = [1, 2, 3, 4].map((i) => ({ ...PASS_ATT, blobId: `p${i}`, partId: `p${i}` }));
    const { client, fetchBlobArrayBuffer } = clientFor({ p1: bytes, p2: bytes, p3: bytes, p4: bytes });
    await run(mail({ attachments: [PDF_ATT, { ...PASS_ATT, blobId: 'big', size: 6 * 1024 * 1024 }, ...passes] }), client);
    expect(fetchBlobArrayBuffer.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2', 'p3']);
  });

  it('reads email.attachments only, never a pass inside an attached message', async () => {
    const { client, fetchBlobArrayBuffer } = clientFor({ 'blob-pass': await zipPass(boardingPass()) });
    const embedded = mail({
      attachments: [{ partId: '2', blobId: 'blob-eml', size: 9000, name: 'forwarded.eml', type: 'message/rfc822' }],
      bodyStructure: {
        partId: '0', blobId: 'root', size: 9000, type: 'multipart/mixed',
        subParts: [{ partId: '2', blobId: 'blob-eml', size: 9000, type: 'message/rfc822', subParts: [{ ...PASS_ATT }] }],
      } as Email['bodyStructure'],
      textBody: [{ ...PASS_ATT }] as Email['textBody'],
    });
    expect(await run(embedded, client)).toEqual([]);
    expect(fetchBlobArrayBuffer).not.toHaveBeenCalled();
  });

  it('stops between downloads once the message is closed', async () => {
    const bytes = await zipPass(boardingPass());
    const controller = new AbortController();
    const { client, fetchBlobArrayBuffer } = clientFor({ p1: bytes, p2: bytes });
    fetchBlobArrayBuffer.mockImplementationOnce(async () => {
      controller.abort();
      return bytes.buffer.slice(0) as ArrayBuffer;
    });
    const cards = await run(mail({ attachments: [{ ...PASS_ATT, blobId: 'p1' }, { ...PASS_ATT, blobId: 'p2' }] }), client, controller.signal);
    expect(cards).toEqual([]);
    expect(fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);

    const late = new AbortController();
    fetchBlobArrayBuffer.mockImplementationOnce(async () => {
      late.abort();
      return bytes.buffer.slice(0) as ArrayBuffer;
    });
    expect(await run(mail({ attachments: [{ ...PASS_ATT, blobId: 'p1' }] }), client, late.signal)).toEqual([]);
  });

  it('gives an empty list, without throwing, when the download fails or there is no client', async () => {
    const { client, fetchBlobArrayBuffer } = clientFor({ 'blob-pass': new Error('Failed to fetch blob: 500') });
    await expect(run(mail({ attachments: [PASS_ATT] }), client)).resolves.toEqual([]);
    expect(fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
    await expect(run(mail({ attachments: [PASS_ATT] }), null)).resolves.toEqual([]);
    await expect(run(mail({ attachments: [{ ...PASS_ATT, blobId: '' }] }), client)).resolves.toEqual([]);
    expect(fetchBlobArrayBuffer).toHaveBeenCalledTimes(1);
  });
});
