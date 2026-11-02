import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { ComposerToolbarMenu, ComposerToolbarMenuItem, ComposerToolbarMenuCheckItem } from '../composer-toolbar-menu';
import { Paperclip } from '@/components/icons';

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

it('opens a named composer menu with Down and returns focus on Escape without invoking an action', async () => {
  const action=vi.fn();
  render(<ComposerToolbarMenu icon={Paperclip} label="Attachment options">{()=> <ComposerToolbarMenuItem onSelect={action}>Attach file</ComposerToolbarMenuItem>}</ComposerToolbarMenu>);
  const trigger=screen.getByRole('button',{name:'Attachment options'});
  trigger.focus();
  fireEvent.keyDown(trigger,{key:'ArrowDown'});
  expect(screen.getByRole('menu',{name:'Attachment options'})).toBeInTheDocument();
  await waitFor(()=>expect(screen.getByRole('menuitem',{name:'Attach file'})).toHaveFocus());
  fireEvent.keyDown(document.activeElement!,{key:'Escape'});
  expect(trigger).toHaveFocus();
  expect(action).not.toHaveBeenCalled();
});
