import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ComposerToolbarMenu, ComposerToolbarMenuItem, ComposerToolbarMenuCheckItem } from '../composer-toolbar-menu';
import { Paperclip } from '@/components/icons';
import { ComposerBarCompactContext } from '../composer-bar-labels';

describe('ComposerToolbarMenu', () => {
  it('names the button with its label and shows how many options are on', () => {
    render(
      <ComposerToolbarMenu icon={Paperclip} label="Options" activeCount={2} testId="menu">
        {() => null}
      </ComposerToolbarMenu>
    );
    const button = screen.getByTestId('menu');
    expect(button).toHaveAccessibleName('Options');
    expect(button).toHaveTextContent('Options');
    expect(button).toHaveTextContent('2');
  });

  // A composer pane on a wide screen is narrow too: the labels go by the
  // bar's width, not the window's, or they run under Send (#1375).
  it('shows its label only when the composer bar is wide enough', () => {
    render(
      <ComposerToolbarMenu icon={Paperclip} label="Options" testId="menu">
        {() => null}
      </ComposerToolbarMenu>
    );
    const label = screen.getByText('Options');
    expect(label.className).toContain('@[40rem]/composer-bar:inline');
    expect(label.className).not.toMatch(/(^|\s)sm:inline/);
  });

  // inline-reply: in a reply docked under its message the bar keeps to
  // icons up to a wider bar, so it stays one row next to Send.
  it('keeps to its icon in a docked reply up to a wider bar', () => {
    render(
      <ComposerBarCompactContext.Provider value>
        <ComposerToolbarMenu icon={Paperclip} label="Options" testId="menu">
          {() => null}
        </ComposerToolbarMenu>
      </ComposerBarCompactContext.Provider>
    );
    const label = screen.getByText('Options');
    expect(label.className).toContain('@[64rem]/composer-bar:inline');
    expect(label.className).not.toContain('@[40rem]/composer-bar:inline');
  });

  // compose-p3-17: an option that was off showed only its label, no box.
  it('draws an empty box for an option that is off and a ticked one when on', () => {
    const { rerender } = render(<ComposerToolbarMenuCheckItem checked={false} onToggle={() => {}} testId="opt">Plain text</ComposerToolbarMenuCheckItem>);
    const off = screen.getByTestId('opt').querySelector('[data-check-box]')!;
    expect(off.getAttribute('data-check-box')).toBe('off');
    expect(off.className).toContain('border');
    expect(off.querySelector('svg')).toBeNull();
    rerender(<ComposerToolbarMenuCheckItem checked onToggle={() => {}} testId="opt">Plain text</ComposerToolbarMenuCheckItem>);
    const on = screen.getByTestId('opt').querySelector('[data-check-box]')!;
    expect(on.getAttribute('data-check-box')).toBe('on');
    expect(on.querySelector('svg')).not.toBeNull();
  });

  it('keeps the menu open while toggling options and closes on Escape or outside click', async () => {
    const onToggle = vi.fn();
    render(
      <div>
        <button data-testid="outside">x</button>
        <ComposerToolbarMenu icon={Paperclip} label="Options" testId="menu">
          {() => (
            <ComposerToolbarMenuCheckItem checked={false} onToggle={onToggle} description="hint" testId="opt">
              Plain text
            </ComposerToolbarMenuCheckItem>
          )}
        </ComposerToolbarMenu>
      </div>
    );
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByTestId('menu'));
    expect(screen.getByTestId('menu')).toHaveAttribute('aria-expanded', 'true');

    // The app's one menu (R6): the ContextMenu, in a portal.
    expect(screen.getByRole('menu').parentElement).toBe(document.body);
    fireEvent.click(screen.getByTestId('opt'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByTestId('opt')).toHaveAttribute('aria-checked', 'false');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(screen.getByTestId('menu'));
    // The menu listens for a press outside from the next tick on.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes after picking a plain action item', () => {
    const onSelect = vi.fn();
    render(
      <ComposerToolbarMenu icon={Paperclip} label="Templates" testId="menu">
        {(close) => (
          <ComposerToolbarMenuItem onSelect={() => { close(); onSelect(); }} testId="item">
            Insert template
          </ComposerToolbarMenuItem>
        )}
      </ComposerToolbarMenu>
    );
    fireEvent.click(screen.getByTestId('menu'));
    fireEvent.click(screen.getByTestId('item'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
