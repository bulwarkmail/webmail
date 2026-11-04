import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useToastStore } from '@/stores/toast-store';
import { runUndoSendCountdown } from '../send-progress-toast';

// compose-p2-12: "Sending in 5 seconds" stayed the same for 5 s and then
// went, with no word that the message went.

const T0 = Date.parse('2026-11-04T10:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useToastStore.setState({ toasts: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

function start(view?: () => void, maxSeconds = 5) {
  const id = toast.success('Sending in 5 seconds', {
    duration: 5000,
    pauseOnHover: false,
    action: { label: 'Undo', onClick: () => {} },
    secondaryAction: { label: 'Send now', onClick: () => {} },
  });
  const stop = runUndoSendCountdown(id, {
    sendAt: T0 + 5600,
    undoEndsAt: T0 + 4600,
    maxSeconds,
    sendingIn: (s) => `Sending in ${s} seconds`,
    sent: 'Sent',
    view: view ? { label: 'View', onClick: view } : undefined,
  });
  const current = () => useToastStore.getState().toasts.find((t) => t.id === id);
  return { id, stop, current };
}

describe('the undo send toast', () => {
  it('counts down, never above the delay the user picked', () => {
    const { current } = start();
    // 5.6 s left would round up to 6; the setting says 5.
    expect(current()?.title).toBe('Sending in 5 seconds');
    vi.advanceTimersByTime(1000);
    expect(current()?.title).toBe('Sending in 5 seconds');
    vi.advanceTimersByTime(1000);
    expect(current()?.title).toBe('Sending in 4 seconds');
    vi.advanceTimersByTime(1500);
    expect(current()?.title).toBe('Sending in 3 seconds');
  });

  it('turns into "Sent" with View as Undo ends, with a fresh time to read it', () => {
    const view = vi.fn();
    const { current } = start(view);
    vi.advanceTimersByTime(4600);
    const shown = current()!;
    expect(shown.title).toBe('Sent');
    expect(shown.action?.label).toBe('View');
    expect(shown.secondaryAction).toBeUndefined();
    expect(shown.pauseOnHover).toBeUndefined();
    expect(shown.duration).not.toBe(5000);
    shown.action!.onClick();
    expect(view).toHaveBeenCalled();
  });

  it('says "Sent" without View when the message can\'t be opened from here', () => {
    const { current } = start(undefined);
    vi.advanceTimersByTime(4600);
    expect(current()?.title).toBe('Sent');
    expect(current()?.action).toBeUndefined();
  });

  it('leaves a toast that is gone (Undo, Send now) alone', () => {
    const { id, current } = start();
    toast.dismiss(id);
    vi.advanceTimersByTime(6000);
    expect(current()).toBeUndefined();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
