// A message that comes out of an imported file keeps its own "Received" and
// "Authentication-Results" lines, and the server stores it as it is. Those lines say what some
// server once found, or what the file's author wrote; this server never checked the message. So the
// import marks what it uploads with the keyword `$imported`, and the reader does not build trust on
// the headers of a message that carries it: no booking card, no sender logo, no trusted invitation.
// The message itself is not changed.
import { describe, expect, it } from 'vitest';
import { authenticationResultsOnReceipt, brandIndicatorDomain, parseAuthenticationResults } from '@/lib/email-headers';
import { getStructuredMailTrust } from '@/lib/structured-mail/trust';
import { getInvitationTrustAssessment } from '@/lib/calendar-invitation';
import { emlSource, mboxSource, zipSource, type ImportItem, type ItemSource } from '@/lib/mail-import/sources';
import { runImport, type ImportOptions } from '@/lib/mail-import/engine';
import { ZipWriter } from '@/lib/mail-export/zip-writer';
import type { IJMAPClient, UploadedEmailImport } from '@/lib/jmap/client-interface';
import type { CalendarEvent, Email, Mailbox } from '@/lib/jmap/types';

const HEAD = [
  'Received: from mx.bigbank.example (mx.bigbank.example [203.0.113.7]) by mail.example.org with ESMTPS id abc; Mon, 2 Nov 2026 09:00:00 +0000',
  'Authentication-Results: mail.example.org; dkim=pass header.d=bigbank.example header.s=s1; spf=pass smtp.mailfrom=bigbank.example; dmarc=pass header.from=bigbank.example',
  'From: Big Bank <service@bigbank.example>',
  'To: reader@example.org',
  'Subject: Your statement',
  'Date: Mon, 2 Nov 2026 09:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
];
const EML = [...HEAD, '', '<p>Your statement is ready.</p>', ''].join('\r\n');

const headers = HEAD.map((line) => ({ name: line.slice(0, line.indexOf(':')), value: line.slice(line.indexOf(':') + 1) }));

/** The message as the reader gets it back from the server. */
function stored(keywords: Record<string, true>) {
  return {
    from: [{ name: 'Big Bank', email: 'service@bigbank.example' }], subject: 'Your statement', keywords,
    authenticationResults: parseAuthenticationResults(headers.filter((h) => h.name === 'Authentication-Results').map((h) => h.value)),
    authenticationResultsOnReceipt: authenticationResultsOnReceipt(headers),
    headers,
    htmlBody: [{ partId: '1', type: 'text/html' }], textBody: [], bodyValues: { 1: { value: '<p>Your statement is ready.</p>' } },
    bodyStructure: { partId: '1', type: 'text/html' },
  } as never;
}

const SOURCE_OPTIONS = { maxMessageBytes: 1e9, skipBefore: 0 };

async function collect(source: ItemSource) {
  const items: ImportItem[] = [];
  for await (const item of source) items.push(item);
  return items.filter((item) => item.kind === 'message') as Extract<ImportItem, { kind: 'message' }>[];
}

async function zipOf(entries: Record<string, string>): Promise<File> {
  const parts: Uint8Array[] = [];
  const zip = new ZipWriter(async (chunk) => { parts.push(chunk.slice()); });
  for (const [name, text] of Object.entries(entries)) await zip.addFile(name, new TextEncoder().encode(text));
  await zip.finish();
  return new File(parts as BlobPart[], 'mail.zip', { lastModified: 1 });
}

const box = (id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  myRights: {} as Mailbox['myRights'], ...extra,
});

/** A server that takes uploads and Email/import calls, and remembers what was imported. */
function fakeServer(failWhen?: (text: string) => boolean) {
  const imported: Array<UploadedEmailImport & { text: string }> = [];
  const blobs = new Map<string, string>();
  let n = 0;
  const client = {
    getAccountId: () => 'acc',
    getCapabilities: () => ({ 'urn:ietf:params:jmap:core': { maxConcurrentUpload: 2 } }),
    getMaxConcurrentRequests: () => 2,
    getMaxSizeUpload: () => 1e9,
    getMailboxes: async () => [box('in', 'Inbox', { role: 'inbox' }), box('target', 'Target')],
    createMailbox: async (name: string) => box(`c-${name}`, name),
    uploadBlob: async (f: File) => {
      const text = await f.text();
      if (failWhen?.(text)) throw new Error('Failed to upload file: 500 - oops');
      const id = `b${n++}`;
      blobs.set(id, text);
      return { blobId: id, size: f.size, type: f.type };
    },
    importUploadedEmails: async (entries: UploadedEmailImport[]) => entries.map((e) => {
      imported.push({ ...e, text: blobs.get(e.blobId)! });
      return { id: `e${imported.length}` };
    }),
  } as unknown as IJMAPClient;
  return { client, imported };
}

function importOptions(client: IJMAPClient, files: ImportOptions['files'], extra: Partial<ImportOptions> = {}): ImportOptions {
  return {
    client, accountId: 'acc', targetMailboxId: 'target', keepFolders: false, files, scope: 'marks', resume: false,
    signal: new AbortController().signal, onProgress: () => {}, sleep: async () => {}, reportEveryMs: 0, ...extra,
  };
}

describe('mail that came out of an imported file', () => {
  it('is uploaded with the $imported keyword', async () => {
    const [item] = await collect(emlSource(new File([EML], 'statement.eml'), SOURCE_OPTIONS));
    expect(item.keywords.$imported).toBe(true);
  });

  it('keeps the keyword when the file sets keywords of its own', async () => {
    const withState = EML.replace('MIME-Version: 1.0', 'X-Keywords: $notjunk\r\nStatus: RO\r\nMIME-Version: 1.0');
    const [item] = await collect(emlSource(new File([withState], 'statement.eml'), SOURCE_OPTIONS));
    expect(item.keywords).toEqual({ $seen: true, $notjunk: true, $imported: true });
    // Naming the keyword itself changes nothing either.
    const naming = EML.replace('MIME-Version: 1.0', 'X-Keywords: $imported\r\nMIME-Version: 1.0');
    const [again] = await collect(emlSource(new File([naming], 'statement.eml'), SOURCE_OPTIONS));
    expect(again.keywords.$imported).toBe(true);
  });

  it('is marked from an mbox, a ZIP of .eml files and an mbox inside a ZIP', async () => {
    const mbox = `From a@example.org Mon Nov  2 09:00:00 2026\n${EML.replace(/\r\n/g, '\n')}\nFrom b@example.org Mon Nov  2 09:00:00 2026\nX-Keywords: $flagged\nSubject: b\n\nb\n`;
    const fromMbox = await collect(mboxSource(new File([mbox], 'mail.mbox'), SOURCE_OPTIONS));
    expect(fromMbox).toHaveLength(2);
    expect(fromMbox.every((item) => item.keywords.$imported)).toBe(true);

    const zip = await zipOf({ 'Inbox/a.eml': EML, 'b.eml': EML, 'Archive/2020.mbox': mbox });
    const fromZip = await collect(zipSource(zip, SOURCE_OPTIONS));
    expect(fromZip).toHaveLength(4);
    expect(fromZip.every((item) => item.keywords.$imported)).toBe(true);
  });

  it('reaches the server marked, also from a PST and on a resumed import', async () => {
    // A PST source hands over the keywords the PST holds; the upload adds the mark.
    const pstServer = fakeServer();
    async function* pst(): ItemSource {
      yield { kind: 'message', index: 0, folder: [], data: new Blob([EML]), size: EML.length, keywords: { $seen: true }, label: 'statement' };
    }
    await runImport(importOptions(pstServer.client, [{ file: new File(['!BDN'], 'Outlook.pst'), format: 'pst' }], { openPst: () => pst() }));
    expect(pstServer.imported.map((e) => e.keywords)).toEqual([{ $seen: true, $imported: true }]);

    // The first run fails on one message; the next run picks up only that one, and marks it too.
    const mbox = ['m0', 'm1', 'm2'].map((s) => `From a@example.org Mon Nov  2 09:00:00 2026\nSubject: ${s}\n\n${s}\n\n`).join('');
    const file = new File([mbox], 'mail.mbox', { lastModified: 1 });
    const first = fakeServer((text) => text.startsWith('Subject: m1\n'));
    await runImport(importOptions(first.client, [{ file, format: 'mbox' }]));
    const second = fakeServer();
    await runImport(importOptions(second.client, [{ file, format: 'mbox' }], { resume: true }));
    expect(second.imported.map((e) => e.text.split('\n')[0])).toEqual(['Subject: m1']);
    expect([...first.imported, ...second.imported].every((e) => e.keywords.$imported === true)).toBe(true);
  });

  it('gets no booking card from its own headers', () => {
    expect(getStructuredMailTrust(stored({ $imported: true, $seen: true })).trusted).toBe(false);
  });

  it('gets no sender logo from its own headers', () => {
    expect(brandIndicatorDomain(stored({ $imported: true }))).toBeUndefined();
  });

  it('gets no trusted invitation, and does not count as handed in on the same server', () => {
    const event = {
      participants: { org: { '@type': 'Participant', email: 'service@bigbank.example', roles: { owner: true } } },
    } as unknown as Partial<CalendarEvent>;
    expect(getInvitationTrustAssessment(event, stored({ $imported: true }), 'request').level).not.toBe('trusted');

    // A file can carry a message of the user's own domain without any results header.
    const colleague = { from: [{ email: 'colleague@example.org' }], keywords: { $imported: true } } as unknown as Email;
    const meeting = {
      participants: { org: { '@type': 'Participant', email: 'colleague@example.org', roles: { owner: true } } },
    } as unknown as Partial<CalendarEvent>;
    expect(getInvitationTrustAssessment(meeting, colleague, 'request', ['reader@example.org']).level).not.toBe('trusted');
    expect(brandIndicatorDomain(colleague, ['example.org'])).toBeUndefined();
  });

  // Control: the same headers on a message that arrived keep their meaning.
  it('leaves mail that arrived as it was', () => {
    expect(getStructuredMailTrust(stored({ $seen: true }))).toEqual({ trusted: true });
    expect(brandIndicatorDomain(stored({}))).toBe('bigbank.example');
    const event = {
      participants: { org: { '@type': 'Participant', email: 'service@bigbank.example', roles: { owner: true } } },
    } as unknown as Partial<CalendarEvent>;
    expect(getInvitationTrustAssessment(event, stored({ $seen: true }), 'request').level).toBe('trusted');
    const colleague = { from: [{ email: 'colleague@example.org' }], keywords: {} } as unknown as Email;
    expect(brandIndicatorDomain(colleague, ['example.org'])).toBe('example.org');
  });
});
