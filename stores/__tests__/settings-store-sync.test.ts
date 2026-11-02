import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore } from '../settings-store';
import { useTemplateStore } from '../template-store';
import { useCalendarStore } from '../calendar-store';

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
    useCalendarStore.setState({ icalSubscriptions: [], deletedSubscriptionIds: {} });
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

  it('defaults pushNotifyInboxOnly to false and round-trips it through the sync payload', async () => {
    const settings = useSettingsStore.getState();
    expect(settings.pushNotifyInboxOnly).toBe(false);

    settings.enableSync('a@example.com', 'https://mail-a.example.com');
    settings.updateSetting('pushNotifyInboxOnly', true);

    await useSettingsStore.getState().flushSync();

    const request = apiFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      settings: { pushNotifyInboxOnly: true },
    });
  });

  it('defaults the signature auto-insert toggles and the separator to on and exports them', () => {
    const settings = useSettingsStore.getState();
    expect(settings.signatureNewMailEnabled).toBe(true);
    expect(settings.signatureReplyForwardEnabled).toBe(true);
    expect(settings.signatureSeparatorEnabled).toBe(true);

    const exported = JSON.parse(settings.exportSettings()) as Record<string, unknown>;
    expect(exported).toMatchObject({
      signatureNewMailEnabled: true,
      signatureReplyForwardEnabled: true,
      signatureSeparatorEnabled: true,
    });
  });

  it('keeps inserting the signature for users whose saved settings predate the toggles', async () => {
    useSettingsStore.getState().resetToDefaults();
    // Saved by a build without the toggles: the keys are missing.
    localStorage.setItem('settings-storage', JSON.stringify({
      state: { signaturePosition: 'below_quote', signatureSeparatorEnabled: true },
      version: 12,
    }));
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().signatureNewMailEnabled).toBe(true);
    expect(useSettingsStore.getState().signatureReplyForwardEnabled).toBe(true);

    // A server copy written by such a build has no toggles either.
    useSettingsStore.getState().importSettings(
      JSON.stringify({ signaturePosition: 'above_quote' }),
      { serverAccountId: 'a@example.com' },
    );
    expect(useSettingsStore.getState().signatureNewMailEnabled).toBe(true);
    expect(useSettingsStore.getState().signatureReplyForwardEnabled).toBe(true);
    localStorage.removeItem('settings-storage');
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

describe('template push after a server load', () => {
  const USER = 'a@example.com';
  const SERVER = 'https://mail-a.example.com';
  const remote = {
    id: 'remote-1',
    name: 'From server',
    subject: '',
    body: '',
    category: '',
    isFavorite: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  function serverReturns(settings: Record<string, unknown> | null) {
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === 'POST' ? { ok: true } : { settings }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }

  function addLocal() {
    return useTemplateStore.getState().addTemplate({
      name: 'Local only', subject: '', body: '', category: '', isFavorite: false,
    });
  }

  async function login() {
    await useSettingsStore.getState().loadFromServer(USER, SERVER);
    useSettingsStore.getState().enableSync(USER, SERVER);
    await useSettingsStore.getState().flushSync();
    return apiFetch.mock.calls
      .map((call) => call[1] as RequestInit | undefined)
      .filter((init) => init?.method === 'POST')
      .map((init) => JSON.parse(init!.body as string));
  }

  beforeEach(() => {
    apiFetch.mockReset();
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({ settingsSyncDisabled: false });
    useTemplateStore.setState({ templates: [], recentTemplateIds: [], deletedTemplateIds: {} });
  });

  it('pushes a local template the server blob lacks', async () => {
    serverReturns({ templates: [remote], deletedTemplateIds: {} });
    const local = addLocal();

    const pushes = await login();

    expect(pushes).toHaveLength(1);
    const ids = pushes[0].settings.templates.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual([local.id, 'remote-1'].sort());
  });

  it('pushes local templates when the server has no blob yet', async () => {
    serverReturns(null);
    addLocal();

    const pushes = await login();

    expect(pushes).toHaveLength(1);
    expect(pushes[0].settings.templates).toHaveLength(1);
  });

  it('does not push when the server blob already matches', async () => {
    serverReturns({ templates: [remote], deletedTemplateIds: {} });

    expect(await login()).toHaveLength(0);
  });

  it('does not push when the user turned sync off', async () => {
    serverReturns({ templates: [], deletedTemplateIds: {}, settingsSyncDisabled: true });
    addLocal();

    expect(await login()).toHaveLength(0);
  });
});

describe('calendar subscription sync', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    useSettingsStore.getState().disableSync();
    useSettingsStore.setState({ settingsSyncDisabled: false });
    useCalendarStore.setState({ icalSubscriptions: [], deletedSubscriptionIds: {} });
  });

  it('merges server-loaded subscriptions instead of replacing local ones', () => {
    useCalendarStore.setState({
      icalSubscriptions: [{
        id: 'local-1',
        url: 'https://example.com/local.ics',
        calendarId: 'cal-local',
        name: 'Local',
        color: '#3b82f6',
        refreshInterval: 60,
        lastRefreshed: null,
      }],
    });

    const ok = useSettingsStore.getState().importSettings(
      JSON.stringify({
        icalSubscriptions: [{
          id: 'remote-1',
          url: 'https://example.com/remote.ics',
          calendarId: 'cal-remote',
          name: 'Remote',
          color: '#ef4444',
          refreshInterval: 60,
          lastRefreshed: null,
        }],
        deletedSubscriptionIds: {},
      }),
      { serverAccountId: 'acct-1' }
    );

    expect(ok).toBe(true);
    const ids = useCalendarStore.getState().icalSubscriptions.map((s) => s.id).sort();
    expect(ids).toEqual(['local-1', 'remote-1']);
  });

  it('leaves local subscriptions untouched when importing a pre-subscription settings blob', () => {
    useCalendarStore.setState({
      icalSubscriptions: [{
        id: 'keep-1',
        url: 'https://example.com/keep.ics',
        calendarId: 'cal-keep',
        name: 'Keep',
        color: '#3b82f6',
        refreshInterval: 60,
        lastRefreshed: null,
      }],
    });

    const ok = useSettingsStore.getState().importSettings(
      JSON.stringify({ sendDelaySeconds: 10 }),
      { serverAccountId: 'acct-1' }
    );

    expect(ok).toBe(true);
    expect(useCalendarStore.getState().icalSubscriptions).toHaveLength(1);
  });

  it('round-trips subscriptions through exportSettings', () => {
    useCalendarStore.setState({
      icalSubscriptions: [{
        id: 'export-1',
        url: 'https://example.com/export.ics',
        calendarId: 'cal-export',
        name: 'Exported Sub',
        color: '#3b82f6',
        refreshInterval: 60,
        lastRefreshed: null,
      }],
    });

    const exported = JSON.parse(useSettingsStore.getState().exportSettings());
    expect(exported.icalSubscriptions).toHaveLength(1);
    expect(exported.icalSubscriptions[0].name).toBe('Exported Sub');
    expect(exported.deletedSubscriptionIds).toEqual({});
  });
  it('pushes only the active login\'s subscriptions into its server blob', async () => {
    const sub = (id: string, owner?: string) => ({
      id, url: `https://example.com/${id}.ics`, calendarId: `cal-${id}`, name: id,
      color: '#3b82f6', refreshInterval: 60, lastRefreshed: null, owner,
    });
    useSettingsStore.getState().enableSync('Alice@Example.com', 'https://mail.example.com/');
    // Secret feed URLs of another login must not land in this login's blob,
    // and unowned (pre-owner) entries are claimed locally before they sync.
    useCalendarStore.setState({
      icalSubscriptions: [
        sub('mine', 'https://mail.example.com|alice@example.com'),
        sub('bobs', 'https://other.example.org|bob@example.org'),
        sub('unowned'),
      ],
    });

    await useSettingsStore.getState().flushSync();

    const body = JSON.parse((apiFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.settings.icalSubscriptions.map((s: { id: string }) => s.id)).toEqual(['mine']);
  });

  it('ignores other logins\' subscriptions in a server blob written before owners were synced', async () => {
    const sub = (id: string, owner?: string) => ({
      id, url: `https://example.com/${id}.ics`, calendarId: `cal-${id}`, name: id,
      color: '#3b82f6', refreshInterval: 60, lastRefreshed: null, owner,
    });
    apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      settings: {
        icalSubscriptions: [
          sub('mine', 'https://mail.example.com|alice@example.com'),
          sub('bobs', 'https://other.example.org|bob@example.org'),
          sub('unowned'),
        ],
        deletedSubscriptionIds: {},
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await useSettingsStore.getState().loadFromServer('alice@example.com', 'https://mail.example.com');

    // Unowned entries stay: calendar-store only adopts them once their
    // calendar id and name are found in this login's account.
    const ids = useCalendarStore.getState().icalSubscriptions.map((s) => s.id).sort();
    expect(ids).toEqual(['mine', 'unowned']);
  });

  it('does not push settings when only calendar view state changes', async () => {
    useSettingsStore.getState().enableSync('a@example.com', 'https://mail-a.example.com');
    await useSettingsStore.getState().flushSync();
    apiFetch.mockClear();

    useCalendarStore.setState({ selectedDate: new Date('2026-05-01T00:00:00Z'), isLoadingEvents: true });
    useCalendarStore.setState({ isLoadingEvents: false, events: [] });
    await useSettingsStore.getState().flushSync();

    expect(apiFetch).not.toHaveBeenCalled();
  });
});
