// mail-p3-15: the phone named you by your account name on your own replies
// ("DSO usability audit mail (thro…"). Folded, your own messages now say
// "me", as Gmail and Apple Mail do; the open card keeps the full name.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useIdentityStore } from '@/stores/identity-store';

vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => (address: string) => address }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');

const MY_NAME = 'DSO usability audit mail (throwaway)';
const mail = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `e${n}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: `Sender ${n}`, email: `s${n}@t.example` }], to: [{ email: 'me@example.org' }],
  subject: 'Lunch', receivedAt: `2026-10-2${n}T10:00:00Z`, sentAt: `2026-10-2${n}T10:00:00Z`, size: 1, preview: `hi ${n}`, hasAttachment: false,
  htmlBody: [], textBody: [], attachments: [], bodyValues: {}, ...extra,
});
const mine = (n: number) => mail(n, { from: [{ name: MY_NAME, email: 'me@example.org' }], mailboxIds: { sent: true } });

function senders(emails: ReturnType<typeof mail>[]) {
  useIdentityStore.setState({ identities: [{ id: 'i1', name: MY_NAME, email: 'me@example.org' }] as never });
  const { container } = render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails, latestEmail: emails[0] } as never}
      emails={emails as never}
      onBack={() => {}}
      mailboxRole="inbox"
    />,
  );
  return Object.fromEntries([...container.querySelectorAll('[data-thread-email-id]')].map((card) => [
    card.getAttribute('data-thread-email-id'),
    card.querySelector('[data-conversation-sender]')!.textContent,
  ]));
}

describe('your own messages in the phone conversation', () => {
  it('say "me" while folded and the full name when open', () => {
    // e2 is yours and folded; e4, the newest, is yours and open.
    const shown = senders([mine(4), mail(3), mine(2), mail(1)]);
    expect(shown).toEqual({
      e1: 'Sender 1',
      e2: 'email_viewer.recipient_me',
      e3: 'Sender 3',
      e4: MY_NAME,
    });
  });
});
