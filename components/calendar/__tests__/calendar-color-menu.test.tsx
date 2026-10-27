import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuSubMenu } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { CalendarColorPicker } from '@/components/settings/calendar-management-settings';

// The sidebar's "Change color" submenu, as calendar-sidebar-panel builds it.
// "+" opens the system color dialog. It takes the focus away from the
// window, and the menu closed on that blur, removing the input before the
// user clicked OK: the chosen color was lost (#1366).
function ColorMenu({ onColor }: { onColor: (color: string) => void }) {
  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<string>();
  return (
    <>
      <button type="button" onContextMenu={(e) => openContextMenu(e, 'cal')}>Work</button>
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        <ContextMenuSubMenu label="Change color" testId="color">
          <CalendarColorPicker value="#3b82f6" onChange={(c) => { onColor(c); closeContextMenu(); }} allowCustom />
        </ContextMenuSubMenu>
      </ContextMenu>
    </>
  );
}

async function openColorDialog(onColor = vi.fn()) {
  render(<ColorMenu onColor={onColor} />);
  fireEvent.contextMenu(screen.getByText('Work'));
  // The menu listens for outside clicks and blur from the next tick on.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  fireEvent.mouseEnter(screen.getByTestId('color').parentElement!);
  const input = screen.getByTitle('Custom color').querySelector('input[type="color"]') as HTMLInputElement;
  input.focus();
  return { input, onColor };
}

describe('the calendar color menu with the system color dialog (#1366)', () => {
  it('stays open while the dialog has the focus and applies the color picked there', async () => {
    const { input, onColor } = await openColorDialog();

    act(() => { window.dispatchEvent(new Event('blur')); });
    fireEvent.mouseLeave(screen.getByTestId('color').parentElement!);
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(input.isConnected).toBe(true);

    fireEvent.change(input, { target: { value: '#b36201' } });
    expect(onColor).toHaveBeenCalledWith('#b36201');
    expect(screen.queryByTestId('color')).toBeNull();
  });

  it('applies the color once the dialog confirms it, not at every step', async () => {
    const { input, onColor } = await openColorDialog();

    fireEvent.input(input, { target: { value: '#111111' } });
    expect(onColor).not.toHaveBeenCalled();
    expect(input.isConnected).toBe(true);

    fireEvent.change(input, { target: { value: '#222222' } });
    expect(onColor).toHaveBeenCalledTimes(1);
    expect(onColor).toHaveBeenCalledWith('#222222');
  });

  it('still closes when the window loses the focus from elsewhere', async () => {
    const { input } = await openColorDialog();
    input.blur();

    act(() => { window.dispatchEvent(new Event('blur')); });

    expect(screen.queryByTestId('color')).toBeNull();
  });
});
