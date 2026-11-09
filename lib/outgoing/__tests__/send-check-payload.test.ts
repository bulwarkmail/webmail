import { beforeEach, describe, expect, it, vi } from 'vitest';
import { externalRecipientsFor, inspectAttachments, sniffFile, TEXT_EXCERPT_BYTES } from '../send-check-payload';
import { isTextAttachment, sniffType, SNIFF_BYTES } from '../attachment-sniff';
import type { OutgoingContext } from '../send-pipeline';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Identity } from '@/lib/jmap/types';
import { hookArgsFor } from '@/lib/plugin-sandbox/hook-payload';
import type { InstalledPlugin, OutgoingEmail } from '@/lib/plugin-types';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? Array.from(new TextEncoder().encode(p)) : p)));

describe('sniffType', () => {
  it('names programs and archives by their first bytes, whatever the name says', () => {
    expect(sniffType(bytes('MZ', [0x90, 0, 3]))).toBe('application/x-msdownload');
    expect(sniffType(bytes([0x7f], 'ELF', [2, 1]))).toBe('application/x-executable');
    expect(sniffType(bytes('PK', [3, 4, 20, 0]))).toBe('application/zip');
    expect(sniffType(bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe('application/x-ole-storage');
    expect(sniffType(bytes('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffType(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(bytes('#!/bin/sh\nrm -rf /\n'))).toBe('text/x-shellscript');
  });

  it('takes a text file that starts with "MZ" for text, not a program', () => {
    expect(sniffType(bytes('MZ Steuerberatung, Rechnung 2026\n'))).toBe('text/plain');
  });

  it('tells Java and Android apps from other ZIP files', () => {
    expect(sniffType(bytes('PK', [3, 4, 20, 0], '....META-INF/MANIFEST.MF'))).toBe('application/java-archive');
    expect(sniffType(bytes('PK', [3, 4, 20, 0], '....AndroidManifest.xml'))).toBe('application/vnd.android.package-archive');
    expect(sniffType(bytes('PK', [3, 4, 20, 0], '....[Content_Types].xml'))).toBe('application/zip');
    // An OpenDocument file has a META-INF/manifest.xml, not MANIFEST.MF.
    expect(sniffType(bytes('PK', [3, 4, 20, 0], 'mimetypeapplication/vnd.oasis.opendocument.textMETA-INF/manifest.xml'))).toBe('application/zip');
  });

  it('tells HTML and plain text from binary data', () => {
    expect(sniffType(bytes('\uFEFF  <!DOCTYPE html><html>'))).toBe('text/html');
    expect(sniffType(bytes('IBAN;Name\nDE89370400440532013000;Alice\n'))).toBe('text/plain');
    // A character cut off at the end of the head is still text.
    expect(sniffType(bytes('Grüße', [0xc3]))).toBe('text/plain');
    expect(sniffType(bytes('abc', [0], 'def'))).toBeUndefined();
    expect(sniffType(bytes([0xff, 0xfe, 0x41]))).toBeUndefined();
    expect(sniffType(new Uint8Array())).toBeUndefined();
  });

  it('knows text attachments by type, else by extension', () => {
    expect(isTextAttachment('a.bin', 'text/csv')).toBe(true);
    expect(isTextAttachment('export.csv', 'application/octet-stream')).toBe(true);
    expect(isTextAttachment('data.json', '')).toBe(true);
    expect(isTextAttachment('photo.jpg', 'image/jpeg')).toBe(false);
  });
});

describe('inspectAttachments', () => {
  it('reads a local text file: its type and the text', async () => {
    const file = new Blob(['IBAN DE89 3704 0044 0532 0130 00']);
    const [out] = await inspectAttachments([{ name: 'list.csv', type: 'text/csv', size: file.size, blobId: 'b1', file }]);
    expect(out).toEqual({
      name: 'list.csv', type: 'text/csv', size: file.size, blobId: 'b1',
      sniffedType: 'text/plain', textExcerpt: 'IBAN DE89 3704 0044 0532 0130 00',
    });
  });

  it('reads a server blob: a megabyte of a text file, only the head of anything else', async () => {
    const asked: number[] = [];
    const load = (content: string) => async (n: number) => { asked.push(n); return new TextEncoder().encode(content).buffer as ArrayBuffer; };
    const out = await inspectAttachments([
      { name: 'notes.txt', type: 'text/plain', size: 10, blobId: 'b1', load: load('hello') },
      { name: 'invoice.pdf', type: 'application/pdf', size: 9_000_000, blobId: 'b2', load: load('MZ\u0090\u0000\u0003') },
    ]);
    expect(asked).toEqual([TEXT_EXCERPT_BYTES, SNIFF_BYTES]);
    expect(out[0]).toMatchObject({ sniffedType: 'text/plain', textExcerpt: 'hello' });
    // A renamed program: the name and type say PDF, the bytes don't.
    expect(out[1]).toEqual({ name: 'invoice.pdf', type: 'application/pdf', size: 9_000_000, blobId: 'b2', sniffedType: 'application/x-msdownload' });
  });

  it("doesn't read a program named .txt as text, nor inline images", async () => {
    const out = await inspectAttachments([
      { name: 'readme.txt', type: 'text/plain', size: 3, file: new Blob([bytes('MZ', [0x90, 0, 3])]) },
      { name: 'pasted.png', type: 'image/png', size: 8, blobId: 'b3', inline: true, file: new Blob([bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])]) },
    ]);
    expect(out[0]).toEqual({ name: 'readme.txt', type: 'text/plain', size: 3, sniffedType: 'application/x-msdownload' });
    expect(out[1]).toEqual({ name: 'pasted.png', type: 'image/png', size: 8, blobId: 'b3', inline: true, sniffedType: 'image/png' });
  });

  it('marks a file it cannot read, so a check does not take it for a clean one', async () => {
    const [out, none] = await inspectAttachments([
      { name: 'a.txt', type: '', size: 1, blobId: 'b', load: async () => { throw new Error('offline'); } },
      { name: 'b.bin', type: '', size: 1, blobId: 'c' },
    ]);
    expect(out).toEqual({ name: 'a.txt', type: 'application/octet-stream', size: 1, blobId: 'b', unreadable: true });
    expect(none.unreadable).toBe(true);
  });

  it('sniffs a file before upload, and says when it cannot', async () => {
    expect(await sniffFile(new Blob([bytes('MZ', [0x90, 0, 3])]))).toEqual({ sniffedType: 'application/x-msdownload' });
    const broken = { slice: () => ({ arrayBuffer: async () => { throw new Error('gone'); } }) } as unknown as Blob;
    expect(await sniffFile(broken)).toEqual({ unreadable: true });
  });
});

describe('externalRecipientsFor', () => {
  const context = (to: string[], bcc: string[] = []): OutgoingContext => ({
    surface: 'composer', to, cc: [], bcc, fromEmail: 'alice@example.org', identityId: 'i1', mode: 'compose', plainText: false,
    sender: { name: 'Alice', email: 'alice@example.org' },
  });
  beforeEach(() => {
    useAuthStore.setState({ client: null, identities: [{ id: 'i1', name: 'Alice', email: 'alice@example.org' } as unknown as Identity] });
  });

  it("lists recipients outside the organisation's domains also while the admin's warning is off", async () => {
    usePolicyStore.setState({
      policy: {
        ...DEFAULT_POLICY,
        organisation: {
          ...DEFAULT_ORGANISATION_POLICY,
          externalMail: { ...DEFAULT_ORGANISATION_POLICY.externalMail, recipientWarning: false, domains: ['partner.example'] },
        },
      },
    });
    expect(await externalRecipientsFor(context(['bob@example.org', 'Carol@Partner.Example', 'eve@other.test'], ['x@sub.example.org', 'Mallory@Evil.test'])))
      .toEqual(['eve@other.test', 'mallory@evil.test']);
    expect(await externalRecipientsFor(context(['bob@example.org']))).toEqual([]);
  });
});

describe('hookArgsFor', () => {
  const email = {
    to: [], cc: [], bcc: [], subject: '', htmlBody: '', textBody: '', identityId: '',
    attachments: [{ name: 'a.txt', type: 'text/plain', size: 1, textExcerpt: 'secret' }],
  } as OutgoingEmail;
  const plugin = (permissions: string[]) => ({ id: 'p', permissions, managed: true } as unknown as InstalledPlugin);

  it('gives the text of attachments only to a plugin that may read files', () => {
    expect((hookArgsFor(plugin(['email:send']), 'onBeforeEmailSend', [email])[0] as OutgoingEmail).attachments[0]).toEqual({ name: 'a.txt', type: 'text/plain', size: 1 });
    expect((hookArgsFor(plugin(['email:send', 'email:blob-read']), 'onBeforeEmailSend', [email])[0] as OutgoingEmail).attachments[0].textExcerpt).toBe('secret');
    expect(email.attachments[0].textExcerpt).toBe('secret');
  });
});
