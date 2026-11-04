import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressBook, Calendar } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useContactStore } from '@/stores/contact-store';
import { useSettingsStore, DEFAULT_KEYWORDS } from '@/stores/settings-store';
import { KeywordSettings } from '../keyword-settings';
import { CalendarManagementSettings } from '../calendar-management-settings';
import { AddressBookManagementSettings } from '../address-book-management-settings';

// R7: row actions that appear on hover also show on keyboard focus and are
// always visible on a touch screen, where there is no hover.

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const initial = {
  auth: useAuthStore.getState(),
  calendar: useCalendarStore.getState(),
  contacts: useContactStore.getState(),
  settings: useSettingsStore.getState(),
};
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useCalendarStore.setState(initial.calendar, true);
  useContactStore.setState(initial.contacts, true);
  useSettingsStore.setState(initial.settings, true);
});

function expectReachable(button: HTMLElement) {
  const group = button.parentElement as HTMLElement;
  expect(group.className).toContain('focus-within:opacity-100');
  expect(group.className).toContain('pointer-coarse:opacity-100');
}

describe('settings row actions on touch and keyboard', () => {
  it('tags', () => {
    useSettingsStore.setState({ emailKeywords: [...DEFAULT_KEYWORDS], nestedTags: false });
    render(<KeywordSettings />);
    expectReachable(screen.getAllByTitle('edit')[0]);
  });

  it('calendars', () => {
    useAuthStore.setState({ client: { getAccountId: () => 'acc' }, serverUrl: null, username: null } as never);
    useCalendarStore.setState({
      calendars: [{ id: 'c', name: 'Work', color: '#3b82f6', isDefault: false, isShared: false, shareWith: null, myRights: { mayShare: true, mayDelete: true, mayWriteAll: true } } as unknown as Calendar],
      icalSubscriptions: [],
    } as never);
    render(<CalendarManagementSettings />);
    // No hover icons since pim-20: Edit… and the ⋮ are always shown.
    for (const name of ['edit_calendar', 'row_actions']) {
      const button = screen.getByRole('button', { name });
      expect(button.className).not.toContain('opacity-0');
      expect((button.parentElement as HTMLElement).className).not.toContain('opacity-0');
    }
  });

  it('address books', () => {
    useAuthStore.setState({ client: { getAccountId: () => 'acc' } } as never);
    useContactStore.setState({
      addressBooks: [{ id: 'b', name: 'Club', isDefault: false, isShared: false, shareWith: null, myRights: { mayRead: true, mayWrite: true, mayDelete: true } } as unknown as AddressBook],
      contacts: [],
      fetchAddressBooks: vi.fn(async () => {}),
    } as never);
    render(<AddressBookManagementSettings />);
    expectReachable(screen.getByTitle('rename'));
  });
});
