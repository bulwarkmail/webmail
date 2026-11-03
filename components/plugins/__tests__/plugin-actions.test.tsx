import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { PluginActions, useMessageActionTarget } from '../plugin-actions';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { resetConfirmedGroups } from '@/lib/plugin-sandbox/account-kind';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';

const dispatch = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  resetActions();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
});

describe('PluginActions', () => {
  it('renders nothing when no plugin declared actions', () => {
    const { container } = render(<PluginActions surface="message-bulk-actions" context={{ emailIds: ['e1'] }} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('draws declared buttons and sends the click with the context', async () => {
    render(<PluginActions surface="message-bulk-actions" context={{ emailIds: ['e1', 'e2'] }} />);
    act(() => setPluginActions('tasks', 'Email to task', 'message-bulk-actions', [{ id: 'make', label: 'Make tasks' }]));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make tasks' })); });

    expect(dispatch).toHaveBeenCalledWith('tasks', 'message-bulk-actions', 'make', { emailIds: ['e1', 'e2'] });
  });

  it('shows only actions meant for the folder or file type', () => {
    act(() => setPluginActions('p', 'P', 'attachment-menu', [
      { id: 'pdf', label: 'Send PDF', mimeTypes: ['application/pdf'] },
      { id: 'img', label: 'Edit image', mimeTypes: ['image/'] },
    ]));

    render(<PluginActions surface="attachment-menu" context={{}} variant="menu" mimeType="image/png" />);

    expect(screen.queryByRole('menuitem', { name: 'Send PDF' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Edit image' })).toBeInTheDocument();
  });

  it('draws a badge on the button, tinted, as the filter button its count', () => {
    act(() => setPluginActions('p', 'P', 'top-bar-actions', [
      { id: 'labels', label: 'Labels', icon: 'tags', badge: 2 },
      { id: 'other', label: 'Other' },
    ]));

    render(<PluginActions surface="top-bar-actions" context={{}} compact />);

    const button = screen.getByRole('button', { name: 'Labels' });
    expect(button.querySelector('[data-plugin-action-badge]')).toHaveTextContent('2');
    expect(button).toHaveClass('bg-primary/10', 'text-primary');
    const other = screen.getByRole('button', { name: 'Other' });
    expect(other.querySelector('[data-plugin-action-badge]')).toBeNull();
    expect(other).not.toHaveClass('bg-primary/10');
  });

  it('draws "99+" past two digits and the count after a menu entry\'s label', () => {
    act(() => setPluginActions('p', 'P', 'top-bar-actions', [{ id: 'labels', label: 'Labels', badge: 120 }]));

    const { unmount } = render(<PluginActions surface="top-bar-actions" context={{}} compact />);
    expect(screen.getByRole('button', { name: 'Labels' })).toHaveTextContent('99+');
    unmount();

    render(<PluginActions surface="top-bar-actions" context={{}} variant="menu" />);
    expect(screen.getByRole('menuitem', { name: /Labels/ })).toHaveTextContent('99+');
  });
});

describe('actions for team mailboxes', () => {
  const TEAM_ACTIONS = [
    { id: 'assign', label: 'Assign to me', accounts: ['group' as const] },
    { id: 'done', label: 'Mark done', accounts: ['group' as const], notKeyword: '$done' },
    { id: 'reopen', label: 'Reopen', accounts: ['group' as const], hasKeyword: '$done' },
  ];

  it("shows them only on a group account's message, by its keywords, and sends its account", async () => {
    act(() => setPluginActions('team', 'Team inbox', 'message-row-actions', TEAM_ACTIONS));
    const view = render(
      <PluginActions surface="message-row-actions" context={{ emailId: 'm1' }} variant="menu"
        target={{ accountId: 'ch', accountKind: 'group', keywords: ['$seen'] }} />,
    );
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Assign to me', 'Mark done']);

    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Mark done' })); });
    expect(dispatch).toHaveBeenCalledWith('team', 'message-row-actions', 'done', { emailId: 'm1', accountId: 'ch' });

    view.rerender(
      <PluginActions surface="message-row-actions" context={{ emailId: 'm1' }} variant="menu"
        target={{ accountId: 'ch', accountKind: 'group', keywords: ['$done'] }} />,
    );
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Assign to me', 'Reopen']);

    view.rerender(
      <PluginActions surface="message-row-actions" context={{ emailId: 'm1' }} variant="menu"
        target={{ accountKind: 'personal', keywords: [] }} />,
    );
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it("hides them where the surface isn't about a message", () => {
    act(() => setPluginActions('team', 'Team inbox', 'message-row-actions', TEAM_ACTIONS));
    const { container } = render(<PluginActions surface="message-row-actions" context={{ emailId: 'm1' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("works out a message's account from the open folder and follows the server's word on groups", async () => {
    let answer!: (types: Record<string, string>) => void;
    const client = {
      getAccountId: () => 'ci',
      getAccountInfo: (id: string) => (id === 'ch' ? { name: 'org-team@example.org', isPersonal: false, isReadOnly: false, accountCapabilities: {} } : null),
      getSharedAccounts: () => [{ id: 'ci', isPrimary: true }, { id: 'ch', isPrimary: false }],
      getPrincipalTypes: () => new Promise((resolve) => { answer = resolve; }),
    } as unknown as IJMAPClient;
    resetConfirmedGroups();
    const team = { id: 'ch:a', originalId: 'a', role: 'inbox', isShared: true, accountId: 'ch' } as unknown as Mailbox;
    useAuthStore.setState({ client });
    useEmailStore.setState({ mailboxes: [team], selectedMailbox: 'ch:a', viewingAccountId: null });
    // The policy subject counting it a group is not enough.
    usePolicyStore.setState({ subject: { email: 'org-alice@example.org', groups: ['org-team@example.org'] } });
    const email = { id: 'm1', keywords: { $seen: true, $done: true } } as unknown as Email;

    const { result } = renderHook(() => useMessageActionTarget(email));
    expect(result.current).toEqual({ accountId: 'ch', accountKind: 'shared', keywords: ['$done', '$seen'] });

    await act(async () => { answer({ ch: 'group' }); });
    expect(result.current.accountKind).toBe('group');

    act(() => useEmailStore.setState({ selectedMailbox: 'inbox', mailboxes: [team, { id: 'inbox', role: 'inbox' } as Mailbox] }));
    expect(result.current).toEqual({ accountKind: 'personal', keywords: ['$done', '$seen'] });

    useAuthStore.setState({ client: null });
    usePolicyStore.setState({ subject: null });
    useEmailStore.setState({ mailboxes: [], selectedMailbox: '' });
  });
});

describe('PluginActions overflow button', () => {
  it('uses the puzzle icon, not a second vertical "more" next to the toolbar\'s own', () => {
    act(() => setPluginActions('tasks', 'Email to task', 'message-bulk-actions', [{ id: 'make', label: 'Make tasks' }]));
    render(<PluginActions surface="message-bulk-actions" context={{ emailIds: ['e1'] }} overflow />);
    const more = screen.getByRole('button', { name: 'more_actions' });
    expect(more.querySelector('.tabler-icon-puzzle')).not.toBeNull();
    expect(more.querySelector('.tabler-icon-dots-vertical')).toBeNull();
  });
});
