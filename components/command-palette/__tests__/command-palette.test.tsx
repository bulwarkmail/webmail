import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';

const nav = vi.hoisted(() => ({ pathname: '/', push: vi.fn() }));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params ? `${key}(${Object.values(params).join(',')})` : key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: nav.push, back: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({
  KeyboardShortcutsModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div>shortcuts help</div> : null),
}));

const { CommandPaletteHost } = await import('../command-palette');
const { useAuthStore } = await import('@/stores/auth-store');
const { useThemeStore } = await import('@/stores/theme-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const { DEFAULT_POLICY, DEFAULT_THEME_POLICY } = await import('@/lib/admin/types');
const appCommands = await import('@/lib/app-commands');

const dispatch = vi.fn().mockResolvedValue(undefined);
const pressCtrlK = (target: Element = document.body) =>
  act(() => { fireEvent.keyDown(target, { key: 'k', code: 'KeyK', ctrlKey: true }); });

beforeEach(() => {
  nav.pathname = '/';
  nav.push.mockClear();
  resetActions();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
  useAuthStore.setState({ isAuthenticated: true, client: null } as never);
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
});
afterEach(() => {
  appCommands.parkAppCommand(null as never);
});

describe('command palette', () => {
  it('opens on Ctrl+K with the search field focused, and closes on Escape', () => {
    render(<CommandPaletteHost />);
    expect(screen.queryByRole('dialog')).toBeNull();

    pressCtrlK();
    expect(screen.getByRole('dialog', { name: 'title' })).toBeInTheDocument();
    const input = screen.getByRole('combobox');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    // The field fills the header of a dialog that clips its overflow: the
    // focus outline goes inside it, or the dialog cuts its top edge off.
    expect(input).toHaveClass('focus-inset');

    act(() => { fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from a menu entry (phones)', () => {
    render(<CommandPaletteHost />);
    act(() => appCommands.openCommandPalette());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('leaves Ctrl+K alone while typing in a field', () => {
    render(<><input aria-label="other field" /><CommandPaletteHost /></>);
    pressCtrlK(screen.getByLabelText('other field'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves Ctrl+K to global search in the Pro shell, and does nothing signed out', () => {
    nav.pathname = '/pro';
    const { unmount } = render(<CommandPaletteHost />);
    pressCtrlK();
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    nav.pathname = '/';
    useAuthStore.setState({ isAuthenticated: false } as never);
    render(<CommandPaletteHost />);
    pressCtrlK();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists the app commands and no plugin group without plugin entries', () => {
    render(<CommandPaletteHost />);
    pressCtrlK();

    // The label, without the key hint after it.
    const labels = screen.getAllByRole('option').map((o) => o.querySelector('.flex-1')?.textContent);
    expect(labels).toContain('go_to(mail)');
    expect(labels).toContain('go_to(settings)');
    expect(labels).toContain('compose');
    expect(labels).toContain('shortcuts');
    expect(screen.queryByText('group_plugins')).toBeNull();
  });

  it("shows Mail's c and / hints only in Mail, where those keys compose and search", () => {
    const hint = (label: string) => {
      const row = screen.getAllByRole('option').find((o) => o.querySelector('.flex-1')?.textContent === label)!;
      return [...row.querySelectorAll('kbd')].map((k) => k.textContent).join(' ');
    };
    const { unmount } = render(<CommandPaletteHost />);
    pressCtrlK();
    expect(hint('compose')).toBe('c');
    expect(hint('search')).toBe('/');
    unmount();

    // Calendar has its own c (new event) and / (search events).
    nav.pathname = '/calendar/week/2026-10-28';
    render(<CommandPaletteHost />);
    pressCtrlK();
    expect(hint('compose')).toBe('');
    expect(hint('search')).toBe('');
  });

  it('shows no single-key hints while single-key shortcuts are off, since those keys do nothing then', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    const hint = (label: string) => {
      const row = screen.getAllByRole('option').find((o) => o.querySelector('.flex-1')?.textContent === label)!;
      return [...row.querySelectorAll('kbd')].map((k) => k.textContent).join(' ');
    };
    useSettingsStore.setState({ singleKeyShortcuts: false });
    try {
      render(<CommandPaletteHost />);
      pressCtrlK();
      expect(hint('compose')).toBe('');
      expect(hint('shortcuts')).toBe('');
    } finally {
      useSettingsStore.setState({ singleKeyShortcuts: true });
    }
  });

  it('names the account Sign out leaves, as the account menu does', async () => {
    const { useAccountStore } = await import('@/stores/account-store');
    const before = useAccountStore.getState().accounts;
    useAccountStore.setState({ accounts: [
      { id: 'a1', email: 'one@example.org', username: 'one@example.org' },
      { id: 'a2', email: 'two@example.org', username: 'two@example.org' },
    ] } as never);
    useAuthStore.setState({ activeAccountId: 'a2' } as never);
    try {
      render(<CommandPaletteHost />);
      pressCtrlK();
      expect(screen.getByText('sign_out_of(two@example.org)')).toBeInTheDocument();
      expect(screen.queryByText('sign_out')).toBeNull();
    } finally {
      useAccountStore.setState({ accounts: before } as never);
    }
  });

  it('shows plugin entries with the plugin name and runs them with Enter', async () => {
    act(() => setPluginActions('jira', 'Jira', 'command-palette', [{ id: 'new-issue', label: 'Create issue' }]));
    render(<CommandPaletteHost />);
    pressCtrlK();

    expect(screen.getByText('group_plugins')).toBeInTheDocument();
    const option = screen.getByRole('option', { name: /Create issue/ });
    expect(option).toHaveTextContent('Jira');

    const input = screen.getByRole('combobox');
    act(() => { fireEvent.change(input, { target: { value: 'issue' } }); });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getByRole('option').id);

    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(dispatch).toHaveBeenCalledWith('jira', 'command-palette', 'new-issue', {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('finds plugin entries by plugin name too', () => {
    act(() => setPluginActions('jira', 'Jira', 'command-palette', [{ id: 'new-issue', label: 'Create issue' }]));
    render(<CommandPaletteHost />);
    pressCtrlK();
    act(() => { fireEvent.change(screen.getByRole('combobox'), { target: { value: 'jir' } }); });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('data-command-id'))).toEqual(['plugin:jira:new-issue']);
  });

  it('moves with the arrow keys and wraps around', () => {
    render(<CommandPaletteHost />);
    pressCtrlK();
    const input = screen.getByRole('combobox');
    const options = () => screen.getAllByRole('option');

    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    act(() => { fireEvent.keyDown(input, { key: 'ArrowDown' }); });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    act(() => { fireEvent.keyDown(input, { key: 'ArrowUp' }); });
    act(() => { fireEvent.keyDown(input, { key: 'ArrowUp' }); });
    expect(options()[options().length - 1]).toHaveAttribute('aria-selected', 'true');
  });

  it('navigates with a go-to command', () => {
    render(<CommandPaletteHost />);
    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'go_to(settings)' })); });
    expect(nav.push).toHaveBeenCalledWith('/settings');
  });

  it('hands compose to the mail page, or opens mail first and parks it', () => {
    const taken = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener('bulwark:app-command', taken);
    render(<CommandPaletteHost />);
    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'compose' })); });
    expect(taken).toHaveBeenCalled();
    expect(nav.push).not.toHaveBeenCalled();
    window.removeEventListener('bulwark:app-command', taken);

    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'compose' })); });
    expect(nav.push).toHaveBeenCalledWith('/');
    expect(appCommands.peekParkedAppCommand()).toBe('compose');
  });

  it('switches the theme and shows the keyboard shortcuts', () => {
    useThemeStore.setState({ resolvedTheme: 'light' } as never);
    const setTheme = vi.fn();
    useThemeStore.setState({ setTheme } as never);
    render(<CommandPaletteHost />);
    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'theme_dark' })); });
    expect(setTheme).toHaveBeenCalledWith('dark');

    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'shortcuts' })); });
    expect(screen.getByText('shortcuts help')).toBeInTheDocument();
  });

  it('offers no theme switch while the theme policy locks the color mode (#1280)', () => {
    usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, themePolicy: { ...DEFAULT_THEME_POLICY, lockColorMode: true } } });
    render(<CommandPaletteHost />);
    pressCtrlK();
    expect(screen.queryByRole('option', { name: /^theme_/ })).toBeNull();
    expect(screen.getByRole('option', { name: 'shortcuts' })).toBeInTheDocument();
  });
});

describe('command palette on a phone', () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => { window.matchMedia = realMatchMedia; });

  it('has a close button, as it fills the screen with nothing to tap around it', () => {
    render(<CommandPaletteHost />);
    act(() => appCommands.openCommandPalette());
    act(() => { fireEvent.click(screen.getByRole('button', { name: 'close' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers no keyboard shortcuts on a touch screen', () => {
    render(<CommandPaletteHost />);
    act(() => appCommands.openCommandPalette());
    expect(screen.queryByRole('option', { name: 'shortcuts' })).toBeNull();
    expect(screen.getByRole('option', { name: 'compose' })).toBeInTheDocument();
  });
});

describe('command palette and plugin pages', () => {
  it('goes to a plugin page like to the built-in apps', async () => {
    const pages = await import('@/lib/plugin-sandbox/pages');
    act(() => pages.setPluginPages('kanban', 'Kanban', [{ id: 'board', title: 'Board' }]));
    render(<CommandPaletteHost />);
    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: /go_to\(Board\)/ })); });
    expect(nav.push).toHaveBeenCalledWith('/apps/kanban/board');
    pages.resetPages();
  });
});

// MO-04 / MO-05: "?" opens the help, except with single-key shortcuts off or
// with a menu or dialog open.
describe('the ? key', () => {
  const pressQuestion = () =>
    act(() => { fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true }); });

  it('opens the shortcuts help', () => {
    render(<CommandPaletteHost />);
    pressQuestion();
    expect(screen.getByText('shortcuts help')).toBeInTheDocument();
  });

  it('does nothing with single-key shortcuts off', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ singleKeyShortcuts: false });
    try {
      render(<CommandPaletteHost />);
      pressQuestion();
      expect(screen.queryByText('shortcuts help')).toBeNull();
    } finally {
      useSettingsStore.setState({ singleKeyShortcuts: true });
    }
  });

  it('does nothing while a menu is open', () => {
    render(<><div role="menu" /><CommandPaletteHost /></>);
    pressQuestion();
    expect(screen.queryByText('shortcuts help')).toBeNull();
  });
});
