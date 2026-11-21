import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerShortcuts, isAllowedPluginCombo } from '../plugin-sandbox/shortcuts';
import type { SandboxInstance } from '../plugin-sandbox/host-bridge';

function instance(pluginId: string) {
  return { pluginId, invokeHook: vi.fn(async () => undefined) } as unknown as SandboxInstance & { invokeHook: ReturnType<typeof vi.fn> };
}

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()!();
});

function press(key: string, mods: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code'>> = {}) {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  const outer = vi.fn();
  document.body.addEventListener('keydown', outer);
  document.body.dispatchEvent(ev);
  document.body.removeEventListener('keydown', outer);
  return { defaultPrevented: ev.defaultPrevented, reachedApp: outer.mock.calls.length > 0 };
}

describe('plugin keyboard shortcuts', () => {
  it.each(['Escape', 'c', 'Shift+G', 'Ctrl+K', 'Ctrl+F', 'Ctrl+P', 'Cmd+W', 'Ctrl+Shift+T', 'Tab', 'Alt+Tab'])(
    'refuses %s, which belongs to the app or the browser',
    (combo) => {
      expect(isAllowedPluginCombo(combo)).toBe(false);
    },
  );

  it.each(['Alt+N', 'Alt+Shift+N', 'Ctrl+Shift+L', 'Ctrl+Alt+S', 'Cmd+Shift+Y'])('allows %s', (combo) => {
    expect(isAllowedPluginCombo(combo)).toBe(true);
  });

  it('does not take Escape away from the app', async () => {
    const plugin = instance('grabber');
    disposers.push(registerShortcuts(plugin, [{ id: 'esc', keys: 'Escape', label: 'x' }]));

    const result = press('Escape');

    expect(plugin.invokeHook).not.toHaveBeenCalled();
    expect(result.defaultPrevented).toBe(false);
    expect(result.reachedApp).toBe(true);
  });

  it('runs an allowed shortcut without hiding the key from the rest of the app', async () => {
    const plugin = instance('notes');
    disposers.push(registerShortcuts(plugin, [{ id: 'new', keys: 'Alt+N', label: 'New note' }]));

    const result = press('n', { altKey: true });

    expect(plugin.invokeHook).toHaveBeenCalledWith('shortcut:new', []);
    expect(result.reachedApp).toBe(true);
  });

  // #1714: Colemak types j on the key a US keyboard has Y on, and n on its J.
  it('matches the letter the key types, not its US place', () => {
    const plugin = instance('notes');
    disposers.push(registerShortcuts(plugin, [{ id: 'new', keys: 'Alt+J', label: 'New note' }]));

    press('n', { altKey: true, code: 'KeyJ' });
    expect(plugin.invokeHook).not.toHaveBeenCalled();

    press('j', { altKey: true, code: 'KeyY' });
    expect(plugin.invokeHook).toHaveBeenCalledTimes(1);

    // macOS: Option + J types ∆, so the place counts.
    press('∆', { altKey: true, code: 'KeyJ' });
    expect(plugin.invokeHook).toHaveBeenCalledTimes(2);
  });

  it('keeps the first plugin that claimed a combo', async () => {
    const first = instance('first');
    const second = instance('second');
    disposers.push(registerShortcuts(first, [{ id: 'a', keys: 'Alt+J', label: 'a' }]));
    disposers.push(registerShortcuts(second, [{ id: 'b', keys: 'Alt+J', label: 'b' }]));

    press('j', { altKey: true });

    expect(first.invokeHook).toHaveBeenCalled();
    expect(second.invokeHook).not.toHaveBeenCalled();
  });
});
