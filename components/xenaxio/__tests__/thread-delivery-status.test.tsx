// Step 15: the delivery status shows in a conversation too (phone thread view),
// on the user's own sent copy only.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const t = Object.assign((k: string) => k, { raw: (k: string) => k, rich: (k: string) => k });
vi.mock('next-intl', () => ({ useTranslations: () => t, useLocale: () => 'en' }));
vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/components/xenaxio/delivery-status', () => ({
  DeliveryStatus: ({ emailId }: { emailId: string }) => <div data-testid="delivery-status">{emailId}</div>,
}));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { useEmailStore } = await import('@/stores/email-store');
const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');

const mail = (id: string, mailbox: string, receivedAt: string) => ({
  id, blobId: `blob-${id}`, threadId: 't1', mailboxIds: { [mailbox]: true }, keywords: { $seen: true },
  from: [{ name: 'Me', email: 'me@example.org' }], to: [{ email: 'me@example.org' }],
  subject: 'Selftest', receivedAt, size: 1, preview: 'Selftest', hasAttachment: false,
  textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [],
  bodyValues: { '1': { value: 'Selftest' } },
});

describe('delivery status in a conversation', () => {
  it('shows on the sent copy, not on the received one', async () => {
    useEmailStore.setState({ mailboxes: [{ id: 'mb-sent', role: 'sent' }, { id: 'mb-inbox', role: 'inbox' }] as never });
    const sent = mail('sent', 'mb-sent', '2026-10-22T22:08:00Z');
    const received = mail('received', 'mb-inbox', '2026-10-22T22:08:01Z');
    render(
      <ThreadConversationView
        thread={{ threadId: 't1', emails: [received, sent], latestEmail: received } as never}
        emails={[received, sent] as never}
        onBack={() => {}}
      />,
    );
    // Unfold both messages.
    for (const card of screen.getAllByRole('button', { name: /Me/ })) {
      if (!card.querySelector('svg.lucide-chevron-up')) card.click();
    }
    await waitFor(() => expect(screen.getAllByTestId('delivery-status').map((n) => n.textContent)).toEqual(['sent']));
  }, 30_000);
});
