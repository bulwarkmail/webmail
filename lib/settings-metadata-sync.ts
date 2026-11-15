/**
 * Settings kept in the private Inbox metadata of the signed-in account
 * (Stalwart 1.0 and later), in the format the mobile app writes, so the app
 * and the webmail have the same settings (bulwarkmail/native#117). The format
 * is set out in the app's docs/settings-sync.md; this file must read and
 * write exactly what the app's src/lib/settings-sync.ts does.
 *
 * Where a setting lives, under its webmail name:
 * - a plain value (boolean, number, string, null) is a member of one of
 *   eight shard entries, `org.bulwarkmail.settings.shard.<0-7>`, picked by a
 *   hash of the name: `{ "<name>": { "v": <value>, "at": <ms> } }`;
 * - a list or a map has an entry of its own,
 *   `org.bulwarkmail.settings.value.<name-in-kebab-case>`:
 *   `{ "k": "<name>", "v": <value>, "at": <ms> }`.
 * `at` is when the setting last changed, on the clock of the device that
 * changed it. Without `v` the setting was put back to its default at `at`.
 * The newest change wins, setting by setting; a list or a map is replaced
 * whole. Plain values are written one member at a time, so two devices that
 * change different settings don't undo each other.
 *
 * Pure: the format and the merge plan. stores/settings-metadata-sync does
 * the rounds and the requests.
 */

import { isValidMetadataKey } from '@/lib/jmap/bulwark-metadata';

export const SHARD_COUNT = 8;
const SHARD_PREFIX = 'settings.shard.';
const VALUE_PREFIX = 'settings.value.';

/**
 * The settings both the webmail and the app have, by webmail name. Only
 * these go into the account's metadata: the webmail's other settings sync
 * between browsers through /api/settings, and the private metadata holds
 * 16 KB in all. A setting the app adds to its sync shows up here once the
 * webmail has it too.
 */
export const METADATA_SETTING_NAMES: readonly string[] = [
  'dateFormat', 'timeFormat', 'includeGroupInUnified', 'externalContentPolicy', 'trustedSendersAddressBook',
  'senderFavicons', 'hideInlineImageAttachments', 'groupContactsByLetter', 'sortContactsByLastName',
  'showContactsDirectory', 'theme', 'fontSize', 'density', 'showToolbarLabels', 'emailAlwaysLightMode', 'appFont',
  'colorBlindPalette', 'autoSelectReplyIdentity', 'replyIdentityMatch', 'attachmentReminderEnabled',
  'attachmentReminderKeywords', 'plainTextMode', 'sendConfirmation', 'confirmDelete', 'confirmArchive',
  'sendDelaySeconds', 'signaturePosition', 'signatureSeparatorEnabled', 'signatureNewMailEnabled',
  'signatureReplyForwardEnabled', 'requestReadReceiptDefault', 'emptySubjectWarningEnabled',
  'placeholderWarningEnabled', 'subAddressDelimiter', 'markAsReadDelay', 'deleteAction', 'permanentlyDeleteJunk',
  'showPreview', 'showVerificationCodes', 'showAttachmentChips', 'emailsPerPage', 'disableThreading',
  'showAvatarsInJunk', 'showFolderTotalCount', 'compactSharedMailboxes', 'clearSearchOnFolderChange',
  'searchDefaultScope', 'unifiedCrossAccount', 'enableCrossUnreadView', 'enableCrossStarredView',
  'enableCrossAllView', 'mailAttachmentAction', 'plainTextFont', 'messageSpacing', 'readReceiptResponse',
  'postExportAction', 'swipeLeftAction', 'swipeRightAction', 'archiveMode', 'firstDayOfWeek', 'showTimeInMonthView',
  'showWeekNumbers', 'calendarMonthTimedEvents', 'calendarFreeScroll', 'calendarHoverPreview', 'timeZone',
  'showBirthdayCalendar', 'enableCalendarTasks', 'showTasksOnCalendar', 'showTasksApp', 'calendarInvitationParsingEnabled',
  'sidebarApps', 'keepAppsLoaded', 'expandedFilterView', 'emailDownloadTemplate', 'attachmentDownloadTemplate',
  'filenameSpaceReplacement', 'filenameLowercase', 'filenameStripDiacritics', 'birthdayCalendarColor',
  'toastDuration', 'quickReplyEnabled', 'calendarTintedEvents', 'recipientMentionsEnabled', 'mentionAddsRecipientTo',
];

/**
 * The stamp of a value chosen before this browser kept stamps: older than
 * any change made since, so it only fills a gap in the account's copy.
 */
export const UNKNOWN_AGE = 1;

/** Setting names both clients write: letters and digits, starting with a letter. */
export function isSettingName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(name) && name.length <= 64;
}

/** The shard a plain setting lives in: FNV-1a (32 bit, over UTF-16 code units) of the name, modulo eight. */
export function shardOf(name: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SHARD_COUNT;
}

export function shardKey(shard: number): string {
  return `${SHARD_PREFIX}${shard}`;
}

/** The entry of a list or map setting: `sidebarApps` is `settings.value.sidebar-apps`. */
export function valueKey(name: string): string {
  return `${VALUE_PREFIX}${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** Whether a setting's values are lists or maps, going by its default. */
export function hasOwnEntry(defaultValue: unknown): boolean {
  return typeof defaultValue === 'object' && defaultValue !== null;
}

/** A setting as the account holds it. */
export interface RemoteSetting {
  at: number;
  /** False when the setting was put back to its default. */
  hasValue: boolean;
  value?: unknown;
}

export interface RemoteSettings {
  settings: Map<string, RemoteSetting>;
  /** The shard entries that exist: only those take a member on its own. */
  shards: Set<number>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readSetting(raw: unknown): RemoteSetting | null {
  if (!isRecord(raw)) return null;
  const at = raw.at;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
  return 'v' in raw ? { at, hasValue: true, value: raw.v } : { at, hasValue: false };
}

/**
 * The settings among an Inbox's Bulwark entries (keys without the
 * `org.bulwarkmail.` prefix). A setting found twice is taken from the newer
 * of the two. Anything that doesn't read as a setting is left alone.
 */
export function readRemoteSettings(entries: Record<string, unknown> | null | undefined): RemoteSettings {
  const settings = new Map<string, RemoteSetting>();
  const shards = new Set<number>();
  const keep = (name: string, setting: RemoteSetting | null) => {
    if (!setting || !isSettingName(name)) return;
    const held = settings.get(name);
    if (!held || setting.at > held.at) settings.set(name, setting);
  };
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (key.startsWith(SHARD_PREFIX)) {
      const digit = key.slice(SHARD_PREFIX.length);
      // "01" or "1e0" would read as shard 1, an entry that doesn't exist.
      if (!/^[0-7]$/.test(digit) || !isRecord(value)) continue;
      shards.add(Number(digit));
      for (const [name, raw] of Object.entries(value)) keep(name, readSetting(raw));
    } else if (key.startsWith(VALUE_PREFIX)) {
      if (isRecord(value) && typeof value.k === 'string') keep(value.k, readSetting(value));
    }
  }
  return { settings, shards };
}

/** Whether two JSON values are the same, whatever order their members come in. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => sameJson(item, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false;
  return keys.every((key) => sameJson(left[key], right[key]));
}

/** A setting as this browser holds it. */
export interface LocalSetting {
  name: string;
  value: unknown;
  defaultValue: unknown;
  /** When it last changed here or was taken from elsewhere; 0 when never. */
  at: number;
  /** Its last change here put it back to the default. */
  reset: boolean;
  /** The user picked the value (it is not just the default). */
  chosen: boolean;
  /** The organisation pins it, or it is not this browser's to share: nothing is taken or sent. */
  locked: boolean;
  /** The value as this browser would store it, or undefined when it can't use it. */
  accept: (value: unknown) => unknown;
}

export interface SettingPush {
  name: string;
  at: number;
  /** Absent for a setting put back to its default. */
  value?: unknown;
  reset: boolean;
  ownEntry: boolean;
}

export interface SettingsSyncPlan {
  /** Values of the account to use here, by name. */
  take: Record<string, unknown>;
  /** Settings to put back to their default here. */
  reset: string[];
  /** The stamps this browser holds after the plan, for the settings it changes them for. */
  stamps: Record<string, number>;
  /** What the account lacks or holds an older value of. */
  push: SettingPush[];
  /** Values of this browser's own choosing that `take` and `reset` replace: it never synced them. */
  replaced: Record<string, unknown>;
  /**
   * Newer stamps of the account that this browser saw but didn't take (a
   * value it can't use, a setting the organisation pins). A change made here
   * later must be stamped after them, or the account's value would win.
   */
  seen: Record<string, number>;
}

/**
 * How this browser's settings and the account's come together. For each
 * setting the newer change wins. A value chosen here before stamps existed
 * fills a gap in the account's copy and otherwise gives way to it. A value
 * this browser can't use (another client's newer choice) is left where it
 * is and never overwritten from here.
 */
export function planSettingsSync(local: LocalSetting[], remote: RemoteSettings): SettingsSyncPlan {
  const plan: SettingsSyncPlan = { take: {}, reset: [], stamps: {}, push: [], replaced: {}, seen: {} };
  for (const setting of local) {
    if (!isSettingName(setting.name)) continue;
    const theirs = remote.settings.get(setting.name);
    if (setting.locked) {
      if (theirs && theirs.at > setting.at) plan.seen[setting.name] = theirs.at;
      continue;
    }
    const ownEntry = hasOwnEntry(setting.defaultValue);
    // Only a chosen value is stored: one that is merely the default here
    // goes up as "the default", so an organisation default can still apply.
    const pushOurs = (at: number) => {
      plan.push.push(setting.reset || !setting.chosen
        ? { name: setting.name, at, reset: true, ownEntry }
        : { name: setting.name, at, reset: false, value: setting.value, ownEntry });
    };
    if (!theirs) {
      if (setting.at > 0) {
        pushOurs(setting.at);
      } else if (setting.chosen) {
        plan.stamps[setting.name] = UNKNOWN_AGE;
        pushOurs(UNKNOWN_AGE);
      }
      continue;
    }
    if (theirs.at < setting.at) {
      pushOurs(setting.at);
      continue;
    }
    // The same stamp with another value: two devices wrote at once. The
    // account holds one of the two, and every device takes that one.
    const tie = theirs.at === setting.at;
    const neverSynced = setting.chosen && (setting.at === 0 || (tie && setting.at === UNKNOWN_AGE));
    if (!theirs.hasValue) {
      // What this browser sent itself: a reset, or a value nobody chose here
      // (an organisation default), which goes up as "the default" too.
      if (tie && (setting.reset || !setting.chosen)) continue;
      if (!sameJson(setting.value, setting.defaultValue) || setting.chosen) {
        plan.reset.push(setting.name);
        if (neverSynced) plan.replaced[setting.name] = setting.value;
      }
      plan.stamps[setting.name] = theirs.at;
      continue;
    }
    const value = setting.accept(theirs.value);
    if (value === undefined) {
      if (!tie) plan.seen[setting.name] = theirs.at;
      continue;
    }
    const same = sameJson(value, setting.value);
    if (tie && same && !setting.reset) continue;
    if (!same) {
      plan.take[setting.name] = value;
      if (neverSynced) plan.replaced[setting.name] = setting.value;
    } else if (!setting.chosen) {
      // The same value, but chosen there: an organisation default must not replace it here either.
      plan.take[setting.name] = value;
    }
    plan.stamps[setting.name] = theirs.at;
  }
  return plan;
}

/**
 * The largest plain value sent, as JSON. The plain settings of a round go
 * in one update, so one overlong text would have the server refuse them all.
 */
export const MAX_PLAIN_VALUE_BYTES = 1024;

/** A stamp for a change made now: later than the one it replaces, even when that came from a fast clock. */
export function nextStamp(previous: number | undefined, now: number): number {
  return Math.max(now, (previous ?? 0) + 1);
}

/** One change of a metadata update: a whole entry, or one member of an entry that exists. */
export interface MetadataChange {
  key: string;
  member?: string;
  /** Null removes the entry or the member. */
  value: unknown;
}

function stored(push: SettingPush): Record<string, unknown> {
  return push.reset ? { at: push.at } : { v: push.value, at: push.at };
}

export interface SettingsWrites {
  /** The plain settings, as one update: members of the shards that exist, whole entries for the others. */
  shards: MetadataChange[];
  /** The lists and maps, one update each, so one too large for the account stops only itself. */
  values: Array<{ name: string; at: number; change: MetadataChange }>;
}

/** The metadata changes that carry `push` to the account. */
export function settingsWrites(push: SettingPush[], existingShards: ReadonlySet<number>): SettingsWrites {
  const shards: MetadataChange[] = [];
  const created = new Map<number, Record<string, unknown>>();
  const values: SettingsWrites['values'] = [];
  for (const item of push) {
    if (item.ownEntry) {
      const key = valueKey(item.name);
      if (!isValidMetadataKey(key)) continue;
      values.push({ name: item.name, at: item.at, change: { key, value: { k: item.name, ...stored(item) } } });
      continue;
    }
    const shard = shardOf(item.name);
    if (existingShards.has(shard)) {
      shards.push({ key: shardKey(shard), member: item.name, value: stored(item) });
    } else {
      const entry = created.get(shard) ?? {};
      entry[item.name] = stored(item);
      created.set(shard, entry);
    }
  }
  for (const [shard, entry] of created) shards.push({ key: shardKey(shard), value: entry });
  return { shards, values };
}
