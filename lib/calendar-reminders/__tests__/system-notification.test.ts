import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSystemReminders } from '../system-notification';

describe('closing reminders', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  function withRegistration(getNotifications: (filter: { tag: string }) => Promise<Notification[]>): void {
    vi.stubGlobal('Notification', { permission: 'granted' });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ getNotifications }) },
    });
  }

  it('closes what is shown', async () => {
    const close = vi.fn();
    withRegistration(async () => [{ close } as unknown as Notification]);
    await closeSystemReminders(['a']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("doesn't wait for good on a shell that never answers", async () => {
    // Electron leaves getNotifications() pending for ever.
    withRegistration(() => new Promise<Notification[]>(() => {}));
    const answer = await Promise.race([
      closeSystemReminders(['a', 'b']).then(() => 'finished'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 6_000)),
    ]);
    expect(answer).toBe('finished');
  }, 10_000);
});
