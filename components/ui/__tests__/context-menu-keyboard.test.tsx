import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuItem, ContextMenuSubMenu, isContextMenuOpen } from '../context-menu';
import { isContextMenuKey, useContextMenu } from '@/hooks/use-context-menu';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Menu({ onPick = () => {}, withSub = false }: { onPick?: (what: string) => void; withSub?: boolean }) {
  const { contextMenu, openContextMenu, openContextMenuFrom, closeContextMenu, menuRef } = useContextMenu<string>();
  const pick = (what: string) => { closeContextMenu(); onPick(what); };
  return (
    <>
      <button type="button" onClick={(e) => openContextMenu(e, 'row')}>More</button>
      <button
        type="button"
        onContextMenu={(e) => openContextMenu(e, 'row')}
        onKeyDown={(e) => { if (isContextMenuKey(e)) { e.preventDefault(); openContextMenuFrom(e.currentTarget, 'row', 'end'); } }}
      >
        Row
      </button>
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        <ContextMenuItem label="Open" onClick={() => pick('open')} />
        <ContextMenuItem label="Rename" onClick={() => pick('rename')} />
        <ContextMenuItem label="Disabled" onClick={() => pick('disabled')} disabled />
        {withSub && (
          <ContextMenuSubMenu label="Move to" testId="move">
            <ContextMenuItem label="Inbox" onClick={() => pick('inbox')} />
            <ContextMenuItem label="Spam" onClick={() => pick('spam')} />
          </ContextMenuSubMenu>
        )}
        <ContextMenuItem label="Delete" onClick={() => pick('delete')} destructive />
      </ContextMenu>
    </>
  );
}

async function openByKeyboard(props: Parameters<typeof Menu>[0] = {}) {
  render(<Menu {...props} />);
  const trigger = screen.getByText('More');
  trigger.focus();
  // Enter or Space on a button fires a click with detail 0.
  fireEvent.click(trigger, { detail: 0 });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Open').closest('button')));
  return trigger;
}

function key(k: string, init: Partial<KeyboardEventInit> = {}) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });
}

const item = (label: string) => screen.getByText(label).closest('[role="menuitem"]') as HTMLElement;

describe('ContextMenu keyboard', () => {
  it('focuses the first item and moves with the arrows, Home and End, skipping disabled items', async () => {
    await openByKeyboard();
    key('ArrowDown');
    expect(document.activeElement).toBe(item('Rename'));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('Delete'));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('Open'));
    key('ArrowUp');
    expect(document.activeElement).toBe(item('Delete'));
    key('Home');
    expect(document.activeElement).toBe(item('Open'));
    key('End');
    expect(document.activeElement).toBe(item('Delete'));
  });

  it('closes on Escape and on Tab and gives the focus back to the trigger', async () => {
    const trigger = await openByKeyboard();
    key('Escape');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger, { detail: 0 });
    await waitFor(() => expect(document.activeElement).toBe(item('Open')));
    key('Tab');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Escape, arrows, Enter and letters from the app while open', async () => {
    const appKeys = vi.fn();
    document.addEventListener('keydown', appKeys);
    try {
      await openByKeyboard();
      expect(isContextMenuOpen()).toBe(true);
      expect(document.documentElement).toHaveAttribute('data-context-menu-open');
      key('ArrowDown');
      key('r');
      key('Enter');
      key('Escape');
      expect(appKeys).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).toBeNull();
      expect(isContextMenuOpen()).toBe(false);
      expect(document.documentElement).not.toHaveAttribute('data-context-menu-open');
      key('Escape');
      expect(appKeys).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', appKeys);
    }
  });
});

describe('ContextMenu placement', () => {
  function mockRects() {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') return rect(0, 0, 200, 120);
      if (this.textContent === 'More') return rect(300, 100, 40, 32);
      if (this.textContent === 'Row') return rect(500, 400, 300, 40);
      return rect(0, 0, 0, 0);
    });
  }
  const menuStyle = () => screen.getByRole('menu').style;

  it('anchors under the trigger when opened by keyboard', async () => {
    mockRects();
    await openByKeyboard();
    expect(menuStyle().left).toBe('300px');
    expect(menuStyle().top).toBe('136px');
  });

  it('opens at the pointer when clicked with a mouse', async () => {
    mockRects();
    render(<Menu />);
    fireEvent.click(screen.getByText('More'), { detail: 1, clientX: 50, clientY: 60 });
    await waitFor(() => expect(menuStyle().visibility).toBe('visible'));
    expect(menuStyle().left).toBe('50px');
    expect(menuStyle().top).toBe('60px');
  });

  it('anchors a keyboard contextmenu (no pointer position) to its element', async () => {
    mockRects();
    render(<Menu />);
    fireEvent.contextMenu(screen.getByText('Row'), { clientX: 0, clientY: 0 });
    await waitFor(() => expect(menuStyle().visibility).toBe('visible'));
    expect(menuStyle().left).toBe('500px');
    expect(menuStyle().top).toBe('444px');
  });

  it('opens from Shift+F10 through the helper, lined up with the end edge', async () => {
    mockRects();
    render(<Menu />);
    const row = screen.getByText('Row');
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    await waitFor(() => expect(menuStyle().visibility).toBe('visible'));
    expect(menuStyle().left).toBe('600px');
    expect(menuStyle().top).toBe('444px');
    expect(document.activeElement).toBe(item('Open'));
  });
});

describe('ContextMenuSubMenu', () => {
  it('opens on a tap and stays open after the emulated mouse events', async () => {
    render(<Menu withSub />);
    fireEvent.click(screen.getByText('More'), { detail: 1, clientX: 10, clientY: 10 });
    await screen.findByText('Move to');
    vi.useFakeTimers();
    const trigger = screen.getByTestId('move');
    fireEvent.pointerDown(trigger, { pointerType: 'touch' });
    fireEvent.mouseEnter(trigger.parentElement!);
    fireEvent.mouseLeave(trigger.parentElement!);
    // The emulated mouse lands on a neighbour as the submenu panel opens.
    fireEvent.mouseEnter(item('Delete'));
    fireEvent.click(trigger);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByText('Spam')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes when a mouse hovers another entry of its menu', async () => {
    render(<Menu withSub />);
    fireEvent.click(screen.getByText('More'), { detail: 1, clientX: 10, clientY: 10 });
    await screen.findByText('Move to');
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('move'));
    expect(screen.getByText('Spam')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByTestId('move').parentElement!);
    act(() => { vi.advanceTimersByTime(500); });
    expect(screen.getByText('Spam')).toBeInTheDocument();
    fireEvent.mouseEnter(item('Delete'));
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('Spam')).toBeNull();
  });

  it('opens with → and Enter, focuses its first item, and ← or Escape closes only the submenu', async () => {
    await openByKeyboard({ withSub: true });
    key('End');
    key('ArrowUp');
    const trigger = screen.getByTestId('move');
    expect(document.activeElement).toBe(trigger);
    key('ArrowRight');
    await waitFor(() => expect(document.activeElement).toBe(item('Inbox')));
    key('ArrowDown');
    expect(document.activeElement).toBe(item('Spam'));
    key('ArrowLeft');
    expect(screen.queryByText('Spam')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    key('Enter');
    await waitFor(() => expect(document.activeElement).toBe(item('Inbox')));
    key('Escape');
    expect(screen.queryByText('Inbox')).toBeNull();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it('runs a submenu item chosen by keyboard', async () => {
    const onPick = vi.fn();
    await openByKeyboard({ withSub: true, onPick });
    key('End');
    key('ArrowUp');
    key('ArrowRight');
    await waitFor(() => expect(document.activeElement).toBe(item('Inbox')));
    // Enter's default action on a button is a click.
    fireEvent.click(document.activeElement!);
    expect(onPick).toHaveBeenCalledWith('inbox');
  });
});

describe('menu type-to-focus', () => {
  it('finds a prefix, scrolls its target into view and never activates it', async () => {
    const onPick=vi.fn();
    await openByKeyboard({onPick});
    const scroll=vi.fn();
    Object.defineProperty(item('Rename'),'scrollIntoView',{value:scroll});
    key('r');
    key('e');
    expect(item('Rename')).toHaveFocus();
    expect(scroll).toHaveBeenCalledWith({block:'nearest',inline:'nearest'});
    expect(onPick).not.toHaveBeenCalled();
  });
  it('cycles repeated letters, skips disabled entries and matches accented labels after timeout', async () => {
    let now=1000;
    vi.spyOn(Date,'now').mockImplementation(()=>now);
    render(<ContextMenu isOpen position={{x:10,y:10}} onClose={()=>{}} label="Actions">
      <ContextMenuItem label="Reply" onClick={()=>{}} />
      <ContextMenuItem label="Reply all" onClick={()=>{}} />
      <ContextMenuItem label="Remove" disabled onClick={()=>{}} />
      <ContextMenuItem label="Remind later" onClick={()=>{}} />
      <ContextMenuItem label="Éxport" onClick={()=>{}} />
    </ContextMenu>);
    await waitFor(()=>expect(item('Reply')).toHaveFocus());
    key('r');expect(item('Reply all')).toHaveFocus();
    key('r');expect(item('Remind later')).toHaveFocus();
    key('r');expect(item('Reply')).toHaveFocus();
    now+=700;
    key('e');expect(item('Éxport')).toHaveFocus();
    vi.restoreAllMocks();
  });
  it('searches only the current submenu level', async () => {
    await openByKeyboard({withSub:true});
    key('m');
    expect(item('Move to')).toHaveFocus();
    key('ArrowRight');
    await waitFor(()=>expect(item('Inbox')).toHaveFocus());
    key('s');
    expect(item('Spam')).toHaveFocus();
    key('Escape');
    expect(item('Move to')).toHaveFocus();
  });
  it('leaves typing in a menu search field to the field', async () => {
    render(<ContextMenu isOpen position={{x:10,y:10}} onClose={()=>{}} label="Folders">
      <input type="search" aria-label="Find a folder" />
      <ContextMenuItem label="Rename" onClick={()=>{}} />
    </ContextMenu>);
    const input=screen.getByRole('searchbox',{name:'Find a folder'});
    await waitFor(()=>expect(input).toHaveFocus());
    expect(fireEvent.keyDown(input,{key:'r'})).toBe(true);
    expect(input).toHaveFocus();
  });
});
