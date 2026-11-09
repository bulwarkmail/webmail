import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MailFolderMenu } from '../mail-list-menus';

vi.mock('@/hooks/use-media-query', () => ({
  useMediaQuery: (query: string) => query === '(pointer: coarse)',
  useIsDesktop: () => false,
  useDeviceDetection: () => ({ isMobile: true, isTablet: false, isDesktop: false }),
}));
vi.mock('@/components/layout/account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-actions', () => ({ PluginActions: () => null }));
vi.mock('@/components/notifications/notification-center', () => ({
  NotificationSheet: () => null, formatBadgeCount: String, useUnreadNotificationCount: () => 0,
}));

const { MobileHeader } = await import('@/components/layout/mobile-header');
const { SearchBox } = await import('@/components/search/search-box');

// The default layout's list header gets the Mountain View list ⋮ (MAIL-29),
// and the phone's header ⋮ carries Select all, Refresh and the folder's
// actions (MAIL-28). Search fields on touch say no "(press /)" (SHELL-24).

describe('list header ⋮', () => {
  it('marks the folder read and offers Empty only where given', () => {
    const onMarkFolderRead = vi.fn();
    render(<MailFolderMenu onMarkFolderRead={onMarkFolderRead} onMarkAllFoldersRead={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mail-folder-menu'));
    expect(screen.queryByText('empty_folder')).toBeNull();
    fireEvent.click(screen.getByText('mark_folder_read'));
    expect(onMarkFolderRead).toHaveBeenCalledTimes(1);
  });
  // p2-14: "Empty folder" read the same in Trash and Spam.
  it('names Empty after Trash or Spam', () => {
    const onEmptyFolder = vi.fn();
    render(<MailFolderMenu folderRole="junk" onEmptyFolder={onEmptyFolder} />);
    fireEvent.click(screen.getByTestId('mail-folder-menu'));
    expect(screen.getByTestId('mail-empty-folder').textContent).toContain('empty_spam');
    fireEvent.click(screen.getByTestId('mail-empty-folder'));
    expect(onEmptyFolder).toHaveBeenCalledTimes(1);
  });
  it('carries Refresh and Sort, which have no buttons of their own', () => {
    const onRefresh = vi.fn();
    render(<MailFolderMenu folderRole="inbox" onRefresh={onRefresh} onMarkAllFoldersRead={vi.fn()} />);
    fireEvent.click(screen.getByTestId('mail-folder-menu'));
    expect(screen.getByTestId('mail-sort')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mail-refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('phone header ⋮', () => {
  it("shows the app's entries above the shell's", () => {
    const selectAll = vi.fn();
    render(
      <MobileHeader
        title="Inbox"
        menuItems={(close) => <button role="menuitem" onClick={() => { close(); selectAll(); }}>select all</button>}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'more' }));
    const items = screen.getAllByRole('menuitem');
    expect(items[0].textContent).toBe('select all');
    fireEvent.click(items[0]);
    expect(selectAll).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('search field on touch', () => {
  it('leaves the keyboard hint out', () => {
    const { container } = render(<SearchBox value="" onChange={() => {}} onSubmit={() => {}} onClear={() => {}} onSelectContact={() => {}} />);
    expect(container.querySelector('input[type="search"]')!.getAttribute('placeholder')).toBe('search_placeholder');
  });
});
