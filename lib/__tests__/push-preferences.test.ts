import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page mirrors the notification sound setting into the service worker's
// Cache store, where sw.js reads it before showing a push notification (#1289).

describe('writeLoginQuiet', () => {
  it('keeps one answer per login', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (key: string) => (stored.has(key) ? new Response(stored.get(key)) : undefined),
        put: async (key: string, res: Response) => { stored.set(key, await res.text()); },
      }),
    });
    const { writeLoginQuiet } = await import('../push-preferences');
    await writeLoginQuiet('a@example.org', true);
    await writeLoginQuiet('b@example.org', false);
    await writeLoginQuiet('a@example.org', true);
    const value = JSON.parse(stored.get(`${window.location.origin}/__push-state/quiet-logins`) ?? 'null');
    expect(value).toEqual({ 'a@example.org': true, 'b@example.org': false });
    vi.unstubAllGlobals();
  });
});

describe('writePushPreferences', () => {
  const put = vi.fn();

  beforeEach(() => {
    put.mockReset();
    vi.stubGlobal('caches', { open: vi.fn(async () => ({ put })) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores the preference under the key the worker reads', async () => {
    const { writePushPreferences, pushPreferencesKey } = await import('../push-preferences');
    await writePushPreferences({ sound: false });
    expect(put).toHaveBeenCalledTimes(1);
    const [key, response] = put.mock.calls[0] as [string, Response];
    expect(key).toBe(pushPreferencesKey(window.location.origin));
    expect(key.endsWith('/__push-state/prefs')).toBe(true);
    expect(await response.json()).toEqual({ sound: false });
  });

  it('does nothing without a Cache store', async () => {
    vi.stubGlobal('caches', undefined);
    const { writePushPreferences } = await import('../push-preferences');
    await expect(writePushPreferences({ sound: true })).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it('does nothing where reading the Cache store throws', async () => {
    // A plugin sandbox frame has an opaque origin: reading `caches` there,
    // typeof included, throws a SecurityError.
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      get() {
        throw new DOMException('Cache storage is disabled because the context is sandboxed', 'SecurityError');
      },
    });
    const { writePushPreferences } = await import('../push-preferences');
    await expect(writePushPreferences({ sound: true })).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });
});

describe('settings store push preference mirror', () => {
  it('writes the sound preference on load and whenever the setting changes', async () => {
    vi.resetModules();
    const writePushPreferences = vi.fn(async () => {});
    vi.doMock('@/lib/push-preferences', () => ({ writePushPreferences }));
    const { useSettingsStore } = await import('@/stores/settings-store');

    expect(writePushPreferences).toHaveBeenCalledWith({ sound: true });
    writePushPreferences.mockClear();

    useSettingsStore.getState().updateSetting('emailNotificationSound', false);
    expect(writePushPreferences).toHaveBeenCalledWith({ sound: false });
    writePushPreferences.mockClear();

    // Unrelated settings do not rewrite it.
    useSettingsStore.getState().updateSetting('emailNotificationsEnabled', true);
    expect(writePushPreferences).not.toHaveBeenCalled();

    // Email notifications off means no notification, so no sound either.
    useSettingsStore.getState().updateSetting('emailNotificationSound', true);
    useSettingsStore.getState().updateSetting('emailNotificationsEnabled', false);
    expect(writePushPreferences).toHaveBeenLastCalledWith({ sound: false });
    vi.doUnmock('@/lib/push-preferences');
  });
});
