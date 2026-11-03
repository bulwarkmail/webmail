import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuHeader, ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu } from '@/components/ui/context-menu';
import type { BulwarkDesktopBridge, DesktopNativeMenuItem } from '../types';
import { accentColours, applySystemAccent } from '../system-accent';
import { mergedDesktopState, registerDesktopSurface, resetDesktopCommands, runDesktopCommand, setDesktopBaseState } from '../commands';
import { readMenu } from '../native-menu';
import { noteOpenDraft, resetOpenDrafts, restoreUrlFor } from '../window-restore';
import { readDesktopPrefs, resetDesktopPrefsCache, setDesktopPref } from '../preferences';
import { closePopoutWindow, isPopoutPath } from '@/lib/popout/window-role';
import { toast } from '@/stores/toast-store';

function setBridge(bridge: Partial<BulwarkDesktopBridge> | undefined) {
  window.bulwarkDesktop = bridge as BulwarkDesktopBridge | undefined;
}

afterEach(() => {
  setBridge(undefined);
  resetDesktopCommands();
  resetOpenDrafts();
  localStorage.clear();
  resetDesktopPrefsCache();
  vi.useRealTimers();
});

function testMenu(extra?: React.ReactNode, handlers: { reply?: () => void; inbox?: () => void } = {}) {
  return (
    <>
      <ContextMenuHeader>Three messages</ContextMenuHeader>
      <ContextMenuItem label="Reply" onClick={handlers.reply ?? (() => {})} shortcut="R" hint="to the sender" />
      <ContextMenuItem label="Forward" onClick={() => {}} disabled />
      <ContextMenuSeparator />
      <ContextMenuSubMenu label="Move to">
        <ContextMenuItem label="Inbox" onClick={handlers.inbox ?? (() => {})} />
        <ContextMenuItem label="R&D" onClick={() => {}} />
      </ContextMenuSubMenu>
      <ContextMenuSubMenu label="Rules" disabled>
        <ContextMenuItem label="Never shown" onClick={() => {}} />
      </ContextMenuSubMenu>
      {extra}
    </>
  );
}

describe('an HTML menu shown natively', () => {
  let popup: ReturnType<typeof vi.fn>;
  let answer: (id: string | null) => void;

  beforeEach(() => {
    popup = vi.fn(() => new Promise<string | null>((resolve) => { answer = resolve; }));
    setBridge({ version: 1, platform: 'win32', menu: { setState: () => {}, popup: popup as never } });
  });

  async function openMenu(children: React.ReactNode, onClose = vi.fn()) {
    render(<ContextMenu isOpen position={{ x: 10, y: 10 }} onClose={onClose}>{children}</ContextMenu>);
    await waitFor(() => expect(popup).toHaveBeenCalled());
    return { items: popup.mock.calls[0][0] as DesktopNativeMenuItem[], at: popup.mock.calls[0][1], onClose };
  }

  it('reads every kind of row, in order, with submenus', async () => {
    const { items } = await openMenu(testMenu());
    expect(items.map((item) => item.label ?? item.type)).toEqual(['Three messages', 'Reply', 'Forward', 'separator', 'Move to', 'Rules']);
    expect(items[0].enabled).toBe(false);
    expect(items[2].enabled).toBe(false);
    expect(items[4].submenu?.map((item) => item.label)).toEqual(['Inbox', 'R&D']);
    // A disabled submenu shows, and has nothing in it.
    expect(items[5].enabled).toBe(false);
    expect(items[5].submenu).toBeUndefined();
  });

  it('takes the label without the shortcut or the hint', async () => {
    const { items } = await openMenu(testMenu());
    expect(items[1].label).toBe('Reply');
  });

  it('at the pointer from a right-click, under the button from a button', async () => {
    const { at } = await openMenu(testMenu());
    expect(at).toBeUndefined();
    popup.mockClear();
    render(
      <ContextMenu isOpen position={{ x: 0, y: 0, anchor: { left: 40, top: 50, right: 90, bottom: 70 } }} onClose={() => {}}>
        <ContextMenuItem label="One" onClick={() => {}} />
      </ContextMenu>,
    );
    await waitFor(() => expect(popup).toHaveBeenCalled());
    expect(popup.mock.calls[0][1]).toEqual({ x: 40, y: 74 });
  });

  it('a pick runs the HTML row, the one a browser would run, and closes the menu', async () => {
    const reply = vi.fn();
    const inbox = vi.fn();
    const { items, onClose } = await openMenu(testMenu(undefined, { reply, inbox }));
    await act(async () => {
      answer(items[4].submenu![0].id!);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(inbox).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('dismissing it runs nothing and closes the menu', async () => {
    const reply = vi.fn();
    const { onClose } = await openMenu(testMenu(undefined, { reply }));
    await act(async () => {
      answer(null);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(reply).not.toHaveBeenCalled();
  });

  it('the hidden copy is never visible', async () => {
    await openMenu(testMenu());
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu?.style.visibility).toBe('hidden');
  });

  it('stays HTML when something in it can\'t be shown natively', async () => {
    render(
      <ContextMenu isOpen position={{ x: 10, y: 10 }} onClose={() => {}}>
        {testMenu(<input type="color" aria-label="Colour" />)}
      </ContextMenu>,
    );
    await waitFor(() => expect(document.body.querySelector<HTMLElement>('[role="menu"]')?.style.visibility).toBe('visible'));
    expect(popup).not.toHaveBeenCalled();
    expect(screen.getByRole('menuitem', { name: /Reply/ })).toBeTruthy();
  });

  it('a plugin\'s frame keeps the rest native, with a line to the HTML menu', async () => {
    const frame = (
      <div data-plugin-slot="context-menu-email"><iframe title="plugin" /></div>
    );
    const onClose = vi.fn();
    const { items } = await openMenu(testMenu(frame), onClose);
    expect(items.at(-1)).toMatchObject({ label: 'from_plugins' });
    expect(items.map((item) => item.label)).toContain('Reply');
    await act(async () => {
      answer(items.at(-1)!.id!);
    });
    await waitFor(() => expect(document.body.querySelector<HTMLElement>('[role="menu"]')?.style.visibility).toBe('visible'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a frame that is no plugin\'s stays HTML whole', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button role="menuitem">Reply</button><iframe></iframe>';
    expect(readMenu(root).unsupported).toBe(true);
  });

  it('a row that went while the menu was up says so, instead of doing nothing', async () => {
    const warning = vi.spyOn(toast, 'warning').mockImplementation(() => '' as never);
    const reply = vi.fn();
    const { items, onClose } = await openMenu(testMenu(undefined, { reply }));
    const row = screen.getAllByRole('menuitem', { hidden: true }).find((el) => el.textContent?.includes('Reply'))!;
    row.parentElement!.remove();
    await act(async () => {
      answer(items[1].id!);
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(reply).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith('pick_gone');
    warning.mockRestore();
  });

  it('a row with no words stays HTML too: a colour swatch says nothing in a native menu', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button role="menuitem"><svg></svg></button>';
    expect(readMenu(root).unsupported).toBe(true);
  });

  it('a search field over a list is left out, and what it searches stays', () => {
    const root = document.createElement('div');
    root.innerHTML = '<input type="search" /><button role="menuitem">Inbox</button>';
    const read = readMenu(root);
    expect(read.unsupported).toBe(false);
    expect(read.items.map((item) => item.label)).toEqual(['Inbox']);
  });

  it('reads check and radio rows', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button role="menuitemcheckbox" aria-checked="true">Show</button><button role="menuitemradio" aria-checked="false">Other</button>';
    expect(readMenu(root).items).toMatchObject([
      { type: 'checkbox', checked: true, label: 'Show' },
      { type: 'radio', checked: false, label: 'Other' },
    ]);
  });
});

describe('the same menu in a browser', () => {
  it('is the HTML menu, on screen, and no bridge is asked', async () => {
    render(<ContextMenu isOpen position={{ x: 10, y: 10 }} onClose={() => {}}>{testMenu()}</ContextMenu>);
    await waitFor(() => expect(document.body.querySelector<HTMLElement>('[role="menu"]')?.style.visibility).toBe('visible'));
    // A closed submenu's rows aren't in the page.
    expect(screen.queryByRole('menuitem', { name: 'Inbox' })).toBeNull();
  });
});

describe('menu commands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('the newest surface answers, and an older one is back when it goes', () => {
    const older = vi.fn();
    const newer = vi.fn();
    registerDesktopSurface({ handlers: { 'message.reply': older }, state: {} });
    const stop = registerDesktopSurface({ handlers: { 'message.reply': newer }, state: {} });
    expect(runDesktopCommand('message.reply')).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    stop();
    runDesktopCommand('message.reply');
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('says when nothing answered, so the host can take it', () => {
    expect(runDesktopCommand('go.calendar')).toBe(false);
  });

  it('the shell gets the state, surfaces over the base', () => {
    const setState = vi.fn();
    setBridge({ version: 1, platform: 'win32', menu: { setState } });
    setDesktopBaseState({ 'message.reply': false, 'file.print': true });
    registerDesktopSurface({ handlers: {}, state: { 'message.reply': true } });
    vi.advanceTimersByTime(50);
    expect(setState).toHaveBeenLastCalledWith({ 'message.reply': true, 'file.print': true });
    expect(mergedDesktopState()['file.print']).toBe(true);
  });
});

describe('composers that come back', () => {
  it('tell the shell which draft they hold, and forget it when they go', () => {
    const setRestore = vi.fn();
    setBridge({ version: 1, platform: 'win32', windows: { setRestore } });
    noteOpenDraft('a', { draftId: 'd1', localAccountId: 'login', ownerAccountId: 'group' });
    expect(setRestore).toHaveBeenLastCalledWith([expect.stringContaining('draft=d1')]);
    expect(setRestore.mock.lastCall![0][0]).toContain('account=login');
    expect(setRestore.mock.lastCall![0][0]).toContain('owner=group');
    noteOpenDraft('a', { draftId: 'd2' });
    expect(setRestore.mock.lastCall![0]).toHaveLength(1);
    expect(setRestore.mock.lastCall![0][0]).toContain('draft=d2');
    noteOpenDraft('a', null);
    expect(setRestore).toHaveBeenLastCalledWith([]);
  });

  it('are pop-out addresses the window type check recognises', () => {
    expect(restoreUrlFor({ draftId: 'x' })).toMatch(/\/popout\/compose\?draft=x$/);
  });

  it('do nothing in a browser', () => {
    expect(() => noteOpenDraft('a', { draftId: 'd1' })).not.toThrow();
  });
});

describe('a pop-out closing itself', () => {
  it('goes through the shell in the desktop app, not window.close', () => {
    const closeSelf = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    setBridge({ version: 1, platform: 'win32', windows: { closeSelf } });
    closePopoutWindow();
    expect(closeSelf).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    close.mockRestore();
  });

  it('uses window.close in a browser', () => {
    vi.useFakeTimers();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    closePopoutWindow();
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it('counts the warm spare as a pop-out, which is a guest of the main window', () => {
    expect(isPopoutPath('/popout/spare')).toBe(true);
    expect(isPopoutPath('/de/popout/spare')).toBe(true);
    expect(isPopoutPath('/popout/spare/x')).toBe(false);
  });
});

describe('window settings', () => {
  it('both default to on, and stay on this computer', () => {
    expect(readDesktopPrefs()).toEqual({ openOnDoubleClick: true, restoreWindows: true, dictionaryDownload: 'ask' });
    setDesktopPref('restoreWindows', false);
    resetDesktopPrefsCache();
    expect(readDesktopPrefs().restoreWindows).toBe(false);
    expect(readDesktopPrefs().openOnDoubleClick).toBe(true);
  });

  it('a damaged value is the default', () => {
    localStorage.setItem('bulwark-desktop-window-prefs', '{nope');
    expect(readDesktopPrefs().restoreWindows).toBe(true);
  });
});

describe('the OS accent colour', () => {
  beforeEach(() => setBridge({ version: 1, platform: 'win32' }));

  const apply = (input: Partial<Parameters<typeof applySystemAccent>[0]>) => {
    const root = document.createElement('div');
    applySystemAccent({ accent: '#0078d4', dark: false, followsSystem: true, ...input }, root);
    return root.style.getPropertyValue('--color-primary');
  };

  it('is used while the theme follows the system', () => {
    expect(apply({})).toBe('#0078d4');
  });

  it('not under a theme the user picked', () => {
    expect(apply({ followsSystem: false })).toBe('');
  });

  it('not in a contrast theme', () => {
    expect(apply({ highContrast: true })).toBe('');
  });

  it('not where it would vanish against the page', () => {
    expect(accentColours('#fefefe', false)).toBeNull();
    expect(accentColours('#050505', true)).toBeNull();
  });

  it('text on it is what reads', () => {
    expect(accentColours('#0078d4', false)?.foreground).toBe('#ffffff');
    expect(accentColours('#ffd400', true)?.foreground).toBe('#000000');
  });

  it('a removed accent takes its colours off again', () => {
    const root = document.createElement('div');
    applySystemAccent({ accent: '#0078d4', dark: false, followsSystem: true }, root);
    applySystemAccent({ dark: false, followsSystem: true }, root);
    expect(root.style.getPropertyValue('--color-primary')).toBe('');
    expect(root.style.getPropertyValue('--color-primary-foreground')).toBe('');
  });

  it('does nothing in a browser', () => {
    setBridge(undefined);
    expect(apply({})).toBe('');
  });
});
