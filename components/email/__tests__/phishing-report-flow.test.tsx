import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { usePolicyStore } from '@/stores/policy-store';
import { useToastStore } from '@/stores/toast-store';
import { usePhishingReportStore } from '@/stores/phishing-report-store';

// The report flow through the real dialog: it names the address, Cancel
// sends nothing, each message gets its own report, each moves to Junk with
// $phishing (read), and Undo moves it back and clears the mark, while the
// toast says the report already went.

const email = (id: string, subject: string) => ({
  id, blobId: `blob-${id}`, threadId: `t-${id}`, size: 100, subject, keywords: {}, mailboxIds: { inbox: true },
  receivedAt: '2026-10-01T10:00:00Z', from: [{ email: 'bad@phish.example' }],
}) as unknown as Email;
const e1 = email('e1', 'Parcel');
const e2 = email('e2', 'Invoice');

const hoisted = vi.hoisted(() => {
  const client = {
    getIdentities: async () => [{ id: 'id-me', name: 'Me', email: 'me@example.org' }],
    getUsername: () => 'me@example.org',
    getAccountId: () => 'acc',
    resolveSendAccountId: async () => 'acc',
    copyBlobs: async () => ({}),
    sendEmail: vi.fn(async () => ({ scheduled: false })),
    submitRawEmail: vi.fn(async () => ({ scheduled: false })),
    fetchBlobArrayBuffer: vi.fn(async () => new TextEncoder().encode('Subject: x' + String.fromCharCode(13, 10, 13, 10) + 'hi').buffer),
    markAsSpam: vi.fn(async () => {}),
    undoSpam: vi.fn(async () => {}),
  };
  const store = {
    emails: [] as Email[],
    mailboxes: [{ id: 'inbox', role: 'inbox' }, { id: 'sent-box', role: 'sent' }],
    selectedEmail: null as Email | null,
    markAsSpam: vi.fn(async (..._args: unknown[]) => true),
    undoSpam: vi.fn(async (..._args: unknown[]) => true),
  };
  return { client, store };
});

vi.mock('@/stores/auth-store', () => {
  const state = { client: hoisted.client, activeAccountId: null, getClientForAccount: () => undefined };
  const hook = (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state);
  hook.getState = () => state;
  hook.subscribe = () => () => {};
  return { useAuthStore: hook };
});
vi.mock('@/stores/email-store', () => ({
  useEmailStore: Object.assign(
    (sel?: (s: typeof hoisted.store) => unknown) => (sel ? sel(hoisted.store) : hoisted.store),
    { getState: () => hoisted.store },
  ),
  resolveEmailActionContext: () => ({ client: hoisted.client, mailboxes: [], accountId: undefined }),
}));

const { PhishingReportHost } = await import('../phishing-report-host');
const { requestPhishingReport } = await import('@/hooks/use-phishing-report');

function setAddress(address: string, format: 'forward' | 'arf' = 'forward') {
  usePolicyStore.setState({
    policy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, phishingReport: { address, format } } },
  });
}

beforeEach(() => {
  hoisted.store.emails = [e1, e2];
  setAddress('soc@example.org');
});
afterEach(() => {
  usePhishingReportStore.setState({ reported: {} });
  cleanup();
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
  useToastStore.setState({ toasts: [] });
  usePhishingReportStore.setState({ pending: null, busy: false, opener: null });
  vi.clearAllMocks();
});

describe('Report phishing', () => {
  it('asks nothing while the admin set no address', () => {
    setAddress('');
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1], 'inbox'));
    expect(screen.queryByTestId('phishing-report-dialog')).toBeNull();
  });

  it('names the address and sends nothing on Cancel or Escape', () => {
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1], 'inbox'));
    expect(screen.getByRole('alertdialog').textContent).toContain('confirm_message');
    fireEvent.click(screen.getByTestId('phishing-report-cancel'));
    expect(screen.queryByTestId('phishing-report-dialog')).toBeNull();
    act(() => requestPhishingReport([e1], 'inbox'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByTestId('phishing-report-dialog')).toBeNull();
    expect(hoisted.client.sendEmail).not.toHaveBeenCalled();
  });

  it('sends one report per message, moves each to Junk with $phishing, and undoes the move', async () => {
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1, e2], 'inbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('phishing-report-confirm')); });
    expect(hoisted.client.sendEmail).toHaveBeenCalledTimes(2);
    expect((hoisted.client.sendEmail.mock.calls as unknown[][]).map((c) => c[1])).toEqual(['Phishing: Parcel', 'Phishing: Invoice']);
    expect(hoisted.store.markAsSpam).toHaveBeenCalledTimes(2);
    expect(hoisted.store.markAsSpam).toHaveBeenCalledWith(hoisted.client, 'e1', 'e1', { keywords: ['$phishing'], markRead: true });
    const toast = useToastStore.getState().toasts.at(-1)!;
    expect(toast.type).toBe('success');
    expect(toast.title).toBe('done');
    await act(async () => { toast.action!.onClick(); });
    expect(hoisted.store.undoSpam).toHaveBeenCalledWith(hoisted.client, 'e1', 'e1', { clearKeywords: ['$phishing'] });
    expect(hoisted.store.undoSpam).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().toasts.at(-1)!.title).toBe('undone');
  });

  it('says so when the report went but the move to Junk failed', async () => {
    hoisted.store.markAsSpam.mockRejectedValueOnce(new Error('forbidden'));
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1], 'inbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('phishing-report-confirm')); });
    expect(hoisted.client.sendEmail).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'warning', title: 'not_moved' });
  });

  it('moves a message the list does not hold straight through its account', async () => {
    hoisted.store.emails = [];
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1], 'inbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('phishing-report-confirm')); });
    expect(hoisted.client.markAsSpam).toHaveBeenCalledWith('e1', undefined, true, ['$phishing']);
    await act(async () => { useToastStore.getState().toasts.at(-1)!.action!.onClick(); });
    expect(hoisted.client.undoSpam).toHaveBeenCalledWith('e1', 'inbox', undefined, ['$phishing']);
  });

  it('sends an ARF report raw when the admin picked ARF', async () => {
    setAddress('abuse@example.org', 'arf');
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1], 'inbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('phishing-report-confirm')); });
    await waitFor(() => expect(hoisted.client.submitRawEmail).toHaveBeenCalledTimes(1));
    expect(hoisted.client.sendEmail).not.toHaveBeenCalled();
    const raw = await ((hoisted.client.submitRawEmail.mock.calls[0] as unknown[])[0] as Blob).text();
    expect(raw).toContain('report-type=feedback-report');
    await waitFor(() => expect(hoisted.store.markAsSpam).toHaveBeenCalledTimes(1));
  });

  it('says how many came back when only some could be moved back', async () => {
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1, e2], 'inbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('phishing-report-confirm')); });
    hoisted.store.undoSpam.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await act(async () => { useToastStore.getState().toasts.at(-1)!.action!.onClick(); });
    // The "undone" toast counts what came back, not what was reported.
    expect(useToastStore.getState().toasts.at(-1)!.title).toBe('undone');
    expect(hoisted.store.undoSpam).toHaveBeenCalledTimes(2);
    expect(usePhishingReportStore.getState().reported).toEqual({ e2: true });
  });

  it('marks the reported messages for every open view, and unmarks them on Undo', async () => {
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1], 'inbox'));
    await act(async () => { fireEvent.click(screen.getByTestId('phishing-report-confirm')); });
    expect(usePhishingReportStore.getState().reported).toEqual({ e1: true });
    await act(async () => { useToastStore.getState().toasts.at(-1)!.action!.onClick(); });
    expect(usePhishingReportStore.getState().reported).toEqual({});
  });

  it('runs the plugins\u2019 spam hook for a message the list doesn\u2019t hold, and stops the move when it says no', async () => {
    hoisted.store.emails = [];
    const { emailHooks } = await import('@/lib/plugin-hooks');
    const off = emailHooks.onBeforeEmailSpamToggle.register('test-plugin', async () => false);
    try {
      render(<PhishingReportHost />);
      act(() => requestPhishingReport([e1], 'inbox'));
      await act(async () => { fireEvent.click(screen.getByTestId('phishing-report-confirm')); });
      expect(hoisted.client.sendEmail).toHaveBeenCalledTimes(1);
      expect(hoisted.client.markAsSpam).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ type: 'warning', title: 'not_moved' });
    } finally {
      off.dispose();
    }
  });

  it('skips the user\u2019s own sent mail found by search', () => {
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([{ ...e1, mailboxIds: { 'sent-box': true } } as Email], null));
    expect(screen.queryByTestId('phishing-report-dialog')).toBeNull();
  });

  it('skips messages of your own folders', () => {
    render(<PhishingReportHost />);
    act(() => requestPhishingReport([e1], 'sent'));
    expect(screen.queryByTestId('phishing-report-dialog')).toBeNull();
  });
});
