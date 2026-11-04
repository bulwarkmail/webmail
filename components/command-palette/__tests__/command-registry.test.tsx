import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/components/global-search/global-search-palette', () => ({
  GlobalSearchPalette: () => null,
}));

const { CommandPaletteHost } = await import('../command-palette');
const { useRegisterCommands, commandMatches } = await import('@/lib/command-registry');
const { useAuthStore } = await import('@/stores/auth-store');
const { useAccountStore } = await import('@/stores/account-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useGlobalSearchStore } = await import('@/stores/global-search-store');
const { DEFAULT_POLICY } = await import('@/lib/admin/types');
const { Plus } = await import('@/components/icons');

const pressCtrlK = () => act(() => { fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true }); });
const optionIds = () => screen.getAllByRole('option').map((o) => o.getAttribute('data-command-id'));
const search = (text: string) => act(() => { fireEvent.change(screen.getByRole('combobox'), { target: { value: text } }); });

function CalendarApp({ newEvent = () => {}, todayVisible = true }: { newEvent?: () => void; todayVisible?: boolean }) {
  useRegisterCommands('Calendar', [
    { id: 'new-event', label: 'New event', icon: Plus, keywords: ['appointment', 'meeting'], shortcut: 'c', run: newEvent },
    { id: 'today', label: 'Go to today', run: () => {}, when: () => todayVisible },
  ]);
  return null;
}

beforeEach(() => {
  nav.pathname = '/calendar';
  nav.push.mockClear();
  useAuthStore.setState({ isAuthenticated: true, client: null, activeAccountId: 'a' } as never);
  useAccountStore.setState({ accounts: [] } as never);
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY } });
  useGlobalSearchStore.setState({ isOpen: false });
});

describe('commands an app registers', () => {
  it('are listed above the global ones while the app is mounted, and go when it unmounts', () => {
    const { rerender } = render(<><CalendarApp /><CommandPaletteHost /></>);
    pressCtrlK();
    const ids = optionIds();
    expect(ids.slice(0, 2)).toEqual(['app:Calendar:new-event', 'app:Calendar:today']);
    expect(ids.indexOf('app:Calendar:today')).toBeLessThan(ids.indexOf('go-mail'));
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    act(() => { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' }); });

    rerender(<CommandPaletteHost />);
    pressCtrlK();
    expect(optionIds()).not.toContain('app:Calendar:new-event');
    expect(screen.queryByText('Calendar')).toBeNull();
  });

  it('are found by label and keywords and run from the palette', () => {
    const newEvent = vi.fn();
    render(<><CalendarApp newEvent={newEvent} /><CommandPaletteHost /></>);
    pressCtrlK();
    search('appoint');
    expect(optionIds()).toEqual(['app:Calendar:new-event']);
    search('new event');
    expect(optionIds()).toContain('app:Calendar:new-event');
    act(() => { fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' }); });
    expect(newEvent).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leave out commands whose `when` is false', () => {
    render(<><CalendarApp todayVisible={false} /><CommandPaletteHost /></>);
    pressCtrlK();
    expect(optionIds()).not.toContain('app:Calendar:today');
    expect(optionIds()).toContain('app:Calendar:new-event');
  });

  it('match every word in any order', () => {
    expect(commandMatches('event new', 'New event')).toBe(true);
    expect(commandMatches('meeting', 'New event', ['appointment', 'meeting'])).toBe(true);
    expect(commandMatches('event task', 'New event')).toBe(false);
  });
});

describe('global commands', () => {
  it('opens the global search from "Search everything"', () => {
    render(<CommandPaletteHost />);
    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'title' })); });
    expect(useGlobalSearchStore.getState().isOpen).toBe(true);
  });

  it('switches to another account and signs out', () => {
    const switchAccount = vi.fn().mockResolvedValue(undefined);
    const logout = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ switchAccount, logout } as never);
    useAccountStore.setState({
      accounts: [
        { id: 'a', label: '', email: 'me@example.com', username: 'me', isConnected: true },
        { id: 'b', label: 'Work', email: 'me@work.example', username: 'me', isConnected: true },
      ],
    } as never);
    render(<CommandPaletteHost />);
    pressCtrlK();
    // The open account isn't offered as a switch target; Sign out names it.
    expect(screen.queryByRole('option', { name: /^switch_to\(me@example\.com/ })).toBeNull();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'switch_to(Work)' })); });
    expect(switchAccount).toHaveBeenCalledWith('b');

    pressCtrlK();
    act(() => { fireEvent.click(screen.getByRole('option', { name: 'sign_out_of(me@example.com)' })); });
    expect(logout).toHaveBeenCalled();
  });
});

describe('the ? key', () => {
  it('opens the keyboard shortcuts in any app, but not while typing or with a modifier', () => {
    render(<><input aria-label="field" /><CommandPaletteHost /></>);
    act(() => { fireEvent.keyDown(screen.getByLabelText('field'), { key: '?', code: 'Slash', shiftKey: true }); });
    act(() => { fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true, ctrlKey: true }); });
    expect(screen.queryByText('shortcuts help')).toBeNull();

    const appHandler = vi.fn();
    document.addEventListener('keydown', appHandler);
    act(() => { fireEvent.keyDown(document.body, { key: '?', code: 'Slash', shiftKey: true }); });
    document.removeEventListener('keydown', appHandler);
    expect(screen.getByText('shortcuts help')).toBeInTheDocument();
    // Mail's own handler doesn't open a second copy.
    expect(appHandler).not.toHaveBeenCalled();
  });
});
