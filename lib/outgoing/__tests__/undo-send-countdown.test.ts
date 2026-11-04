import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useToastStore } from '@/stores/toast-store';
import { runUndoSendCountdown, undoEndsAt } from '../send-progress-toast';

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
    undoEndsAt: T0 + 5000,
    maxSeconds,
    sendingIn: (s) => `Sending in ${s} seconds`,
    sent: 'Sent',
    view: view ? { label: 'View', onClick: view } : undefined,
  });
  const current = () => useToastStore.getState().toasts.find((t) => t.id === id);
  return { id, stop, current };
}

describe('the undo send toast', () => {
  // compose-p3-8: the count went 5, 4, 3, 2 and then "Sent", a second early.
  it('counts every second down to 1, then says "Sent" when the delay is over', () => {
    const { current } = start();
    const seen: string[] = [];
    for (let t = 0; t < 5000; t += 250) {
      const title = current()?.title ?? '';
      if (seen.at(-1) !== title) seen.push(title);
      vi.advanceTimersByTime(250);
    }
    expect(seen).toEqual([5, 4, 3, 2, 1].map((n) => `Sending in ${n} seconds`));
    expect(current()?.title).toBe('Sent');
  });

  it('ends Undo after the whole delay from when it shows, and never at the server’s last moment', () => {
    // The server holds a second longer (lib/outgoing/undo-delay.ts).
    expect(undoEndsAt(T0 + 5800, T0, 5)).toBe(T0 + 5000);
    // A slow answer ate into the margin: Undo ends half a second before the send.
    expect(undoEndsAt(T0 + 5200, T0, 5)).toBe(T0 + 4700);
  });

  it('turns into "Sent" with View as Undo ends, with a fresh time to read it', () => {
    const view = vi.fn();
    const { current } = start(view);
    vi.advanceTimersByTime(5000);
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
    vi.advanceTimersByTime(5000);
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
