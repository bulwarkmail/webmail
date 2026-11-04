// mail-p2-6: the phone listed a conversation newest first while every other
// layout reads it oldest first. It now reads oldest first too, with the
// newest message (your own reply as well) open at the bottom.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');

const mail = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `e${n}`, threadId: 't1', mailboxIds: { inbox: true }, keywords: { $seen: true },
  from: [{ name: `Sender ${n}`, email: `s${n}@t.example` }], to: [{ email: 'me@example.org' }],
  subject: 'Lunch', receivedAt: `2026-10-2${n}T10:00:00Z`, sentAt: `2026-10-2${n}T10:00:00Z`, size: 1, preview: `hi ${n}`, hasAttachment: false,
  htmlBody: [], textBody: [], attachments: [], bodyValues: {}, ...extra,
});

function renderView(emails: ReturnType<typeof mail>[]) {
  return render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails, latestEmail: emails[0] } as never}
      emails={emails as never}
      onBack={() => {}}
      mailboxRole="inbox"
    />,
  );
}

const order = (c: HTMLElement) => [...c.querySelectorAll('[data-thread-email-id]')].map((e) => e.getAttribute('data-thread-email-id'));

describe('phone conversation order', () => {
  it('lists the messages oldest first, as the thread arrives newest first', () => {
    const { container } = renderView([mail(3), mail(2), mail(1)]);
    expect(order(container)).toEqual(['e1', 'e2', 'e3']);
  });

  it('opens the newest message, your own reply too, and not a draft after it', () => {
    const mine = mail(3, { from: [{ name: 'Me', email: 'me@example.org' }], mailboxIds: { sent: true } });
    const draft = mail(4, { keywords: { $draft: true, $seen: true } });
    const { container } = renderView([draft, mine, mail(2), mail(1)]);
    const expanded = [...container.querySelectorAll('[data-thread-email-id]')]
      .filter((el) => el.querySelector('[aria-expanded="true"]'))
      .map((el) => el.getAttribute('data-thread-email-id'));
    expect(expanded).toEqual(['e3']);
  });
});
