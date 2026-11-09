import { describe, it, expect } from 'vitest';
import { readMessageDate } from '@/lib/eml-import';
import { emlSource, zipSource, type ImportItem } from '@/lib/mail-import/sources';
import { ZipWriter } from '@/lib/mail-export/zip-writer';

const emlFile = (name: string, content = 'raw email', type = 'message/rfc822') =>
  new File([content], name, { type });

const opts = { skipBefore: 0, maxMessageBytes: 50_000_000 };

async function all(source: AsyncGenerator<ImportItem>): Promise<ImportItem[]> {
  const out: ImportItem[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('Date header as receivedAt (#891)', () => {
  const CRLF = String.fromCharCode(13, 10);
  const raw = [
    'From: Alice <alice@example.com>',
    'Subject: old mail',
    'Date: Tue, 5 Mar 2019 09:30:00',
    ' +0100 (CET)',
    '',
    'Date: Wed, 1 Jan 2025 00:00:00 +0000',
    'body',
  ].join(CRLF);

  it('carries the Date header of an .eml file as a JMAP UTCDate', async () => {
    const [item] = await all(emlSource(emlFile('old.eml', raw), opts));
    expect(item).toMatchObject({ kind: 'message', receivedAt: '2019-03-05T08:30:00Z' });
  });

  it('carries the Date header of each .eml inside a .zip', async () => {
    const parts: Uint8Array[] = [];
    const z = new ZipWriter(async (c) => { parts.push(c.slice()); });
    await z.addFile('old.eml', new TextEncoder().encode(raw));
    await z.finish();
    const [item] = await all(zipSource(new File(parts as BlobPart[], 'a.zip', { type: 'application/zip' }), opts));
    expect(item).toMatchObject({ kind: 'message', receivedAt: '2019-03-05T08:30:00Z' });
  });

  it('leaves receivedAt unset when there is no usable Date header', async () => {
    const bodyOnly = ['Subject: x', '', 'Date: Tue, 5 Mar 2019 09:30:00 +0100'].join(CRLF);
    await expect(readMessageDate(new Blob([bodyOnly]))).resolves.toBeUndefined();
    const garbage = ['Date: not a date', '', 'body'].join(CRLF);
    await expect(readMessageDate(new Blob([garbage]))).resolves.toBeUndefined();
  });

  it('ignores a Date header far in the future', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const future = ['Date: Fri, 1 Jan 2027 00:00:00 +0000', '', 'body'].join(CRLF);
    await expect(readMessageDate(new Blob([future]), now)).resolves.toBeUndefined();
  });
});
