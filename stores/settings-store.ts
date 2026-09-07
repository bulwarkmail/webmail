import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useThemeStore } from './theme-store';
import { useLocaleStore } from './locale-store';
import type { EmailTemplate } from '@/lib/template-types';
import type { NotificationSoundChoice } from '@/lib/notification-sound';
import { apiFetch } from '@/lib/browser-navigation';
import { generateAccountId } from '@/lib/account-utils';
import { orderForMailbox, sanitizeSortLevels, type MessageListOrderScope, type SortLevel } from '@/lib/message-list-order';
import {
  DEFAULT_SUB_ADDRESS_DELIMITER,
  isValidSubAddressDelimiter,
} from '@/lib/sub-addressing';

// Use console directly to avoid circular dependency with lib/debug.ts
// (debug.ts imports useSettingsStore for debugMode check)
const syncLog = (...args: unknown[]) => console.log('[SETTINGS_SYNC]', ...args);
const syncWarn = (...args: unknown[]) => console.warn('[SETTINGS_SYNC]', ...args);
const syncError = (...args: unknown[]) => console.error('[SETTINGS_SYNC]', ...args);

/** True for a non-null, non-array plain object (the allMailFolderIds map shape). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Settings sync state (module-level, not persisted)
let syncEnabled = false;
let syncUsername: string | null = null;
let syncServerUrl: string | null = null;
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSync: SettingsSyncJob | null = null;
let isLoadingFromServer = false;

const SYNC_DEBOUNCE_MS = 2000;

interface SettingsSyncJob {
  username: string;
  serverUrl: string;
  settings: Record<string, unknown>;
}

// --- Template sync bridge ---------------------------------------------------
// Templates ride along in the synced settings blob (#825), but template-store
// cannot be imported statically from here: it reaches this module through
// lib/utils -> lib/debug, and the resulting import cycle leaves one side's
// bindings uninitialized depending on which module loads first. Instead,
// template-store registers itself here during its own module init.
interface TemplateSyncBridge {
  getSyncedState: () => {
    templates: EmailTemplate[];
    deletedTemplateIds: Record<string, string>;
  };
  applySyncedState: (
    templates: unknown,
    deletedTemplateIds: unknown,
    opts: { merge: boolean }
  ) => void;
}

let templateSyncBridge: TemplateSyncBridge | null = null;
// Wired up in the window-only init block below; null during SSR.
let onTemplateStoreChange: (() => void) | null = null;

export function registerTemplateSyncBridge(
  bridge: TemplateSyncBridge,
  subscribe: (listener: () => void) => void
): void {
  templateSyncBridge = bridge;
  subscribe(() => onTemplateStoreChange?.());
}

async function syncSettingsJob(job: SettingsSyncJob, retries = 1): Promise<void> {
  syncLog('Syncing settings to server for', job.username);
  const res = await apiFetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  if (res.status === 404) {
    syncWarn('Settings sync endpoint returned 404, disabling sync');
    syncEnabled = false;
  } else if (res.status === 403) {
    syncWarn('Settings sync rejected (identity mismatch), disabling sync');
    syncEnabled = false;
  } else if (res.status >= 500 && retries > 0) {
    const body = await res.json().catch(() => ({}));
    syncWarn('Settings sync got server error:', body.error || `status ${res.status}`, '- retrying...');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return syncSettingsJob(job, retries - 1);
  } else if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    syncError('Settings sync failed:', body.error || `status ${res.status}`);
  } else {
    syncLog('Settings synced to server successfully');
  }
}

export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';
/** @deprecated Use Density instead */
export type ListDensity = Density;
export type DeleteAction = 'trash' | 'trash-and-read' | 'permanent';
export type ReplyMode = 'reply' | 'replyAll';
export type SignaturePosition = 'above_quote' | 'below_quote';
/** How to handle an incoming Disposition-Notification-To (read-receipt) request. */
export type ReadReceiptResponse = 'ask' | 'always' | 'never';
export type DateFormat = 'smart' | 'relative' | 'full';
/**
 * Regional ordering of numeric dates, independent of the `DateFormat` style.
 *   - `auto`  — follow the UI language (today's behaviour).
 *   - `iso`   — ISO 8601, `YYYY-MM-DD`.
 *   - `en-GB` — Day/Month/Year (`DD/MM/YYYY`).
 *   - `en-US` — Month/Day/Year (`MM/DD/YYYY`).
 */
export type DateLocale = 'auto' | 'iso' | 'en-GB' | 'en-US';
export type TimeFormat = '12h' | '24h';
export type FirstDayOfWeek = 0 | 1 | 6; // 0 = Sunday, 1 = Monday, 6 = Saturday
/** IANA zone id that overrides the browser's, or 'auto' to follow the browser (#755). */
export type TimeZoneSetting = 'auto' | (string & {});
export type ExternalContentPolicy = 'ask' | 'block' | 'allow';
export type MailAttachmentAction = 'preview' | 'download';
export type AttachmentPosition = 'beside-sender' | 'below-header';
export type ToolbarPosition = 'top' | 'below-subject';
export type ArchiveMode = 'single' | 'year' | 'month';
export type MailLayout = 'split' | 'focus' | 'horizontal';

/**
 * Spacing around a message body in the reader.
 * - 'auto'  : add a gutter unless the email paints its own full-bleed background
 * - 'always': always add the gutter
 * - 'edge'  : never add one (render edge-to-edge)
 */
export type MessageSpacing = 'auto' | 'always' | 'edge';

/** Font used to render text/plain email bodies. */
export type PlainTextFont = 'mono' | 'sans';

/**
 * Default font family for the rich-text composer. Web-safe stacks only (no
 * web-font loading); 'default' leaves the family unset. Mapped to CSS in
 * components/email/compose-typography.ts. When replying to a styled draft the
 * draft's own family wins (so edits stay invisible); this setting supplies the
 * family for a fresh message.
 */
export type ComposeFontFamily =
  | 'default'
  | 'sans'
  | 'serif-georgia'
  | 'serif-times'
  | 'verdana'
  | 'trebuchet'
  | 'monospace';

/**
 * Default text size for the rich-text composer, as a tier mapped to px in
 * compose-typography.ts. 'default' leaves the size unset. Like ComposeFontFamily
 * it yields to a styled draft's own size when replying.
 */
export type ComposeFontSize = 'default' | 'small' | 'normal' | 'medium' | 'large' | 'x-large';

const COMPOSE_FONT_FAMILIES: ComposeFontFamily[] = [
  'default', 'sans', 'serif-georgia', 'serif-times', 'verdana', 'trebuchet', 'monospace',
];
const COMPOSE_FONT_SIZES: ComposeFontSize[] = ['default', 'small', 'normal', 'medium', 'large', 'x-large'];

/** A validated hex colour (`#rgb`/`#rrggbb`), or '' for unset. Non-hex input is coerced to ''. */
export function normalizeComposeColor(v: unknown): string {
  return typeof v === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim()) ? v.trim() : '';
}
export type CalendarHoverPreview = 'off' | 'instant' | 'delay-500ms' | 'delay-1s' | 'delay-2s';
export type SendDelaySeconds = 0 | 10 | 30 | 60;
export type ProtocolOpenMode = 'active-session' | 'new-tab';

/**
 * Settings that must never round-trip through the cross-device sync API.
 * Decided per device and kept only in the local zustand-persist storage -
 * a value already stored on the server (from a prior build) is ignored on
 * import.
 */
const DEVICE_LOCAL_SETTING_KEYS = new Set<string>(['proInterface']);

export type HoverAction = 'delete' | 'star' | 'markRead' | 'archive' | 'tag' | 'spam';
/** Action fired by a mobile list-row swipe. 'none' disables that direction. */
export type SwipeAction = 'none' | 'archive' | 'delete' | 'markRead' | 'star' | 'spam';
export type HoverActionsMode = 'inline' | 'floating';
export type HoverActionsCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export const ALL_HOVER_ACTIONS: { id: HoverAction; labelKey: string }[] = [
  { id: 'delete', labelKey: 'delete' },
  { id: 'star', labelKey: 'star' },
  { id: 'markRead', labelKey: 'mark_read' },
  { id: 'archive', labelKey: 'archive' },
  { id: 'tag', labelKey: 'tag' },
  { id: 'spam', labelKey: 'spam' },
];

export type DebugCategory = 'jmap' | 'calendar' | 'tasks' | 'auth' | 'filters' | 'email' | 'push' | 'contacts';

export const ALL_DEBUG_CATEGORIES: { id: DebugCategory; labelKey: string }[] = [
  { id: 'jmap', labelKey: 'jmap' },
  { id: 'calendar', labelKey: 'calendar' },
  { id: 'tasks', labelKey: 'tasks' },
  { id: 'auth', labelKey: 'auth' },
  { id: 'filters', labelKey: 'filters' },
  { id: 'email', labelKey: 'email' },
  { id: 'push', labelKey: 'push' },
  { id: 'contacts', labelKey: 'contacts' },
];

/** Whether a tag shows in the sidebar always, only when it has unread mail, or never. */
export type KeywordVisibility = 'show' | 'hide' | 'unread';

export interface KeywordDefinition {
  id: string;     // Used as JMAP keyword suffix: $label:<id>
  label: string;  // Display name
  color: string;  // Key from KEYWORD_PALETTE
  visibility?: KeywordVisibility; // Absent on tags stored before this was configurable
}

/** Resolves the sidebar visibility of a tag, defaulting to always shown. */
export function getKeywordVisibility(keyword: KeywordDefinition): KeywordVisibility {
  return keyword.visibility ?? 'show';
}

export interface SidebarApp {
  id: string;
  name: string;
  url: string;
  icon: string;       // Lucide icon name (e.g. 'Globe', 'Rss')
  openMode: 'tab' | 'inline'; // Open in new tab or embed inline
  showOnMobile: boolean;
}

export interface KeywordColor {
  /** Solid swatch: the dot form and the settings swatches. */
  dot: string;
  /** The same solid colour as `dot`, for glyphs that take a text colour. */
  icon: string;
  /** Lozenge background. */
  fill: string;
  /** Lozenge border. */
  border: string;
  /** Lozenge text. */
  text: string;
  /** Full-row wash when `tintListRowsByTag` is on. */
  rowTint: string;
}

/**
 * Tag colours, written out literally.
 *
 * Tailwind v4 scans this file, but only for classes that appear verbatim -
 * a composed `bg-${hue}-500` would compile to nothing. Every shade a tag can
 * take therefore has to be spelled out, which is why this map is long.
 *
 * Three shades per hue: the middle one keeps the bare hue name, so a tag
 * saved before the lighter and darker rows existed still resolves.
 */
export const KEYWORD_PALETTE: Record<string, KeywordColor> = {
  // light
  'red-light': { dot: 'bg-red-300', icon: 'text-red-300', fill: 'bg-red-300/10', border: 'border-red-300/30', text: 'text-red-600 dark:text-red-200', rowTint: 'bg-red-50/60 dark:bg-red-950/20' },
  'orange-light': { dot: 'bg-orange-300', icon: 'text-orange-300', fill: 'bg-orange-300/10', border: 'border-orange-300/30', text: 'text-orange-600 dark:text-orange-200', rowTint: 'bg-orange-50/60 dark:bg-orange-950/20' },
  'amber-light': { dot: 'bg-amber-300', icon: 'text-amber-300', fill: 'bg-amber-300/10', border: 'border-amber-300/30', text: 'text-amber-600 dark:text-amber-200', rowTint: 'bg-amber-50/60 dark:bg-amber-950/20' },
  'yellow-light': { dot: 'bg-yellow-300', icon: 'text-yellow-300', fill: 'bg-yellow-300/10', border: 'border-yellow-300/30', text: 'text-yellow-600 dark:text-yellow-200', rowTint: 'bg-yellow-50/60 dark:bg-yellow-950/20' },
  'lime-light': { dot: 'bg-lime-300', icon: 'text-lime-300', fill: 'bg-lime-300/10', border: 'border-lime-300/30', text: 'text-lime-600 dark:text-lime-200', rowTint: 'bg-lime-50/60 dark:bg-lime-950/20' },
  'green-light': { dot: 'bg-green-300', icon: 'text-green-300', fill: 'bg-green-300/10', border: 'border-green-300/30', text: 'text-green-600 dark:text-green-200', rowTint: 'bg-green-50/60 dark:bg-green-950/20' },
  'teal-light': { dot: 'bg-teal-300', icon: 'text-teal-300', fill: 'bg-teal-300/10', border: 'border-teal-300/30', text: 'text-teal-600 dark:text-teal-200', rowTint: 'bg-teal-50/60 dark:bg-teal-950/20' },
  'cyan-light': { dot: 'bg-cyan-300', icon: 'text-cyan-300', fill: 'bg-cyan-300/10', border: 'border-cyan-300/30', text: 'text-cyan-600 dark:text-cyan-200', rowTint: 'bg-cyan-50/60 dark:bg-cyan-950/20' },
  'blue-light': { dot: 'bg-blue-300', icon: 'text-blue-300', fill: 'bg-blue-300/10', border: 'border-blue-300/30', text: 'text-blue-600 dark:text-blue-200', rowTint: 'bg-blue-50/60 dark:bg-blue-950/20' },
  'indigo-light': { dot: 'bg-indigo-300', icon: 'text-indigo-300', fill: 'bg-indigo-300/10', border: 'border-indigo-300/30', text: 'text-indigo-600 dark:text-indigo-200', rowTint: 'bg-indigo-50/60 dark:bg-indigo-950/20' },
  'purple-light': { dot: 'bg-purple-300', icon: 'text-purple-300', fill: 'bg-purple-300/10', border: 'border-purple-300/30', text: 'text-purple-600 dark:text-purple-200', rowTint: 'bg-purple-50/60 dark:bg-purple-950/20' },
  'pink-light': { dot: 'bg-pink-300', icon: 'text-pink-300', fill: 'bg-pink-300/10', border: 'border-pink-300/30', text: 'text-pink-600 dark:text-pink-200', rowTint: 'bg-pink-50/60 dark:bg-pink-950/20' },
  'gray-light': { dot: 'bg-gray-300', icon: 'text-gray-300', fill: 'bg-gray-300/10', border: 'border-gray-300/30', text: 'text-gray-600 dark:text-gray-200', rowTint: 'bg-gray-50/60 dark:bg-gray-950/20' },
  // base
  red: { dot: 'bg-red-500', icon: 'text-red-500', fill: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-700 dark:text-red-300', rowTint: 'bg-red-50 dark:bg-red-950/30' },
  orange: { dot: 'bg-orange-500', icon: 'text-orange-500', fill: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-700 dark:text-orange-300', rowTint: 'bg-orange-50 dark:bg-orange-950/30' },
  amber: { dot: 'bg-amber-500', icon: 'text-amber-500', fill: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-700 dark:text-amber-300', rowTint: 'bg-amber-50 dark:bg-amber-950/30' },
  yellow: { dot: 'bg-yellow-500', icon: 'text-yellow-500', fill: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-700 dark:text-yellow-300', rowTint: 'bg-yellow-50 dark:bg-yellow-950/30' },
  lime: { dot: 'bg-lime-500', icon: 'text-lime-500', fill: 'bg-lime-500/10', border: 'border-lime-500/30', text: 'text-lime-700 dark:text-lime-300', rowTint: 'bg-lime-50 dark:bg-lime-950/30' },
  green: { dot: 'bg-green-500', icon: 'text-green-500', fill: 'bg-green-500/10', border: 'border-green-500/30', text: 'text-green-700 dark:text-green-300', rowTint: 'bg-green-50 dark:bg-green-950/30' },
  teal: { dot: 'bg-teal-500', icon: 'text-teal-500', fill: 'bg-teal-500/10', border: 'border-teal-500/30', text: 'text-teal-700 dark:text-teal-300', rowTint: 'bg-teal-50 dark:bg-teal-950/30' },
  cyan: { dot: 'bg-cyan-500', icon: 'text-cyan-500', fill: 'bg-cyan-500/10', border: 'border-cyan-500/30', text: 'text-cyan-700 dark:text-cyan-300', rowTint: 'bg-cyan-50 dark:bg-cyan-950/30' },
  blue: { dot: 'bg-blue-500', icon: 'text-blue-500', fill: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-700 dark:text-blue-300', rowTint: 'bg-blue-50 dark:bg-blue-950/30' },
  indigo: { dot: 'bg-indigo-500', icon: 'text-indigo-500', fill: 'bg-indigo-500/10', border: 'border-indigo-500/30', text: 'text-indigo-700 dark:text-indigo-300', rowTint: 'bg-indigo-50 dark:bg-indigo-950/30' },
  purple: { dot: 'bg-purple-500', icon: 'text-purple-500', fill: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-700 dark:text-purple-300', rowTint: 'bg-purple-50 dark:bg-purple-950/30' },
  pink: { dot: 'bg-pink-500', icon: 'text-pink-500', fill: 'bg-pink-500/10', border: 'border-pink-500/30', text: 'text-pink-700 dark:text-pink-300', rowTint: 'bg-pink-50 dark:bg-pink-950/30' },
  gray: { dot: 'bg-gray-500', icon: 'text-gray-500', fill: 'bg-gray-500/10', border: 'border-gray-500/30', text: 'text-gray-700 dark:text-gray-300', rowTint: 'bg-gray-50 dark:bg-gray-950/30' },
  // dark
  'red-dark': { dot: 'bg-red-700', icon: 'text-red-700', fill: 'bg-red-700/10', border: 'border-red-700/30', text: 'text-red-800 dark:text-red-400', rowTint: 'bg-red-100 dark:bg-red-950/50' },
  'orange-dark': { dot: 'bg-orange-700', icon: 'text-orange-700', fill: 'bg-orange-700/10', border: 'border-orange-700/30', text: 'text-orange-800 dark:text-orange-400', rowTint: 'bg-orange-100 dark:bg-orange-950/50' },
  'amber-dark': { dot: 'bg-amber-700', icon: 'text-amber-700', fill: 'bg-amber-700/10', border: 'border-amber-700/30', text: 'text-amber-800 dark:text-amber-400', rowTint: 'bg-amber-100 dark:bg-amber-950/50' },
  'yellow-dark': { dot: 'bg-yellow-700', icon: 'text-yellow-700', fill: 'bg-yellow-700/10', border: 'border-yellow-700/30', text: 'text-yellow-800 dark:text-yellow-400', rowTint: 'bg-yellow-100 dark:bg-yellow-950/50' },
  'lime-dark': { dot: 'bg-lime-700', icon: 'text-lime-700', fill: 'bg-lime-700/10', border: 'border-lime-700/30', text: 'text-lime-800 dark:text-lime-400', rowTint: 'bg-lime-100 dark:bg-lime-950/50' },
  'green-dark': { dot: 'bg-green-700', icon: 'text-green-700', fill: 'bg-green-700/10', border: 'border-green-700/30', text: 'text-green-800 dark:text-green-400', rowTint: 'bg-green-100 dark:bg-green-950/50' },
  'teal-dark': { dot: 'bg-teal-700', icon: 'text-teal-700', fill: 'bg-teal-700/10', border: 'border-teal-700/30', text: 'text-teal-800 dark:text-teal-400', rowTint: 'bg-teal-100 dark:bg-teal-950/50' },
  'cyan-dark': { dot: 'bg-cyan-700', icon: 'text-cyan-700', fill: 'bg-cyan-700/10', border: 'border-cyan-700/30', text: 'text-cyan-800 dark:text-cyan-400', rowTint: 'bg-cyan-100 dark:bg-cyan-950/50' },
  'blue-dark': { dot: 'bg-blue-700', icon: 'text-blue-700', fill: 'bg-blue-700/10', border: 'border-blue-700/30', text: 'text-blue-800 dark:text-blue-400', rowTint: 'bg-blue-100 dark:bg-blue-950/50' },
  'indigo-dark': { dot: 'bg-indigo-700', icon: 'text-indigo-700', fill: 'bg-indigo-700/10', border: 'border-indigo-700/30', text: 'text-indigo-800 dark:text-indigo-400', rowTint: 'bg-indigo-100 dark:bg-indigo-950/50' },
  'purple-dark': { dot: 'bg-purple-700', icon: 'text-purple-700', fill: 'bg-purple-700/10', border: 'border-purple-700/30', text: 'text-purple-800 dark:text-purple-400', rowTint: 'bg-purple-100 dark:bg-purple-950/50' },
  'pink-dark': { dot: 'bg-pink-700', icon: 'text-pink-700', fill: 'bg-pink-700/10', border: 'border-pink-700/30', text: 'text-pink-800 dark:text-pink-400', rowTint: 'bg-pink-100 dark:bg-pink-950/50' },
  'gray-dark': { dot: 'bg-gray-700', icon: 'text-gray-700', fill: 'bg-gray-700/10', border: 'border-gray-700/30', text: 'text-gray-800 dark:text-gray-400', rowTint: 'bg-gray-100 dark:bg-gray-950/50' },
} as const;

/** Palette laid out as the settings picker shows it: lighter, base, darker. */
export const KEYWORD_PALETTE_ROWS: string[][] = [
  ['red-light', 'orange-light', 'amber-light', 'yellow-light', 'lime-light', 'green-light', 'teal-light', 'cyan-light', 'blue-light', 'indigo-light', 'purple-light', 'pink-light', 'gray-light'],
  ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'teal', 'cyan', 'blue', 'indigo', 'purple', 'pink', 'gray'],
  ['red-dark', 'orange-dark', 'amber-dark', 'yellow-dark', 'lime-dark', 'green-dark', 'teal-dark', 'cyan-dark', 'blue-dark', 'indigo-dark', 'purple-dark', 'pink-dark', 'gray-dark'],
];

/** The colour a tag falls back to when its definition is gone. */
export const FALLBACK_KEYWORD_COLOR = 'gray';

export const DEFAULT_KEYWORDS: KeywordDefinition[] = [
  { id: 'red', label: 'Red', color: 'red' },
  { id: 'orange', label: 'Orange', color: 'orange' },
  { id: 'yellow', label: 'Yellow', color: 'yellow' },
  { id: 'green', label: 'Green', color: 'green' },
  { id: 'blue', label: 'Blue', color: 'blue' },
  { id: 'purple', label: 'Purple', color: 'purple' },
  { id: 'pink', label: 'Pink', color: 'pink' },
];

export const DEV_KEYWORDS: KeywordDefinition[] = [
  { id: 'work', label: 'Work', color: 'blue' },
  { id: 'work/clients', label: 'Clients', color: 'teal' },
  { id: 'work/clients/acme', label: 'Acme', color: 'green' },
  { id: 'personal', label: 'Personal', color: 'purple' },
  { id: 'personal/finance', label: 'Finance', color: 'amber' },
  { id: 'receipts', label: 'Receipts', color: 'gray' },
];

const USING_MOCK_SERVER = process.env.NEXT_PUBLIC_DEV_MOCK_JMAP === 'true';

interface SettingsState {
  // Appearance
  fontSize: FontSize;
  density: Density;
  animationsEnabled: boolean;
  // Message-list ordering (#718): prioritised sort levels mapped onto the JMAP
  // Email/query sort; empty = chronological. Scope: Inbox only or every folder.
  messageListOrder: SortLevel[];
  messageListOrderScope: MessageListOrderScope;

  // Language & Region
  dateFormat: DateFormat;
  dateLocale: DateLocale;
  timeFormat: TimeFormat;
  firstDayOfWeek: FirstDayOfWeek;
  timeZone: TimeZoneSetting;

  // Email Behavior
  markAsReadDelay: number; // milliseconds (0 = instant, -1 = never)
  deleteAction: DeleteAction;
  permanentlyDeleteJunk: boolean; // Permanently delete emails from junk/spam instead of moving to trash
  returnToListAfterAction: boolean; // After delete / mark-unread in an open message, return to the list instead of opening the next message
  clearSearchOnFolderChange: boolean; // Reset the search query + advanced filters when switching folders, instead of re-running the search in the newly selected folder (#553 keeps it applied when this is off)
  showPreview: boolean;
  mailLayout: MailLayout;
  emailsPerPage: number;
  externalContentPolicy: ExternalContentPolicy;
  messageSpacing: MessageSpacing; // Gutter around the message body in the reader
  plainTextFont: PlainTextFont; // Font for text/plain email bodies in the reader
  mailAttachmentAction: MailAttachmentAction;
  attachmentPosition: AttachmentPosition;
  emailAlwaysLightMode: boolean; // Always render email content in light mode
  archiveMode: ArchiveMode; // How to organize archived emails: single folder, by year, or by year+month
  hoverActions: HoverAction[]; // Quick actions shown on hover in mail list
  hoverActionsMode: HoverActionsMode; // Display mode: inline (current) or floating corner
  hoverActionsCorner: HoverActionsCorner; // Corner for floating mode
  swipeRightAction: SwipeAction; // Mobile: action when a list row is swiped right
  swipeLeftAction: SwipeAction; // Mobile: action when a list row is swiped left

  // Composer
  autoSaveDraftInterval: number; // milliseconds
  sendConfirmation: boolean;
  defaultReplyMode: ReplyMode;
  autoSelectReplyIdentity: boolean;
  plainTextMode: boolean; // Send plain text only (no rich text editor)
  composeFontFamily: ComposeFontFamily; // Default composer font family (yields to a styled reply draft)
  composeFontSize: ComposeFontSize; // Default composer text size (yields to a styled reply draft)
  composeTextColor: string; // Default composer text colour as hex ('' = unset; yields to a styled reply draft)
  rtlEditingSupport: boolean; // Show a per-paragraph LTR/RTL direction control in the composer (Gmail-style)
  subAddressDelimiter: string; // Character separating user from tag (e.g. "user+tag@")
  sendDelaySeconds: SendDelaySeconds;
  signaturePosition: SignaturePosition; // Position of the signature relative to quoted text in replies/forwards
  signatureSeparatorEnabled: boolean; // Prefix the signature with the RFC 3676 "-- " delimiter
  requestReadReceiptDefault: boolean; // Pre-check "request read receipt" in the composer
  readReceiptResponse: ReadReceiptResponse; // How to respond to incoming read-receipt requests

  // Privacy & Security
  sessionTimeout: number; // minutes (0 = never)
  trustedSenders: string[]; // Email addresses that can load external content
  // Store trusted senders in a dedicated JMAP address book so they sync across
  // devices. `null` means "not yet decided": resolved on first connect to
  // `true` when the server supports contacts, otherwise left off. Once the user
  // toggles it, it holds a concrete boolean and is never auto-changed again.
  trustedSendersAddressBook: boolean | null;

  // Filters
  expandedFilterView: boolean;

  // Calendar
  showTimeInMonthView: boolean;
  showWeekNumbers: boolean;
  calendarHoverPreview: CalendarHoverPreview;

  // Calendar Tasks
  enableCalendarTasks: boolean;
  showTasksOnCalendar: boolean;

  // Contact Birthday Calendar
  showBirthdayCalendar: boolean;
  birthdayCalendarColor: string;

  // Per-viewer color overrides for shared calendars, keyed by
  // sharedCalendarColorKey(). Lets each recipient recolor calendars shared
  // with them without changing the owner's color (see #345).
  sharedCalendarColors: Record<string, string>;

  // Contacts Display
  groupContactsByLetter: boolean;

  // Email Notifications
  emailNotificationsEnabled: boolean;
  emailNotificationSound: boolean;
  notificationSoundChoice: NotificationSoundChoice;
  /** Chosen Web Push relay URL. Empty = the admin-configured default. */
  pushRelayUrl: string;

  // Protocol Handlers
  protocolOpenMode: ProtocolOpenMode;

  // Calendar Notifications
  calendarNotificationsEnabled: boolean;
  calendarNotificationSound: boolean;
  calendarInvitationParsingEnabled: boolean;

  // Layout
  toolbarPosition: ToolbarPosition;
  showToolbarLabels: boolean;
  hideAccountSwitcher: boolean;
  showRailAccountList: boolean;
  proInterface: boolean;

  // Unified Mailbox
  enableUnifiedMailbox: boolean;
  // Include shared/delegated folders in the unified mailbox. Default true: the
  // account-bounded unified view is defined by spanning the account's own folders
  // plus every shared folder it can access.
  includeGroupInUnified: boolean;
  // When true, the unified mailbox merges across every logged-in account
  // (cross-account). When false (default for new installs) it stays within the
  // active account boundary (own + shared folders). Gated by the admin
  // `unifiedCrossAccountEnabled` feature.
  unifiedCrossAccount: boolean;

  // Unified Mailbox entries, each gated per-view by the admin policy. These show
  // the All mail / Unread / Starred lists, scoped by `unifiedCrossAccount` and
  // narrowed by the `allMailFolderIds` folder selection.
  enableCrossUnreadView: boolean;
  enableCrossStarredView: boolean;
  enableCrossAllView: boolean;

  // Per-account folder selection narrowing the unified All mail / Unread /
  // Starred lists, keyed by AccountEntry.id. A missing entry = "not configured"
  // -> defaults to inbox + custom folders; an explicit [] = "no own folders".
  allMailFolderIds: Record<string, string[]>;

  // Per-account default sender identity, keyed by AccountEntry.id -> JMAP
  // Identity id. Synced (and exported) so the chosen default survives clearing
  // site data and follows the user across browsers/devices (issue #507). Kept
  // per account because JMAP identity ids are account-scoped and would collide.
  preferredIdentityIds: Record<string, string>;

  // Email Display
  disableThreading: boolean; // Show emails as individual messages instead of grouped by conversation

  senderFavicons: boolean;
  showAvatarsInJunk: boolean; // Show profile images/favicons in the junk folder
  faviconUnreadBadge: boolean; // Badge the browser-tab icon with the inbox unread count

  // Sidebar
  colorfulSidebarIcons: boolean; // Tint folder icons by role (inbox blue, junk red, etc.)
  tintListRowsByTag: boolean; // Tint mail-list rows by the first tag color
  showFolderTotalCount: boolean; // Show total message count next to folders/tags (alongside unread)

  // Folders
  folderIcons: Record<string, string>; // mailboxId -> icon name

  // Keywords (labels/tags)
  emailKeywords: KeywordDefinition[];
  nestedTags: boolean; // Treat "/" in a tag id as a parent/child separator

  // Attachment Reminder
  attachmentReminderEnabled: boolean;
  attachmentReminderKeywords: string[];

  // Ask for confirmation when sending a message with an empty subject
  emptySubjectWarningEnabled: boolean;

  // Hide inline images (images referenced by cid in the HTML body) from the
  // attachment list shown above the message body.
  hideInlineImageAttachments: boolean;

  // Render image attachments as thumbnail cards (preview the actual image
  // contents inside the chip) instead of generic file icons.
  attachmentImagePreviewsEnabled: boolean;

  // Sidebar Apps
  sidebarApps: SidebarApp[];
  keepAppsLoaded: boolean;

  // Onboarding
  onboardingCompleted: boolean; // Welcome banner dismissed
  tourCompleted: boolean; // Interactive tour completed
  showOnboardingOnNewDevices: boolean; // When true, onboarding shows again on each new device

  // Downloads
  emailDownloadTemplate: string;
  attachmentDownloadTemplate: string;
  bundleDownloadTemplate: string;
  filenameSpaceReplacement: 'keep' | 'underscore' | 'dash';
  filenameLowercase: boolean;
  filenameStripDiacritics: boolean;
  filenameCollapseSeparators: boolean;
  postExportAction: 'keep' | 'archive' | 'trash';

  // Advanced
  debugMode: boolean;
  debugCategories: Record<DebugCategory, boolean>;
  settingsSyncDisabled: boolean;

  // Actions
  updateSetting: <K extends keyof SettingsState>(
    key: K,
    value: SettingsState[K]
  ) => void;
  resetToDefaults: () => void;
  exportSettings: () => string;
  importSettings: (json: string, opts?: { serverAccountId?: string }) => boolean;

  // Folder icons
  setFolderIcon: (mailboxId: string, icon: string) => void;
  removeFolderIcon: (mailboxId: string) => void;

  // Shared-calendar color overrides
  setSharedCalendarColor: (key: string, color: string) => void;
  removeSharedCalendarColor: (key: string) => void;

  // Trusted senders
  addTrustedSender: (email: string) => void;
  removeTrustedSender: (email: string) => void;
  isSenderTrusted: (email: string) => boolean;

  // Keywords
  addKeyword: (keyword: KeywordDefinition) => void;
  updateKeyword: (id: string, updates: Partial<Omit<KeywordDefinition, 'id'>>) => void;
  renameKeyword: (oldId: string, newKeyword: KeywordDefinition) => void;
  removeKeyword: (id: string) => void;
  reorderKeywords: (keywords: KeywordDefinition[]) => void;
  getKeywordById: (id: string) => KeywordDefinition | undefined;

  // Sidebar Apps
  addSidebarApp: (app: SidebarApp) => void;
  updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => void;
  removeSidebarApp: (id: string) => void;
  reorderSidebarApps: (apps: SidebarApp[]) => void;

  // Settings sync
  enableSync: (username: string, serverUrl: string) => void;
  flushSync: () => Promise<void>;
  disableSync: () => void;
  loadFromServer: (username: string, serverUrl: string) => Promise<boolean>;
}

const DEFAULT_SETTINGS = {
  // Appearance
  fontSize: 'medium' as FontSize,
  density: 'regular' as Density,
  animationsEnabled: true,
  messageListOrder: [] as SortLevel[],
  messageListOrderScope: 'inbox' as MessageListOrderScope,

  // Language & Region
  dateFormat: 'smart' as DateFormat,
  dateLocale: 'auto' as DateLocale,
  timeFormat: '24h' as TimeFormat,
  firstDayOfWeek: 1 as FirstDayOfWeek, // Monday
  timeZone: 'auto' as TimeZoneSetting,

  // Email Behavior
  markAsReadDelay: 0, // Instant
  deleteAction: 'trash' as DeleteAction,
  permanentlyDeleteJunk: false,
  returnToListAfterAction: true,
  clearSearchOnFolderChange: false,
  showPreview: true,
  mailLayout: 'split' as MailLayout,
  emailsPerPage: 50,
  externalContentPolicy: 'ask' as ExternalContentPolicy,
  messageSpacing: 'auto' as MessageSpacing,
  plainTextFont: 'sans' as PlainTextFont,
  mailAttachmentAction: 'preview' as MailAttachmentAction,
  attachmentPosition: 'beside-sender' as AttachmentPosition,
  emailAlwaysLightMode: false,
  archiveMode: 'single' as ArchiveMode,
  hoverActions: ['delete', 'star', 'markRead', 'archive'] as HoverAction[],
  hoverActionsMode: 'inline' as HoverActionsMode,
  hoverActionsCorner: 'top-right' as HoverActionsCorner,
  swipeRightAction: 'archive' as SwipeAction,
  swipeLeftAction: 'delete' as SwipeAction,

  // Composer
  autoSaveDraftInterval: 60000, // 1 minute
  sendConfirmation: false,
  defaultReplyMode: 'reply' as ReplyMode,
  autoSelectReplyIdentity: false,
  plainTextMode: false,
  composeFontFamily: 'default' as ComposeFontFamily,
  composeFontSize: 'default' as ComposeFontSize,
  composeTextColor: '',
  rtlEditingSupport: false,
  subAddressDelimiter: DEFAULT_SUB_ADDRESS_DELIMITER,
  sendDelaySeconds: 0 as SendDelaySeconds,
  signaturePosition: 'below_quote' as SignaturePosition,
  signatureSeparatorEnabled: true,
  requestReadReceiptDefault: false,
  readReceiptResponse: 'ask' as ReadReceiptResponse,

  // Privacy & Security
  sessionTimeout: 0, // Never
  trustedSenders: [] as string[],
  trustedSendersAddressBook: null as boolean | null,

  // Filters
  expandedFilterView: false,

  // Calendar
  showTimeInMonthView: false,
  showWeekNumbers: false,
  calendarHoverPreview: 'delay-500ms' as CalendarHoverPreview,

  // Calendar Tasks
  enableCalendarTasks: false,
  showTasksOnCalendar: true,

  // Contact Birthday Calendar
  showBirthdayCalendar: false,
  birthdayCalendarColor: '#eab308',

  sharedCalendarColors: {} as Record<string, string>,

  // Contacts Display
  groupContactsByLetter: true,

  // Email Notifications
  emailNotificationsEnabled: true,
  emailNotificationSound: true,
  notificationSoundChoice: 'default' as NotificationSoundChoice,
  pushRelayUrl: '',

  // Protocol Handlers
  protocolOpenMode: 'new-tab' as ProtocolOpenMode,

  // Calendar Notifications
  calendarNotificationsEnabled: true,
  calendarNotificationSound: true,
  calendarInvitationParsingEnabled: true,

  // Layout
  toolbarPosition: 'top' as ToolbarPosition,
  showToolbarLabels: true,
  hideAccountSwitcher: false,
  showRailAccountList: false,
  proInterface: false,

  // Unified Mailbox
  enableUnifiedMailbox: false,
  includeGroupInUnified: true,
  unifiedCrossAccount: false,

  allMailFolderIds: {} as Record<string, string[]>,
  preferredIdentityIds: {} as Record<string, string>,

  enableCrossUnreadView: false,
  enableCrossStarredView: false,
  enableCrossAllView: false,

  // Email Display
  disableThreading: false,

  senderFavicons: true,
  showAvatarsInJunk: false,
  faviconUnreadBadge: true,

  // Sidebar
  colorfulSidebarIcons: true,
  tintListRowsByTag: true,
  showFolderTotalCount: true,

  // Folders
  folderIcons: {} as Record<string, string>,

  // Keywords
  emailKeywords: USING_MOCK_SERVER ? DEV_KEYWORDS : DEFAULT_KEYWORDS,
  nestedTags: USING_MOCK_SERVER,

  // Attachment Reminder
  attachmentReminderEnabled: true,
  attachmentReminderKeywords: [
    // English
    'attached', 'attachment', 'attachments', 'see attached', 'find attached', 'please find attached',
    // German
    'angehängt', 'anhang', 'anbei', 'im anhang',
    // French
    'ci-joint', 'pièce jointe',
    // Spanish
    'adjunto', 'adjunta', 'en adjunto',
    // Italian
    'allegato', 'in allegato',
    // Dutch
    'bijgevoegd', 'bijlage',
    // Portuguese
    'em anexo', 'anexo',
    // Polish
    'w załączniku',
    // Russian
    'во вложении',
    // Japanese
    '添付',
    // Chinese
    '附件',
    // Korean
    '첨부',
    // Latvian
    'pielikumā',
  ] as string[],

  emptySubjectWarningEnabled: true,

  hideInlineImageAttachments: true,
  attachmentImagePreviewsEnabled: true,

  // Sidebar Apps
  sidebarApps: [] as SidebarApp[],
  keepAppsLoaded: false,

  // Onboarding
  onboardingCompleted: false,
  tourCompleted: false,
  showOnboardingOnNewDevices: false,

  // Downloads
  emailDownloadTemplate: '{date} ({from}-{to}) {subject}',
  attachmentDownloadTemplate: '{filename}',
  bundleDownloadTemplate: 'emails-{count}',
  filenameSpaceReplacement: 'keep' as 'keep' | 'underscore' | 'dash',
  filenameLowercase: false,
  filenameStripDiacritics: false,
  filenameCollapseSeparators: true,
  postExportAction: 'keep' as 'keep' | 'archive' | 'trash',

  // Advanced
  debugMode: false,
  debugCategories: {
    jmap: true,
    calendar: true,
    tasks: true,
    auth: true,
    filters: true,
    email: true,
    push: true,
  } as Record<DebugCategory, boolean>,
  settingsSyncDisabled: false,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,

      updateSetting: (key, value) => {
        set({ [key]: value });

        // Apply font size to document root
        if (key === 'fontSize') {
          applyFontSize(value as FontSize);
        }

        // Apply density to document root
        if (key === 'density') {
          applyDensity(value as Density);
        }

        // Apply animations to document root
        if (key === 'animationsEnabled') {
          applyAnimations(value as boolean);
        }
      },

      resetToDefaults: () => {
        set(DEFAULT_SETTINGS);
        applyFontSize(DEFAULT_SETTINGS.fontSize);
        applyDensity(DEFAULT_SETTINGS.density);
        applyAnimations(DEFAULT_SETTINGS.animationsEnabled);
      },

      exportSettings: () => {
        const state = get();
        const templateSync = templateSyncBridge?.getSyncedState();
        const settings = {
          fontSize: state.fontSize,
          density: state.density,
          animationsEnabled: state.animationsEnabled,
          messageListOrder: state.messageListOrder,
          messageListOrderScope: state.messageListOrderScope,
          dateFormat: state.dateFormat,
          dateLocale: state.dateLocale,
          timeFormat: state.timeFormat,
          firstDayOfWeek: state.firstDayOfWeek,
          timeZone: state.timeZone,
          markAsReadDelay: state.markAsReadDelay,
          deleteAction: state.deleteAction,
          returnToListAfterAction: state.returnToListAfterAction,
          clearSearchOnFolderChange: state.clearSearchOnFolderChange,
          showPreview: state.showPreview,
          mailLayout: state.mailLayout,
          emailsPerPage: state.emailsPerPage,
          externalContentPolicy: state.externalContentPolicy,
          messageSpacing: state.messageSpacing,
          plainTextFont: state.plainTextFont,
          mailAttachmentAction: state.mailAttachmentAction,
          attachmentPosition: state.attachmentPosition,
          archiveMode: state.archiveMode,
          hoverActions: state.hoverActions,
          hoverActionsMode: state.hoverActionsMode,
          hoverActionsCorner: state.hoverActionsCorner,
          swipeRightAction: state.swipeRightAction,
          swipeLeftAction: state.swipeLeftAction,
          disableThreading: state.disableThreading,
          trustedSenders: state.trustedSenders,
          autoSaveDraftInterval: state.autoSaveDraftInterval,
          sendConfirmation: state.sendConfirmation,
          defaultReplyMode: state.defaultReplyMode,
          autoSelectReplyIdentity: state.autoSelectReplyIdentity,
          plainTextMode: state.plainTextMode,
          composeFontFamily: state.composeFontFamily,
          composeFontSize: state.composeFontSize,
          composeTextColor: state.composeTextColor,
          rtlEditingSupport: state.rtlEditingSupport,
          subAddressDelimiter: state.subAddressDelimiter,
          sendDelaySeconds: state.sendDelaySeconds,
          signaturePosition: state.signaturePosition,
          signatureSeparatorEnabled: state.signatureSeparatorEnabled,
          requestReadReceiptDefault: state.requestReadReceiptDefault,
          readReceiptResponse: state.readReceiptResponse,
          sessionTimeout: state.sessionTimeout,
          emailNotificationsEnabled: state.emailNotificationsEnabled,
          emailNotificationSound: state.emailNotificationSound,
          notificationSoundChoice: state.notificationSoundChoice,
          pushRelayUrl: state.pushRelayUrl,
          protocolOpenMode: state.protocolOpenMode,
          calendarNotificationsEnabled: state.calendarNotificationsEnabled,
          calendarNotificationSound: state.calendarNotificationSound,
          calendarInvitationParsingEnabled: state.calendarInvitationParsingEnabled,
          enableCalendarTasks: state.enableCalendarTasks,
          showTasksOnCalendar: state.showTasksOnCalendar,
          showBirthdayCalendar: state.showBirthdayCalendar,
          birthdayCalendarColor: state.birthdayCalendarColor,
          sharedCalendarColors: state.sharedCalendarColors,
          groupContactsByLetter: state.groupContactsByLetter,
          expandedFilterView: state.expandedFilterView,
          showTimeInMonthView: state.showTimeInMonthView,
          showWeekNumbers: state.showWeekNumbers,
          calendarHoverPreview: state.calendarHoverPreview,
          toolbarPosition: state.toolbarPosition,
          hideAccountSwitcher: state.hideAccountSwitcher,
          showRailAccountList: state.showRailAccountList,
          // proInterface is intentionally omitted - it's a per-device choice
          // (see DEVICE_LOCAL_SETTING_KEYS) and must not be synced.
          enableUnifiedMailbox: state.enableUnifiedMailbox,
          includeGroupInUnified: state.includeGroupInUnified,
          unifiedCrossAccount: state.unifiedCrossAccount,
          allMailFolderIds: state.allMailFolderIds,
          preferredIdentityIds: state.preferredIdentityIds,
          enableCrossUnreadView: state.enableCrossUnreadView,
          enableCrossStarredView: state.enableCrossStarredView,
          enableCrossAllView: state.enableCrossAllView,
          senderFavicons: state.senderFavicons,
          showAvatarsInJunk: state.showAvatarsInJunk,
          faviconUnreadBadge: state.faviconUnreadBadge,
          colorfulSidebarIcons: state.colorfulSidebarIcons,
          tintListRowsByTag: state.tintListRowsByTag,
          showFolderTotalCount: state.showFolderTotalCount,
          folderIcons: state.folderIcons,
          emailKeywords: state.emailKeywords,
          nestedTags: state.nestedTags,
          attachmentReminderEnabled: state.attachmentReminderEnabled,
          attachmentReminderKeywords: state.attachmentReminderKeywords,
          emptySubjectWarningEnabled: state.emptySubjectWarningEnabled,
          hideInlineImageAttachments: state.hideInlineImageAttachments,
          attachmentImagePreviewsEnabled: state.attachmentImagePreviewsEnabled,
          sidebarApps: state.sidebarApps,
          keepAppsLoaded: state.keepAppsLoaded,
          onboardingCompleted: state.onboardingCompleted,
          tourCompleted: state.tourCompleted,
          showOnboardingOnNewDevices: state.showOnboardingOnNewDevices,
          debugMode: state.debugMode,
          debugCategories: state.debugCategories,
          settingsSyncDisabled: state.settingsSyncDisabled,
          // Cross-store settings
          theme: useThemeStore.getState().theme,
          locale: useLocaleStore.getState().locale,
          // Omitted entirely (rather than emitted empty) if the bridge has
          // not registered, so an importing device leaves its templates alone.
          ...(templateSync
            ? {
                templates: templateSync.templates,
                deletedTemplateIds: templateSync.deletedTemplateIds,
              }
            : {}),
        };
        return JSON.stringify(settings, null, 2);
      },

      importSettings: (json: string, opts?: { serverAccountId?: string }) => {
        try {
          const settings = JSON.parse(json);

          // Validate settings
          if (typeof settings !== 'object' || settings === null) {
            return false;
          }

          if (typeof settings.protocolOpenMode !== 'string' && typeof settings.protocolMailtoOpenMode === 'string') {
            settings.protocolOpenMode = settings.protocolMailtoOpenMode;
          }

          // Apply settings
          Object.keys(settings).forEach((key) => {
            if (key in DEFAULT_SETTINGS) {
              if (key === 'subAddressDelimiter' && !isValidSubAddressDelimiter(settings[key])) {
                return;
              }
              if (key === 'sendDelaySeconds' && ![0, 10, 30, 60].includes(settings[key])) {
                set({ sendDelaySeconds: 0 });
                return;
              }
              // Reject an unknown enum value from a newer/older client rather
              // than letting the composer map it to `undefined` CSS.
              if (key === 'composeFontFamily' && !COMPOSE_FONT_FAMILIES.includes(settings[key])) {
                return;
              }
              if (key === 'composeFontSize' && !COMPOSE_FONT_SIZES.includes(settings[key])) {
                return;
              }
              // Validity of the zone id itself is checked at use time
              // (lib/timezone resolveTimeZone falls back to the browser zone),
              // so only reject non-strings here.
              if (key === 'timeZone' && typeof settings[key] !== 'string') {
                return;
              }
              // Ignore a legacy global allMailFolderIds (string[] | null) or any
              // non-record value - this build keys it per account.
              if (key === 'allMailFolderIds' && !isPlainRecord(settings[key])) {
                return;
              }
              // Per-account map (accountId -> identityId); ignore any legacy
              // global/non-record value rather than corrupting the map.
              if (key === 'preferredIdentityIds' && !isPlainRecord(settings[key])) {
                return;
              }
              // The list order is sent to the server as a sort array, so an
              // unknown criterion from a newer/older client must never get
              // through (an unsupportedSort refusal empties the folder).
              if (key === 'messageListOrder') {
                set({ messageListOrder: sanitizeSortLevels(settings[key]) });
                return;
              }
              if (key === 'messageListOrderScope' && settings[key] !== 'inbox' && settings[key] !== 'all') {
                return;
              }
              if (DEVICE_LOCAL_SETTING_KEYS.has(key)) {
                return;
              }
              // Per-account maps (accountId -> value) live in every account's
              // synced settings blob, so a per-account server load must NOT
              // replace the whole map - each account's server is authoritative
              // only for its OWN entry. Merging preserves the other accounts'
              // local values; without this the last account to load clobbers
              // the map and the composer picks another account's default sender
              // (login-order dependent). File imports (no serverAccountId)
              // still replace wholesale.
              if (opts?.serverAccountId && (key === 'preferredIdentityIds' || key === 'allMailFolderIds')) {
                const existing = (get() as unknown as Record<string, unknown>)[key];
                const merged: Record<string, unknown> = isPlainRecord(existing) ? { ...existing } : {};
                const incoming = settings[key] as Record<string, unknown>;
                if (Object.prototype.hasOwnProperty.call(incoming, opts.serverAccountId)) {
                  merged[opts.serverAccountId] = incoming[opts.serverAccountId];
                }
                set({ [key]: merged });
                return;
              }
              set({ [key]: settings[key] });
            }
          });

          // Apply visual settings
          applyFontSize(get().fontSize);
          applyDensity(get().density);
          applyAnimations(get().animationsEnabled);

          // Apply cross-store settings
          if (settings.theme) {
            useThemeStore.getState().setTheme(settings.theme);
          }
          if (settings.locale) {
            useLocaleStore.getState().setLocale(settings.locale);
          }
          // Templates live in their own store but ride along in the synced
          // settings blob (#825). Server loads merge, because every account's
          // blob carries the full (account-agnostic) template list and a stale
          // blob must not clobber it; file imports replace wholesale like the
          // rest of the settings. Blobs from builds that predate template sync
          // have no `templates` key and leave the local store untouched.
          templateSyncBridge?.applySyncedState(
            settings.templates,
            settings.deletedTemplateIds,
            { merge: Boolean(opts?.serverAccountId) }
          );

          return true;
        } catch (error) {
          console.error('Failed to import settings:', error);
          return false;
        }
      },

      // Folder icon methods
      setFolderIcon: (mailboxId: string, icon: string) => {
        set({ folderIcons: { ...get().folderIcons, [mailboxId]: icon } });
      },

      removeFolderIcon: (mailboxId: string) => {
        const { [mailboxId]: _, ...rest } = get().folderIcons;
        set({ folderIcons: rest });
      },

      // Shared-calendar color override methods
      setSharedCalendarColor: (key: string, color: string) => {
        set({ sharedCalendarColors: { ...get().sharedCalendarColors, [key]: color } });
      },

      removeSharedCalendarColor: (key: string) => {
        const { [key]: _, ...rest } = get().sharedCalendarColors;
        set({ sharedCalendarColors: rest });
      },

      // Trusted senders methods
      addTrustedSender: (email: string) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const emailAddress = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        const current = get().trustedSenders;
        if (!current.includes(emailAddress)) {
          set({ trustedSenders: [...current, emailAddress] });
        }
      },

      removeTrustedSender: (email: string) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const emailAddress = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        set({
          trustedSenders: get().trustedSenders.filter(e => e !== emailAddress)
        });
      },

      isSenderTrusted: (email: string) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const emailAddress = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        return get().trustedSenders.includes(emailAddress);
      },

      // Keyword methods
      addKeyword: (keyword: KeywordDefinition) => {
        const current = get().emailKeywords;
        if (current.some(k => k.id === keyword.id)) return;
        set({ emailKeywords: [...current, keyword] });
      },

      updateKeyword: (id: string, updates: Partial<Omit<KeywordDefinition, 'id'>>) => {
        set({
          emailKeywords: get().emailKeywords.map(k =>
            k.id === id ? { ...k, ...updates } : k
          ),
        });
      },

      renameKeyword: (oldId: string, newKeyword: KeywordDefinition) => {
        set({
          emailKeywords: get().emailKeywords.map(k =>
            k.id === oldId ? newKeyword : k
          ),
        });
      },

      removeKeyword: (id: string) => {
        set({ emailKeywords: get().emailKeywords.filter(k => k.id !== id) });
      },

      reorderKeywords: (keywords: KeywordDefinition[]) => {
        set({ emailKeywords: keywords });
      },

      getKeywordById: (id: string) => {
        return get().emailKeywords.find(k => k.id === id);
      },

      // Sidebar Apps methods
      addSidebarApp: (app: SidebarApp) => {
        const current = get().sidebarApps;
        if (current.some(a => a.id === app.id)) return;
        set({ sidebarApps: [...current, app] });
      },

      updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => {
        set({
          sidebarApps: get().sidebarApps.map(a =>
            a.id === id ? { ...a, ...updates } : a
          ),
        });
      },

      removeSidebarApp: (id: string) => {
        set({ sidebarApps: get().sidebarApps.filter(a => a.id !== id) });
      },

      reorderSidebarApps: (apps: SidebarApp[]) => {
        set({ sidebarApps: apps });
      },

      // Settings sync methods
      enableSync: (username: string, serverUrl: string) => {
        syncUsername = username;
        syncServerUrl = serverUrl;
        syncEnabled = true;
        syncLog('Settings sync enabled for', username);
      },

      flushSync: async () => {
        if (syncTimeout) {
          clearTimeout(syncTimeout);
          syncTimeout = null;
        }
        const job = pendingSync;
        pendingSync = null;
        if (job) await syncSettingsJob(job);
      },

      disableSync: () => {
        syncEnabled = false;
        syncUsername = null;
        syncServerUrl = null;
        if (syncTimeout) {
          clearTimeout(syncTimeout);
          syncTimeout = null;
        }
        pendingSync = null;
        syncLog('Settings sync disabled');
      },

      loadFromServer: async (username: string, serverUrl: string) => {
        try {
          syncLog('Loading settings from server for', username);
          const res = await apiFetch('/api/settings', {
            headers: {
              'x-settings-username': username,
              'x-settings-server': serverUrl,
            },
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            syncLog('Settings fetch failed:', body.error || `status ${res.status}`);
            return false;
          }
          const { settings } = await res.json();
          if (!settings) {
            syncLog('No server settings found yet');
            return false;
          }
          if (settings && typeof settings === 'object') {
            isLoadingFromServer = true;
            // Merge (not replace) per-account maps for the account being loaded,
            // so multi-account logins don't clobber each other by login order.
            get().importSettings(JSON.stringify(settings), {
              serverAccountId: generateAccountId(username, serverUrl),
            });
            isLoadingFromServer = false;
            syncLog('Settings loaded from server successfully');
            // The per-account preferred sender identity (#507) is re-applied by
            // applyPreferredIdentity() in auth-store, invoked from the
            // loadFromServer().finally() of every login / switch / restore path,
            // so no extra hook is needed here.
            return true;
          }
          return false;
        } catch (error) {
          syncError('Failed to load settings from server:', error);
          isLoadingFromServer = false;
          return false;
        }
      },
    }),
    {
      name: 'settings-storage',
      version: 7,
      migrate: migrateSettings,
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            // Defensive: a legacy global array or any non-record value (e.g.
            // synced from an older client) is coerced to an empty map so
            // per-account consumers never see a non-record.
            if (!isPlainRecord(state.allMailFolderIds)) {
              state.allMailFolderIds = {};
            }
            if (!isPlainRecord(state.preferredIdentityIds)) {
              state.preferredIdentityIds = {};
            }
            state.messageListOrder = sanitizeSortLevels(state.messageListOrder);
            if (state.messageListOrderScope !== 'inbox' && state.messageListOrderScope !== 'all') {
              state.messageListOrderScope = 'inbox';
            }
            applyFontSize(state.fontSize);
            applyDensity(state.density);
            applyAnimations(state.animationsEnabled);
          }
        };
      },
    }
  )
);

/**
 * Versioned migration for persisted settings. Exported for tests. Mutates and
 * returns the persisted record so each bump only needs to handle its own delta.
 */
export function migrateSettings(persisted: unknown, version: number): SettingsState {
  const state = persisted as Record<string, unknown>;
        if (version < 2 && state.listDensity) {
          state.density = state.listDensity;
          delete state.listDensity;
        }
        if (![0, 10, 30, 60].includes(state.sendDelaySeconds as number)) {
          state.sendDelaySeconds = 0;
        }
        if (version < 3 && typeof state.protocolOpenMode !== 'string' && typeof state.protocolMailtoOpenMode === 'string') {
          state.protocolOpenMode = state.protocolMailtoOpenMode;
        }
        delete state.protocolMailtoOpenMode;
        // v4: `dateFormat` was repurposed from 'regional'|'iso'|'custom' to
        // 'smart'|'relative'|'full'. The old setting was never read anywhere,
        // so every persisted value maps to the new default.
        if (version < 4) {
          state.dateFormat = 'smart';
        }
        // v5: allMailFolderIds went from a global `string[] | null` to a
        // per-account `Record<accountId, string[]>`. The legacy global list
        // can't be attributed to a specific account here (the active account
        // isn't known at migrate time), so it's dropped - each account starts
        // "not configured" (defaults to all no-role folders).
        if (version < 5 || !isPlainRecord(state.allMailFolderIds)) {
          state.allMailFolderIds = {};
        }
        // "All accounts" was reworked into the account-bounded "Unified
        // Mailbox". The standalone __all_mail__ view (`enableAllMailView`) was
        // folded into the unified "All mail" entry (`enableCrossAllView`), and a
        // `unifiedCrossAccount` toggle now governs whether the views span every
        // logged-in account. Existing users keep their current behaviour:
        //  - if any cross view was on, they were already cross-account -> keep it on
        //  - else if only standalone All Mail was on, enable the account-bounded
        //    unified "All mail" entry (folder selection carries over via allMailFolderIds)
        // Guarded at <7 (not <6) so users who stopped at main's interim v6
        // identity-map bump - which shipped without this rework - still receive it.
        if (version < 7) {
          const hadCross = !!(state.enableCrossUnreadView || state.enableCrossStarredView || state.enableCrossAllView);
          if (hadCross) {
            state.unifiedCrossAccount = true;
          } else if (state.enableAllMailView) {
            state.enableUnifiedMailbox = true;
            state.enableCrossAllView = true;
            state.unifiedCrossAccount = false;
          }
          delete state.enableAllMailView;
          if (typeof state.unifiedCrossAccount !== 'boolean') state.unifiedCrossAccount = false;
          // The reworked unified mailbox spans the account's own folders plus its
          // shared/group folders, so enable shared inclusion for every migrated
          // configuration (matches the new-install default).
          state.includeGroupInUnified = true;
        }
        // Per-account default-identity map (issue #507). Coerce any
        // missing/legacy value to an empty record. Guarded at <6 so users who
        // already received it via main's v6 bump keep their populated map.
        if (version < 6 || !isPlainRecord(state.preferredIdentityIds)) {
          state.preferredIdentityIds = {};
        }
        return state as unknown as SettingsState;
}

// Helper functions to apply settings to DOM
function applyFontSize(size: FontSize) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const sizeMap = {
    small: '14px',
    medium: '16px',
    large: '18px',
  };
  root.style.setProperty('--font-size-base', sizeMap[size]);
}

function applyDensity(density: Density) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  const densityValues = {
    'extra-compact': {
      '--list-item-height': 'auto',
      '--density-item-py': '2px',
      '--density-item-gap': '6px',
      '--density-header-py': '4px',
      '--density-card-p': '8px',
      '--density-sidebar-py': '0px',
    },
    compact: {
      '--list-item-height': 'auto',
      '--density-item-py': '4px',
      '--density-item-gap': '8px',
      '--density-header-py': '6px',
      '--density-card-p': '10px',
      '--density-sidebar-py': '1px',
    },
    regular: {
      '--list-item-height': '48px',
      '--density-item-py': '12px',
      '--density-item-gap': '12px',
      '--density-header-py': '12px',
      '--density-card-p': '16px',
      '--density-sidebar-py': '4px',
    },
    comfortable: {
      '--list-item-height': '64px',
      '--density-item-py': '16px',
      '--density-item-gap': '16px',
      '--density-header-py': '16px',
      '--density-card-p': '20px',
      '--density-sidebar-py': '6px',
    },
  };

  const values = densityValues[density];
  for (const [prop, val] of Object.entries(values)) {
    root.style.setProperty(prop, val);
  }
}

function applyAnimations(enabled: boolean) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  if (enabled) {
    root.style.removeProperty('--transition-duration');
  } else {
    root.style.setProperty('--transition-duration', '0s');
  }
}

// Initialize settings on load
if (typeof window !== 'undefined') {
  const store = useSettingsStore.getState();
  applyFontSize(store.fontSize);
  applyDensity(store.density);
  applyAnimations(store.animationsEnabled);

  const triggerSync = () => {
    if (!syncEnabled || !syncUsername || !syncServerUrl || isLoadingFromServer) return;
    pendingSync = {
      username: syncUsername,
      serverUrl: syncServerUrl,
      settings: JSON.parse(useSettingsStore.getState().exportSettings()),
    };
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
      syncTimeout = null;
      const job = pendingSync;
      pendingSync = null;
      if (!job) return;
      try {
        await syncSettingsJob(job);
      } catch (error) {
        syncError('Settings sync error:', error);
      }
    }, SYNC_DEBOUNCE_MS);
  };

  // Auto-sync settings to server on any state change
  let prevSyncDisabled = useSettingsStore.getState().settingsSyncDisabled;
  useSettingsStore.subscribe(() => {
    const currentSyncDisabled = useSettingsStore.getState().settingsSyncDisabled;
    const syncToggleChanged = currentSyncDisabled !== prevSyncDisabled;
    prevSyncDisabled = currentSyncDisabled;
    // Skip sync if disabled, unless the toggle itself just changed
    if (currentSyncDisabled && !syncToggleChanged) return;
    triggerSync();
  });

  // Also sync when theme or locale changes
  useThemeStore.subscribe(triggerSync);
  useLocaleStore.subscribe(triggerSync);

  // And when templates change (they ride along in the synced blob, #825).
  // Unlike theme/locale this honors the user's sync opt-out toggle. The
  // subscription itself is made by template-store when it registers the
  // template sync bridge (see registerTemplateSyncBridge).
  onTemplateStoreChange = () => {
    if (useSettingsStore.getState().settingsSyncDisabled) return;
    triggerSync();
  };
  // Ensure template-store is loaded (and the bridge registered) even before
  // any UI component imports it, so the first sync push already carries the
  // templates.
  void import('./template-store');
}

/**
 * The message-list order to request for a folder with the given role (#718):
 * the configured levels when they apply to every folder or this is the Inbox,
 * chronological otherwise. Pass null for views without a folder role (tag
 * views, search) - those only pick the order up under the "all folders" scope.
 */
export function getMessageListOrderFor(role: string | null | undefined): SortLevel[] {
  const { messageListOrder, messageListOrderScope } = useSettingsStore.getState();
  return orderForMailbox(messageListOrder, messageListOrderScope, role);
}
