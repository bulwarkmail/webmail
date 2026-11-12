import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import {
  DEFAULT_KEYWORDS,
  adminPolicyPatch,
  adminPolicyReleasePatch,
  legacyExplicitSettings,
  migrateSettings,
  migrateUntrackedKeywords,
  sameSettingValue,
  useSettingsStore,
} from '../settings-store';
import { usePolicyStore } from '../policy-store';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';

// #1612: new accounts start with the seven colour tags, or the admin's list.

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
const SEVEN = DEFAULT_KEYWORDS.map((k) => ({ ...k }));
const ADMIN_TAGS = [
  { id: 'clients', label: 'Clients', color: 'teal' },
  { id: 'internal', label: 'Internal', color: 'gray-dark' },
];

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the built-in tag list', () => {
  it('gives a new account the seven colour tags when the admin sets none', () => {
    expect(settings().emailKeywords).toEqual(SEVEN);
    expect(settings().explicitSettings).not.toContain('emailKeywords');
    settings().addKeyword({ id: 'work', label: 'Work', color: 'blue' });
    expect(settings().emailKeywords).toEqual([...SEVEN, { id: 'work', label: 'Work', color: 'blue' }]);
  });

  it('keeps the seven colour tags as a constant', () => {
    expect(DEFAULT_KEYWORDS.map((k) => k.label)).toEqual(['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink']);
  });

  it('exports the marker that tag choices are recorded', () => {
    const exported = JSON.parse(settings().exportSettings());
    expect(exported.emailKeywordsChoiceTracked).toBe(true);
    expect(exported.emailKeywords).toEqual(SEVEN);
  });
});

describe('defaults.emailKeywords', () => {
  it('gives a new account exactly the admin list, in its order', () => {
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    expect(settings().emailKeywords).toEqual(ADMIN_TAGS);
    expect(settings().explicitSettings).not.toContain('emailKeywords');
  });

  it('applies only the id, name and colour of each tag', () => {
    loadPolicy({
      defaults: { emailKeywords: [{ id: 'clients', label: ' Clients ', color: 'teal', visibility: 'hide', addedBy: 'x', extra: 1 }] },
    });
    expect(settings().emailKeywords).toEqual([{ id: 'clients', label: 'Clients', color: 'teal' }]);
  });

  it('follows the admin changing the list and goes back to the seven when it is removed', () => {
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    loadPolicy({ defaults: { emailKeywords: [ADMIN_TAGS[1]] } });
    expect(settings().emailKeywords).toEqual([ADMIN_TAGS[1]]);
    loadPolicy({ defaults: {} });
    expect(settings().emailKeywords).toEqual(SEVEN);
  });

  it.each([
    ['adds', () => settings().addKeyword({ id: 'work', label: 'Work', color: 'blue' })],
    ['edits', () => settings().updateKeyword('clients', { color: 'red' })],
    ['renames', () => settings().renameKeyword('clients', { id: 'customers', label: 'Customers', color: 'teal' })],
    ['removes', () => settings().removeKeyword('internal')],
    ['reorders', () => settings().reorderKeywords([...settings().emailKeywords].reverse())],
  ])('stops following the admin list once the user %s a tag', (_name, edit) => {
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    edit();
    expect(settings().explicitSettings).toContain('emailKeywords');
    const mine = settings().emailKeywords;
    loadPolicy({ defaults: { emailKeywords: [{ id: 'other', label: 'Other', color: 'pink' }] } });
    expect(settings().emailKeywords).toEqual(mine);
    loadPolicy({ defaults: {} });
    expect(settings().emailKeywords).toEqual(mine);
  });

  it('skips an invalid list with a warning and keeps the built-in one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadPolicy({ defaults: { emailKeywords: [{ id: 'a', label: 'A', color: 'chartreuse' }] } });
    expect(settings().emailKeywords).toEqual(SEVEN);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('defaults.emailKeywords'));
  });

  it.each([
    ['not a list', 'red'],
    ['a colour outside the palette', [{ id: 'a', label: 'A', color: 'chartreuse' }]],
    ['a repeated id, without case', [{ id: 'a', label: 'A', color: 'red' }, { id: 'A', label: 'B', color: 'blue' }]],
    ['an empty name', [{ id: 'a', label: '  ', color: 'red' }]],
    ['a missing name', [{ id: 'a', color: 'red' }]],
    ['a name that is too long', [{ id: 'a', label: 'x'.repeat(256), color: 'red' }]],
    ['an id that is no keyword', [{ id: 'a b', label: 'A', color: 'red' }]],
    ['an empty id', [{ id: '', label: 'A', color: 'red' }]],
    ['an entry that is no object', ['red']],
    ['more than 50 tags', Array.from({ length: 51 }, (_, i) => ({ id: `t${i}`, label: `T${i}`, color: 'red' }))],
  ])('does not apply %s', (_name, value) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(adminPolicyPatch({ emailKeywords: [], explicitSettings: [] }, { defaults: { emailKeywords: value } })).toEqual({});
  });

  it('applies an empty list over the tags of a user who never chose them', () => {
    expect(adminPolicyPatch({ emailKeywords: ADMIN_TAGS, explicitSettings: [] }, { defaults: { emailKeywords: [] } }))
      .toEqual({ emailKeywords: [] });
  });

  it('skips a user who chose their tags', () => {
    expect(adminPolicyPatch({ emailKeywords: SEVEN, explicitSettings: ['emailKeywords'] }, { defaults: { emailKeywords: ADMIN_TAGS } }))
      .toEqual({});
  });

  it('cannot lock the tag list', () => {
    const patch = adminPolicyPatch(
      { emailKeywords: SEVEN, explicitSettings: ['emailKeywords'] },
      { defaults: { emailKeywords: ADMIN_TAGS }, restrictions: { emailKeywords: { locked: true, value: ADMIN_TAGS } } },
    );
    expect(patch).toEqual({});
  });

  it('ignores a policy setting the marker', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(adminPolicyPatch({ emailKeywordsChoiceTracked: true, explicitSettings: [] }, { defaults: { emailKeywordsChoiceTracked: false } }))
      .toEqual({});
  });

  it('puts the seven back when the admin list goes', () => {
    const state = { emailKeywords: ADMIN_TAGS.map((k) => ({ ...k })), explicitSettings: [] };
    expect(adminPolicyReleasePatch(state, { defaults: { emailKeywords: ADMIN_TAGS } }, { defaults: {} }))
      .toEqual({ emailKeywords: SEVEN });
    // A list the user has since chosen, or one that no longer matches, stays.
    expect(adminPolicyReleasePatch({ ...state, explicitSettings: ['emailKeywords'] }, { defaults: { emailKeywords: ADMIN_TAGS } }, { defaults: {} }))
      .toEqual({});
    expect(adminPolicyReleasePatch({ ...state, emailKeywords: SEVEN }, { defaults: { emailKeywords: ADMIN_TAGS } }, { defaults: {} }))
      .toEqual({});
  });
});

describe('sameSettingValue', () => {
  it('compares tags by id, name and colour', () => {
    expect(sameSettingValue(ADMIN_TAGS.map((k) => ({ ...k })), ADMIN_TAGS)).toBe(true);
    expect(sameSettingValue([{ ...ADMIN_TAGS[0], visibility: 'hide' }], [ADMIN_TAGS[0]])).toBe(true);
    expect(sameSettingValue([{ ...ADMIN_TAGS[0], color: 'red' }], [ADMIN_TAGS[0]])).toBe(false);
    expect(sameSettingValue([{ ...ADMIN_TAGS[0], label: 'Other' }], [ADMIN_TAGS[0]])).toBe(false);
    expect(sameSettingValue([...ADMIN_TAGS].reverse(), ADMIN_TAGS)).toBe(false);
    expect(sameSettingValue([], [])).toBe(true);
  });

  it('still compares lists of strings', () => {
    expect(sameSettingValue(['delete', 'spam'], ['delete', 'spam'])).toBe(true);
    expect(sameSettingValue(['delete', 'spam'], ['spam', 'delete'])).toBe(false);
  });

  it('lets a stored tag list count as chosen when it differs from the built-in one', () => {
    expect(legacyExplicitSettings({ emailKeywords: ADMIN_TAGS })).toEqual(['emailKeywords']);
    expect(legacyExplicitSettings({ emailKeywords: SEVEN })).toEqual([]);
  });
});

describe('tags stored by earlier builds', () => {
  it('keeps the seven tags of local state from version 16, whatever the admin default', () => {
    const migrated = migrateSettings(
      { emailKeywords: SEVEN, explicitSettings: ['density'], preferredIdentityIds: {}, allMailFolderIds: {} },
      16,
    );
    expect(migrated.explicitSettings).toEqual(['density', 'emailKeywords']);
    expect(migrated.emailKeywordsChoiceTracked).toBe(true);
    expect(migrated.emailKeywords).toEqual(SEVEN);

    useSettingsStore.setState({ emailKeywords: migrated.emailKeywords, explicitSettings: migrated.explicitSettings });
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    expect(settings().emailKeywords).toEqual(SEVEN);
  });

  it('keeps no tags for a version 16 user who deleted them all, whatever the admin default', () => {
    const migrated = migrateSettings({ emailKeywords: [], explicitSettings: [], preferredIdentityIds: {}, allMailFolderIds: {} }, 16);
    expect(migrated.explicitSettings).toEqual(['emailKeywords']);

    useSettingsStore.setState({ emailKeywords: migrated.emailKeywords, explicitSettings: migrated.explicitSettings });
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    expect(settings().emailKeywords).toEqual([]);
    loadPolicy({ defaults: {} });
    expect(settings().emailKeywords).toEqual([]);
  });

  it('marks nothing for local state from version 16 without a tag list', () => {
    const migrated = migrateSettings({ explicitSettings: [], preferredIdentityIds: {}, allMailFolderIds: {} }, 16);
    expect(migrated.explicitSettings).toEqual([]);
    expect(migrated.emailKeywordsChoiceTracked).toBe(true);
  });

  it('counts the tags of an old blob with explicitSettings as chosen', () => {
    const blob: Record<string, unknown> = { emailKeywords: SEVEN, explicitSettings: ['density'] };
    migrateUntrackedKeywords(blob);
    expect(blob.explicitSettings).toEqual(['density', 'emailKeywords']);
    expect(blob.emailKeywordsChoiceTracked).toBe(true);
  });

  it('counts the tags of a blob from before explicitSettings as chosen', () => {
    // The untouched seven equal the built-in list, so only the marker step makes them chosen.
    const blob: Record<string, unknown> = { emailKeywords: SEVEN, density: 'compact', showSharedMailAccounts: true };
    migrateUntrackedKeywords(blob);
    expect(blob.explicitSettings).toEqual(['density', 'emailKeywords']);
  });

  it('leaves a blob from a build that records tag choices as it is', () => {
    const blob: Record<string, unknown> = { emailKeywords: ADMIN_TAGS, explicitSettings: [], emailKeywordsChoiceTracked: true };
    migrateUntrackedKeywords(blob);
    expect(blob.explicitSettings).toEqual([]);
  });

  it('keeps the tags of an old server copy over the admin default, with or without explicitSettings', async () => {
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    serverFiles['a@example.com'] = { emailKeywords: SEVEN, explicitSettings: [] };
    await signIn('a@example.com');
    expect(settings().emailKeywords).toEqual(SEVEN);
    expect(settings().explicitSettings).toContain('emailKeywords');

    useSettingsStore.getState().disableSync();
    serverFiles['b@example.com'] = { emailKeywords: SEVEN, fontSize: 'large' };
    await signIn('b@example.com');
    expect(settings().emailKeywords).toEqual(SEVEN);
    expect(settings().fontSize).toBe('large');
  });

  it('applies the admin default over a new server copy whose tags were never chosen', async () => {
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    serverFiles['a@example.com'] = { emailKeywords: [], explicitSettings: [], emailKeywordsChoiceTracked: true };
    await signIn('a@example.com');
    expect(settings().emailKeywords).toEqual(ADMIN_TAGS);
  });

  it('keeps the tags of an old export file on import', () => {
    loadPolicy({ defaults: { emailKeywords: ADMIN_TAGS } });
    expect(settings().importSettings(JSON.stringify({ emailKeywords: SEVEN }))).toBe(true);
    expect(settings().emailKeywords).toEqual(SEVEN);
  });
});
