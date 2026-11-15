import { describe, expect, it } from 'vitest';
import {
  METADATA_SETTING_NAMES, UNKNOWN_AGE, nextStamp, planSettingsSync, readRemoteSettings, settingsWrites, shardOf,
  valueKey, type LocalSetting,
} from '@/lib/settings-metadata-sync';

// The vectors below are what the mobile app's src/lib/settings-sync.ts
// computes for the same input: both clients must file a setting in the
// same place, or neither finds the other's.
describe('the format the app writes', () => {
  it('files plain settings in the same shard as the app', () => {
    expect({
      showPreview: shardOf('showPreview'),
      theme: shardOf('theme'),
      dateFormat: shardOf('dateFormat'),
      sendDelaySeconds: shardOf('sendDelaySeconds'),
      firstDayOfWeek: shardOf('firstDayOfWeek'),
      confirmDelete: shardOf('confirmDelete'),
      timeZone: shardOf('timeZone'),
    }).toEqual({
      showPreview: 0, theme: 2, dateFormat: 6, sendDelaySeconds: 3, firstDayOfWeek: 0, confirmDelete: 4, timeZone: 2,
    });
  });

  it('names list entries as the app does', () => {
    expect(valueKey('sidebarApps')).toBe('settings.value.sidebar-apps');
    expect(valueKey('attachmentReminderKeywords')).toBe('settings.value.attachment-reminder-keywords');
  });

  it('writes members of existing shards, whole new shards, and one update per list', () => {
    const writes = settingsWrites([
      { name: 'showPreview', at: 5, value: false, reset: false, ownEntry: false },
      { name: 'theme', at: 6, reset: true, ownEntry: false },
      { name: 'sidebarApps', at: 7, value: [], reset: false, ownEntry: true },
    ], new Set([shardOf('theme')]));
    expect(writes).toEqual({
      shards: [
        { key: 'settings.shard.2', member: 'theme', value: { at: 6 } },
        { key: 'settings.shard.0', value: { showPreview: { v: false, at: 5 } } },
      ],
      values: [
        { name: 'sidebarApps', at: 7, change: { key: 'settings.value.sidebar-apps', value: { k: 'sidebarApps', v: [], at: 7 } } },
      ],
    });
  });

  it('reads shards and list entries, the newer copy of a setting found twice, and skips the rest', () => {
    const remote = readRemoteSettings({
      'settings.shard.0': { showPreview: { v: false, at: 10 }, 'bad name': { v: 1, at: 2 }, firstDayOfWeek: { at: 0 } },
      'settings.shard.01': { showPreview: { v: true, at: 99 } },
      'settings.shard.2': { theme: { at: 20 } },
      'settings.value.sidebar-apps': { k: 'sidebarApps', v: [], at: 30 },
      'settings.value.other': { k: 'showPreview', v: true, at: 5 },
      templates: { whatever: true },
    });
    expect([...remote.shards].sort()).toEqual([0, 2]);
    expect(Object.fromEntries(remote.settings)).toEqual({
      showPreview: { at: 10, hasValue: true, value: false },
      theme: { at: 20, hasValue: false },
      sidebarApps: { at: 30, hasValue: true, value: [] },
    });
  });
});

function local(over: Partial<LocalSetting> & { name: string }): LocalSetting {
  return {
    value: true, defaultValue: true, at: 0, reset: false, chosen: false, locked: false,
    accept: (value) => (typeof value === 'boolean' ? value : undefined),
    ...over,
  };
}

const remoteOf = (entries: Record<string, unknown>) => readRemoteSettings(entries);

describe('planSettingsSync', () => {
  it('takes a newer value from the account and keeps its stamp', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: true, at: 100, chosen: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { v: false, at: 200 } } }),
    );
    expect(plan.take).toEqual({ showPreview: false });
    expect(plan.stamps).toEqual({ showPreview: 200 });
    expect(plan.push).toEqual([]);
  });

  it('sends a newer change made here', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: false, at: 300, chosen: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { v: true, at: 200 } } }),
    );
    expect(plan.take).toEqual({});
    expect(plan.push).toEqual([{ name: 'showPreview', at: 300, reset: false, value: false, ownEntry: false }]);
  });

  it('sends a setting put back to its default here without a value', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: true, at: 300, chosen: false, reset: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { v: false, at: 200 } } }),
    );
    expect(plan.push).toEqual([{ name: 'showPreview', at: 300, reset: true, ownEntry: false }]);
  });

  it('puts a setting back to its default when the account did so later', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: false, at: 100, chosen: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { at: 200 } } }),
    );
    expect(plan.reset).toEqual(['showPreview']);
    expect(plan.stamps).toEqual({ showPreview: 200 });
  });

  it('fills a gap with a value chosen before stamps, at the oldest stamp', () => {
    const plan = planSettingsSync([local({ name: 'showPreview', value: false, chosen: true })], remoteOf({}));
    expect(plan.push).toEqual([{ name: 'showPreview', at: UNKNOWN_AGE, reset: false, value: false, ownEntry: false }]);
    expect(plan.stamps).toEqual({ showPreview: UNKNOWN_AGE });
  });

  it('gives way to the account with a value chosen before stamps, and remembers it', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: false, chosen: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { v: true, at: 50 } } }),
    );
    expect(plan.take).toEqual({ showPreview: true });
    expect(plan.stamps).toEqual({ showPreview: 50 });
    expect(plan.replaced).toEqual({ showPreview: false });
  });

  it('takes a value chosen there that equals the default here, so a policy default cannot replace it', () => {
    const plan = planSettingsSync(
      [local({ name: 'dateFormat', value: 'smart', defaultValue: 'smart', at: 10, chosen: false, reset: true, accept: (v) => v })],
      remoteOf({ 'settings.shard.6': { dateFormat: { v: 'smart', at: 50 } } }),
    );
    expect(plan.take).toEqual({ dateFormat: 'smart' });
    expect(plan.replaced).toEqual({});
  });

  it('neither takes nor overwrites a value it cannot use', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: true, at: 100, chosen: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { v: 'sometimes', at: 200 } } }),
    );
    // Its stamp is noted, so a change made here later beats it.
    expect(plan).toEqual({ take: {}, reset: [], stamps: {}, push: [], replaced: {}, seen: { showPreview: 200 } });
  });

  it('leaves a locked setting alone both ways', () => {
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: false, at: 300, chosen: true, locked: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { v: true, at: 200 } } }),
    );
    expect(plan).toEqual({ take: {}, reset: [], stamps: {}, push: [], replaced: {}, seen: {} });
    const newer = planSettingsSync(
      [local({ name: 'showPreview', value: false, at: 100, chosen: true, locked: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { v: true, at: 200 } } }),
    );
    expect(newer).toEqual({ take: {}, reset: [], stamps: {}, push: [], replaced: {}, seen: { showPreview: 200 } });
  });

  it('keeps a value nobody chose here that it sent up as the default itself', () => {
    // An admin default: sent as "the default" with its stamp, read back the next round.
    const plan = planSettingsSync(
      [local({ name: 'showPreview', value: false, defaultValue: true, at: 700, chosen: false, reset: true })],
      remoteOf({ 'settings.shard.0': { showPreview: { at: 700 } } }),
    );
    expect(plan.reset).toEqual([]);
    expect(plan.push).toEqual([]);
    const unmarked = planSettingsSync(
      [local({ name: 'showPreview', value: false, defaultValue: true, at: 700, chosen: false, reset: false })],
      remoteOf({ 'settings.shard.0': { showPreview: { at: 700 } } }),
    );
    expect(unmarked.reset).toEqual([]);
  });
});

describe('nextStamp', () => {
  it('beats the stamp it replaces even from a clock that runs ahead', () => {
    expect(nextStamp(5000, 1000)).toBe(5001);
    expect(nextStamp(500, 1000)).toBe(1000);
    expect(nextStamp(undefined, 1000)).toBe(1000);
  });
});

describe('METADATA_SETTING_NAMES', () => {
  it('names each setting once, in the shape both clients accept', () => {
    expect(new Set(METADATA_SETTING_NAMES).size).toBe(METADATA_SETTING_NAMES.length);
    for (const name of METADATA_SETTING_NAMES) expect(name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });
});
