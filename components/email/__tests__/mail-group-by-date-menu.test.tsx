import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { MailFolderMenu } from '../mail-list-menus';

// "Group by date" in the list header's ⋮, right after Sort: it shows and
// flips the same setting as the toggle in Settings → Message list.

const initial = { policy: usePolicyStore.getState(), settings: useSettingsStore.getState() };

beforeEach(() => {
  useSettingsStore.setState({ groupListByDate: false });
  useAuthStore.setState({ client: { getEmailQuerySortOptions: () => null } } as never);
});

afterEach(() => {
  usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState(initial.settings, true);
});

function openMenu() {
  render(<MailFolderMenu folderRole="inbox" onMarkAllFoldersRead={vi.fn()} />);
  fireEvent.click(screen.getByTestId('mail-folder-menu'));
}

const restrict = (rule: { hidden?: boolean; locked?: boolean }) =>
  usePolicyStore.setState((state) => ({
    policy: { ...state.policy, restrictions: { ...state.policy.restrictions, groupListByDate: rule } },
  }));

describe('Group by date in the list ⋮', () => {
  it('sits right after Sort and shows the setting', () => {
    openMenu();
    const item = screen.getByTestId('mail-group-by-date');
    expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect(item.textContent).toContain('group_by_date');
    const entries = [...screen.getByRole('menu').querySelectorAll('[role^="menuitem"]')];
    expect(entries.indexOf(item)).toBe(entries.indexOf(screen.getByTestId('mail-sort')) + 1);
  });

  it('turns the setting on and closes the menu', () => {
    openMenu();
    fireEvent.click(screen.getByTestId('mail-group-by-date'));
    expect(useSettingsStore.getState().groupListByDate).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('is ticked while the setting is on, and turns it off', () => {
    useSettingsStore.setState({ groupListByDate: true });
    openMenu();
    expect(screen.getByTestId('mail-group-by-date').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('mail-group-by-date'));
    expect(useSettingsStore.getState().groupListByDate).toBe(false);
  });

  it('is left out when policy hides the setting, and disabled when it locks it', () => {
    restrict({ hidden: true });
    const { unmount } = render(<MailFolderMenu folderRole="inbox" />);
    fireEvent.click(screen.getByTestId('mail-folder-menu'));
    expect(screen.queryByTestId('mail-group-by-date')).toBeNull();
    unmount();

    restrict({ locked: true });
    openMenu();
    expect(screen.getByTestId('mail-group-by-date')).toBeDisabled();
  });
});
