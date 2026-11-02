import { describe, expect, it, vi } from 'vitest';
import type { Email, Identity } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import {
  PHISHING_KEYWORD,
  isReportable,
  phishingReportSetup,
  reportSubject,
  sendPhishingReport,
} from '../phishing-report';
import { isPhishingMarked, turnOffLinks } from '../phishing-links';

// Report phishing: one report per message, the original attached by its
// blobId (no upload), no copy in Sent, the blob copied over for a message
// of another account, and which messages can be reported at all.

const me: Identity = { id: 'id-me', name: 'Alice', email: 'alice@example.org' } as Identity;
const email = {
  id: 'e1', blobId: 'blob-1', threadId: 't1', size: 2048, subject: 'Your parcel',
  receivedAt: '2026-10-01T10:00:00Z', keywords: {}, mailboxIds: { inbox: true },
  from: [{ email: 'bad@phish.example' }],
} as unknown as Email;

function fakeClient(over: Partial<Record<string, unknown>> = {}) {
  const client = {
    getIdentities: vi.fn(async () => [me]),
    getUsername: () => 'alice@example.org',
    getAccountId: () => 'acc-own',
    resolveSendAccountId: vi.fn(async () => 'acc-own'),
    copyBlobs: vi.fn(async () => ({ 'blob-1': 'blob-copied' })),
    sendEmail: vi.fn(async () => ({ scheduled: false })),
    submitRawEmail: vi.fn(async () => ({ scheduled: false })),
    ...over,
  };
  return client as typeof client & IJMAPClient;
}

const setup = { address: 'soc@example.org', format: 'forward' as const };

describe('the forwarded report', () => {
  it('attaches the original by blobId, to the admin address, with "Phishing:" and no Sent copy', async () => {
    const client = fakeClient();
    await sendPhishingReport(email, { client, sourceAccountId: 'acc-own', setup });
    expect(client.sendEmail).toHaveBeenCalledTimes(1);
    const args = client.sendEmail.mock.calls[0] as unknown[];
    expect(args[0]).toEqual(['soc@example.org']);
    expect(args[1]).toBe('Phishing: Your parcel');
    expect(String(args[2])).toContain('Reported as phishing by Alice <alice@example.org> with Bulwark');
    expect(args[5]).toBe('id-me');
    const attachments = args[10] as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ blobId: 'blob-1', type: 'message/rfc822', size: 2048, disposition: 'attachment' });
    expect(String(attachments[0].name)).toMatch(/\.eml$/);
    expect(args[15]).toEqual({ noSentCopy: true });
    expect(client.copyBlobs).not.toHaveBeenCalled();
    expect(client.submitRawEmail).not.toHaveBeenCalled();
  });

  it('copies the blob first when the message is in another account (a group mailbox)', async () => {
    const client = fakeClient();
    await sendPhishingReport(email, { client, sourceAccountId: 'acc-group', setup });
    expect(client.copyBlobs).toHaveBeenCalledWith('acc-group', ['blob-1'], 'acc-own');
    const attachments = (client.sendEmail.mock.calls[0] as unknown[])[10] as Array<{ blobId: string }>;
    expect(attachments[0].blobId).toBe('blob-copied');
  });

  it('sends nothing when the copy fails', async () => {
    const client = fakeClient({ copyBlobs: vi.fn(async () => ({})) });
    await expect(sendPhishingReport(email, { client, sourceAccountId: 'acc-group', setup })).rejects.toThrow();
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it('names an empty subject plainly', () => {
    expect(reportSubject('')).toBe('Phishing');
    expect(reportSubject('a\r\nBcc: x@evil.example')).toBe('Phishing: a Bcc: x@evil.example');
  });
});

describe('which messages can be reported', () => {
  it('not your own mail, drafts, scheduled mail, or a message reported already', () => {
    expect(isReportable(email, 'inbox')).toBe(true);
    expect(isReportable(email, 'junk')).toBe(true);
    for (const role of ['sent', 'drafts', 'scheduled']) expect(isReportable(email, role)).toBe(false);
    expect(isReportable({ ...email, keywords: { $draft: true } }, 'inbox')).toBe(false);
    expect(isReportable({ ...email, isScheduled: true }, 'inbox')).toBe(false);
    expect(isReportable({ ...email, blobId: '' }, 'inbox')).toBe(false);
    expect(isReportable({ ...email, keywords: { [PHISHING_KEYWORD]: true } }, 'junk')).toBe(false);
  });

  it('only while the admin set an address', () => {
    expect(phishingReportSetup(DEFAULT_POLICY)).toBeNull();
    const on = { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, phishingReport: { address: 'soc@example.org', format: 'arf' as const } } };
    expect(phishingReportSetup(on)).toEqual({ address: 'soc@example.org', format: 'arf' });
  });
});

describe('links of a reported message', () => {
  it('are turned off: no address, not reachable by Tab, and say so', () => {
    const html = '<p>Hi <a href="https://phish.example/login" target="_blank" rel="noopener">log in</a> <map><area href="https://x.example" alt="x"></map></p>';
    const out = turnOffLinks(html, { title: 'link turned off', note: '(link turned off)' });
    expect(out).not.toContain('href=');
    expect(out).not.toContain('phish.example');
    expect(out).toContain('data-link-off');
    expect(out).toContain('(link turned off)');
    const doc = new DOMParser().parseFromString(out, 'text/html');
    expect(doc.querySelectorAll('a[href], area[href]')).toHaveLength(0);
  });

  it('follow the $phishing keyword', () => {
    expect(isPhishingMarked({ keywords: { [PHISHING_KEYWORD]: true } })).toBe(true);
    expect(isPhishingMarked({ keywords: { $junk: true } })).toBe(false);
  });
});
