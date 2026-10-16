import { render, screen } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

// The admin policy's archiveActionEnabled gate (#1257): off, the viewer's
// toolbar has no Archive button.

vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
}));

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));

vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: () => null,
}));

vi.mock('@/hooks/use-plugin-slot-offers', () => ({
  usePluginSlotOffers: () => [],
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { EmailViewer } = await import('../email-viewer');
const { usePolicyStore } = await import('@/stores/policy-store');

const mailboxes: Mailbox[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function makeEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e1',
    blobId: 'b1',
    threadId: 't1',
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }],
    to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello',
    receivedAt: '2026-01-01T00:00:00Z',
    preview: 'Hello',
    hasAttachment: false,
    size: 100,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
    ...overrides,
  } as unknown as Email;
}

function setArchiveGate(on: boolean) {
  usePolicyStore.setState((state) => ({
    policy: { ...state.policy, features: { ...state.policy.features, archiveActionEnabled: on } },
  }));
}

afterEach(() => setArchiveGate(true));

function viewer() {
  return render(
    <EmailViewer
      email={makeEmail()}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      onArchive={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe('the viewer and the Archive action gate', () => {
  it('shows the Archive button while the gate is on', () => {
    viewer();
    expect(screen.getByTitle('tooltips.archive')).toBeInTheDocument();
  });

  it('has no Archive button with the gate off, Delete still there', () => {
    setArchiveGate(false);
    viewer();
    expect(screen.queryByTitle('tooltips.archive')).toBeNull();
    expect(screen.getByTitle('tooltips.delete')).toBeInTheDocument();
  });
});
