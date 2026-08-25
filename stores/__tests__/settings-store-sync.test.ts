import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore } from '../settings-store';
import { useTemplateStore } from '../template-store';

describe('settings sync debounce', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({ sendDelaySeconds: 0, settingsSyncDisabled: false });
    useTemplateStore.setState({ templates: [], recentTemplateIds: [], deletedTemplateIds: {} });
  });

  it('flushes a pending snapshot for the account that scheduled it', async () => {
    const settings = useSettingsStore.getState();
    settings.enableSync('a@example.com', 'https://mail-a.example.com');
    settings.updateSetting('sendDelaySeconds', 10);

    await useSettingsStore.getState().flushSync();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const request = apiFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      username: 'a@example.com',
      serverUrl: 'https://mail-a.example.com',
      settings: { sendDelaySeconds: 10 },
    });
  });

  it('does not rewrite a pending account snapshot after another account becomes active', async () => {
    const settings = useSettingsStore.getState();
    settings.enableSync('a@example.com', 'https://mail-a.example.com');
    settings.updateSetting('sendDelaySeconds', 10);

    const flush = useSettingsStore.getState().flushSync();
    useSettingsStore.getState().disableSync();
    useSettingsStore.getState().enableSync('b@example.com', 'https://mail-b.example.com');
    useSettingsStore.getState().updateSetting('sendDelaySeconds', 30);
    await flush;

    const request = apiFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      username: 'a@example.com',
      settings: { sendDelaySeconds: 10 },
    });
  });
});

describe('template sync (#825)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({ settingsSyncDisabled: false });
    useTemplateStore.setState({ templates: [], recentTemplateIds: [], deletedTemplateIds: {} });
  });

  it('schedules a sync when a template is created and includes it in the payload', async () => {
    useSettingsStore.getState().enableSync('a@example.com', 'https://mail-a.example.com');
    const created = useTemplateStore.getState().addTemplate({
      name: 'Greeting',
      subject: 'Hi',
      body: 'Hello there',
      category: '',
      isFavorite: false,
    });

    await useSettingsStore.getState().flushSync();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    const request = apiFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(request.body as string);
    expect(body.settings.templates).toHaveLength(1);
    expect(body.settings.templates[0]).toMatchObject({ id: created.id, name: 'Greeting' });
    expect(body.settings.deletedTemplateIds).toEqual({});
  });

  it('does not schedule a sync for template changes when sync is user-disabled', async () => {
    useSettingsStore.getState().enableSync('a@example.com', 'https://mail-a.example.com');
    useSettingsStore.setState({ settingsSyncDisabled: true });
    // Flipping the toggle itself schedules one sync (so the server learns of
    // the opt-out) - flush it so the assertion below only sees template work.
    await useSettingsStore.getState().flushSync();
    apiFetch.mockClear();

    useTemplateStore.getState().addTemplate({
      name: 'Greeting',
      subject: '',
      body: '',
      category: '',
      isFavorite: false,
    });
    await useSettingsStore.getState().flushSync();

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('merges server-loaded templates instead of replacing local ones', () => {
    const local = useTemplateStore.getState().addTemplate({
      name: 'Local only',
      subject: '',
      body: '',
      category: '',
      isFavorite: false,
    });

    const ok = useSettingsStore.getState().importSettings(
      JSON.stringify({
        templates: [{
          id: 'remote-1',
          name: 'From server',
          subject: '',
          body: '',
          category: '',
          isFavorite: false,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        }],
        deletedTemplateIds: {},
      }),
      { serverAccountId: 'acct-1' }
    );

    expect(ok).toBe(true);
    const ids = useTemplateStore.getState().templates.map((t) => t.id).sort();
    expect(ids).toEqual([local.id, 'remote-1'].sort());
  });

  it('leaves local templates untouched when importing a pre-template settings blob', () => {
    useTemplateStore.getState().addTemplate({
      name: 'Keep me',
      subject: '',
      body: '',
      category: '',
      isFavorite: false,
    });

    const ok = useSettingsStore.getState().importSettings(
      JSON.stringify({ sendDelaySeconds: 10 }),
      { serverAccountId: 'acct-1' }
    );

    expect(ok).toBe(true);
    expect(useTemplateStore.getState().templates).toHaveLength(1);
  });

  it('round-trips templates through exportSettings', () => {
    useTemplateStore.getState().addTemplate({
      name: 'Exported',
      subject: 'S',
      body: 'B',
      category: '',
      isFavorite: false,
    });

    const exported = JSON.parse(useSettingsStore.getState().exportSettings());
    expect(exported.templates).toHaveLength(1);
    expect(exported.templates[0].name).toBe('Exported');
    expect(exported.deletedTemplateIds).toEqual({});
  });
});
