import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore, migrateSettings } from '../settings-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';

// #1248: `policy.defaults` from policy.json never reached the settings store.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let serverFiles: Record<string, unknown> = {};

function loadPolicy(patch: Partial<SettingsPolicy>) {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY, ...patch }, loaded: true });
}

async function signIn(username: string) {
  const serverUrl = 'https://mail.example.com';
  await useSettingsStore.getState().loadFromServer(username, serverUrl).finally(() => {
    useSettingsStore.getState().enableSync(username, serverUrl);
  });
}

const settings = () => useSettingsStore.getState();

beforeEach(() => {
  localStorage.clear();
  serverFiles = {};
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ ok: true });
    const username = (init?.headers as Record<string, string>)['x-settings-username'];
    return json({ settings: serverFiles[username] ?? null });
  });
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: false });
  useSettingsStore.getState().disableSync();
  useSettingsStore.getState().resetToDefaults();
});

describe('admin policy defaults (#1248)', () => {
  it('applies a default to a user who never changed the setting', () => {
    expect(settings().showSharedMailAccounts).toBe(true);
    loadPolicy({ defaults: { showSharedMailAccounts: false, enableUnifiedMailbox: true } });
    expect(settings().showSharedMailAccounts).toBe(false);
    expect(settings().enableUnifiedMailbox).toBe(true);
  });

  it('keeps a value the user chose, even the build default', () => {
    settings().updateSetting('showSharedMailAccounts', true);
    loadPolicy({ defaults: { showSharedMailAccounts: false } });
    expect(settings().showSharedMailAccounts).toBe(true);
  });

  it('keeps a choice made after the default applied when the policy loads again', () => {
    loadPolicy({ defaults: { showSharedMailAccounts: false } });
    settings().updateSetting('showSharedMailAccounts', true);
    loadPolicy({ defaults: { showSharedMailAccounts: false } });
    expect(settings().showSharedMailAccounts).toBe(true);
  });

  it('follows the operator changing a default the user never touched', () => {
    loadPolicy({ defaults: { deleteAction: 'trash-and-read' } });
    expect(settings().deleteAction).toBe('trash-and-read');
    loadPolicy({ defaults: { deleteAction: 'permanent' } });
    expect(settings().deleteAction).toBe('permanent');
  });

  it('ignores keys that are not settings and values of the wrong type', () => {
    const updateSetting = settings().updateSetting;
    loadPolicy({
      defaults: {
        updateSetting: 'boom',
        explicitSettings: 'boom',
        notASetting: true,
        showSharedMailAccounts: 'no',
        emailsPerPage: '25',
        emailKeywords: [],
        sendDelaySeconds: 15,
      },
    });
    expect(settings().updateSetting).toBe(updateSetting);
    expect(settings().explicitSettings).toEqual([]);
    expect('notASetting' in settings()).toBe(false);
    expect(settings().showSharedMailAccounts).toBe(true);
    expect(settings().emailsPerPage).toBe(50);
    expect(settings().sendDelaySeconds).toBe(5);
  });

  it('presets the hover actions, a list setting (#1564)', () => {
    loadPolicy({ defaults: { hoverActions: ['delete', 'star', 'markRead', 'archive', 'tag', 'spam'] } });
    expect(settings().hoverActions).toEqual(['delete', 'star', 'markRead', 'archive', 'tag', 'spam']);
    expect(settings().explicitSettings).toEqual([]);
  });

  it('keeps hover actions the user chose over the preset', () => {
    settings().updateSetting('hoverActions', ['delete']);
    loadPolicy({ defaults: { hoverActions: ['delete', 'spam'] } });
    expect(settings().hoverActions).toEqual(['delete']);
  });

  it('skips a hover action preset with an unknown or repeated action, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadPolicy({ defaults: { hoverActions: ['delete', 'launchRockets'] } });
    expect(settings().hoverActions).toEqual(['delete', 'star', 'markRead', 'archive']);
    loadPolicy({ defaults: { hoverActions: ['delete', 'delete'] } });
    expect(settings().hoverActions).toEqual(['delete', 'star', 'markRead', 'archive']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('defaults.hoverActions'));
    warn.mockRestore();
  });

  it('puts the built-in hover actions back when the preset goes', () => {
    loadPolicy({ defaults: { hoverActions: ['spam'] } });
    expect(settings().hoverActions).toEqual(['spam']);
    loadPolicy({ defaults: {} });
    expect(settings().hoverActions).toEqual(['delete', 'star', 'markRead', 'archive']);
  });

  it('respects the allowed values of a restriction', () => {
    loadPolicy({
      defaults: { emailsPerPage: 500 },
      restrictions: { emailsPerPage: { max: 100 } },
    });
    expect(settings().emailsPerPage).toBe(50);
  });

  it('enforces a locked value over the user\'s choice', () => {
    settings().updateSetting('deleteAction', 'permanent');
    loadPolicy({ restrictions: { deleteAction: { locked: true, value: 'trash' } } });
    expect(settings().deleteAction).toBe('trash');
  });

  it('enforces the default of a locked setting that has no value of its own', () => {
    settings().updateSetting('showSharedMailAccounts', true);
    loadPolicy({
      defaults: { showSharedMailAccounts: false },
      restrictions: { showSharedMailAccounts: { locked: true } },
    });
    expect(settings().showSharedMailAccounts).toBe(false);
  });

  it('lands on the operator default after a reset', () => {
    loadPolicy({ defaults: { showSharedMailAccounts: false } });
    settings().updateSetting('showSharedMailAccounts', true);
    settings().resetToDefaults();
    expect(settings().showSharedMailAccounts).toBe(false);
    expect(settings().explicitSettings).toEqual([]);
  });

  it('syncs which settings the user chose', () => {
    settings().updateSetting('showSharedMailAccounts', false);
    expect(JSON.parse(settings().exportSettings()).explicitSettings).toEqual(['showSharedMailAccounts']);
  });
});

describe('admin policy defaults and the server copy (#1248)', () => {
  it('applies to an account signing in for the first time in a browser another account used', async () => {
    serverFiles['a@example.com'] = { fontSize: 'large' };
    await signIn('a@example.com');
    loadPolicy({ defaults: { showSharedMailAccounts: false } });
    settings().updateSetting('showSharedMailAccounts', true);

    // b has no server settings yet and starts from defaults (#1185): the
    // operator's, not the build's.
    useSettingsStore.getState().disableSync();
    await signIn('b@example.com');
    expect(settings().showSharedMailAccounts).toBe(false);
    expect(settings().fontSize).toBe('medium');
  });

  it('applies over a server copy written before the default existed', async () => {
    loadPolicy({ defaults: { showSharedMailAccounts: false, deleteAction: 'trash-and-read' } });
    // Written by a build without explicitSettings: the build default for
    // showSharedMailAccounts, a choice of its own for deleteAction.
    serverFiles['a@example.com'] = { showSharedMailAccounts: true, deleteAction: 'permanent' };
    await signIn('a@example.com');
    expect(settings().showSharedMailAccounts).toBe(false);
    expect(settings().deleteAction).toBe('permanent');
    expect(settings().explicitSettings).toEqual(['deleteAction']);
  });

  it('keeps a choice the server copy records, even the build default', async () => {
    loadPolicy({ defaults: { showSharedMailAccounts: false } });
    serverFiles['a@example.com'] = { showSharedMailAccounts: true, explicitSettings: ['showSharedMailAccounts'] };
    await signIn('a@example.com');
    expect(settings().showSharedMailAccounts).toBe(true);
  });

  it('applies when the policy arrives after the server copy', async () => {
    serverFiles['a@example.com'] = { showSharedMailAccounts: true, explicitSettings: [] };
    await signIn('a@example.com');
    expect(settings().showSharedMailAccounts).toBe(true);
    loadPolicy({ defaults: { showSharedMailAccounts: false } });
    expect(settings().showSharedMailAccounts).toBe(false);
  });
});

describe('settings stored before #1248', () => {
  it('counts a value that differs from the build default as the user\'s choice', () => {
    const migrated = migrateSettings(
      { showSharedMailAccounts: false, deleteAction: 'trash', density: 'compact', preferredIdentityIds: {} },
      7,
    );
    expect([...migrated.explicitSettings].sort()).toEqual(['density', 'showSharedMailAccounts']);
  });
});

describe('accessibility settings and the admin policy', () => {
  it('presets an accessibility option for users who never set it', () => {
    loadPolicy({ defaults: { fontSize: 'x-large', contrast: 'more' } });
    expect(settings().fontSize).toBe('x-large');
    expect(settings().contrast).toBe('more');
  });

  it("treats a lock on text size as a default, so the user's own choice wins", () => {
    settings().updateSetting('fontSize', 'huge');
    loadPolicy({ restrictions: { fontSize: { locked: true, value: 'small' } } });
    expect(settings().fontSize).toBe('huge');
  });

  it('still enforces a lock on single-key shortcuts', () => {
    settings().updateSetting('singleKeyShortcuts', true);
    loadPolicy({ restrictions: { singleKeyShortcuts: { locked: true, value: false } } });
    expect(settings().singleKeyShortcuts).toBe(false);
  });

  it('applies a preset written for the old Animations switch', () => {
    loadPolicy({ defaults: { animationsEnabled: false } });
    expect(settings().reduceMotion).toBe('on');
  });

  it('ignores a preset value the page does not know', () => {
    loadPolicy({ defaults: { fontSize: 'enormous' } });
    expect(settings().fontSize).toBe('medium');
  });

  it('keeps toasts at least as long as the minimum an admin sets', () => {
    loadPolicy({ restrictions: { toastDuration: { locked: true, value: 5, min: 20 } } });
    expect(settings().toastDuration).toBe(5);
    loadPolicy({ restrictions: { toastDuration: { locked: true, value: 0, min: 20 } } });
    expect(settings().toastDuration).toBe(0);
  });
});

describe('settings export', () => {
  it('syncs always-light mail, toolbar labels and the accessibility options', () => {
    settings().updateSetting('emailAlwaysLightMode', true);
    settings().updateSetting('showToolbarLabels', false);
    settings().updateSetting('appFont', 'atkinson');
    const exported = JSON.parse(settings().exportSettings());
    expect(exported.emailAlwaysLightMode).toBe(true);
    expect(exported.showToolbarLabels).toBe(false);
    expect(exported.appFont).toBe('atkinson');
    expect(exported.reduceMotion).toBe('system');
  });

  it('keeps the current value when an import carries one the page does not know', () => {
    settings().updateSetting('fontSize', 'large');
    settings().importSettings(JSON.stringify({ fontSize: 'enormous', appFont: 'comic-sans' }));
    expect(settings().fontSize).toBe('large');
    expect(settings().appFont).toBe('default');
  });
});


describe('virtual view defaults', () => {
  it('defaults Unread and Starred ON without enabling aggregation', () => {
    expect(settings().enableCrossUnreadView).toBe(true);
    expect(settings().enableCrossStarredView).toBe(true);
    expect(settings().enableUnifiedMailbox).toBe(false);
    expect(settings().enableCrossAllView).toBe(false);
    expect(settings().unifiedCrossAccount).toBe(false);
  });

  it('preserves existing untouched v16 values locally and through server/import copies', async () => {
    const old = { enableCrossUnreadView: false, enableCrossStarredView: false, explicitSettings: [] };
    const migrated = migrateSettings({ ...old }, 16);
    expect(migrated.enableCrossUnreadView).toBe(false);
    expect(migrated.enableCrossStarredView).toBe(false);
    expect(migrated.explicitSettings).toEqual([]);
    localStorage.setItem('settings-storage', JSON.stringify({ state: old, version: 16 }));
    await useSettingsStore.persist.rehydrate();
    expect(settings().enableCrossUnreadView).toBe(false);
    expect(settings().enableCrossStarredView).toBe(false);
    settings().importSettings(JSON.stringify(old));
    expect(settings().enableCrossUnreadView).toBe(false);
    expect(settings().enableCrossStarredView).toBe(false);
    serverFiles.existingUser = old;
    localStorage.clear();
    await signIn('existingUser');
    expect(settings().enableCrossUnreadView).toBe(false);
    expect(settings().enableCrossStarredView).toBe(false);
  });

  it.each(['enableCrossUnreadView', 'enableCrossStarredView'] as const)(
    'preserves explicit OFF for %s through persistence, migration, export/import and server reload', async (key) => {
      settings().updateSetting(key, false);
      expect(settings().explicitSettings).toContain(key);
      const saved = JSON.parse(localStorage.getItem('settings-storage')!);
      expect(saved.state[key]).toBe(false);
      const migrated = migrateSettings({ ...saved.state }, 16);
      expect(migrated[key]).toBe(false);
      // Real Zustand local-storage rehydrate, not just a migration helper.
      useSettingsStore.setState({ [key]: true });
      localStorage.setItem('settings-storage', JSON.stringify(saved));
      await useSettingsStore.persist.rehydrate();
      expect(settings()[key]).toBe(false);
      expect(settings().explicitSettings).toContain(key);
      const exported = settings().exportSettings();
      settings().resetToDefaults();
      settings().importSettings(exported);
      expect(settings()[key]).toBe(false);
      expect(settings().explicitSettings).toContain(key);
      serverFiles.chosen = JSON.parse(exported);
      settings().resetToDefaults();
      // Simulate another browser: no newer local reset stamp may win.
      localStorage.clear();
      await signIn('chosen');
      expect(settings()[key]).toBe(false);
      expect(settings().explicitSettings).toContain(key);
    },
  );

  it('still applies operator defaults to untouched views', () => {
    loadPolicy({ defaults: { enableCrossUnreadView: false, enableCrossStarredView: false } });
    expect(settings().enableCrossUnreadView).toBe(false);
    expect(settings().enableCrossStarredView).toBe(false);
  });
});
