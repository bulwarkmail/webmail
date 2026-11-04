import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { clearOffers, offerSlots, slotProps } from '@/components/plugins/__tests__/fake-plugin-offer';

// Plugin surfaces of the message list: frames above the list and in the empty
// list, buttons on each row (hover, and the row menu), and buttons in the
// toolbar shown while messages are selected.

vi.mock('@/components/plugins/plugin-iframe-slot', async () => ({
  PluginIframeSlot: (await import('@/components/plugins/__tests__/fake-plugin-offer')).FakeIframeSlot,
}));
vi.mock('@/hooks/use-email-drag', () => ({
  useEmailDrag: () => ({ dragHandlers: {}, isDragging: false }),
}));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/email/rules-menu', () => ({ RulesContextSubMenu: () => null }));
vi.mock('@/hooks/use-copy-link', () => ({ useCopyLink: () => vi.fn() }));
vi.mock('@/stores/auth-store', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create(() => ({
      client: {}, identities: [], username: null, activeAccountId: 'acct-1',
      getAllConnectedClients: () => new Map(), getClientForAccount: () => null,
    })),
  };
});
vi.mock('@/stores/account-store', () => {
  const state = { getAccountById: () => undefined, accounts: [] };
  return {
    useAccountStore: Object.assign(
      (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
      { getState: () => state },
    ),
  };
});

const { EmailList } = await import('../email-list');
const { MvListToolbar } = await import('../mv-list-toolbar');
const { ThreadListItem } = await import('../thread-list-item');
const { EmailContextMenu } = await import('../email-context-menu');
const { useEmailStore } = await import('@/stores/email-store');
const { useUIStore } = await import('@/stores/ui-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { groupEmailsByThread } = await import('@/lib/thread-utils');

const mail = (id: string): Email => ({
  id,
  threadId: `thread-${id}`,
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  size: 1000,
  receivedAt: '2026-09-30T10:00:00Z',
  from: [{ name: 'Alice', email: 'alice@example.com' }],
  subject: `Mail ${id}`,
  hasAttachment: false,
});

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

const dispatch = vi.fn().mockResolvedValue(undefined);
const initialEmailState = useEmailStore.getState();

beforeEach(() => {
  resetActions();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
  useEmailStore.setState(initialEmailState, true);
  useEmailStore.setState({ selectedMailbox: 'inbox', mailboxes, emails: [], selectedEmailKeys: new Set<string>() });
  useUIStore.setState({ isMobile: false, isCompact: false, isDesktop: true });
  useSettingsStore.setState({ interfaceLayout: 'default', hoverActions: ['delete', 'star'], hoverActionsMode: 'inline' } as never);
});

afterEach(() => {
  clearOffers();
  setActionDispatcher(null);
});

describe('message-list-header', () => {
  it('shows the plugin frame above the list with the folder', () => {
    offerSlots('p1', ['message-list-header']);
    render(<EmailList emails={[mail('a')]} />);

    const frame = screen.getByTestId('slot-message-list-header');
    expect(slotProps(frame)).toEqual({ mailboxId: 'inbox', mailboxRole: 'inbox' });
    // Above the scrolling list, not inside it.
    expect(frame.closest('[data-tour="email-list"]')).toBeNull();
  });

  it('draws nothing without a plugin', () => {
    const { container } = render(<EmailList emails={[mail('a')]} />);
    expect(container.querySelector('[data-plugin-slot="message-list-header"]')).toBeNull();
  });
});

describe('message-list-empty', () => {
  it('shows the frame under the "no messages" text of an empty list', () => {
    offerSlots('p1', ['message-list-empty']);
    render(<EmailList emails={[]} />);

    const frame = screen.getByTestId('slot-message-list-empty');
    expect(slotProps(frame)).toEqual({ mailboxId: 'inbox', mailboxRole: 'inbox', searching: false });
    const text = screen.getByText('no_emails_description');
    expect(text.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says when the empty list is a search', () => {
    offerSlots('p1', ['message-list-empty']);
    useEmailStore.setState({ searchQuery: 'invoice' });
    render(<EmailList emails={[]} />);

    expect(slotProps(screen.getByTestId('slot-message-list-empty')).searching).toBe(true);
  });

  it('is not there when the list has messages, or without a plugin', () => {
    offerSlots('p1', ['message-list-empty']);
    const { unmount } = render(<EmailList emails={[mail('a')]} />);
    expect(screen.queryByTestId('slot-message-list-empty')).toBeNull();
    unmount();
    clearOffers();
    render(<EmailList emails={[]} />);
    expect(screen.queryByTestId('slot-message-list-empty')).toBeNull();
  });
});

describe('message-bulk-actions', () => {
  it('adds the plugin buttons to the selection toolbar and sends the selected ids', async () => {
    const emails = [mail('a'), mail('b'), mail('c')];
    useEmailStore.setState({ emails, selectedEmailKeys: new Set(['a', 'c']) });
    act(() => setPluginActions('tasks', 'Tasks', 'message-bulk-actions', [{ id: 'make', label: 'Make tasks' }]));
    render(<EmailList emails={emails} />);

    const button = screen.getByRole('button', { name: 'Make tasks' });
    // In the toolbar that holds the app's own batch buttons.
    const toolbar = screen.getByText('batch_actions.clear_selection', { selector: 'button' }).parentElement!;
    expect(toolbar).toContainElement(button);
    await act(async () => { fireEvent.click(button); });
    expect(dispatch).toHaveBeenCalledWith('tasks', 'message-bulk-actions', 'make', { emailIds: ['a', 'c'] });
  });

  it('has no plugin buttons without a selection or without a plugin', () => {
    const emails = [mail('a')];
    useEmailStore.setState({ emails, selectedEmailKeys: new Set(['a']) });
    const { unmount } = render(<EmailList emails={emails} />);
    expect(document.querySelector('[data-plugin-actions="message-bulk-actions"]')).toBeNull();
    unmount();

    act(() => setPluginActions('tasks', 'Tasks', 'message-bulk-actions', [{ id: 'make', label: 'Make tasks' }]));
    useEmailStore.setState({ selectedEmailKeys: new Set<string>() });
    render(<EmailList emails={emails} />);
    expect(screen.queryByRole('button', { name: 'Make tasks' })).toBeNull();
  });

  it('puts them behind one "more" button when the list is narrow', async () => {
    // The list next to an open folder sidebar, or on a phone.
    class NarrowObserver {
      constructor(private cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, contentRect: { width: 384, height: 48 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', NarrowObserver);
    try {
      const emails = [mail('a'), mail('b')];
      useEmailStore.setState({ emails, selectedEmailKeys: new Set(['a', 'b']) });
      act(() => setPluginActions('tasks', 'Tasks', 'message-bulk-actions', [
        { id: 'make', label: 'Make tasks' },
        { id: 'more', label: 'Remind me' },
      ]));
      render(<EmailList emails={emails} />);

      expect(screen.queryByRole('button', { name: 'Make tasks' })).toBeNull();
      // "Clear selection" keeps its name for screen readers but drops the text.
      const clear = screen.getByRole('button', { name: 'batch_actions.clear_selection' });
      expect(clear).not.toHaveTextContent('batch_actions.clear_selection');

      fireEvent.click(screen.getByRole('button', { name: 'more_actions' }));
      const item = await screen.findByRole('menuitem', { name: 'Make tasks' });
      expect(screen.getByRole('menuitem', { name: 'Remind me' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(item); });
      expect(dispatch).toHaveBeenCalledWith('tasks', 'message-bulk-actions', 'make', { emailIds: ['a', 'b'] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('adds them to the Mountain View toolbar too', async () => {
    const emails = [mail('a'), mail('b')];
    useEmailStore.setState({ emails, selectedEmailKeys: new Set(['b']) });
    act(() => setPluginActions('tasks', 'Tasks', 'message-bulk-actions', [{ id: 'make', label: 'Make tasks' }]));
    render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make tasks' })); });
    expect(dispatch).toHaveBeenCalledWith('tasks', 'message-bulk-actions', 'make', { emailIds: ['b'] });
  });

  it('leaves the Mountain View toolbar alone without a selection', () => {
    useEmailStore.setState({ emails: [mail('a')] });
    act(() => setPluginActions('tasks', 'Tasks', 'message-bulk-actions', [{ id: 'make', label: 'Make tasks' }]));
    render(<MvListToolbar loadedCount={1} onRefresh={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Make tasks' })).toBeNull();
  });
});

describe('message-row-actions', () => {
  const row = (email: Email) => {
    const [thread] = groupEmailsByThread([email]);
    return <ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={() => {}} />;
  };

  it('adds the plugin buttons after the row\'s own hover buttons', async () => {
    act(() => setPluginActions('p', 'Snooze+', 'message-row-actions', [{ id: 'later', label: 'Later', icon: 'clock' }]));
    const onSelect = vi.fn();
    const [thread] = groupEmailsByThread([mail('a')]);
    render(<ThreadListItem thread={thread} isExpanded={false} onToggleExpand={() => {}} onEmailSelect={onSelect} />);
    // The hover actions mount once the row has been pointed at.
    fireEvent.pointerEnter(screen.getByTestId('email-list-item'));

    const button = screen.getByRole('button', { name: 'Later' });
    const star = screen.getByTestId('hover-action-star');
    expect(star.parentElement).toContainElement(button);
    expect(star.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { fireEvent.click(button); });
    expect(dispatch).toHaveBeenCalledWith('p', 'message-row-actions', 'later', { emailId: 'a' });
    // The click is the plugin's, not a row click that opens the message.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows them even when the user turned off every quick action', () => {
    useSettingsStore.setState({ hoverActions: [] } as never);
    act(() => setPluginActions('p', 'P', 'message-row-actions', [{ id: 'later', label: 'Later' }]));
    render(row(mail('a')));
    fireEvent.pointerEnter(screen.getByTestId('email-list-item'));
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
  });

  it('honours the folder roles the plugin asked for', () => {
    act(() => setPluginActions('p', 'P', 'message-row-actions', [{ id: 'later', label: 'Later', mailboxRoles: ['sent'] }]));
    render(row(mail('a')));
    fireEvent.pointerEnter(screen.getByTestId('email-list-item'));
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  });

  it('draws nothing without a plugin', () => {
    render(row(mail('a')));
    expect(document.querySelector('[data-plugin-actions="message-row-actions"]')).toBeNull();
  });

  const menu = (props: Partial<React.ComponentProps<typeof EmailContextMenu>> = {}) => render(
    <EmailContextMenu
      email={mail('a')}
      position={{ x: 0, y: 0 }}
      isOpen
      onClose={props.onClose ?? (() => {})}
      menuRef={{ current: null }}
      mailboxes={mailboxes}
      selectedMailbox="inbox"
      currentMailboxRole="inbox"
      {...props}
    />,
  );

  it('puts them in the row menu, which is what a long press opens on phones', async () => {
    act(() => setPluginActions('p', 'Snooze+', 'message-row-actions', [{ id: 'later', label: 'Later' }]));
    const onClose = vi.fn();
    menu({ onClose });

    const item = screen.getByRole('menuitem', { name: 'Later' });
    await act(async () => { fireEvent.click(item); });
    expect(dispatch).toHaveBeenCalledWith('p', 'message-row-actions', 'later', { emailId: 'a' });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps them out of the menu for a multi-selection, and out of an empty menu', () => {
    const { unmount } = menu();
    expect(screen.queryByRole('menuitem', { name: 'Later' })).toBeNull();
    unmount();
    act(() => setPluginActions('p', 'P', 'message-row-actions', [{ id: 'later', label: 'Later' }]));
    menu({ isMultiSelect: true, selectedCount: 3 });
    expect(screen.queryByRole('menuitem', { name: 'Later' })).toBeNull();
  });

  it('keeps the menu entries to the folder roles the plugin asked for', () => {
    act(() => setPluginActions('p', 'P', 'message-row-actions', [{ id: 'later', label: 'Later', mailboxRoles: ['junk'] }]));
    menu();
    expect(within(document.body).queryByRole('menuitem', { name: 'Later' })).toBeNull();
  });
});
