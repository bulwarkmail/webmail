import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';

// The top bar's plugin buttons (top-bar-actions): next to the search field in
// Mountain View's bar, and in the phone header's overflow menu.

vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => <input data-testid="search" /> }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));

const { MvTopBar } = await import('../mv-top-bar');
const { MobileHeader } = await import('../mobile-header');

const dispatch = vi.fn().mockResolvedValue(undefined);

const search = {
  query: '', onQueryChange: vi.fn(), onSubmit: vi.fn(), onClear: vi.fn(), onSelectContact: vi.fn(),
  onToggleFilters: vi.fn(), filtersOpen: false, activeFilterCount: 0,
};

beforeEach(() => {
  resetActions();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
});

describe('Mountain View top bar', () => {
  it('has no plugin buttons when no plugin declared any', () => {
    const { container } = render(<MvTopBar search={search} />);
    expect(container.querySelector('[data-plugin-actions="top-bar-actions"]')).toBeNull();
  });

  it('puts plugin buttons right after the search field and sends the click', async () => {
    act(() => setPluginActions('tr', 'Translator', 'top-bar-actions', [{ id: 'go', label: 'Translate', icon: 'Languages' }]));
    const { container } = render(<MvTopBar search={search} />);

    const group = container.querySelector('[data-plugin-actions="top-bar-actions"]')!;
    expect(group).not.toBeNull();
    const searchField = screen.getByTestId('search');
    expect(searchField.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const button = screen.getByRole('button', { name: 'Translate' });
    // Compact: icon only, the label as tooltip.
    expect(button).toHaveAttribute('title', 'Translate (Translator)');
    await act(async () => { fireEvent.click(button); });
    expect(dispatch).toHaveBeenCalledWith('tr', 'top-bar-actions', 'go', {});
  });

  it('draws a pressed action as a toggle that is on, and follows setActions', () => {
    act(() => setPluginActions('fu', 'Follow-ups', 'top-bar-actions', [
      { id: 'filter', label: 'Follow up', icon: 'flag', pressed: true },
      { id: 'plain', label: 'Plain' },
    ]));
    render(<MvTopBar search={search} />);

    const toggle = screen.getByRole('button', { name: 'Follow up' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(toggle.className).toContain('bg-primary/10');
    // A button that is no toggle says nothing about being pressed.
    expect(screen.getByRole('button', { name: 'Plain' })).not.toHaveAttribute('aria-pressed');

    act(() => setPluginActions('fu', 'Follow-ups', 'top-bar-actions', [
      { id: 'filter', label: 'Follow up', icon: 'flag', pressed: false },
    ]));
    const off = screen.getByRole('button', { name: 'Follow up' });
    expect(off).toHaveAttribute('aria-pressed', 'false');
    expect(off.className).not.toContain('bg-primary/10');
  });
});

describe('phone header', () => {
  it('offers only the command palette in its menu when no plugin declared buttons', () => {
    const opened = vi.fn();
    window.addEventListener('bulwark:command-palette', opened);
    render(<MobileHeader title="Inbox" />);
    fireEvent.click(screen.getByRole('button', { name: 'more' }));

    // Notifications and the command palette (both labelled "title" here, as
    // the translations are keys in tests); no plugin entries.
    const items = screen.getAllByRole('menuitem');
    expect(items.map((m) => m.textContent)).toEqual(['title', 'title']);
    fireEvent.click(items[1]);
    expect(opened).toHaveBeenCalled();
    window.removeEventListener('bulwark:command-palette', opened);
  });

  it('lists plugin buttons in its overflow menu', async () => {
    act(() => setPluginActions('tr', 'Translator', 'top-bar-actions', [{ id: 'go', label: 'Translate' }]));
    render(<MobileHeader title="Inbox" />);

    const more = screen.getByRole('button', { name: 'more' });
    expect(screen.queryByRole('menuitem', { name: 'Translate' })).toBeNull();
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');

    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Translate' })); });
    expect(dispatch).toHaveBeenCalledWith('tr', 'top-bar-actions', 'go', {});
    // The menu closes on the click.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows whether a pressed toggle is on in its overflow menu', async () => {
    act(() => setPluginActions('fu', 'Follow-ups', 'top-bar-actions', [
      { id: 'filter', label: 'Follow up', icon: 'flag', pressed: true },
    ]));
    render(<MobileHeader title="Inbox" />);
    fireEvent.click(screen.getByRole('button', { name: 'more' }));

    const item = screen.getByRole('menuitemcheckbox', { name: 'Follow up' });
    expect(item).toHaveAttribute('aria-checked', 'true');
    await act(async () => { fireEvent.click(item); });
    expect(dispatch).toHaveBeenCalledWith('fu', 'top-bar-actions', 'filter', {});
  });
});
