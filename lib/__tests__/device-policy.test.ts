import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canDownload,
  canExport,
  canPrint,
  devicesForAccount,
  getStrictestDevices,
  watermarkAddress,
  watermarkText,
} from '@/lib/device-policy';
import { DOWNLOAD_BLOCKED_EVENT, downloadAllowed, saveBlobAs } from '@/lib/download-guard';
import { openPreviewInNewWindow } from '@/lib/standalone-display';
import { saveBlob } from '@/lib/files-zip';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { resetAccountSubjects, useAccountSubjects } from '@/lib/org/account-subjects';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useEmailStore } from '@/stores/email-store';
import { canCopyBetween } from '@/lib/device-policy';

// The device policies (Organisation > Devices) follow the account a message
// belongs to; what isn't about one account follows the strictest signed-in
// account. The anchor and new-tab helpers refuse as a backstop.

const ALICE = { email: 'alice@example.org', groups: ['team@example.org'] };
const CAROL = { email: 'carol@example.org', groups: [] };

// Whatever works the subject out from a client gets the same answer.
const clientA = {
  getUsername: () => ALICE.email,
  getSharedAccounts: () => [{ id: 'g', name: 'team@example.org', isPrimary: false }],
  getAccountInfo: () => ({ isPersonal: false }),
  getPrincipalTypes: async () => ({ g: 'group' }),
};
const clientC = { getUsername: () => CAROL.email, getSharedAccounts: () => [] };

const RAW: SettingsPolicy = {
  ...DEFAULT_POLICY,
  scopes: [{ id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: { organisation: { devices: { noDownloads: true, noPrint: true } } } }],
};

const initialAuth = useAuthStore.getState();
const initialPolicy = usePolicyStore.getState();

beforeEach(() => {
  resetAccountSubjects();
  useAuthStore.setState({
    activeAccountId: 'acc-a',
    client: clientA as never,
    username: ALICE.email,
    getClientForAccount: ((id: string) => (id === 'acc-a' ? clientA : id === 'acc-c' ? clientC : undefined)) as never,
    getAllConnectedClients: (() => new Map<string, unknown>([['acc-a', clientA], ['acc-c', clientC]])) as never,
  });
  usePolicyStore.setState({ rawPolicy: RAW, loaded: true });
  usePolicyStore.getState().setPolicySubject(ALICE);
  useAccountSubjects.setState({ subjects: { 'acc-c': CAROL }, settled: { 'acc-c': true } });
});

afterEach(() => {
  useAuthStore.setState(initialAuth, true);
  usePolicyStore.setState(initialPolicy, true);
  resetAccountSubjects();
});

describe('which account decides', () => {
  it('a message follows its own account', () => {
    expect(canDownload({ sourceClientAccountId: 'acc-a' })).toBe(false);
    expect(canDownload({ sourceClientAccountId: 'acc-c' })).toBe(true);
    expect(canPrint('acc-c')).toBe(true);
    expect(canExport('acc-a')).toBe(true);
  });

  it('the active account when nothing names one', () => {
    expect(canDownload(null)).toBe(false);
    expect(devicesForAccount(undefined).noPrint).toBe(true);
  });

  it('a JMAP client stands for its account', () => {
    expect(canDownload({ client: clientC })).toBe(true);
    expect(canDownload({ client: clientA })).toBe(false);
  });

  it('the strictest signed-in account where no message decides', () => {
    usePolicyStore.getState().setPolicySubject(CAROL);
    useAuthStore.setState({ activeAccountId: 'acc-c', client: clientC as never });
    useAccountSubjects.setState({ subjects: { 'acc-a': ALICE }, settled: { 'acc-a': true } });
    expect(canDownload(null)).toBe(true);
    expect(getStrictestDevices()).toMatchObject({ noDownloads: true, noPrint: true, noExport: false });
  });
});

describe('the backstop', () => {
  it('refuses a download, says so, and never builds the anchor', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const blocked = vi.fn();
    window.addEventListener(DOWNLOAD_BLOCKED_EVENT, blocked);
    expect(saveBlobAs(new Blob(['x']), 'a.pdf', { kind: 'attachment', subject: 'acc-a' })).toBe(false);
    expect(saveBlob(new Blob(['x']), 'b.zip')).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledTimes(2);
    expect(saveBlobAs(new Blob(['x']), 'a.pdf', { kind: 'attachment', subject: 'acc-c' })).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    window.removeEventListener(DOWNLOAD_BLOCKED_EVENT, blocked);
    click.mockRestore();
  });

  it('keeps exports and downloads apart', () => {
    expect(downloadAllowed('export', 'acc-a')).toBe(true);
    expect(downloadAllowed('attachment', 'acc-a')).toBe(false);
  });

  it('opens no new tab under the policy, so the caller previews in the app', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openPreviewInNewWindow('https://example.org/x.pdf', { sourceClientAccountId: 'acc-a' })).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(openPreviewInNewWindow('https://example.org/x.pdf', { sourceClientAccountId: 'acc-c' })).toBe(true);
    open.mockRestore();
  });
});

describe('another account opened from the sidebar', () => {
  afterEach(() => useEmailStore.setState({ viewingAccountId: null }));

  it('a message without a stamp follows the account the sidebar shows', () => {
    // ent-carol active, ent-alice's Inbox opened from the multi-account sidebar.
    usePolicyStore.getState().setPolicySubject(CAROL);
    useAuthStore.setState({ activeAccountId: 'acc-c', client: clientC as never });
    useAccountSubjects.setState({ subjects: { 'acc-a': ALICE }, settled: { 'acc-a': true } });
    useEmailStore.setState({ viewingAccountId: 'acc-a' });
    expect(canDownload({ sourceClientAccountId: undefined })).toBe(false);
    expect(canPrint({})).toBe(false);
    expect(watermarkAddress({})).toBe(ALICE.email);
    useEmailStore.setState({ viewingAccountId: null });
    expect(canDownload({})).toBe(true);
  });
});

describe('Copy to another account', () => {
  it('never copies out of an account into a less strict one', () => {
    expect(canCopyBetween('acc-a', 'acc-c')).toBe(false);
    expect(canCopyBetween('acc-c', 'acc-a')).toBe(true);
    expect(canCopyBetween('acc-a', 'acc-a')).toBe(true);
  });
});

describe('watermark', () => {
  it('names the address of the message’s account and the date', () => {
    expect(watermarkAddress({ sourceClientAccountId: 'acc-c' })).toBe(CAROL.email);
    expect(watermarkAddress(null)).toBe(ALICE.email);
    expect(watermarkText('alice@example.org', new Date('2026-11-01T12:00:00Z'), 'en-GB')).toBe('alice@example.org · 1 Nov 2026');
  });
});
