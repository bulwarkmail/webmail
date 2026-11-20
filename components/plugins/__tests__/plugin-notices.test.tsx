import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

const createSlotInstance = vi.fn((..._args: unknown[]) => ({ destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn() }));
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (...args: unknown[]) => createSlotInstance(...args),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));
const announce = vi.fn();
vi.mock('@/lib/announce', () => ({ announce: (...args: unknown[]) => announce(...args) }));

const { PluginNoticeHost, noticeFrameLimit, NOTICE_FOCUS_GUARD_MS } = await import('../plugin-notice-host');
const { ToastContainer } = await import('@/components/ui/toast');
const { useToastStore } = await import('@/stores/toast-store');
const registry = await import('@/lib/plugin-sandbox/registry');
const { dispatchApiCall } = await import('@/lib/plugin-sandbox/host-api');
const { PluginDialogHost } = await import('../plugin-dialog-host');
const { cancelForPlugin } = await import('@/lib/plugin-sandbox/host-dialog');
const { closeNoticesFor, notices, resetNotices, MAX_NOTICES_PER_MINUTE } = await import('@/lib/plugin-sandbox/notices');

function plugin(id: string, name: string, perms: string[] = ['ui:notices']): InstalledPlugin {
  const p: InstalledPlugin = {
    id, name, version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: perms as never, grantedPermissions: perms as never, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  registry.register({
    plugin: p,
    code: '',
    tier: 'untrusted',
    background: { evaluateShouldShow: vi.fn(async () => true) } as never,
    slotOffers: [{ name: 'plugin-notice' as never, order: 100, hasShouldShow: false }, { name: 'plugin-dialog' as never, order: 100, hasShouldShow: false }],
    hookDisposables: [],
  });
  return p;
}

/** One frame of the plugin's: its lifetime ends when the frame goes. */
function frame() {
  const life = new AbortController();
  return {
    life,
    call: (p: InstalledPlugin, method: string, ...args: unknown[]) =>
      dispatchApiCall(p, method, args, { toastSignal: life.signal, frame: 'background' }),
  };
}

function Stack() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return (
    <>
      <PluginNoticeHost />
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </>
  );
}

/** A style value as the browser keeps it, to compare with an element's. */
function css(prop: 'height' | 'maxHeight', value: string): string {
  const probe = document.createElement('div');
  probe.style[prop] = value;
  return probe.style[prop];
}

const noticeCards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-toast-container] .toast-item'));

beforeEach(() => {
  createSlotInstance.mockClear();
  announce.mockClear();
  resetNotices();
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  resetNotices();
  for (const p of registry.all()) registry.deregister(p.plugin.id);
});

describe('api.ui.showNotice', () => {
  it('needs ui:notices', async () => {
    const p = plugin('crm', 'CRM', []);
    await expect(frame().call(p, 'ui.showNotice', {})).rejects.toThrow('lacks permission "ui:notices"');
    await expect(frame().call(p, 'ui.closeNotice', 'x')).rejects.toThrow('lacks permission "ui:notices"');
  });

  it('draws the plugin-notice slot in the toasts\' stack, named by the plugin, with its props and id', async () => {
    const p = plugin('crm', 'CRM');
    render(<Stack />);
    let id = '';
    await act(async () => {
      id = await frame().call(p, 'ui.showNotice', { title: 'Incoming call', extraProps: { call: 'c1' } }) as string;
    });
    expect(typeof id).toBe('string');
    const [card] = noticeCards();
    expect(card).toBeTruthy();
    expect(card.closest('[data-toast-container]')).not.toBeNull();
    // The host's own line: the plugin's name and the close button; the title only read out.
    expect(card.querySelector('[data-toast-header] [data-toast-source]')).toHaveTextContent('from_plugin');
    expect(card).toHaveAccessibleName('Incoming call');
    expect(announce).toHaveBeenCalledWith('Incoming call', { assertive: false });
    expect(card.querySelector('[data-toast-header] [data-toast-close]')).toHaveClass('opacity-100');
    expect(card.querySelector('[data-toast-close]')).not.toHaveClass('max-sm:hidden');
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = createSlotInstance.mock.calls[0][0] as { slot: string; extraProps: Record<string, unknown>; fill?: boolean };
    expect(opts.slot).toBe('plugin-notice');
    expect(opts.extraProps).toEqual({ call: 'c1', noticeId: id });
    expect(opts.fill).toBe(false);
    // It stays until closed: no countdown.
    expect(card.querySelector('[style*="toast-progress"]')).toBeNull();
  });

  it('never takes the focus', async () => {
    const p = plugin('crm', 'CRM');
    render(<><input aria-label="Search" /><Stack /></>);
    const input = screen.getByRole('textbox', { name: 'Search' });
    input.focus();
    await act(async () => { await frame().call(p, 'ui.showNotice', { title: 'Call' }); });
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('takes the focus back when the frame takes it as the notice comes up', async () => {
    const p = plugin('crm', 'CRM');
    render(<><input aria-label="Search" /><Stack /></>);
    const input = screen.getByRole('textbox', { name: 'Search' });
    input.focus();
    await act(async () => { await frame().call(p, 'ui.showNotice', { title: 'Call' }); });
    // The frame's field with autofocus, as the frame draws it.
    const field = document.createElement('input');
    document.querySelector('[data-plugin-notice="crm"]')!.appendChild(field);
    act(() => { field.focus(); });
    expect(document.activeElement).toBe(input);
  });

  it('lets the user into the notice: by the pointer, from its close button, and once it has come up', async () => {
    vi.useFakeTimers();
    try {
      const p = plugin('crm', 'CRM');
      render(<><input aria-label="Search" /><Stack /></>);
      const input = screen.getByRole('textbox', { name: 'Search' });
      await act(async () => { await frame().call(p, 'ui.showNotice', { title: 'Call' }); });
      const box = document.querySelector<HTMLElement>('[data-plugin-notice="crm"]')!;
      const field = document.createElement('input');
      box.appendChild(field);

      input.focus();
      fireEvent.pointerEnter(box);
      act(() => { field.focus(); });
      expect(document.activeElement).toBe(field);
      fireEvent.pointerLeave(box);

      act(() => { noticeCards()[0].querySelector<HTMLElement>('[data-toast-close]')!.focus(); });
      act(() => { field.focus(); });
      expect(document.activeElement).toBe(field);

      input.focus();
      act(() => { vi.advanceTimersByTime(NOTICE_FOCUS_GUARD_MS); });
      act(() => { field.focus(); });
      expect(document.activeElement).toBe(field);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the notice\'s frame open a dialog, which stands above the stack', async () => {
    const p = plugin('crm', 'CRM');
    render(<><Stack /><PluginDialogHost /></>);
    const f = frame();
    await act(async () => { await f.call(p, 'ui.showNotice', { title: 'Call' }); });
    await act(async () => { void f.call(p, 'ui.openDialog', { slot: 'plugin-dialog', title: 'Record' }); });
    const dialog = await screen.findByRole('dialog');
    const z = (el: Element) => Number(/\bz-\[(\d+)\]/.exec(el.className)?.[1]);
    expect(z(dialog)).toBeGreaterThan(z(document.querySelector('[data-toast-container]')!));
    expect(noticeCards()).toHaveLength(1);
    act(() => { cancelForPlugin('crm'); });
  });

  it('fixes the frame\'s height when asked, within limits, and the frame fills it', async () => {
    const p = plugin('crm', 'CRM');
    render(<Stack />);
    await act(async () => { await frame().call(p, 'ui.showNotice', { height: 9999 }); });
    const box = document.querySelector<HTMLElement>('[data-plugin-notice="crm"]')!;
    expect(box.style.height).toBe(css('height', `min(400px, ${noticeFrameLimit(1)})`));
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    expect((createSlotInstance.mock.calls[0][0] as { fill?: boolean }).fill).toBe(true);
    await expect(frame().call(p, 'ui.showNotice', { height: 'tall' })).rejects.toThrow('height must be a number');
  });

  it('keeps a notice in another of the plugin\'s slots to a notice\'s height', async () => {
    const p = plugin('crm', 'CRM');
    render(<Stack />);
    await act(async () => { await frame().call(p, 'ui.showNotice', { slot: 'plugin-dialog' }); });
    const box = document.querySelector<HTMLElement>('[data-plugin-notice="crm"]')!;
    expect(box.style.maxHeight).toBe(css('maxHeight', noticeFrameLimit(1)));
    expect(box.style.maxHeight).toContain('min(400px,');
    expect(box).toHaveClass('overflow-y-auto');
  });

  it('shares the screen\'s height among the notices up, so all of them fit', async () => {
    const p = plugin('crm', 'CRM');
    const other = plugin('other', 'Other');
    render(<Stack />);
    await act(async () => { await frame().call(p, 'ui.showNotice', { height: 300 }); });
    await act(async () => { await frame().call(other, 'ui.showNotice', {}); });
    await act(async () => { await frame().call(other, 'ui.showNotice', {}); });
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('[data-plugin-notice]'));
    expect(boxes).toHaveLength(3);
    expect(boxes[0].style.height).toBe(css('height', `min(300px, ${noticeFrameLimit(3)})`));
    expect(boxes[1].style.maxHeight).toBe(css('maxHeight', noticeFrameLimit(3)));
    expect(css('maxHeight', noticeFrameLimit(3))).not.toBe(css('maxHeight', noticeFrameLimit(1)));
  });

  it('takes another of the plugin\'s own slots, but none it doesn\'t offer', async () => {
    const p = plugin('crm', 'CRM');
    await expect(frame().call(p, 'ui.showNotice', { slot: 'plugin-dialog' })).resolves.toEqual(expect.any(String));
    await expect(frame().call(p, 'ui.showNotice', { slot: 'side-panel' })).rejects.toThrow('offers no slot "side-panel"');
  });

  it('keeps at most three per plugin: a fourth closes the oldest', async () => {
    const p = plugin('crm', 'CRM');
    const other = plugin('other', 'Other');
    const f = frame();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await f.call(p, 'ui.showNotice', { title: `n${i}` }) as string);
    await f.call(other, 'ui.showNotice', { title: 'theirs' });
    expect(notices().filter((n) => n.pluginId === 'crm').map((n) => n.id)).toEqual(ids.slice(1));
    expect(notices().filter((n) => n.pluginId === 'other')).toHaveLength(1);
  });

  it('limits how many a plugin shows a minute', async () => {
    const p = plugin('crm', 'CRM');
    const f = frame();
    for (let i = 0; i < MAX_NOTICES_PER_MINUTE; i++) await f.call(p, 'ui.showNotice', {});
    await expect(f.call(p, 'ui.showNotice', {})).rejects.toThrow('too many notices');
  });

  it('closes on the plugin\'s request, its own notices only, from any of its frames', async () => {
    const p = plugin('crm', 'CRM');
    const other = plugin('other', 'Other');
    render(<Stack />);
    let id = '';
    await act(async () => { id = await frame().call(p, 'ui.showNotice', { title: 'Call' }) as string; });
    expect(noticeCards()).toHaveLength(1);
    await act(async () => { await frame().call(other, 'ui.closeNotice', id); });
    expect(noticeCards()).toHaveLength(1);
    await act(async () => { await frame().call(p, 'ui.closeNotice', id); });
    expect(noticeCards()).toHaveLength(0);
    // Again: nothing to close, no error.
    await expect(frame().call(p, 'ui.closeNotice', id)).resolves.toBeUndefined();
  });

  it('closes when the user closes it', async () => {
    vi.useFakeTimers();
    try {
      const p = plugin('crm', 'CRM');
      render(<Stack />);
      await act(async () => { await frame().call(p, 'ui.showNotice', { title: 'Call' }); });
      fireEvent.click(noticeCards()[0].querySelector('[data-toast-close]')!);
      expect(notices()).toHaveLength(0);
      act(() => { vi.advanceTimersByTime(300); });
      expect(noticeCards()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes when the frame that showed it goes, or the plugin is turned off', async () => {
    const p = plugin('crm', 'CRM');
    render(<Stack />);
    const f = frame();
    await act(async () => { await f.call(p, 'ui.showNotice', { title: 'From a frame' }); });
    await act(async () => { await frame().call(p, 'ui.showNotice', { title: 'From the background' }); });
    expect(noticeCards()).toHaveLength(2);
    act(() => { f.life.abort(); });
    expect(noticeCards()).toHaveLength(1);
    act(() => { closeNoticesFor('crm'); });
    expect(noticeCards()).toHaveLength(0);
  });
});
