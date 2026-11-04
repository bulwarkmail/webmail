// compose-p2-6: on a phone the conversation listed a reply draft as an
// ordinary message, expanded at the top with Reply, Reply all and Forward.
// It is marked Draft and offers Edit and Discard instead.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/hooks/use-wopi-status', () => ({ useWopiStatus: () => ({ enabled: false }), canWopiOpen: () => false }));
vi.mock('@/hooks/use-own-domain-address', () => ({ useOwnDomainAddress: () => () => false }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const { ThreadConversationView } = await import('@/components/email/thread-conversation-view');

const base = {
  threadId: 't1', mailboxIds: { inbox: true }, to: [{ email: 'me@example.org' }],
  subject: 's', size: 1, hasAttachment: false, htmlBody: [], textBody: [], attachments: [], bodyValues: {},
};
const received = { ...base, id: 'e1', keywords: { $seen: true }, from: [{ name: 'Ann', email: 'ann@t.example' }], receivedAt: '2026-11-01T10:00:00Z', preview: 'question' };
const draft = { ...base, id: 'd1', keywords: { $seen: true, $draft: true }, from: [{ name: 'Me', email: 'me@example.org' }], receivedAt: '2026-11-02T10:00:00Z', preview: 'my answer' };

function renderView(handlers: Record<string, unknown>) {
  render(
    <ThreadConversationView
      thread={{ threadId: 't1', emails: [draft, received], latestEmail: draft } as never}
      emails={[draft, received] as never}
      onBack={() => {}}
      onReply={() => {}}
      onReplyAll={() => {}}
      onForward={() => {}}
      {...handlers}
    />,
  );
}

describe('a draft in a phone conversation', () => {
  it('is marked Draft, and the newest received message is the one open', () => {
    renderView({});
    expect(screen.getAllByTestId('conversation-draft-label')).toHaveLength(1);
    // Only the received message is open, with its Reply.
    expect(screen.getAllByRole('button', { name: /email_viewer.reply$/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /email_viewer.edit_draft/ })).toBeNull();
  });

  it('offers Edit and Discard instead of Reply once opened', () => {
    const onEditDraft = vi.fn();
    const onDiscardDraft = vi.fn();
    renderView({ onEditDraft, onDiscardDraft });
    fireEvent.click(screen.getByText('my answer'));
    expect(screen.getAllByRole('button', { name: /email_viewer.reply$/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /email_viewer.edit_draft/ }));
    fireEvent.click(screen.getByRole('button', { name: /email_composer.discard/ }));
    expect(onEditDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
    expect(onDiscardDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
  });
});
