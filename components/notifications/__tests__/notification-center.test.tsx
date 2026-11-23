import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The bell and its panel, where they sit (rail, Mountain View's bar, the
// phone header's menu) and what a click on an entry does.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${Object.values(params).join(',')})` : key,
  useFormatter: () => ({ relativeTime: () => 'just now' }),
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/components/layout/account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));

const { NavigationRail } = await import('@/components/layout/navigation-rail');
const { MvTopBar } = await import('@/components/layout/mv-top-bar');
const { MobileHeader } = await import('@/components/layout/mobile-header');
const { useNotificationCenterStore } = await import('@/stores/notification-center-store');
const { useUpdateStore } = await import('@/stores/update-store');
const { toastHooks } = await import('@/lib/plugin-hooks');

const add = useNotificationCenterStore.getState().add;
const clicked = vi.fn();

beforeEach(() => {
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
  act(() => useNotificationCenterStore.getState().clear());
  clicked.mockClear();
  toastHooks.onNotificationClick.register('rss', clicked);
});
afterEach(() => toastHooks.onNotificationClick.removePlugin('rss'));

const bell = () => screen.getByRole('button', { name: /^title/ });

describe('notification bell', () => {
  it('sits in the navigation rail without a count when nothing is unread', () => {
    render(<NavigationRail collapsed />);
    expect(bell()).toHaveAccessibleName('title');
    expect(bell()).toHaveTextContent('');
  });

  it('shows the unread count and lists entries with their source, newest first', () => {
    act(() => {
      add({ level: 'error', title: 'Could not send', body: 'Server said no' });
      add({ level: 'info', title: '3 new posts', body: 'Hacker News', pluginId: 'rss', pluginName: 'RSS Reader', tag: 'feed:hn' });
    });
    render(<NavigationRail collapsed />);

    expect(bell()).toHaveAccessibleName('title (unread_count(2))');
    expect(bell()).toHaveTextContent('2');
    fireEvent.click(bell());

    const panel = screen.getByRole('dialog', { name: 'title' });
    const items = within(panel).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-entry-source'))).toEqual(['rss', 'app']);
    expect(items[0]).toHaveTextContent('3 new posts');
    expect(items[0]).toHaveTextContent('RSS Reader');
    expect(items[1]).toHaveTextContent('Could not send');
    expect(items[1]).toHaveTextContent('Bulwark');
    expect(items[1]).toHaveTextContent('level_error');
  });

  it('tells the plugin when its entry is clicked, with the tag, and marks it read', async () => {
    act(() => add({ level: 'info', title: '3 new posts', body: '', pluginId: 'rss', pluginName: 'RSS Reader', tag: 'feed:hn' }));
    render(<NavigationRail collapsed />);
    fireEvent.click(bell());

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /3 new posts/ })); });
    expect(clicked).toHaveBeenCalledWith({ tag: 'feed:hn' });
    expect(useNotificationCenterStore.getState().entries[0].read).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("shows a plugin's link under its entry, opening in a new tab without the opener", () => {
    act(() => {
      add({ level: 'info', title: 'Filed', body: '', pluginId: 'rss', pluginName: 'Paperless-ngx', action: { label: 'Open in Paperless', url: 'https://paperless.example.com/documents/12/details' } });
      add({ level: 'info', title: 'Odd', body: '', pluginId: 'rss', pluginName: 'X', action: { label: 'Run', url: 'javascript:alert(1)' } });
    });
    render(<NavigationRail collapsed />);
    fireEvent.click(bell());

    const panel = screen.getByRole('dialog', { name: 'title' });
    const links = within(panel).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('Open in Paperless');
    expect(links[0]).toHaveAttribute('href', 'https://paperless.example.com/documents/12/details');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0].getAttribute('rel')).toContain('noopener');
    // Not inside the entry's button.
    expect(links[0].closest('button')).toBeNull();
  });

  // A calendar notice such as 'Alex Example cancelled "Quarterly planning ..."'
  // was cut at one line, and an entry has nothing that shows more (#1834).
  it('shows the whole title and body of an entry, wrapped', () => {
    act(() => add({ level: 'warning', title: 'Alex cancelled "Quarterly planning"', body: 'Moved to next week' }));
    render(<NavigationRail collapsed />);
    fireEvent.click(bell());

    const title = screen.getByText('Alex cancelled "Quarterly planning"');
    expect(title).not.toHaveClass('truncate');
    expect(title).toHaveClass('wrap-anywhere');
    const body = screen.getByText('Moved to next week');
    expect(body.className).not.toMatch(/line-clamp/);
    expect(body).toHaveClass('wrap-anywhere');
  });

  it('marks all read and clears', () => {
    act(() => {
      add({ level: 'warning', title: 'a', body: '' });
      add({ level: 'error', title: 'b', body: '' });
    });
    render(<NavigationRail collapsed />);
    fireEvent.click(bell());

    act(() => { fireEvent.click(screen.getByRole('button', { name: 'mark_all_read' })); });
    expect(bell()).toHaveAccessibleName('title');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    act(() => { fireEvent.click(screen.getByRole('button', { name: 'clear' })); });
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('empty')).toBeInTheDocument();
  });

  it('sits in Mountain View\'s top bar', () => {
    act(() => add({ level: 'error', title: 'a', body: '' }));
    render(<MvTopBar />);
    expect(bell()).toHaveAccessibleName('title (unread_count(1))');
  });

  it('is an entry in the phone header menu that opens the list full screen', () => {
    act(() => add({ level: 'error', title: 'Could not send', body: '' }));
    render(<MobileHeader title="Inbox" />);

    const more = screen.getByRole('button', { name: /^more/ });
    expect(more).toHaveAccessibleName('more (unread_count(1))');
    fireEvent.click(more);
    // First entry: notifications (with the count), then the command palette.
    const [notifications] = screen.getAllByRole('menuitem');
    expect(notifications).toHaveTextContent('1');
    fireEvent.click(notifications);

    const sheet = screen.getByRole('dialog', { name: 'title' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(within(sheet).getByText('Could not send')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('notification panel and the keyboard', () => {
  it('moves the focus into the panel when it opens', () => {
    act(() => add({ level: 'error', title: 'a', body: '' }));
    render(<NavigationRail collapsed />);
    fireEvent.click(bell());
    expect(screen.getByRole('button', { name: 'mark_all_read' })).toHaveFocus();
  });

  it('focuses the panel itself when it has nothing to act on', () => {
    render(<NavigationRail collapsed />);
    fireEvent.click(bell());
    expect(screen.getByRole('dialog', { name: 'title' })).toHaveFocus();
  });

  it('closes and returns to the bell when Tab leaves the panel', () => {
    act(() => add({ level: 'error', title: 'a', body: '' }));
    render(<NavigationRail collapsed />);
    fireEvent.click(bell());
    const clear = screen.getByRole('button', { name: 'clear' });
    clear.focus();
    act(() => { fireEvent.keyDown(clear, { key: 'Tab' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(bell()).toHaveFocus();

    fireEvent.click(bell());
    const markAll = screen.getByRole('button', { name: 'mark_all_read' });
    act(() => { fireEvent.keyDown(markAll, { key: 'Tab', shiftKey: true }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
