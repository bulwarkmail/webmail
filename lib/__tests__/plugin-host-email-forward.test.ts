import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { emailHooks } from '../plugin-hooks';
import { head, resolveHead, resetDialogLimits } from '../plugin-sandbox/host-dialog';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { forwardApprovals, revokeForwardApproval } from '../plugin-sandbox/forward-approvals';
import { clearPluginStorageForAccount } from '../plugin-sandbox/storage-scope';
import { HIGH_RISK_PERMISSIONS } from '../plugin-sandbox/permission-text';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';
import type { OutgoingEmail } from '../plugin-types';

function plugin(perms: string[], id = 'e-invoice'): InstalledPlugin {
  return {
    id, name: 'E-Invoice', version: '1.0.0', author: 'test', description: '',
    type: 'ui-extension', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const FORWARDER = plugin(['email:forward']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const invoice: Email = {
  id: 'E1',
  threadId: 'T1',
  mailboxIds: { inbox: true },
  keywords: {},
  size: 9000,
  receivedAt: '2026-10-20T08:00:00Z',
  from: [{ name: 'Supplier GmbH', email: 'billing@supplier.example' }],
  to: [{ name: 'Ann', email: 'ann@example.com' }],
  subject: 'Rechnung 2026-117',
  textBody: [{ partId: '1', blobId: 'tb', size: 20, type: 'text/plain' }],
  bodyValues: { 1: { value: 'Please find the invoice attached.' } },
  attachments: [
    { partId: '2', blobId: 'pdf-1', name: 'invoice.pdf', type: 'application/pdf', size: 5000, disposition: 'attachment' },
    { partId: '3', blobId: 'xml-1', name: 'xrechnung.xml', type: 'application/xml', size: 3000, disposition: 'attachment' },
    { partId: '4', blobId: 'logo', name: 'logo.png', type: 'image/png', size: 900, disposition: 'inline', cid: 'logo@x' },
  ],
} as unknown as Email;

/** Answer the host's confirm once it shows. */
async function answerDialog(allow: boolean): Promise<string> {
  await vi.waitFor(() => expect(head()).not.toBeNull());
  const shown = head()!;
  resolveHead(allow);
  return `${shown.title}\n${shown.message}`;
}

describe('api.email.forward', () => {
  let client: Record<string, ReturnType<typeof vi.fn>>;
  let sendEmail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPluginRateLimits();
    resetDialogLimits();
    localStorage.clear();
    client = {
      getAccountId: vi.fn(() => 'own'),
      getEmail: vi.fn(async (id: string, accountId?: string) => (id === 'E1' ? { ...invoice, accountId } : null)),
      getMailboxes: vi.fn(async () => []),
      resolveSendAccountId: vi.fn(async () => 'own'),
      copyBlobs: vi.fn(async (_from: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, `copy-${id}`]))),
      hasDelayedSend: vi.fn(() => true),
      batchUpdateKeywords: vi.fn(async () => undefined),
    };
    sendEmail = vi.fn(async () => ({ emailId: 'S1', emailSubmissionId: 'sub-1', scheduled: false }));
    useAuthStore.setState({ client: client as unknown as IJMAPClient });
    useAccountStore.setState({ activeAccountId: 'acct-1' });
    useEmailStore.setState({ sendEmail, emails: [], selectedEmail: null, mailboxes: [] } as never);
    useIdentityStore.setState({
      identities: [{ id: 'id-a', name: 'Ann', email: 'ann@example.com' }] as never,
      preferredPrimaryId: 'id-a',
    });
    useSettingsStore.setState({ sendDelaySeconds: 0 });
  });
  afterEach(() => {
    while (head()) resolveHead(false);
    useAuthStore.setState({ client: null });
    useIdentityStore.setState({ identities: [], preferredPrimaryId: null });
  });

  it('asks before the first forward to an address, then sends with the attachments and marks the original', async () => {
    const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['Accounting <Buchhaltung@Firma.example>'], text: 'For booking.' });
    const shown = await answerDialog(true);
    expect(shown).toContain('E-Invoice');
    expect(shown).toContain('buchhaltung@firma.example');
    expect(shown).toContain('Rechnung 2026-117');
    expect(await pending).toEqual({ sent: true, emailId: 'S1', to: ['buchhaltung@firma.example'], scheduledFor: null });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [, to, subject, body, , , identityId, fromEmail, , , html, attachments, , , delayedUntil] = sendEmail.mock.calls[0];
    expect({ to, subject, identityId, fromEmail, html, delayedUntil }).toEqual({
      to: ['Accounting <Buchhaltung@Firma.example>'], subject: 'Fwd: Rechnung 2026-117',
      identityId: 'id-a', fromEmail: 'ann@example.com', html: undefined, delayedUntil: undefined,
    });
    expect(body).toMatch(/^For booking\.\n\n---------- Forwarded message ----------\nFrom: Supplier GmbH <billing@supplier\.example>\n/);
    expect(body).toContain('Subject: Rechnung 2026-117');
    expect(body).toContain('Please find the invoice attached.');
    // The inline logo of the body stays behind.
    expect(attachments).toEqual([
      { blobId: 'pdf-1', name: 'invoice.pdf', type: 'application/pdf', size: 5000, disposition: 'attachment' },
      { blobId: 'xml-1', name: 'xrechnung.xml', type: 'application/xml', size: 3000, disposition: 'attachment' },
    ]);
    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['E1'], { 'keywords/$forwarded': true }, undefined);
    expect(forwardApprovals('e-invoice')).toEqual(['buchhaltung@firma.example']);

    // The next forward there goes out without a question.
    expect(await call(FORWARDER, 'email.forward', 'E1', { to: ['buchhaltung@firma.example'] })).toMatchObject({ sent: true });
    expect(head()).toBeNull();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('forwards the words of an HTML-only mail, not its markup', async () => {
    // RFC 8621 lists the text/html part under textBody when there is no text/plain one.
    const htmlPart = { partId: '1', blobId: 'hb', size: 90, type: 'text/html' };
    client.getEmail.mockResolvedValue({
      ...invoice, textBody: [htmlPart], htmlBody: [htmlPart],
      bodyValues: { 1: { value: '<div style="font:14px Arial">Please pay &amp; book.</div><div>Thanks</div>' } },
    });
    const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['buchhaltung@firma.example'] });
    await answerDialog(true);
    await pending;

    const body = sendEmail.mock.calls[0][3] as string;
    expect(body).not.toContain('<div');
    expect(body).toMatch(/\n\nPlease pay & book\.\nThanks$/);
  });

  it('sends nothing and remembers nothing when the user says no', async () => {
    const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['eve@evil.example'] });
    await answerDialog(false);
    expect(await pending).toEqual({ sent: false, reason: 'declined' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(forwardApprovals('e-invoice')).toEqual([]);
  });

  it('asks again for an address that is new, even next to an allowed one', async () => {
    revokeForwardApproval('e-invoice', 'nobody@example.com');
    const first = call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com'] });
    await answerDialog(true);
    await first;
    const second = call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com', 'eve@evil.example'] });
    const shown = await answerDialog(false);
    expect(shown).toContain('eve@evil.example');
    expect(shown).not.toContain('books@example.com');
    expect(await second).toEqual({ sent: false, reason: 'declined' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends only the attachments named, and only attachments of that message', async () => {
    const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com'], attachments: ['xml-1'] });
    await answerDialog(true);
    await pending;
    expect(sendEmail.mock.calls[0][11]).toEqual([expect.objectContaining({ blobId: 'xml-1' })]);
    await expect(call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com'], attachments: ['someone-elses-blob'] }))
      .rejects.toThrow(/not an attachment of this message/);
  });

  it('copies the attachments when the message is in a team mailbox', async () => {
    useEmailStore.setState({ mailboxes: [{ id: 'team-inbox', name: 'Inbox', role: 'inbox', isShared: true, accountId: 'team' }] } as never);
    const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com'], accountId: 'team' });
    await answerDialog(true);
    await pending;
    expect(client.getEmail).toHaveBeenCalledWith('E1', 'team');
    expect(client.copyBlobs).toHaveBeenCalledWith('team', ['pdf-1', 'xml-1'], 'own');
    expect(sendEmail.mock.calls[0][11].map((a: { blobId: string }) => a.blobId)).toEqual(['copy-pdf-1', 'copy-xml-1']);
    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['E1'], { 'keywords/$forwarded': true }, 'team');
  });

  it('holds the forward for the undo delay like any other send', async () => {
    useSettingsStore.setState({ sendDelaySeconds: 10 });
    sendEmail.mockResolvedValueOnce({ emailId: 'S1', emailSubmissionId: 'sub-1', scheduled: true, sendAt: '2026-10-29T10:00:10Z' });
    const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com'] });
    await answerDialog(true);
    expect(await pending).toMatchObject({ sent: true, scheduledFor: '2026-10-29T10:00:10Z' });
    expect(sendEmail.mock.calls[0][14]).toEqual(expect.any(String));
  });

  it('lets another plugin stop it in onBeforeEmailSend', async () => {
    const seen: unknown[] = [];
    const off = emailHooks.onBeforeEmailSend.register('guardrail', (outgoing) => { seen.push(outgoing); return false; });
    try {
      const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com'] });
      await answerDialog(true);
      expect(await pending).toEqual({ sent: false, reason: 'stopped' });
      expect(seen).toEqual([expect.objectContaining({ subject: 'Fwd: Rechnung 2026-117', to: ['books@example.com'] })]);
      expect(sendEmail).not.toHaveBeenCalled();
    } finally {
      off.dispose();
    }
  });

  it("gives send checks the note, the recipients outside and what the attachments really are", async () => {
    const seen: OutgoingEmail[] = [];
    client.fetchBlobArrayBuffer = vi.fn(async (blobId: string) => (blobId === 'pdf-1' ? new Uint8Array([0x4d, 0x5a, 0x90, 0, 3]) : new TextEncoder().encode('<Invoice/>')).buffer);
    const off = emailHooks.onBeforeEmailSend.register('send-checks', (outgoing: OutgoingEmail) => { seen.push(outgoing); return false; });
    try {
      const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['books@outside.test', 'ann2@example.com'], text: 'Please book this.' });
      await answerDialog(true);
      expect(await pending).toEqual({ sent: false, reason: 'stopped' });
      expect(seen[0]).toMatchObject({
        surface: 'plugin-forward',
        mode: 'forward',
        authoredText: 'Please book this.',
        externalRecipients: ['books@outside.test'],
      });
      expect(seen[0].attachments).toEqual([
        { name: 'invoice.pdf', type: 'application/pdf', size: 5000, blobId: 'pdf-1', sniffedType: 'application/x-msdownload' },
        { name: 'xrechnung.xml', type: 'application/xml', size: 3000, blobId: 'xml-1', sniffedType: 'text/plain', textExcerpt: '<Invoice/>' },
      ]);
    } finally {
      off.dispose();
    }
  });

  it('is held while a send check the admin requires is down, also with no plugin listening', async () => {
    const { setSendGuardSource } = await import('../plugin-send-guards');
    const down = { id: 'send-checks', name: 'Send checks', version: '1', permissions: ['email:send'], status: 'error', error: 'auto-disabled', enabled: false, forceEnabled: true } as unknown as InstalledPlugin;
    setSendGuardSource({ snapshot: () => ({ plugins: [down], forced: () => true }), subscribe: () => () => {} });
    try {
      const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['books@example.com'] });
      await answerDialog(true);
      expect(await pending).toEqual({ sent: false, reason: 'stopped' });
      expect(sendEmail).not.toHaveBeenCalled();
    } finally {
      setSendGuardSource(null);
    }
  });

  it('needs email:forward and sound input', async () => {
    await expect(call(plugin(['email:read', 'email:send']), 'email.forward', 'E1', { to: ['a@example.com'] }))
      .rejects.toThrow(/lacks permission "email:forward"/);
    await expect(call(FORWARDER, 'email.forward', 'E1', { to: [] })).rejects.toThrow(/at least one address/);
    await expect(call(FORWARDER, 'email.forward', 'E1', { to: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`) }))
      .rejects.toThrow(/at most 10 addresses/);
    await expect(call(FORWARDER, 'email.forward', 'E1', { to: ['a@example.com'], bcc: ['eve@evil.example'] }))
      .rejects.toThrow(/unknown property "bcc"/);
    await expect(call(FORWARDER, 'email.forward', 'missing', { to: ['a@example.com'] })).rejects.toThrow(/no message/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('is high risk in the consent dialog', () => {
    expect(HIGH_RISK_PERMISSIONS.has('email:forward')).toBe(true);
  });
});

describe('forward approvals', () => {
  beforeEach(() => {
    localStorage.clear();
    useAccountStore.setState({ activeAccountId: 'acct-1' });
  });

  it('are out of reach of the plugin’s own storage', async () => {
    const p = plugin(['email:forward']);
    localStorage.setItem('plugin:e-invoice:!forward-to:@acct-1:', JSON.stringify(['books@example.com']));
    expect(await call(p, 'storage.keys')).toEqual([]);
    await call(p, 'storage.set', '!forward-to', ['eve@evil.example']);
    await call(p, 'storage.set', ':!forward-to:@acct-1:', ['eve@evil.example']);
    expect(forwardApprovals('e-invoice')).toEqual(['books@example.com']);
  });

  it('go when the account signs out or the user removes them', () => {
    localStorage.setItem('plugin:e-invoice:!forward-to:@acct-1:', JSON.stringify(['a@example.com', 'b@example.com']));
    localStorage.setItem('plugin:e-invoice:!forward-to:@acct-2:', JSON.stringify(['c@example.com']));
    revokeForwardApproval('e-invoice', 'A@example.com');
    expect(forwardApprovals('e-invoice')).toEqual(['b@example.com']);
    clearPluginStorageForAccount('acct-1');
    expect(forwardApprovals('e-invoice')).toEqual([]);
    expect(forwardApprovals('e-invoice', 'acct-2')).toEqual(['c@example.com']);
  });
});
