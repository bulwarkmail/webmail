import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useContactStore } from '@/stores/contact-store';
import { remoteContentBlockedByOrg } from '@/hooks/use-third-party-mode';
import { QuotedHtml, buildQuotedHtmlBlock } from '../quoted-html';

// The ways around an organisation's "block remote content" that the
// first fix (f8805b8d5) left open: the trusted address book, a restriction
// that allows only "block" without locking, the moment before the policy
// has loaded, the trusted senders settings, and a re-opened draft's quote.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');
const { ThreadConversationView } = await import('../thread-conversation-view');
const { ReadingSettings } = await import('@/components/settings/reading-settings');

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const email = {
  id: 'e1', blobId: 'b-e1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'News', email: 'news@shop.example' }], to: [{ email: 'me@example.org' }],
  subject: 'Offer', receivedAt: '2026-10-01T10:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<p>Hello</p><img src="https://track.shop.example/pixel.gif">' } },
} as unknown as Email;

const initialPolicy = usePolicyStore.getState().policy;

function restrict(restriction: Record<string, unknown>) {
  usePolicyStore.setState({ policy: { ...initialPolicy, restrictions: { externalContentPolicy: restriction } } });
}

afterEach(() => {
  usePolicyStore.setState({ policy: initialPolicy, loaded: false, fetching: false });
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [], trustedSendersAddressBook: false });
  useContactStore.setState({ trustedSenderEmails: [] });
});

async function renderViewer() {
  render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

describe('trusted address book', () => {
  it('loads remote content of a sender in the trusted address book when nothing blocks it', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSendersAddressBook: true });
    useContactStore.setState({ trustedSenderEmails: ['news@shop.example'] });
    await renderViewer();
    expect(screen.queryByTestId('external-content-notice')).toBeNull();
  });

  it('keeps it blocked, with nothing offered, while the organisation locks block', async () => {
    restrict({ locked: true, value: 'block' });
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSendersAddressBook: true });
    useContactStore.setState({ trustedSenderEmails: ['news@shop.example'] });
    await renderViewer();
    expect((await screen.findByTestId('external-content-notice')).textContent).toContain('remote_content_blocked');
    expect(screen.queryByText('trust_sender')).toBeNull();
  });

  it('keeps it blocked in the conversation view too', async () => {
    restrict({ locked: true, value: 'block' });
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSendersAddressBook: true });
    useContactStore.setState({ trustedSenderEmails: ['news@shop.example'] });
    const { container } = render(
      <ThreadConversationView thread={{ threadId: 't1', emails: [email], latestEmail: email } as never} emails={[email] as never} onBack={() => {}} />,
    );
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).not.toMatch(/\ssrc="https:\/\/track\.shop\.example/);
  });
});

describe('a restriction that allows only "block"', () => {
  it('counts as a block, without a lock', async () => {
    restrict({ allowedValues: ['block'] });
    expect(remoteContentBlockedByOrg()).toBe(true);
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: ['news@shop.example'] });
    await renderViewer();
    expect((await screen.findByTestId('external-content-notice')).textContent).toContain('remote_content_blocked');
  });

  it('does not count when "ask" is allowed too', () => {
    restrict({ allowedValues: ['block', 'ask'] });
    expect(remoteContentBlockedByOrg()).toBe(false);
  });
});

describe('before the policy has loaded', () => {
  it("doesn't let a trusted sender through while the first policy fetch is on its way", async () => {
    usePolicyStore.setState({ fetching: true, loaded: false });
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: ['news@shop.example'] });
    const { container } = render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const srcdoc = () => container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(screen.getByTestId('external-content-notice')).toBeTruthy();
    expect(srcdoc()).not.toMatch(/\ssrc="https:\/\/track\.shop\.example/);
    // Once the policy is in and doesn't lock anything, trust works.
    await act(async () => { usePolicyStore.setState({ fetching: false, loaded: true }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId('external-content-notice')).toBeNull();
    expect(srcdoc()).toMatch(/\ssrc="https:\/\/track\.shop\.example/);
  });
});

describe('trusted senders settings', () => {
  it('lets users add senders and switch the address book when nothing blocks', async () => {
    render(<ReadingSettings />);
    const toggle = screen.getByText('trusted_senders.use_address_book_label').closest('[class]')!.parentElement!;
    expect(toggle.querySelector('[inert]')).toBeNull();
    fireEvent.click(screen.getByText('trusted_senders.count_zero'));
    expect(await screen.findAllByText('add_manually')).not.toHaveLength(0);
  });

  it('shows the list read-only and the address book switch as the organisation\'s while it blocks', async () => {
    restrict({ locked: true, value: 'block' });
    render(<ReadingSettings />);
    expect(screen.getAllByText('trusted_senders_note').length).toBeGreaterThan(0);
    const switchRow = screen.getByText('trusted_senders.use_address_book_label').closest('div')!.parentElement!.parentElement!;
    expect(switchRow.querySelector('[inert]')).not.toBeNull();
    fireEvent.click(screen.getByText('trusted_senders.count_zero'));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(screen.queryByText('add_manually')).toBeNull();
    expect(screen.getAllByText('org_locked').length).toBeGreaterThan(0);
  });

  it('still lets users take a sender off the list while it blocks', async () => {
    restrict({ locked: true, value: 'block' });
    useSettingsStore.setState({ trustedSenders: ['news@shop.example'], trustedSendersAddressBook: false });
    render(<ReadingSettings />);
    fireEvent.click(screen.getByText('trusted_senders.count_one'));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    fireEvent.click(screen.getByTitle('remove'));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(useSettingsStore.getState().trustedSenders).toEqual([]);
  });
});

describe('a re-opened draft', () => {
  const QUOTE = '<p>Hi</p><img src="https://t.example/pixel.gif" alt="logo">';
  let editor: Editor | null = null;
  afterEach(() => { editor?.destroy(); editor = null; });

  function shadowInner(): HTMLElement {
    const host = editor!.view.dom.querySelector('.quoted-html-island') as HTMLElement;
    return host.shadowRoot!.firstElementChild as HTMLElement;
  }

  it('shows the remote images of a quote that was allowed when the draft was started', () => {
    editor = new Editor({ extensions: [Document, Paragraph, Text, QuotedHtml], content: buildQuotedHtmlBlock(QUOTE, { remoteAllowed: true }) });
    expect(shadowInner().innerHTML).toContain('src="https://t.example/pixel.gif"');
  });

  it('parks them once the organisation blocks remote content', () => {
    restrict({ locked: true, value: 'block' });
    editor = new Editor({ extensions: [Document, Paragraph, Text, QuotedHtml], content: buildQuotedHtmlBlock(QUOTE, { remoteAllowed: true }) });
    expect(shadowInner().innerHTML).not.toMatch(/\ssrc="https:/);
  });
});
