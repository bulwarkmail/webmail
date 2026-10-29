import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ToastContainer } from '@/components/ui/toast';
import { toast, useToastStore } from '@/stores/toast-store';
import { dispatchApiCall, PERM_PER_METHOD } from '../plugin-sandbox/host-api';
import { createBackgroundInstance } from '../plugin-sandbox/host-bridge';
import type { InstalledPlugin } from '../plugin-types';

let sequence = 0;
const lifetimes: AbortController[] = [];

/** Give each test its own plugin and frame lifetime. 각 시험의 플러그인과 프레임 수명을 분리합니다. */
function owner() {
  const controller = new AbortController();
  lifetimes.push(controller);
  const plugin: InstalledPlugin = {
    id: `progress-${++sequence}`, name: 'Progress', version: '1.0.0', author: '', description: '',
    type: 'hook', permissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  };
  const options = { toastSignal: controller.signal };
  return { plugin, controller, options };
}

/** Render the real host notification lifecycle. 실제 호스트 알림 수명 주기를 렌더링합니다. */
function Toasts() {
  const toasts = useToastStore((state) => state.toasts);
  const removeToast = useToastStore((state) => state.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

beforeEach(() => { vi.useFakeTimers(); useToastStore.getState().clearToasts(); });
afterEach(() => {
  for (const controller of lifetimes.splice(0)) controller.abort();
  cleanup();
  useToastStore.getState().clearToasts();
  vi.useRealTimers();
});

describe('sandbox progress toasts', () => {
  it('keeps an indeterminate native toast beyond five seconds, then dismisses it explicitly', async () => {
    const scope = owner();
    render(<Toasts />);
    let id: unknown;
    await act(async () => { id = await dispatchApiCall(scope.plugin, 'toast.progress', ['Working'], scope.options); });
    expect(typeof id).toBe('string');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    act(() => { toast.info('Ordinary'); });
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.queryByText('Ordinary')).toBeNull();
    await act(async () => { await dispatchApiCall(scope.plugin, 'toast.dismiss', [id], scope.options); });
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('cannot dismiss native notices or notices belonging to another plugin or frame', async () => {
    const a = owner();
    const b = owner();
    const id = await dispatchApiCall(a.plugin, 'toast.progress', ['Owned'], a.options);
    toast.info('Native');
    const nativeId = useToastStore.getState().toasts.find((item) => item.title === 'Native')!.id;
    await dispatchApiCall(b.plugin, 'toast.dismiss', [id], b.options);
    await dispatchApiCall(a.plugin, 'toast.dismiss', [id], b.options);
    await dispatchApiCall(a.plugin, 'toast.dismiss', [nativeId], a.options);
    expect(useToastStore.getState().toasts.map((item) => item.title)).toEqual(['Owned', 'Native']);
    await dispatchApiCall(a.plugin, 'toast.dismiss', [id], a.options);
    await dispatchApiCall(a.plugin, 'toast.dismiss', [id], a.options);
    expect(useToastStore.getState().toasts.map((item) => item.title)).toEqual(['Native']);
  });

  it('bounds outstanding progress notices across frames even after the burst window', async () => {
    const scope = owner();
    const otherFrame = owner();
    const ids = [];
    for (let index = 0; index < 5; index++) ids.push(await dispatchApiCall(scope.plugin, 'toast.progress', ['Working'], scope.options));
    vi.advanceTimersByTime(10001);
    await expect(dispatchApiCall(scope.plugin, 'toast.progress', ['Overflow'], otherFrame.options)).rejects.toThrow(/too many/i);
    await dispatchApiCall(scope.plugin, 'toast.dismiss', [ids[0]], scope.options);
    await expect(dispatchApiCall(scope.plugin, 'toast.progress', ['Replacement'], scope.options)).resolves.toEqual(expect.any(String));
  });

  it('shares the normal toast burst limit but never rate-limits dismissal', async () => {
    const scope = owner();
    const id = await dispatchApiCall(scope.plugin, 'toast.progress', ['Working'], scope.options);
    for (let index = 0; index < 4; index++) await dispatchApiCall(scope.plugin, 'toast.info', ['Info']);
    await expect(dispatchApiCall(scope.plugin, 'toast.progress', ['Overflow'], scope.options)).rejects.toThrow(/too many/i);
    await dispatchApiCall(scope.plugin, 'toast.dismiss', [id], scope.options);
    expect(useToastStore.getState().toasts.some((item) => item.id === id)).toBe(false);
  });

  it('releases dismissed entries and caps text without recreating user-closed progress', async () => {
    const scope = owner();
    render(<Toasts />);
    await act(async () => { await dispatchApiCall(scope.plugin, 'toast.progress', ['x'.repeat(1000)], scope.options); });
    expect(useToastStore.getState().toasts[0].title).toHaveLength(300);
    fireEvent.click(screen.getByRole('group').querySelector('button')!);
    act(() => { vi.advanceTimersByTime(20000); });
    expect(screen.queryByRole('progressbar')).toBeNull();
    for (let index = 0; index < 5; index++) await dispatchApiCall(scope.plugin, 'toast.progress', ['Next'], scope.options);
    expect(useToastStore.getState().toasts).toHaveLength(5);
  });

  it('cleans only the aborted frame and rejects calls without a live owner', async () => {
    const a = owner();
    const b = owner();
    await dispatchApiCall(a.plugin, 'toast.progress', ['First'], a.options);
    await dispatchApiCall(a.plugin, 'toast.progress', ['Other frame'], b.options);
    a.controller.abort();
    expect(useToastStore.getState().toasts.map((item) => item.title)).toEqual(['Other frame']);
    await expect(dispatchApiCall(a.plugin, 'toast.progress', ['Late'], a.options)).rejects.toThrow(/live/i);
    await expect(dispatchApiCall(a.plugin, 'toast.progress', ['Unowned'])).rejects.toThrow(/live/i);
    expect(PERM_PER_METHOD['toast.progress']).toBeNull();
    expect(PERM_PER_METHOD['toast.dismiss']).toBeNull();
  });

  it('binds RPC-created notices to the real sandbox destruction lifecycle', async () => {
    vi.useRealTimers();
    const scope = owner();
    const instance = createBackgroundInstance({ plugin: scope.plugin, code: '', locale: 'en', tier: 'untrusted' });
    try {
      window.dispatchEvent(new MessageEvent('message', {
        source: instance.iframe.contentWindow, origin: 'null',
        data: { type: 'api-request', id: 'progress', method: 'toast.progress', args: ['Frame work'] },
      }));
      await vi.waitFor(() => expect(useToastStore.getState().toasts).toHaveLength(1));
      instance.destroy();
      expect(useToastStore.getState().toasts).toHaveLength(0);
    } finally { instance.destroy(); }
  });
});
