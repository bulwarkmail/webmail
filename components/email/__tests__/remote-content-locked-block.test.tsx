import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { remoteContentBlockedByOrg } from '@/hooks/use-third-party-mode';

// An organisation that locks the external content setting to "block" means
// it: a sender the user trusted before (or trusts now) doesn't load remote
// content, and nothing offers to trust or load.

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

const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];
const email = {
  id: 'e1', blobId: 'b-e1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'News', email: 'news@shop.example' }], to: [{ email: 'me@example.org' }],
  subject: 'Offer', receivedAt: '2026-10-01T10:00:00Z', preview: 'Hello', hasAttachment: false, size: 100,
  textBody: [], htmlBody: [{ partId: '1', type: 'text/html' }], attachments: [],
  bodyValues: { '1': { value: '<p>Hello</p><img src="https://track.shop.example/pixel.gif">' } },
} as unknown as Email;

const initialPolicy = usePolicyStore.getState().policy;

function lockExternalContent(restriction: Record<string, unknown>, defaults: Record<string, unknown> = {}) {
  usePolicyStore.setState({
    policy: {
      ...initialPolicy,
      restrictions: { externalContentPolicy: restriction },
      defaults: { ...initialPolicy.defaults, ...defaults },
    },
  });
}

afterEach(() => {
  usePolicyStore.setState({ policy: initialPolicy });
  useSettingsStore.setState({ externalContentPolicy: 'ask', trustedSenders: [] });
});

async function renderViewer() {
  render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
}

async function renderConversation() {
  const view = render(
    <ThreadConversationView thread={{ threadId: 't1', emails: [email], latestEmail: email } as never} emails={[email] as never} onBack={() => {}} />,
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  return view;
}

describe('external content locked to block', () => {
  it('a trusted sender still loads remote content when the user chose block', async () => {
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: ['news@shop.example'] });
    await renderViewer();
    expect(screen.queryByTestId('external-content-notice')).toBeNull();
  });

  it('keeps a trusted sender blocked in the reading pane, with no trust button', async () => {
    lockExternalContent({ locked: true, value: 'block' });
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: ['news@shop.example'] });
    await renderViewer();
    const notice = await screen.findByTestId('external-content-notice');
    expect(notice.textContent).toContain('remote_content_blocked');
    expect(screen.queryByText('trust_sender')).toBeNull();
    expect(screen.queryByText('load_external_content')).toBeNull();
  });

  it('keeps a trusted sender blocked in the conversation view, with nothing offered', async () => {
    lockExternalContent({ locked: true, value: 'block' });
    useSettingsStore.setState({ externalContentPolicy: 'block', trustedSenders: ['news@shop.example'] });
    const { container } = await renderConversation();
    expect(screen.getByTestId('external-content-notice').textContent).toContain('third_party.remote_content_blocked');
    expect(screen.queryByText('email_viewer.load_external_content')).toBeNull();
    expect(screen.queryByText('email_viewer.trust_sender')).toBeNull();
    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).not.toMatch(/\ssrc="https:\/\/track\.shop\.example/);
  });
});

describe('remoteContentBlockedByOrg', () => {
  it('is true for a lock to block, also when the block comes from the defaults', () => {
    lockExternalContent({ locked: true, value: 'block' });
    expect(remoteContentBlockedByOrg()).toBe(true);
    lockExternalContent({ locked: true }, { externalContentPolicy: 'block' });
    expect(remoteContentBlockedByOrg()).toBe(true);
  });

  it('is false for a lock to ask, and for block without a lock', () => {
    lockExternalContent({ locked: true, value: 'ask' });
    expect(remoteContentBlockedByOrg()).toBe(false);
    lockExternalContent({ value: 'block' });
    expect(remoteContentBlockedByOrg()).toBe(false);
  });
});
