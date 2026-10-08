import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';

vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('../rules-menu', () => ({ RulesContextSubMenu: () => null }));
vi.mock('@/hooks/use-copy-link', () => ({ useCopyLink: () => vi.fn() }));

const { EmailContextMenu } = await import('../email-context-menu');

const rights = { mayAddItems: true } as Mailbox['myRights'];
function mailbox(id: string, extra: Partial<Mailbox> = {}): Mailbox {
  return { id, name: id, role: undefined, parentId: undefined, myRights: rights, ...extra } as unknown as Mailbox;
}

const email = { id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true } } as unknown as Email;
const ownMailboxes = [mailbox('inbox', { role: 'inbox', name: 'Inbox' }), mailbox('archive', { role: 'archive', name: 'Archive' })];
const otherMailboxes = [
  mailbox('b-inbox', { role: 'inbox', name: 'Inbox' }),
  mailbox('b-drafts', { role: 'drafts', name: 'Drafts' }),
  mailbox('b-work', { name: 'Work' }),
  mailbox('b-readonly', { name: 'Read only', myRights: { mayAddItems: false } as Mailbox['myRights'] }),
];

function renderMenu(props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) {
  return render(
    <EmailContextMenu
      email={email}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={() => {}}
      menuRef={{ current: null }}
      mailboxes={ownMailboxes}
      selectedMailbox="inbox"
      {...props}
    />,
  );
}

describe('Copy to entry of the message menu', () => {
  it('is hidden without another connected account', () => {
    renderMenu({ onCopyToAccount: vi.fn(), copyTargets: [] });
    expect(screen.queryByTestId('ctx-copy-to')).toBeNull();
  });

  it('lists the writable folders of the other accounts and copies into the picked one', () => {
    const onCopyToAccount = vi.fn();
    renderMenu({
      onCopyToAccount,
      copyTargets: [{ accountId: 'local-B', label: 'bob@example.org', mailboxes: otherMailboxes }],
    });
    fireEvent.mouseEnter(screen.getByTestId('ctx-copy-to').parentElement!);

    expect(screen.getByText('bob@example.org')).toBeTruthy();
    expect(screen.getByTestId('copy-to:local-B:b-inbox')).toBeTruthy();
    expect(screen.getByTestId('copy-to:local-B:b-work')).toBeTruthy();
    expect(screen.queryByTestId('copy-to:local-B:b-drafts')).toBeNull();
    expect(screen.queryByTestId('copy-to:local-B:b-readonly')).toBeNull();

    fireEvent.click(screen.getByTestId('copy-to:local-B:b-work'));
    expect(onCopyToAccount).toHaveBeenCalledWith('local-B', 'b-work');
  });

  it('leaves Move to on the current account', () => {
    renderMenu({
      onCopyToAccount: vi.fn(),
      copyTargets: [{ accountId: 'local-B', label: 'bob@example.org', mailboxes: otherMailboxes }],
    });
    fireEvent.mouseEnter(screen.getByTestId('ctx-move-to').parentElement!);
    expect(screen.getByTestId('move-to:archive')).toBeTruthy();
    expect(screen.queryByTestId('move-to:b-work')).toBeNull();
  });

  it('offers the shared account folders first for a message in a shared mailbox (#1149)', () => {
    const sharedBox = (id: string, name: string, role?: string) =>
      mailbox(`S:${id}`, { name, role, originalId: id, accountId: 'S', accountName: 'info@example.org', isShared: true });
    const mailboxes = [
      mailbox('inbox', { role: 'inbox', name: 'Inbox', accountId: 'A', accountName: 'me@example.org' }),
      mailbox('junk', { role: 'junk', name: 'Junk', accountId: 'A', accountName: 'me@example.org' }),
      sharedBox('inbox', 'Inbox', 'inbox'),
      sharedBox('junk', 'Junk', 'junk'),
    ];
    const onMoveToMailbox = vi.fn();
    renderMenu({
      email: { id: 'e1', keywords: { $seen: true }, mailboxIds: { 'S:inbox': true } } as unknown as Email,
      mailboxes,
      selectedMailbox: 'S:inbox',
      onMoveToMailbox,
    });
    fireEvent.mouseEnter(screen.getByTestId('ctx-move-to').parentElement!);

    const items = screen.getAllByTestId(/^move-to:/).map((el) => el.getAttribute('data-testid'));
    expect(items).toEqual(['move-to:S:junk', 'move-to:inbox', 'move-to:junk']);

    fireEvent.click(screen.getByTestId('move-to:S:junk'));
    expect(onMoveToMailbox).toHaveBeenCalledWith('S:junk');
  });
});
