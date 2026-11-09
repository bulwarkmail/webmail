import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { LABEL_PRESETS } from '@/lib/classification/presets';
import { usePolicyStore } from '@/stores/policy-store';

// A received message with a known label shows it next to the sender, in
// the reader and the conversation view; an unknown one, or labels off,
// shows nothing. Headers as both servers hand them back (raw, leading space).

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { EmailViewer } = await import('../email-viewer');
const { ThreadConversationView } = await import('../thread-conversation-view');

const message = (headers: Record<string, string>) => ({
  id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: 'Bob', email: 'bob@example.org' }], to: [{ email: 'me@example.org' }],
  subject: 'Budget', receivedAt: '2026-01-01T00:00:00Z', preview: 'x', hasAttachment: false, size: 100,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [], attachments: [], bodyValues: { '1': { value: 'Numbers' } },
  headers,
}) as unknown as Email;
const mailboxes = [{ id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } }] as unknown as Mailbox[];

function useLabels(on: boolean) {
  usePolicyStore.setState({
    policy: {
      ...DEFAULT_POLICY,
      organisation: { ...DEFAULT_ORGANISATION_POLICY, labels: { ...DEFAULT_ORGANISATION_POLICY.labels, list: on ? LABEL_PRESETS[0].list : [], extraHeader: 'X-Classification' } },
    },
  });
}

afterEach(() => {
  cleanup();
  usePolicyStore.setState({ policy: DEFAULT_POLICY });
});

async function viewer(email: Email) {
  render(<EmailViewer email={email} isLoading={false} mailboxes={mailboxes} selectedMailbox="inbox" currentMailboxRole="inbox" />);
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

describe('the received label chip', () => {
  it('names a known label in the reader, for screen readers too', async () => {
    useLabels(true);
    await viewer(message({ 'SIO-Label': ' marking="CONFIDENTIAL"; fgcolor=#000000; bgcolor=#d97706' }));
    const chips = screen.getAllByTestId('received-label-chip');
    expect(chips[0].getAttribute('aria-label')).toBe('chip_label');
    expect(chips[0].textContent).toBe('Confidential');
    expect(chips[0].getAttribute('style')).toContain('background-color');
  });

  it('matches by the extra header when there is no SIO-Label', async () => {
    useLabels(true);
    await viewer(message({ 'X-Classification': ' Strictly confidential' }));
    expect(screen.getAllByTestId('received-label-chip')[0].textContent).toBe('Strictly confidential');
  });

  it('shows nothing for an unknown label or while labels are off', async () => {
    useLabels(true);
    await viewer(message({ 'SIO-Label': ' marking="TOP SECRET"' }));
    expect(screen.queryByTestId('received-label-chip')).toBeNull();
    cleanup();
    useLabels(false);
    await viewer(message({ 'SIO-Label': ' marking="CONFIDENTIAL"' }));
    expect(screen.queryByTestId('received-label-chip')).toBeNull();
  });

  it('shows in the conversation view', async () => {
    useLabels(true);
    const email = message({ 'sio-label': ' marking="PUBLIC"' });
    render(<ThreadConversationView thread={{ threadId: 't1', emails: [email], latestEmail: email } as never} emails={[email] as never} onBack={() => {}} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getAllByTestId('received-label-chip')[0].textContent).toBe('Public');
  });
});
