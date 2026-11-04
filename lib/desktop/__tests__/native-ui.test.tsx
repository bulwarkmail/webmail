import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextMenu, ContextMenuHeader, ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu } from '@/components/ui/context-menu';
import type { BulwarkDesktopBridge } from '../types';
import { accentColours, applySystemAccent } from '../system-accent';
import { mergedDesktopState, registerDesktopSurface, resetDesktopCommands, runDesktopCommand, setDesktopBaseState } from '../commands';
import { noteOpenDraft, resetOpenDrafts, restoreUrlFor } from '../window-restore';
import { readDesktopPrefs, resetDesktopPrefsCache, setDesktopPref } from '../preferences';
import { closePopoutWindow, isPopoutPath } from '@/lib/popout/window-role';

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

describe('the same menu in a browser', () => {
  it('is the HTML menu, on screen, and no bridge is asked', async () => {
    render(<ContextMenu isOpen position={{ x: 10, y: 10 }} onClose={() => {}}>{testMenu()}</ContextMenu>);
    await waitFor(() => expect(document.body.querySelector<HTMLElement>('[role="menu"]')?.style.visibility).toBe('visible'));
    // A closed submenu's rows aren't in the page.
    expect(screen.queryByRole('menuitem', { name: 'Inbox' })).toBeNull();
  });
});

describe('the same menu in the desktop app', () => {
  it('is the HTML menu too, with its icons and keys, and no native menu is asked for', async () => {
    const popup = vi.fn(async () => null);
    setBridge({ version: 1, platform: 'win32', menu: { setState: () => {}, popup: popup as never } });
    document.documentElement.lang = 'de';
    const Icon = () => <svg data-testid="row-icon" />;
    render(
      <ContextMenu isOpen position={{ x: 10, y: 10 }} onClose={() => {}}>
        <ContextMenuItem icon={Icon} label="Allen antworten" onClick={() => {}} shortcut="Shift + R" />
      </ContextMenu>,
    );
    await waitFor(() => expect(document.body.querySelector<HTMLElement>('[role="menu"]')?.style.visibility).toBe('visible'));
    const row = screen.getByRole('menuitem', { name: /Allen antworten/ });
    expect(row.querySelector('[data-testid="row-icon"]')).not.toBeNull();
    // Windows' own words for the keys, not Chromium's "Umschalttaste".
    expect(row.querySelector('[data-menu-shortcut]')?.textContent).toBe('Umschalt + R');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(popup).not.toHaveBeenCalled();
    document.documentElement.lang = '';
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
