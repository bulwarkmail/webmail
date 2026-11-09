import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { Email } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { LABEL_PRESETS } from '@/lib/classification/presets';
import { head, resolveHead, resetDialogLimits } from '../plugin-sandbox/host-dialog';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { beginLabelTakeover, endLabelTakeover, resetLabelTakeovers } from '../outgoing/classification-raw';

// Classification labels on the plugin paths: api.email.forward carries the
// original's label (else the default) and refuses when a required one is
// missing; a crypto plugin's raw send during a labelled takeover gets the
// label headers in its top-level header block.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(perms: string[], id: string): InstalledPlugin {
  return {
    id, name: id, version: '1.0.0', author: 'test', description: '',
    type: 'ui-extension', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const FORWARDER = plugin(['email:forward'], 'e-invoice');
const SMIME = plugin(['email:raw-send'], 'smime');
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args, { privileged: p.id === 'smime' });

const original = (headers: Record<string, string>, sender = 'colleague@example.com') => ({
  id: 'E1', threadId: 'T1', mailboxIds: { inbox: true }, keywords: {}, size: 900, receivedAt: '2026-10-20T08:00:00Z',
  from: [{ email: sender }], to: [{ email: 'ann@example.com' }], subject: 'Invoice',
  textBody: [{ partId: '1', blobId: 'tb', size: 20, type: 'text/plain' }], bodyValues: { 1: { value: 'Hello' } },
  attachments: [], headers,
}) as unknown as Email;

function useLabels(labels: Partial<typeof DEFAULT_ORGANISATION_POLICY.labels>) {
  const org = { ...DEFAULT_ORGANISATION_POLICY, labels: { ...DEFAULT_ORGANISATION_POLICY.labels, list: LABEL_PRESETS[0].list, ...labels } };
  usePolicyStore.setState({ loaded: true, policy: { ...DEFAULT_POLICY, organisation: org }, rawPolicy: { ...DEFAULT_POLICY, organisation: org } });
}

describe('labels on the plugin paths', () => {
  let client: Record<string, ReturnType<typeof vi.fn>>;
  let sendEmail: ReturnType<typeof vi.fn>;
  let sendRawEmail: ReturnType<typeof vi.fn>;
  let headers: Record<string, string> = {};
  let sender = 'colleague@example.com';

  beforeEach(() => {
    resetPluginRateLimits();
    resetDialogLimits();
    localStorage.clear();
    // The forward to this address is approved already: no dialog.
    localStorage.setItem('plugin-forward-approvals', '{}');
    client = {
      getAccountId: vi.fn(() => 'own'),
      getEmail: vi.fn(async () => original(headers, sender)),
      getMailboxes: vi.fn(async () => []),
      resolveSendAccountId: vi.fn(async () => 'own'),
      copyBlobs: vi.fn(async () => ({})),
      hasDelayedSend: vi.fn(() => false),
      batchUpdateKeywords: vi.fn(async () => undefined),
      submitRawEmail: vi.fn(async () => ({ scheduled: false })),
    };
    sendEmail = vi.fn(async () => ({ emailId: 'S1', scheduled: false }));
    sendRawEmail = vi.fn(async () => ({ scheduled: false }));
    useAuthStore.setState({ client: client as unknown as IJMAPClient });
    useAccountStore.setState({ activeAccountId: 'acct-1' });
    useEmailStore.setState({ sendEmail, sendRawEmail, emails: [], selectedEmail: null, mailboxes: [] } as never);
    useIdentityStore.setState({ identities: [{ id: 'id-a', name: 'Ann', email: 'ann@example.com' }] as never, preferredPrimaryId: 'id-a' });
    useAuthStore.setState({ identities: [{ id: 'id-a', name: 'Ann', email: 'ann@example.com' }] } as never);
    useSettingsStore.setState({ sendDelaySeconds: 0 });
  });
  afterEach(() => {
    while (head()) resolveHead(false);
    useAuthStore.setState({ client: null });
    usePolicyStore.setState({ policy: DEFAULT_POLICY, rawPolicy: DEFAULT_POLICY });
    resetLabelTakeovers();
    headers = {};
    sender = 'colleague@example.com';
    vi.clearAllMocks();
  });

  async function forward() {
    const pending = call(FORWARDER, 'email.forward', 'E1', { to: ['acc@example.com'] });
    await vi.waitFor(() => expect(head()).not.toBeNull());
    resolveHead(true);
    return pending;
  }

  it('forwards with the original’s label', async () => {
    useLabels({ defaultId: 'internal' });
    headers = { 'SIO-Label': ' marking="CONFIDENTIAL"' };
    expect(await forward()).toMatchObject({ sent: true });
    const args = sendEmail.mock.calls[0] as unknown[];
    expect(args[2]).toBe('[Confidential] Fwd: Invoice');
    expect((args[16] as { labelHeaders: Record<string, string> }).labelHeaders['header:SIO-Label:asRaw']).toContain('CONFIDENTIAL');
  });

  it('takes the default, not an outside sender’s label', async () => {
    useLabels({ defaultId: 'internal' });
    headers = { 'SIO-Label': ' marking="PUBLIC"' };
    sender = 'billing@supplier.example';
    expect(await forward()).toMatchObject({ sent: true });
    expect((sendEmail.mock.calls[0] as unknown[])[2]).toBe('Fwd: Invoice');
    const labelHeaders = ((sendEmail.mock.calls[0] as unknown[])[16] as { labelHeaders: Record<string, string> }).labelHeaders;
    expect(labelHeaders['header:SIO-Label:asRaw']).toContain('INTERNAL');
  });

  it('refuses a forward that needs a label it has no way to get', async () => {
    useLabels({ required: true, defaultId: '' });
    expect(await call(FORWARDER, 'email.forward', 'E1', { to: ['acc@example.com'] })).toEqual({ sent: false, reason: 'stopped' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('puts the takeover’s label into its raw sends and takes forged ones out of every raw send', async () => {
    useLabels({});
    const forged = new TextEncoder().encode('From: ann@example.com\r\nSubject: [Confidential] Hi\r\nSIO-Label: marking="PUBLIC"\r\n\r\nENCRYPTED\r\n');
    // Outside a takeover, no default label: nothing stamped, the forged header gone.
    await call(SMIME, 'jmap.sendRaw', forged, 'id-a', {});
    expect(await (sendRawEmail.mock.calls[0][1] as Blob).text()).not.toContain('SIO-Label');

    const token = beginLabelTakeover(usePolicyStore.getState().policy.organisation!.labels, LABEL_PRESETS[0].list[2], 'id-a')!;
    await call(SMIME, 'jmap.sendRaw', forged, 'id-a', { labelToken: token });
    await call(SMIME, 'jmap.submitRaw', forged, 'id-a', { labelToken: token });
    endLabelTakeover(token);
    const sent = await (sendRawEmail.mock.calls[1][1] as Blob).text();
    expect(sent).toMatch(/^From: ann@example.com\r\nSubject: \[Confidential\] Hi\r\nSIO-Label: marking="CONFIDENTIAL"[^\r]*\r\nSensitivity: Company-Confidential\r\n\r\nENCRYPTED\r\n$/);
    expect(await (client.submitRawEmail.mock.calls[0][0] as Blob).text()).toContain('SIO-Label: marking="CONFIDENTIAL"');
  });

  it('refuses a raw send outside the composer when a label is required', async () => {
    useLabels({ required: true });
    const bytes = new TextEncoder().encode('Subject: Hi\r\n\r\nX\r\n');
    await expect(call(SMIME, 'jmap.sendRaw', bytes, 'id-a', {})).rejects.toThrow(/requires a classification label/);
    await expect(call(SMIME, 'jmap.submitRaw', bytes, 'id-a', {})).rejects.toThrow(/requires a classification label/);
    expect(sendRawEmail).not.toHaveBeenCalled();
    expect(client.submitRawEmail).not.toHaveBeenCalled();
  });
});
