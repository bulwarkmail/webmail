import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Email } from '@/lib/jmap/types';

// #1852: an attachment in the conversation view (the phone's thread view,
// Mountain View's expanded messages) can be saved to Files, as in the reader.

vi.mock('@/lib/offline/availability', async (original) => ({
  ...(await original<typeof import('@/lib/offline/availability')>()),
  scopeDecided: () => true,
}));
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

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { ThreadConversationView } = await import('../thread-conversation-view');
const { useAuthStore } = await import('@/stores/auth-store');
const { usePolicyStore } = await import('@/stores/policy-store');

function makeEmail(): Email {
  return {
    id: 'e1', blobId: 'b1', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
    from: [{ name: 'Alice', email: 'alice@example.com' }], to: [{ name: 'Bob', email: 'bob@example.com' }],
    subject: 'Hello', receivedAt: '2026-01-01T00:00:00Z', preview: 'Hello', hasAttachment: true, size: 100,
    textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }],
    attachments: [{ partId: '2', blobId: 'blob-1', name: 'invoice.pdf', type: 'application/pdf', size: 10, disposition: 'attachment' }],
    bodyValues: { 1: { value: 'Hello' } },
  } as unknown as Email;
}

/** Answers anything the view asks of a client with nothing, Files aside. */
function makeClient(files: boolean) {
  const listAllFileNodes = vi.fn(async () => []);
  const client = new Proxy({}, {
    get: (_target, name) => {
      if (name === 'then') return undefined;
      if (name === 'supportsFiles') return () => files;
      if (name === 'listAllFileNodes') return listAllFileNodes;
      return () => undefined;
    },
  });
  return { client, listAllFileNodes };
}

function conversation() {
  render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails: [makeEmail()], latestEmail: makeEmail() } as never}
      emails={[makeEmail()] as never}
      onBack={() => {}}
    />,
  );
}

const saveButton = () => screen.queryByRole('button', { name: 'email_viewer.save_to_files.title' });

afterEach(() => {
  cleanup();
  useAuthStore.setState({ activeAccountId: null, client: null } as never);
  usePolicyStore.setState({ demoFeatureOverrides: {} } as never);
});

describe('Save to Files in the conversation view', () => {
  beforeEach(() => {
    usePolicyStore.setState({ demoFeatureOverrides: {} } as never);
  });

  it('opens the folder picker for the attachment', async () => {
    const { client, listAllFileNodes } = makeClient(true);
    useAuthStore.setState({ activeAccountId: 'acct', client } as never);
    conversation();
    await waitFor(() => expect(saveButton()).not.toBeNull());
    fireEvent.click(saveButton()!);
    await waitFor(() => expect(listAllFileNodes).toHaveBeenCalled());
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('has none when the server has no Files', async () => {
    useAuthStore.setState({ activeAccountId: 'acct', client: makeClient(false).client } as never);
    conversation();
    await screen.findByText(/invoice\.pdf/);
    expect(saveButton()).toBeNull();
  });

  it('has none when the admin turned Files off', async () => {
    usePolicyStore.setState({ demoFeatureOverrides: { filesEnabled: false } } as never);
    useAuthStore.setState({ activeAccountId: 'acct', client: makeClient(true).client } as never);
    conversation();
    await screen.findByText(/invoice\.pdf/);
    expect(saveButton()).toBeNull();
  });
});
