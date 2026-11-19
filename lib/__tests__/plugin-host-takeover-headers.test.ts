import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { useIdentityStore } from '@/stores/identity-store';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { clearAllHooks, emailHooks } from '../plugin-hooks';
import { beginComposeTakeover, endComposeTakeover, resetComposeTakeovers } from '../outgoing/compose-takeover';

// A crypto plugin's raw send that completes a send of the composer goes out
// with the Reply-To, read receipt request and priority the composer's own
// send would have written: api.jmap.sendRaw and api.jmap.submitRaw add them
// to the top-level header block.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

const SMIME: InstalledPlugin = {
  id: 'smime', name: 'smime', version: '1.0.0', author: 'test', description: '',
  type: 'ui-extension', permissions: ['email:raw-send'], grantedPermissions: ['email:raw-send'], entrypoint: 'index.js',
  enabled: true, status: 'running', settings: {},
};
const RAW = 'From: ann@example.com\r\nTo: bob@example.org\r\nSubject: Hi\r\nContent-Type: application/pkcs7-mime; smime-type=enveloped-data\r\n\r\nMIIB\r\n';
const bytes = () => new TextEncoder().encode(RAW);
const OPTIONS = { replyTo: [{ name: 'Team', email: 'team@example.org' }], readReceiptTo: 'ann@example.com', priority: 'high' as const };
const ADDED = ['Reply-To: Team <team@example.org>', 'Disposition-Notification-To: ann@example.com', 'X-Priority: 1 (Highest)', 'Importance: high'];

describe('the composer\'s header options on a plugin\'s raw send', () => {
  let sendRawEmail: ReturnType<typeof vi.fn>;
  let submitRawEmail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPluginRateLimits();
    submitRawEmail = vi.fn(async () => ({ scheduled: false }));
    sendRawEmail = vi.fn(async () => ({ scheduled: false }));
    const client = { getAccountId: vi.fn(() => 'own'), getMailboxes: vi.fn(async () => []), hasDelayedSend: vi.fn(() => false), submitRawEmail };
    useAuthStore.setState({ client: client as unknown as IJMAPClient });
    useAccountStore.setState({ activeAccountId: 'acct-1' });
    useEmailStore.setState({ sendRawEmail, emails: [], selectedEmail: null, mailboxes: [] } as never);
    useIdentityStore.setState({ identities: [{ id: 'id-a', name: 'Ann', email: 'ann@example.com' }] as never, preferredPrimaryId: 'id-a' });
  });
  afterEach(() => {
    clearAllHooks();
    resetComposeTakeovers();
    useAuthStore.setState({ client: null });
    vi.clearAllMocks();
  });

  /** Runs `method` from the plugin's onComposeSend handler, as a takeover does. */
  async function duringTakeover(method: string, identityId = 'id-a'): Promise<void> {
    emailHooks.onComposeSend.register('smime', async () => {
      await dispatchApiCall(SMIME, method, [bytes(), identityId, {}], { privileged: true });
      return false;
    });
    await emailHooks.onComposeSend.takeOver({} as never);
    clearAllHooks();
  }
  const sentHead = async (blob: Blob) => (await blob.text()).split('\r\n\r\n')[0].split('\r\n');

  it('adds them to sendRaw', async () => {
    const token = beginComposeTakeover('id-a', OPTIONS);
    await duringTakeover('jmap.sendRaw');
    endComposeTakeover(token);
    expect(await sentHead(sendRawEmail.mock.calls[0][1] as Blob)).toEqual([...RAW.split('\r\n\r\n')[0].split('\r\n'), ...ADDED]);
    expect(await (sendRawEmail.mock.calls[0][1] as Blob).text()).toContain('\r\n\r\nMIIB\r\n');
  });

  it('adds them to submitRaw', async () => {
    const token = beginComposeTakeover('id-a', OPTIONS);
    await duringTakeover('jmap.submitRaw');
    endComposeTakeover(token);
    expect(await sentHead(submitRawEmail.mock.calls[0][0] as Blob)).toEqual([...RAW.split('\r\n\r\n')[0].split('\r\n'), ...ADDED]);
  });

  it('adds nothing for a takeover without options', async () => {
    const token = beginComposeTakeover('id-a');
    await duringTakeover('jmap.sendRaw');
    endComposeTakeover(token);
    expect(await (sendRawEmail.mock.calls[0][1] as Blob).text()).toBe(RAW);
  });

  it('adds nothing to a raw send for another identity', async () => {
    const token = beginComposeTakeover('id-b', OPTIONS);
    await duringTakeover('jmap.sendRaw');
    endComposeTakeover(token);
    expect(await (sendRawEmail.mock.calls[0][1] as Blob).text()).toBe(RAW);
  });

  it('adds nothing to a raw send outside a takeover', async () => {
    const token = beginComposeTakeover('id-a', OPTIONS);
    await dispatchApiCall(SMIME, 'jmap.sendRaw', [bytes(), 'id-a', {}], { privileged: true });
    endComposeTakeover(token);
    expect(await (sendRawEmail.mock.calls[0][1] as Blob).text()).toBe(RAW);
  });
});
