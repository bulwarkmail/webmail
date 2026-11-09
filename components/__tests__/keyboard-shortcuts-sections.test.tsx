import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@/i18n/navigation', () => ({ usePathname: () => nav.pathname }));
vi.mock('@/components/pro/pro-interface-redirect', () => ({ useProInterfaceActive: () => false }));
vi.mock('@/components/tour/tour-provider', () => ({ useTour: () => ({ startTour: vi.fn() }) }));
vi.mock('@/lib/keyboard-shortcuts/calendar', () => ({
  CALENDAR_SECTIONS: [{ id: 'views', title: 'calendar.views', entries: [{ key: 'd', description: 'calendar.day_view' }] }],
}));

// Apps without keys get no tab; Contacts and Files are left empty here for that.
vi.mock('@/lib/keyboard-shortcuts/contacts', () => ({ CONTACTS_SECTIONS: [] }));
vi.mock('@/lib/keyboard-shortcuts/files', () => ({ FILES_SECTIONS: [] }));

const { KeyboardShortcutsModal } = await import('../keyboard-shortcuts-modal');
const { useSettingsStore } = await import('@/stores/settings-store');

describe('keyboard shortcuts help per app', () => {
  it("opens on the current app's tab and lists the general keys there too", () => {
    nav.pathname = '/calendar';
    render(<KeyboardShortcutsModal isOpen onClose={() => {}} />);
    const tabs = screen.getAllByRole('tab');
    // Contacts, Files and Settings have no keys yet: no tabs.
    expect(tabs.map((tab) => tab.textContent)).toEqual(['sidebar.mail', 'sidebar.calendar']);
    expect(screen.getByRole('tab', { name: 'sidebar.calendar' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('calendar.day_view')).toBeInTheDocument();
    expect(screen.getByText('shortcuts.global.help')).toBeInTheDocument();
    expect(screen.queryByText('shortcuts.actions.reply')).toBeNull();

    act(() => { fireEvent.click(screen.getByRole('tab', { name: 'sidebar.mail' })); });
    expect(screen.getByText('shortcuts.actions.reply')).toBeInTheDocument();
    expect(screen.getAllByText('shortcuts.global.help')).toHaveLength(1);
  });

  it('translates "or" between alternatives and uses Ctrl off Apple devices', () => {
    nav.pathname = '/';
    render(<KeyboardShortcutsModal isOpen onClose={() => {}} />);
    expect(screen.getAllByText('or').length).toBeGreaterThan(0);
    // The command palette, and Insert link in the composer.
    expect(screen.getAllByText('Ctrl + K').length).toBe(2);
    expect(screen.queryByText('⌘ + K')).toBeNull();
  });
});

// MO-04: the help says when single-key shortcuts are off.
describe('keyboard shortcuts help with single-key shortcuts off', () => {
  it('says so and drops the "press ?" tip', () => {
    nav.pathname = '/';
    useSettingsStore.setState({ singleKeyShortcuts: false });
    try {
      render(<KeyboardShortcutsModal isOpen onClose={() => {}} />);
      expect(screen.getByText('shortcuts.single_keys_off')).toBeInTheDocument();
      expect(screen.getByText('shortcuts.tip_single_keys_off')).toBeInTheDocument();
      expect(screen.queryByText('shortcuts.tip')).toBeNull();
    } finally {
      useSettingsStore.setState({ singleKeyShortcuts: true });
    }
  });

  it('says nothing with them on', () => {
    nav.pathname = '/';
    render(<KeyboardShortcutsModal isOpen onClose={() => {}} />);
    expect(screen.queryByText('shortcuts.single_keys_off')).toBeNull();
    expect(screen.getByText('shortcuts.tip')).toBeInTheDocument();
  });
});
