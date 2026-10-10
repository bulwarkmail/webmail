import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookBus, pluginErrorTracker, removeAllPluginHooks, clearAllHooks, emailHooks, calendarHooks, isExternalAttachmentResult } from '../plugin-hooks';
import type { CalendarEventFormView } from '../plugin-types';

beforeEach(() => {
  pluginErrorTracker.resetAll();
  clearAllHooks();
});

describe('HookBus', () => {
  describe('register / size / dispose', () => {
    it('registers a handler', () => {
      const bus = new HookBus();
      bus.register('p1', vi.fn());
      expect(bus.size).toBe(1);
    });

    it('dispose removes the handler', () => {
      const bus = new HookBus();
      const d = bus.register('p1', vi.fn());
      d.dispose();
      expect(bus.size).toBe(0);
    });

    it('registering multiple handlers', () => {
      const bus = new HookBus();
      bus.register('p1', vi.fn());
      bus.register('p2', vi.fn());
      expect(bus.size).toBe(2);
    });

    it('removePlugin removes all handlers for that plugin', () => {
      const bus = new HookBus();
      bus.register('p1', vi.fn());
      bus.register('p1', vi.fn());
      bus.register('p2', vi.fn());
      bus.removePlugin('p1');
      expect(bus.size).toBe(1);
    });

    it('clear removes all handlers', () => {
      const bus = new HookBus();
      bus.register('p1', vi.fn());
      bus.register('p2', vi.fn());
      bus.clear();
      expect(bus.size).toBe(0);
    });
  });

  describe('emit (observer)', () => {
    it('calls all handlers with args', async () => {
      const bus = new HookBus<(x: number) => void>();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      bus.register('p1', fn1);
      bus.register('p2', fn2);
      await bus.emit(42);
      expect(fn1).toHaveBeenCalledWith(42);
      expect(fn2).toHaveBeenCalledWith(42);
    });

    it('calls handlers in order', async () => {
      const bus = new HookBus<() => void>();
      const order: number[] = [];
      bus.register('p1', () => order.push(200), 200);
      bus.register('p2', () => order.push(50), 50);
      bus.register('p3', () => order.push(100), 100);
      await bus.emit();
      expect(order).toEqual([50, 100, 200]);
    });

    it('catches handler errors and records them', async () => {
      const bus = new HookBus<() => void>();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bus.register('p1', () => { throw new Error('fail'); });
      await bus.emit();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('skips disabled plugins', async () => {
      const bus = new HookBus<() => void>();
      const fn = vi.fn();
      bus.register('p1', fn);

      // Manually trigger circuit breaker
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      for (let i = 0; i < 3; i++) {
        pluginErrorTracker.record('p1', new Error('test'));
      }
      consoleSpy.mockRestore();

      expect(pluginErrorTracker.isDisabled('p1')).toBe(true);
      await bus.emit();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('emitSync', () => {
    it('calls handlers synchronously', () => {
      const bus = new HookBus<(x: string) => void>();
      const fn = vi.fn();
      bus.register('p1', fn);
      bus.emitSync('hello');
      expect(fn).toHaveBeenCalledWith('hello');
    });

    it('catches errors without throwing', () => {
      const bus = new HookBus<() => void>();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      bus.register('p1', () => { throw new Error('boom'); });
      expect(() => bus.emitSync()).not.toThrow();
      consoleSpy.mockRestore();
    });
  });

  describe('intercept', () => {
    it('returns true when all handlers pass', async () => {
      const bus = new HookBus<() => boolean>();
      bus.register('p1', () => true);
      bus.register('p2', () => true);
      const result = await bus.intercept();
      expect(result).toBe(true);
    });

    it('returns false when any handler returns false', async () => {
      const bus = new HookBus<() => boolean>();
      bus.register('p1', () => true);
      bus.register('p2', () => false);
      const result = await bus.intercept();
      expect(result).toBe(false);
    });

    it('stops early on false (short-circuits)', async () => {
      const bus = new HookBus<() => boolean>();
      const fn3 = vi.fn(() => true);
      bus.register('p1', () => true, 10);
      bus.register('p2', () => false, 20);
      bus.register('p3', fn3, 30);
      await bus.intercept();
      expect(fn3).not.toHaveBeenCalled();
    });

    it('returns true when no handlers registered', async () => {
      const bus = new HookBus<() => boolean>();
      expect(await bus.intercept()).toBe(true);
    });
  });

  describe('transform', () => {
    it('chains values through handlers', async () => {
      const bus = new HookBus<(val: number) => number>();
      bus.register('p1', (val: number) => val * 2);
      bus.register('p2', (val: number) => val + 1);
      const result = await bus.transform(5);
      expect(result).toBe(11); // (5 * 2) + 1
    });

    it('returns initial value when no handlers', async () => {
      const bus = new HookBus<(val: string) => string>();
      const result = await bus.transform('hello');
      expect(result).toBe('hello');
    });

    it('skips handler that returns undefined', async () => {
      const bus = new HookBus<(val: number) => number | undefined>();
      bus.register('p1', () => undefined);
      bus.register('p2', (val: number) => val + 10);
      const result = await bus.transform(5);
      expect(result).toBe(15);
    });

    it('drops a handler that overruns the bus timeout', async () => {
      vi.useFakeTimers();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const bus = new HookBus<(val: number) => Promise<number>>(50);
        bus.register('slow', () => new Promise<number>(resolve => setTimeout(() => resolve(99), 500)));
        const pending = bus.transform(1);
        await vi.advanceTimersByTimeAsync(60);
        expect(await pending).toBe(1); // initial value kept, handler timed out
      } finally {
        consoleSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('honours a per-bus timeout longer than the 5s default', async () => {
      vi.useFakeTimers();
      try {
        const bus = new HookBus<(val: number) => Promise<number>>(120_000);
        bus.register('slow', () => new Promise<number>(resolve => setTimeout(() => resolve(99), 30_000)));
        const pending = bus.transform(1);
        await vi.advanceTimersByTimeAsync(30_100);
        expect(await pending).toBe(99);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('onBeforeBlobUpload offload budget', () => {
  it('gives the hook room for a real upload, not the 5s default', async () => {
    vi.useFakeTimers();
    try {
      emailHooks.onBeforeBlobUpload.register('offloader', () =>
        new Promise(resolve => setTimeout(() => resolve({
          externalAttachment: true, html: '<a href="https://drop.example/x">x</a>', text: 'https://drop.example/x',
        }), 20_000)),
      );
      const pending = emailHooks.onBeforeBlobUpload.transform<unknown>('file-id');
      await vi.advanceTimersByTimeAsync(20_100);
      expect(isExternalAttachmentResult(await pending)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isExternalAttachmentResult', () => {
  const valid = { externalAttachment: true, html: '<a href="https://x/y">y</a>', text: 'https://x/y' };

  it('accepts a well-formed result', () => {
    expect(isExternalAttachmentResult(valid)).toBe(true);
  });

  it('accepts an optional fileId', () => {
    expect(isExternalAttachmentResult({ ...valid, fileId: 'abc' })).toBe(true);
  });

  it.each([
    ['a plain file id', 'some-uuid'],
    ['null', null],
    ['undefined', undefined],
    ['missing marker', { html: 'x', text: 'x' }],
    ['falsy marker', { ...valid, externalAttachment: false }],
    ['missing text', { externalAttachment: true, html: 'x' }],
    ['non-string html', { externalAttachment: true, html: 1, text: 'x' }],
    ['non-string fileId', { ...valid, fileId: 42 }],
  ])('rejects %s', (_label, value) => {
    expect(isExternalAttachmentResult(value)).toBe(false);
  });
});

describe('PluginErrorTracker', () => {
  it('is not disabled initially', () => {
    expect(pluginErrorTracker.isDisabled('some-plugin')).toBe(false);
  });

  it('disables after threshold errors', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    pluginErrorTracker.record('p1', new Error('1'));
    pluginErrorTracker.record('p1', new Error('2'));
    expect(pluginErrorTracker.isDisabled('p1')).toBe(false);
    pluginErrorTracker.record('p1', new Error('3'));
    expect(pluginErrorTracker.isDisabled('p1')).toBe(true);
    consoleSpy.mockRestore();
  });

  it('calls auto-disable callback', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cb = vi.fn();
    pluginErrorTracker.setAutoDisableCallback(cb);
    for (let i = 0; i < 3; i++) {
      pluginErrorTracker.record('p2', new Error(`err-${i}`));
    }
    expect(cb).toHaveBeenCalledWith('p2', expect.any(Error));
    consoleSpy.mockRestore();
    pluginErrorTracker.setAutoDisableCallback(() => {});
  });

  it('reset re-enables a plugin', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) {
      pluginErrorTracker.record('p3', new Error(`err-${i}`));
    }
    expect(pluginErrorTracker.isDisabled('p3')).toBe(true);
    pluginErrorTracker.reset('p3');
    expect(pluginErrorTracker.isDisabled('p3')).toBe(false);
    consoleSpy.mockRestore();
  });
});

describe('Hook domain instances', () => {
  it('emailHooks has expected buses', () => {
    expect(emailHooks.onEmailOpen).toBeInstanceOf(HookBus);
    expect(emailHooks.onBeforeEmailSend).toBeInstanceOf(HookBus);
    expect(emailHooks.onAfterEmailDelete).toBeInstanceOf(HookBus);
    expect(emailHooks.onNewEmailReceived).toBeInstanceOf(HookBus);
  });

  it('calendarHooks has expected buses', () => {
    expect(calendarHooks.onCalendarEventOpen).toBeInstanceOf(HookBus);
    expect(calendarHooks.onBeforeEventCreate).toBeInstanceOf(HookBus);
    expect(calendarHooks.onEventRsvp).toBeInstanceOf(HookBus);
  });

  it('onCalendarEventFormSave pipes a returned patch through transform with the form view', async () => {
    const { calendarFormHooks } = await import('../plugin-hooks');
    const views: CalendarEventFormView[] = [];
    const disposable = calendarFormHooks.onCalendarEventFormSave.register(
      'test-p',
      async (_patch, view) => {
        views.push(view);
        return { virtualLocation: 'https://meet.example.com/rooms/x?role=host' };
      },
    );

    const patch = await calendarFormHooks.onCalendarEventFormSave.transform(
      {},
      {
        title: 'Team Sync',
        description: '',
        start: '2026-10-09T10:00:00',
        end: '2026-10-09T11:00:00',
        isAllDay: false,
        location: '',
        virtualLocation: '',
        calendarId: 'cal-1',
        uid: 'uid-1',
        attendees: ['a@sunbeam.pt'],
      },
    );

    expect(patch).toEqual({ virtualLocation: 'https://meet.example.com/rooms/x?role=host' });
    expect(views[0]).toMatchObject({ title: 'Team Sync', uid: 'uid-1', attendees: ['a@sunbeam.pt'] });
    disposable.dispose();
  });

  it('onCalendarEventFormSave keeps the form unchanged when handlers return undefined', async () => {
    const { calendarFormHooks } = await import('../plugin-hooks');
    const disposable = calendarFormHooks.onCalendarEventFormSave.register('test-p', async () => undefined);

    const patch = await calendarFormHooks.onCalendarEventFormSave.transform(
      { virtualLocation: 'keep-me' },
      {
        title: 'T', description: '', start: '', end: '', isAllDay: false,
        location: '', virtualLocation: '', calendarId: 'cal-1', attendees: [],
      },
    );

    expect(patch).toEqual({ virtualLocation: 'keep-me' });
    disposable.dispose();
  });
});

describe('removeAllPluginHooks', () => {
  it('removes handlers from all buses for a plugin', () => {
    emailHooks.onEmailOpen.register('test-p', vi.fn());
    calendarHooks.onCalendarEventOpen.register('test-p', vi.fn());
    emailHooks.onEmailOpen.register('other-p', vi.fn());

    removeAllPluginHooks('test-p');

    expect(emailHooks.onEmailOpen.size).toBe(1); // other-p remains
    expect(calendarHooks.onCalendarEventOpen.size).toBe(0);
  });
});

describe('clearAllHooks', () => {
  it('removes all handlers from all buses', () => {
    emailHooks.onEmailOpen.register('p1', vi.fn());
    calendarHooks.onCalendarEventOpen.register('p2', vi.fn());
    clearAllHooks();
    expect(emailHooks.onEmailOpen.size).toBe(0);
    expect(calendarHooks.onCalendarEventOpen.size).toBe(0);
  });
});
