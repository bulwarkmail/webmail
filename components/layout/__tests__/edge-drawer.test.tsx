import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EdgeDrawer } from '../edge-drawer';

// The drawer Calendar, Contacts and Files open below the full desktop, with
// the keyboard side Mail's phone drawer uses too (useEdgeDrawer).

function Harness({ contained = false, onPickFocus }: { contained?: boolean; onPickFocus?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>menu</button>
      <input aria-label="elsewhere" />
      <EdgeDrawer open={open} onClose={() => setOpen(false)} contained={contained} data-testid="drawer">
        <button type="button">first</button>
        <button type="button" aria-current="true">current</button>
        <button type="button" onClick={() => { setOpen(false); onPickFocus?.(); }}>pick</button>
      </EdgeDrawer>
    </>
  );
}

describe('EdgeDrawer', () => {
  it('opens on the current item and gives the focus back to the opener after a pick', () => {
    render(<Harness />);
    const menu = screen.getByText('menu');
    menu.focus();
    fireEvent.click(menu);
    expect(document.activeElement).toBe(screen.getByText('current'));
    fireEvent.click(screen.getByText('pick'));
    expect(screen.getByTestId('drawer')).toHaveAttribute('inert');
    expect(document.activeElement).toBe(menu);
  });

  // Seen in the desktop app: with visibility in the opening transition the
  // panel is still hidden in its first frame and refuses the focus.
  it('is visible from its first frame when it opens, and hidden only after sliding out', () => {
    render(<Harness />);
    const classes = () => screen.getByTestId('drawer').className.split(/\s+/);
    expect(classes()).toContain('transition-[transform,visibility]');
    fireEvent.click(screen.getByText('menu'));
    expect(classes()).toContain('transition-transform');
    expect(classes()).not.toContain('transition-[transform,visibility]');
    expect(classes()).not.toContain('invisible');
  });

  it('leaves the focus where a pick moved it, outside the drawer', () => {
    render(<Harness onPickFocus={() => screen.getByLabelText('elsewhere').focus()} />);
    const menu = screen.getByText('menu');
    menu.focus();
    fireEvent.click(menu);
    act(() => fireEvent.click(screen.getByText('pick')));
    expect(document.activeElement).toBe(screen.getByLabelText('elsewhere'));
  });

  it('stays inside a Pro pane: at the pane\'s edge, with only the pane dimmed', () => {
    render(<Harness contained />);
    fireEvent.click(screen.getByText('menu'));
    const classes = screen.getByTestId('drawer').className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['absolute', 'inset-y-0', 'start-0']));
    expect(classes).not.toContain('fixed');
    expect(screen.getByTestId('drawer-scrim').className.split(/\s+/)).toContain('absolute');
  });
});
