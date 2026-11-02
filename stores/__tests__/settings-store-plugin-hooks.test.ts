import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore, DEFAULT_KEYWORDS } from '../settings-store';
import { useContactStore } from '../contact-store';
import { clearAllHooks, settingsHooks } from '@/lib/plugin-hooks';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('settings plugin hooks', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({
      sendDelaySeconds: 0,
      tourCompleted: false,
      trustedSenders: [],
      folderIcons: {},
      emailKeywords: [...DEFAULT_KEYWORDS],
      settingsSyncDisabled: false,
    });
  });

  afterEach(() => clearAllHooks());

  it('asks onBeforeSettingChange first and reports the change afterwards', async () => {
    const order: string[] = [];
    const before = vi.fn(() => { order.push(`before:${useSettingsStore.getState().sendDelaySeconds}`); return true; });
    const after = vi.fn(() => { order.push('after'); });
    settingsHooks.onBeforeSettingChange.register('test', before);
    settingsHooks.onSettingChange.register('test', after);

    useSettingsStore.getState().updateSetting('sendDelaySeconds', 30);
    await flush();

    expect(before).toHaveBeenCalledWith({ key: 'sendDelaySeconds', value: 30, previous: 0 });
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith({ key: 'sendDelaySeconds', value: 30, previous: 0 });
    expect(order).toEqual(['before:0', 'after']);
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(30);
  });

  it('keeps the old value when a plugin says no', async () => {
    const after = vi.fn();
    settingsHooks.onBeforeSettingChange.register('test', () => false);
    settingsHooks.onSettingChange.register('test', after);

    useSettingsStore.getState().updateSetting('sendDelaySeconds', 30);
    await flush();

    expect(useSettingsStore.getState().sendDelaySeconds).toBe(0);
    expect(after).not.toHaveBeenCalled();
  });

  it('lets no plugin hold up turning proofreading off, overall or for one plugin (#1397)', async () => {
    useSettingsStore.setState({ proofreading: true, proofreadingPlugins: {} });
    settingsHooks.onBeforeSettingChange.register('test', () => false);
    useSettingsStore.getState().updateSetting('proofreading', false);
    useSettingsStore.getState().updateSetting('proofreadingPlugins', { lt: false });
    expect(useSettingsStore.getState().proofreading).toBe(false);
    expect(useSettingsStore.getState().proofreadingPlugins).toEqual({ lt: false });
    // Turning it on still asks.
    useSettingsStore.getState().updateSetting('proofreading', true);
    await flush();
    expect(useSettingsStore.getState().proofreading).toBe(false);
  });

  it('applies synchronously when no plugin intercepts', () => {
    const after = vi.fn();
    settingsHooks.onSettingChange.register('test', after);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 10);
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(10);
    expect(after).toHaveBeenCalledWith({ key: 'sendDelaySeconds', value: 10, previous: 0 });
  });

  it('leaves bookkeeping and internal writes out of the setting hooks', async () => {
    const before = vi.fn(() => false);
    const after = vi.fn();
    settingsHooks.onBeforeSettingChange.register('test', before);
    settingsHooks.onSettingChange.register('test', after);

    useSettingsStore.getState().updateSetting('tourCompleted', true);
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 60, { internal: true });
    await flush();

    expect(useSettingsStore.getState().tourCompleted).toBe(true);
    expect(useSettingsStore.getState().sendDelaySeconds).toBe(60);
    expect(before).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('routes folder icon changes through the setting hooks', async () => {
    settingsHooks.onBeforeSettingChange.register('test', () => false);
    useSettingsStore.getState().setFolderIcon('mb1', 'Star');
    await flush();
    expect(useSettingsStore.getState().folderIcons).toEqual({});
  });

  it('reports export but not the sync snapshot', () => {
    const exported = vi.fn();
    settingsHooks.onSettingsExport.register('test', exported);

    useSettingsStore.getState().exportSettings({ forSync: true });
    expect(exported).not.toHaveBeenCalled();

    useSettingsStore.getState().exportSettings();
    expect(exported).toHaveBeenCalledTimes(1);
    const { keys } = exported.mock.calls[0][0] as { keys: string[] };
    expect(keys).toContain('sendDelaySeconds');
    expect(keys).toContain('theme');
  });

  it('reports a file import with the keys taken over, and not a failed one', () => {
    const imported = vi.fn();
    settingsHooks.onSettingsImport.register('test', imported);

    expect(useSettingsStore.getState().importSettings('not json')).toBe(false);
    expect(imported).not.toHaveBeenCalled();

    useSettingsStore.getState().importSettings(JSON.stringify({ sendDelaySeconds: 30, unknownKey: 1, proInterface: true }));
    expect(imported).toHaveBeenCalledTimes(1);
    expect(imported).toHaveBeenCalledWith({ keys: ['sendDelaySeconds'] });
  });

  it('reports a reset', () => {
    const reset = vi.fn();
    settingsHooks.onSettingsReset.register('test', reset);
    useSettingsStore.getState().resetToDefaults();
    expect(reset).toHaveBeenCalledWith({});
  });

  it('reports a pull from the server as a sync, not an import', async () => {
    const synced = vi.fn();
    const imported = vi.fn();
    settingsHooks.onSettingsSync.register('test', synced);
    settingsHooks.onSettingsImport.register('test', imported);
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ settings: { sendDelaySeconds: 10 } }), { status: 200 }));

    await useSettingsStore.getState().loadFromServer('a@example.com', 'https://mail.example.com');

    expect(synced).toHaveBeenCalledWith({ direction: 'pulled' });
    expect(imported).not.toHaveBeenCalled();
  });

  it('reports a push only when the server accepted it', async () => {
    const synced = vi.fn();
    settingsHooks.onSettingsSync.register('test', synced);
    const settings = useSettingsStore.getState();
    settings.enableSync('a@example.com', 'https://mail.example.com');

    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope' }), { status: 400 }));
    settings.updateSetting('sendDelaySeconds', 10);
    await useSettingsStore.getState().flushSync();
    expect(synced).not.toHaveBeenCalled();

    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 30);
    await useSettingsStore.getState().flushSync();
    expect(synced).toHaveBeenCalledWith({ direction: 'pushed' });
  });

  it('reports tag definition changes as keyword views', () => {
    const changed = vi.fn();
    settingsHooks.onKeywordChange.register('test', changed);
    useSettingsStore.getState().addKeyword({ id: 'work', label: 'Work', color: 'blue' });
    expect(changed).toHaveBeenCalledTimes(1);
    const { keywords } = changed.mock.calls[0][0] as { keywords: unknown[] };
    expect(keywords).toContainEqual({ id: 'work', name: 'Work', color: 'blue' });

    // Writing an identical list is no change.
    useSettingsStore.getState().reorderKeywords([...useSettingsStore.getState().emailKeywords]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('reports trusted senders added and removed, once each', () => {
    const changed = vi.fn();
    settingsHooks.onTrustedSenderChange.register('test', changed);
    const s = useSettingsStore.getState();
    s.addTrustedSender('Alice <Alice@Example.com>');
    s.addTrustedSender('alice@example.com');
    s.removeTrustedSender('alice@example.com');
    s.removeTrustedSender('alice@example.com');
    expect(changed.mock.calls).toEqual([
      [{ email: 'alice@example.com', trusted: true }],
      [{ email: 'alice@example.com', trusted: false }],
    ]);
  });

  it('reports trusted senders kept in the address book after the server stored them', async () => {
    const changed = vi.fn();
    settingsHooks.onTrustedSenderChange.register('test', changed);
    useContactStore.setState({ trustedSendersBookId: 'book1', trustedSenderEmails: [] });
    const client = {
      createContact: vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ id: 'c1' }),
    } as unknown as IJMAPClient;

    await expect(useContactStore.getState().addToTrustedSendersBook(client, 'bob@example.com')).rejects.toThrow();
    expect(changed).not.toHaveBeenCalled();

    await useContactStore.getState().addToTrustedSendersBook(client, 'bob@example.com');
    expect(changed).toHaveBeenCalledWith({ email: 'bob@example.com', trusted: true });
  });
});
