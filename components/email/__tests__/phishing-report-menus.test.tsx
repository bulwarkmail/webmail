import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { usePolicyStore } from '@/stores/policy-store';
import { usePhishingReportStore } from '@/stores/phishing-report-store';
import { useAuthStore } from '@/stores/auth-store';
import { resetAccountSubjects, useAccountSubjects } from '@/lib/org/account-subjects';
import { requestPhishingReport } from '@/hooks/use-phishing-report';
import { htmlAttachmentDocument } from '@/components/files/file-preview-modal';
import { stampProSource } from '@/components/pro/pro-email-tab-body';

// Where "Report phishing" shows: the row menu, the reader's ⋮ and a
// selection's menu, only while the admin set an address and not in your own
// folders. A reported message ($phishing) shows a banner and its links are off.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');
const { EmailContextMenu } = await import('../email-context-menu');

const email = {
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Phish', email: 'bad@phish.example' }], to: [{ email: 'me@example.org' }],
  subject: 'Parcel', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<p>Track it <a href="https://phish.example/login">here</a></p>' } },
} as unknown as Email;
const other = { ...email, id: 'e2', blobId: 'b2', subject: 'Invoice' } as Email;
const other_message = other;
const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

function setAddress(address: string) {
  usePolicyStore.setState({
    policy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, phishingReport: { address, format: 'forward' } } },
  });
}

function rowMenu(role: string, props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) {
  return render(
    <EmailContextMenu
      email={email}
      position={{ x: 10, y: 10 }}
      isOpen
      onClose={vi.fn()}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole={role}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
  usePhishingReportStore.setState({ pending: null, busy: false, opener: null, reported: {} });
  useAuthStore.setState({ activeAccountId: null, getClientForAccount: () => undefined } as never);
  resetAccountSubjects();
});

describe('several accounts', () => {
  it('names every address a selection across accounts goes to', () => {
    const other = { getUsername: () => 'b@other.example', getSharedAccounts: () => [] };
    useAuthStore.setState({ activeAccountId: 'acct-a', getClientForAccount: (id: string) => (id === 'acct-b' ? other : undefined) } as never);
    const org = { ...DEFAULT_ORGANISATION_POLICY, phishingReport: { address: 'soc@example.org', format: 'forward' as const } };
    usePolicyStore.setState({
      policy: { ...DEFAULT_POLICY, organisation: org },
      rawPolicy: {
        ...DEFAULT_POLICY,
        organisation: org,
        scopes: [{ id: 'other', label: 'Other', match: { domains: ['other.example'] }, policy: { organisation: { phishingReport: { address: 'abuse@other.example' } } } }],
      } as never,
      subject: { email: 'me@example.org', groups: [] },
    });
    useAccountSubjects.setState({ subjects: { 'acct-b': { email: 'b@other.example', groups: [] } }, settled: { 'acct-b': true } });
    const fromB = { ...other_message, sourceClientAccountId: 'acct-b', sourceAccountId: 'jmap-b' } as Email;
    act(() => requestPhishingReport([email, fromB], 'inbox'));
    expect(usePhishingReportStore.getState().pending?.addresses).toEqual(['soc@example.org', 'abuse@other.example']);
  });

  it('a Pro tab stamps a message of another login or a shared account with where it came from', () => {
    useAuthStore.setState({ activeAccountId: 'acct-a' } as never);
    const own = { getAccountId: () => 'jmap-a' };
    expect(stampProSource(email, { client: own as never }, undefined)).toBe(email);
    expect(stampProSource(email, { client: own as never, accountId: 'jmap-team' }, undefined)).toMatchObject({ sourceClientAccountId: 'acct-a', sourceAccountId: 'jmap-team' });
    expect(stampProSource(email, { client: { getAccountId: () => 'jmap-b' } as never }, 'acct-b')).toMatchObject({ sourceClientAccountId: 'acct-b', sourceAccountId: 'jmap-b' });
  });
});

describe('the focus after the dialog', () => {
  it('goes back to the button that opened the menu, not to the menu item that is gone', () => {
    document.body.innerHTML = '<button aria-haspopup="menu" aria-expanded="true" id="more">More</button><div role="menu"><button id="item">Report</button></div>';
    (document.getElementById('item') as HTMLElement).focus();
    act(() => usePhishingReportStore.getState().ask([email], ['soc@example.org']));
    expect(usePhishingReportStore.getState().opener?.id).toBe('more');
    document.body.innerHTML = '';
  });
});

describe('links elsewhere in a reported message', () => {
  it('are off in an attachment preview', () => {
    const doc = htmlAttachmentDocument('<a href="https://phish.example/x">go</a>', true, { title: 'link turned off', note: '(link turned off)' });
    expect(doc).not.toContain('https://phish.example/x');
    expect(htmlAttachmentDocument('<a href="https://ok.example/x">go</a>', true)).toContain('https://ok.example/x');
  });

  it('the unsubscribe banner doesn\u2019t show', async () => {
    const withList = { ...email, headers: { 'List-Unsubscribe': '<https://phish.example/unsub>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } as Email;
    const { unmount } = render(<EmailViewer email={withList} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const shown = document.body.textContent?.includes('phish.example') || screen.queryAllByRole('button', { name: /unsubscribe/i }).length > 0;
    expect(shown).toBe(true);
    unmount();
    const reported = { ...withList, keywords: { $seen: true, $phishing: true } } as Email;
    render(<EmailViewer email={reported} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="junk" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryAllByRole('button', { name: /unsubscribe/i })).toHaveLength(0);
  });

  it('a message reported in this session shows as reported before its keyword arrives', async () => {
    usePhishingReportStore.setState({ reported: { e1: true } });
    render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('phishing-mark-banner')).toBeTruthy();
  });
});

describe('the row menu', () => {
  it('has no Report phishing while the admin set no address', () => {
    rowMenu('inbox');
    expect(screen.queryByTestId('ctx-report-phishing')).toBeNull();
  });

  it('offers it once an address is set, and asks with that address', () => {
    setAddress('soc@example.org');
    rowMenu('inbox');
    fireEvent.click(screen.getByTestId('ctx-report-phishing'));
    expect(usePhishingReportStore.getState().pending).toEqual({ emails: [email], addresses: ['soc@example.org'] });
  });

  it('shows up when the policy arrives after the menu opened', () => {
    rowMenu('inbox');
    expect(screen.queryByTestId('ctx-report-phishing')).toBeNull();
    act(() => setAddress('soc@example.org'));
    expect(screen.getByTestId('ctx-report-phishing')).toBeTruthy();
  });

  it('is not offered in Sent', () => {
    setAddress('soc@example.org');
    rowMenu('sent');
    expect(screen.queryByTestId('ctx-report-phishing')).toBeNull();
  });

  it('reports a whole selection, one message each', () => {
    setAddress('soc@example.org');
    rowMenu('inbox', { isMultiSelect: true, selectedCount: 2, batchEmails: [email, other], onBatchMarkAsSpam: vi.fn() });
    fireEvent.click(screen.getByTestId('ctx-batch-report-phishing'));
    expect(usePhishingReportStore.getState().pending?.emails.map((e) => e.id)).toEqual(['e1', 'e2']);
  });
});

describe('the reader', () => {
  it("offers it in the ⋮ menu", () => {
    setAddress('soc@example.org');
    render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
    expect(within(screen.getByRole('menu', { name: 'more_actions' })).getByTestId('ctx-report-phishing')).toBeTruthy();
  });

  it('shows a reported message with a banner and its links turned off', async () => {
    const reported = { ...email, keywords: { $seen: true, $junk: true, $phishing: true } } as Email;
    const { container } = render(<EmailViewer email={reported} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="junk" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByTestId('phishing-mark-banner').textContent).toContain('banner');
    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('Track it');
    expect(srcdoc).not.toContain('https://phish.example/login');
    expect(srcdoc).toContain('data-link-off');
  });

  it('leaves the links of other messages alone', async () => {
    const { container } = render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('phishing-mark-banner')).toBeNull();
    expect(container.querySelector('iframe')?.getAttribute('srcdoc') ?? '').toContain('https://phish.example/login');
  });
});
