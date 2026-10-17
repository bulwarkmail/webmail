import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Mailbox } from "./jmap/types";
import { debug } from "./debug";
import { getEffectiveLocale } from '@/i18n/detect-locale';
import { useSettingsStore } from "@/stores/settings-store";
import type { DateFormat, DateLocale } from "@/stores/settings-store";
import { getEffectiveTimeZone, getWallClock } from "./timezone";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip embedded Basic-auth credentials from a URL for display.
 * `https://user:pass@host/path` → `https://host/path`. Falls back to
 * regex stripping if URL parsing fails.
 */
export function redactUrlCredentials(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/, '$1');
  }
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: construct a v4 UUID from crypto.getRandomValues
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Resolve the Intl locale used to render NUMERIC date parts, honouring the
 * user's regional `dateLocale` override while leaving weekday/month names on
 * the UI language. `auto` returns `fallback` unchanged (prior behaviour); the
 * explicit regions force a fixed numeric ordering (#456):
 *   - `iso`   → `en-CA`  (YYYY-MM-DD)
 *   - `en-GB` → `en-GB`  (DD/MM/YYYY)
 *   - `en-US` → `en-US`  (MM/DD/YYYY)
 */
function resolveDateLocale<T extends string | undefined>(
  dateLocale: DateLocale,
  fallback: T,
): string | T {
  switch (dateLocale) {
    case "iso":
      return "en-CA";
    case "en-GB":
      return "en-GB";
    case "en-US":
      return "en-US";
    case "auto":
    default:
      return fallback;
  }
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * An Intl.DateTimeFormat for `locale` and `options`, built once. Each
 * toLocale*String call constructs one afresh, and the list formats every
 * row's date on every render. Only for option sets that name a date or time
 * field: then toLocaleString, toLocaleDateString and toLocaleTimeString all
 * format exactly as the formatter does.
 */
function cachedDateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    dateFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Formats a received-at date for the email list. The output style is
 * controlled by the `dateFormat` user setting:
 *
 *   - `smart` (default) — locale-aware, age-bucketed:
 *       today        → time only           ("15:31" or "3:31 PM")
 *       last 7 days  → short weekday+time  ("Fr 15:31", "Fri 3:31 PM")
 *       older        → full locale date    ("28.04.2026", "04/28/2026")
 *       With `listStyle: 'mountain-view'` the buckets are Gmail's instead:
 *       today → time, this year → "Oct 10", older → "10/10/25".
 *   - `relative` — legacy en-US relative format ("1h ago", "2d ago").
 *   - `full` — always the full locale date+time.
 *
 * The numeric date ordering is additionally governed by the `dateLocale`
 * region setting (`auto` = follow the UI language, unchanged; or a fixed
 * ISO / DD-MM / MM-DD ordering). Weekday and month names always follow the
 * UI language.
 *
 * The locale (from the language picker), the region override and the 12h/24h
 * preference are all read via `getState()` so this stays SSR-safe.
 *
 * All output is rendered in the user's effective time zone (the `timeZone`
 * setting when set, else the browser's), including the today / this-week
 * bucketing - a browser pinned to UTC for anti-fingerprinting must not
 * roll a 00:30 local mail into "yesterday" (#755).
 */
export function formatDate(
  date: Date | string,
  // Settings preview: render as if these were picked, without saving them.
  overrides?: { dateFormat?: DateFormat; dateLocale?: DateLocale; listStyle?: 'mountain-view' },
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  // An unparsable receivedAt (e.g. a 5-digit year) makes Intl throw
  // "RangeError: Invalid time value" and takes the whole list down with it.
  // Leave the row's date slot blank; the viewer header shows the raw value. (#1099)
  if (!d || Number.isNaN(d.getTime())) return "";
  const now = new Date();

  const locale = getEffectiveLocale();
  // Names (weekday, month) follow the UI language: `en` alone resolves to
  // en-US in Intl; everything else uses the language subtag as-is and lets
  // the runtime pick a sensible default region.
  const uiLocale = locale === "en" ? "en-US" : locale;
  const { dateFormat, dateLocale, timeFormat } = { ...useSettingsStore.getState(), ...overrides };
  // Numeric dates additionally honour the regional `dateLocale` override
  // (defaults to `auto` = the UI language, preserving prior behaviour). (#456)
  const numericLocale = resolveDateLocale(dateLocale, uiLocale);
  const hour12 = timeFormat === "12h";
  const timeZone = getEffectiveTimeZone();

  if (dateFormat === "relative") {
    const diff = now.getTime() - d.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    // Natural, fully localized relative time ("an hour ago" / "לפני שעה",
    // "2 days ago" / "לפני יומיים") with correct singular/dual/plural per locale.
    const rtf = new Intl.RelativeTimeFormat(uiLocale, { numeric: "auto" });
    if (minutes < 1) return rtf.format(0, "second");
    if (minutes < 60) return rtf.format(-minutes, "minute");
    if (hours < 24) return rtf.format(-hours, "hour");
    if (days < 7) return rtf.format(-days, "day");
    return cachedDateFormat(uiLocale, {
      timeZone,
      month: "short",
      day: "numeric",
      year: getWallClock(d, timeZone).year !== getWallClock(now, timeZone).year ? "numeric" : undefined,
    }).format(d);
  }

  if (dateFormat === "full") {
    return cachedDateFormat(numericLocale, {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12,
    }).format(d);
  }

  // 'smart' (default)
  const timeStr = cachedDateFormat(uiLocale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12,
  }).format(d);

  // Calendar-day comparison in the display zone, not the browser zone.
  const dWall = getWallClock(d, timeZone);
  const nowWall = getWallClock(now, timeZone);
  const isSameDay =
    dWall.year === nowWall.year &&
    dWall.month === nowWall.month &&
    dWall.day === nowWall.day;
  if (isSameDay) return timeStr;

  if (overrides?.listStyle === 'mountain-view') {
    if (dWall.year === nowWall.year) {
      return cachedDateFormat(uiLocale, { timeZone, month: "short", day: "numeric" }).format(d);
    }
    return cachedDateFormat(numericLocale, { timeZone, year: "2-digit", month: "numeric", day: "numeric" }).format(d);
  }

  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (daysAgo < 7) {
    // German Intl outputs "Fr." with a trailing dot for `weekday: 'short'`;
    // strip it so the result reads cleanly next to the time.
    const weekday = cachedDateFormat(uiLocale, { timeZone, weekday: "short" })
      .format(d)
      .replace(/\.$/, "");
    return `${weekday} ${timeStr}`;
  }

  return cachedDateFormat(numericLocale, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Format a date/time string respecting the user's 12h/24h time format preference.
 * Rendered in the effective time zone (user override, else browser) - #755.
 */
export function formatDateTime(
  date: Date | string,
  timeFormat: '12h' | '24h',
  options?: {
    weekday?: 'short' | 'long';
    year?: 'numeric';
    month?: 'short' | 'long';
    day?: 'numeric';
    second?: '2-digit';
    timeZoneName?: 'short';
    dateOnly?: boolean;
  }
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return typeof date === 'string' ? date : '';

  // Honour the regional `dateLocale` override; `auto` keeps the previous
  // `undefined` (runtime default) locale so existing behaviour is unchanged. (#456)
  const { dateLocale } = useSettingsStore.getState();
  const effectiveLocale = resolveDateLocale(dateLocale, undefined);

  const localeOptions: Intl.DateTimeFormatOptions = { timeZone: getEffectiveTimeZone() };
  if (options?.weekday) localeOptions.weekday = options.weekday;
  if (options?.year) localeOptions.year = options.year;
  if (options?.month) localeOptions.month = options.month;
  if (options?.day) localeOptions.day = options.day;

  if (!options?.dateOnly) {
    localeOptions.hour = '2-digit';
    localeOptions.minute = '2-digit';
    localeOptions.hour12 = timeFormat === '12h';
    if (options?.second) localeOptions.second = options.second;
    if (options?.timeZoneName) localeOptions.timeZoneName = options.timeZoneName;
  }

  return d.toLocaleString(effectiveLocale, localeOptions);
}

/**
 * How long ago `date` was, in words ("3 minutes ago", "2 days ago"), for the
 * parenthesis Gmail puts after a message's time. Empty once it is a month
 * old, where the date alone says enough.
 *
 * Days are calendar days in the user's effective time zone, so a mail from
 * the day before yesterday is never called "yesterday" just because fewer
 * than 48 hours have passed. (#1259)
 */
export function formatRelativeAgo(date: Date | string, now: Date = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  if (!d || Number.isNaN(d.getTime())) return '';
  const diff = Math.max(0, now.getTime() - d.getTime());
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const timeZone = getEffectiveTimeZone();
  const dayNumber = (x: Date) => {
    const w = getWallClock(x, timeZone);
    return Date.UTC(w.year, w.month - 1, w.day) / 86400000;
  };
  const days = Math.max(1, dayNumber(now) - dayNumber(d));
  if (days >= 30) return '';
  const locale = getEffectiveLocale();
  const rtf = new Intl.RelativeTimeFormat(locale === 'en' ? 'en-US' : locale, { numeric: 'auto' });
  if (minutes < 1) return rtf.format(0, 'second');
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-days, 'day');
}

// Marketing emails pad the preheader with whitespace, format chars (soft
// hyphens, zero-width chars, BOM, directional marks) and combining marks
// (e.g. U+034F) to push real content past the preview window. Strip them all.
// \p{Cf} = Format, \p{Mn} = combining marks; \s covers figure space, NBSP, etc.
const LEADING_INVISIBLE_RE = /^[\s\p{Cf}\p{Mn}]+/u;
// After stripping, a server-side truncation indicator like "..." may be all
// that's left. Treat that as no preview so callers can fall back.
const ONLY_PUNCTUATION_RE = /^[.\u2026\s]+$/;

export function stripInvisibleLeading(text: string): string {
  const stripped = text.replace(LEADING_INVISIBLE_RE, '');
  if (ONLY_PUNCTUATION_RE.test(stripped)) return '';
  return stripped;
}

// A style sheet at the start of the text: an at-rule, or a selector opening a
// rule. Plain prose does not start like this - "@" or "#" followed by a word
// and then, before any sentence ends, a "{".
const DECLARATIONS_RE = /^\s*(?:[-\w]+\s*:|[.#@a-z*][^{}]*\{)/i;
// At-rule names are matched case-sensitively: style sheets write them in lower
// case, while "@Page …" at the start of a preview is a mention. A selector's
// colon is a pseudo-class ("a:hover"), never followed by a space as in
// "Reminder: your appointment {date: …}".
const AT_RULE_RE = /^@(?:media|font-face|import|supports|keyframes|charset|page)\b/;
const SELECTOR_RE = /^[.#]?[a-z*](?:[\w\-.#,>~+*\s[\]="']|:(?!\s))*\{/i;

/**
 * Drops a style sheet from the start of a text preview.
 *
 * Some servers build the preview from an HTML body without skipping its
 * <style> element, so a marketing mail's preview can begin with
 * "@media screen and (min-width:600px){.hide{display:none!important;…" and
 * never reach the text. Whole leading rules are removed; a preview that ends
 * inside one was nothing but CSS and becomes empty, so callers fall back to
 * their "no preview" text.
 */
export function stripLeadingCss(text: string): string {
  let rest = text.trimStart();
  for (let guard = 0; guard < 100 && (AT_RULE_RE.test(rest) || SELECTOR_RE.test(rest)); guard++) {
    const brace = rest.indexOf('{');
    const semicolon = rest.indexOf(';');
    // `@import url(...);` and `@charset "x";` end without a block.
    if (semicolon >= 0 && (brace < 0 || semicolon < brace) && /^@(?:import|charset)\b/.test(rest)) {
      rest = rest.slice(semicolon + 1).trimStart();
      continue;
    }
    // An at-rule word with no block after it ("@media team, …", "@page 3 …")
    // starts prose, not a style sheet.
    if (brace < 0) return rest;
    let depth = 0;
    let end = -1;
    for (let i = brace; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) return rest.startsWith('@') || DECLARATIONS_RE.test(rest.slice(brace + 1)) ? '' : rest;
    // A rule's block holds declarations ("color: red") or further rules; a
    // brace in prose ("at {time} tomorrow") holds neither and ends the strip.
    if (!rest.startsWith('@') && !DECLARATIONS_RE.test(rest.slice(brace + 1, end))) return rest;
    rest = rest.slice(end + 1).trimStart();
  }
  return rest;
}

/** A message preview ready to show: no leading padding, no leading style sheet. */
export function cleanPreview(text: string | null | undefined): string {
  return stripInvisibleLeading(stripLeadingCss(stripInvisibleLeading(text ?? '')));
}

/**
 * A size people can read at a glance: whole numbers from 10 up ("67 KB"),
 * one decimal below that ("2.1 MB"), never a trailing ".0".
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  let value = bytes / Math.pow(k, i);
  if (i === 0) return `${Math.round(bytes)} B`;

  let rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  // 1023.6 KB rounds to 1024 KB: show it as 1 MB instead.
  if (rounded >= k && i < units.length - 1) {
    i += 1;
    value /= k;
    rounded = Math.round(value * 10) / 10;
  }
  return `${rounded} ${units[i]}`;
}

// Types for mailbox tree
export interface MailboxNode extends Mailbox {
  children: MailboxNode[];
  depth: number;
}

// Role priority for mailbox ordering (lower number = higher priority)
const ROLE_PRIORITY: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  spam: 4, // Treat spam same as junk
  trash: 5,
};

// Deduplicate mailboxes (e.g., "Sent" vs "Sent Mail")
function deduplicateMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  const result: Mailbox[] = [];
  const removed: { id: string; name: string; matchedRole: string; parentId?: string }[] = [];

  // Group role mailboxes by account so deduplication is scoped per-account
  const rolesByAccount = new Map<string, Mailbox[]>();
  mailboxes.forEach(mb => {
    if (mb.role) {
      const key = mb.accountId || '';
      if (!rolesByAccount.has(key)) rolesByAccount.set(key, []);
      rolesByAccount.get(key)!.push(mb);
    }
  });

  // Build a set of IDs that are referenced as parents
  const referencedParentIds = new Set<string>();
  mailboxes.forEach(mb => {
    if (mb.parentId) referencedParentIds.add(mb.parentId);
  });

  // Filter out duplicates scoped to the same account
  mailboxes.forEach(mb => {
    // If this mailbox has a role, always keep it
    if (mb.role) {
      result.push(mb);
      return;
    }

    // Never deduplicate nested mailboxes - only root-level folders can be
    // duplicates of role-based mailboxes. Removing a nested folder that happens
    // to share a name with a role folder (e.g. a subfolder named "Sent") would
    // orphan its children to root level. (GitHub #118)
    if (mb.parentId) {
      result.push(mb);
      return;
    }

    // Check if this root-level mailbox is a duplicate of a role-based mailbox in the SAME account
    const accountKey = mb.accountId || '';
    const accountRoles = rolesByAccount.get(accountKey) || [];
    // Only an exact name collision counts as a duplicate. Substring matching
    // silently hid legitimate user folders whose name merely contained a role
    // folder's name - "Old Inbox", "2025 Archive", "Sent to Accounting".
    // (GitHub #771)
    const lowerName = mb.name.trim().toLowerCase();
    const matchedRole = accountRoles.find(roleMb => roleMb.name.trim().toLowerCase() === lowerName);
    const isDuplicate = !!matchedRole;

    // Only keep if not a duplicate
    if (!isDuplicate) {
      result.push(mb);
    } else {
      removed.push({ id: mb.id, name: mb.name, matchedRole: matchedRole!.name, parentId: mb.parentId });
      // Warn if this removed mailbox is a parent of other mailboxes (orphan risk)
      if (referencedParentIds.has(mb.id)) {
        debug.warn('jmap', `[Mailbox Tree] Deduplication removed mailbox "${mb.name}" (id: ${mb.id}) which is a parent of other mailboxes. ` +
          `Matched role mailbox: "${matchedRole!.name}" (role: ${matchedRole!.role}). ` +
          `Children referencing parentId "${mb.id}" will be orphaned to root level.`
        );
      }
    }
  });

  if (removed.length > 0) {
    debug.log('jmap', `[Mailbox Tree] Deduplication removed ${removed.length} mailbox(es):`, removed);
  }

  return result;
}

// Build a hierarchical tree structure from flat mailbox array
export function buildMailboxTree(mailboxes: Mailbox[]): MailboxNode[] {
  debug.log('jmap', `[Mailbox Tree] Building tree from ${mailboxes.length} mailboxes`);

  // Deduplicate mailboxes first
  const deduplicated = deduplicateMailboxes(mailboxes);

  if (deduplicated.length !== mailboxes.length) {
    debug.log('jmap', `[Mailbox Tree] After deduplication: ${deduplicated.length} mailboxes (removed ${mailboxes.length - deduplicated.length})`);
  }

  // Separate own and shared mailboxes
  const ownMailboxes = deduplicated.filter(mb => !mb.isShared);
  const sharedMailboxes = deduplicated.filter(mb => mb.isShared);

  const mailboxMap = new Map<string, MailboxNode>();
  const rootMailboxes: MailboxNode[] = [];

  // First pass: create nodes for own mailboxes
  ownMailboxes.forEach(mailbox => {
    mailboxMap.set(mailbox.id, {
      ...mailbox,
      children: [],
      depth: 0
    });
  });

  // Helper to recursively recalculate depths after tree is built
  const recalculateDepths = (nodes: MailboxNode[], baseDepth: number) => {
    for (const node of nodes) {
      node.depth = baseDepth;
      if (node.children.length > 0) {
        recalculateDepths(node.children, baseDepth + 1);
      }
    }
  };

  // Second pass: build tree structure for own mailboxes
  const orphanedMailboxes: { id: string; name: string; parentId: string }[] = [];
  ownMailboxes.forEach(mailbox => {
    const node = mailboxMap.get(mailbox.id)!;

    if (mailbox.parentId && mailboxMap.has(mailbox.parentId)) {
      const parent = mailboxMap.get(mailbox.parentId)!;
      parent.children.push(node);
    } else {
      // Root level mailbox or orphaned mailbox
      if (mailbox.parentId) {
        orphanedMailboxes.push({ id: mailbox.id, name: mailbox.name, parentId: mailbox.parentId });
      }
      rootMailboxes.push(node);
    }
  });

  if (orphanedMailboxes.length > 0) {
    debug.warn('jmap', `[Mailbox Tree] ${orphanedMailboxes.length} orphaned mailbox(es) moved to root level (missing parent):`,
      orphanedMailboxes
    );
  }

  // Third pass: correctly calculate depths from the root down
  recalculateDepths(rootMailboxes, 0);

  // Log tree depth statistics
  const maxDepth = (nodes: MailboxNode[]): number => {
    let max = 0;
    for (const node of nodes) {
      max = Math.max(max, node.depth);
      if (node.children.length > 0) max = Math.max(max, maxDepth(node.children));
    }
    return max;
  };
  debug.log('jmap', `[Mailbox Tree] Built tree: ${rootMailboxes.length} root nodes, ` +
    `max depth: ${maxDepth(rootMailboxes)}, ` +
    `total own: ${ownMailboxes.length}, shared: ${sharedMailboxes.length}`
  );

  // For each shared account, create a virtual top-level account node
  // containing that account's mailboxes. This places shared accounts as
  // peers of the primary account's folders rather than nesting them under
  // a "Shared Folders" wrapper. (GitHub #151)
  if (sharedMailboxes.length > 0) {
    // Group shared mailboxes by account
    const accountGroups = new Map<string, Mailbox[]>();
    sharedMailboxes.forEach(mb => {
      const accountId = mb.accountId || 'unknown';
      if (!accountGroups.has(accountId)) {
        accountGroups.set(accountId, []);
      }
      accountGroups.get(accountId)!.push(mb);
    });

    accountGroups.forEach((accountMailboxes, accountId) => {
      // Create nodes for this account's mailboxes
      const accountMailboxMap = new Map<string, MailboxNode>();
      const accountRootNodes: MailboxNode[] = [];

      accountMailboxes.forEach(mailbox => {
        accountMailboxMap.set(mailbox.id, {
          ...mailbox,
          children: [],
          depth: 0,
        });
      });

      // Build tree for this account's mailboxes
      accountMailboxes.forEach(mailbox => {
        const node = accountMailboxMap.get(mailbox.id)!;

        if (mailbox.parentId && accountMailboxMap.has(mailbox.parentId)) {
          const parent = accountMailboxMap.get(mailbox.parentId)!;
          parent.children.push(node);
        } else {
          accountRootNodes.push(node);
        }
      });

      // Render the shared account's mailboxes flush with primary-account
      // mailboxes (depth 0) so the indents line up. The virtual account
      // node visually wraps them via its chevron/header rather than via
      // an extra indent level. (GitHub #151)
      recalculateDepths(accountRootNodes, 0);

      // Create virtual account folder node at top level (depth 0)
      const accountName = accountMailboxes[0]?.accountName || accountId;
      const accountNode: MailboxNode = {
        id: `shared-account-${accountId}`,
        name: accountName,
        sortOrder: 1000, // After all own folders
        totalEmails: accountMailboxes.reduce((sum, mb) => sum + mb.totalEmails, 0),
        unreadEmails: accountMailboxes.reduce((sum, mb) => sum + mb.unreadEmails, 0),
        totalThreads: 0,
        unreadThreads: 0,
        myRights: {
          mayReadItems: true,
          mayAddItems: false,
          mayRemoveItems: false,
          maySetSeen: false,
          maySetKeywords: false,
          mayCreateChild: false,
          mayRename: false,
          mayDelete: false,
          maySubmit: false,
        },
        isSubscribed: true,
        accountId: accountId,
        accountName: accountName,
        isShared: true,
        children: accountRootNodes,
        depth: 0,
      };

      rootMailboxes.push(accountNode);
    });
  }

  // Smart multi-level sorting
  const sortNodes = (nodes: MailboxNode[]) => {
    nodes.sort((a, b) => {
      // 1. Priority: Own folders before shared folders
      if (a.isShared !== b.isShared) {
        return a.isShared ? 1 : -1;
      }

      // 2. Priority: user-defined order. When a folder has been explicitly
      // reordered its sortOrder is non-zero and takes precedence over the
      // default role/name ordering below. Untouched folders keep sortOrder 0,
      // so the default arrangement is unchanged until the user drags something.
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }

      // 3. Priority: Role-based ordering (inbox first, trash last, etc.)
      const aPriority = a.role ? (ROLE_PRIORITY[a.role] ?? 999) : 999;
      const bPriority = b.role ? (ROLE_PRIORITY[b.role] ?? 999) : 999;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // 4. Priority: Year folders (e.g., "2025", "2024") sorted numerically descending
      const aIsYear = /^\d{4}$/.test(a.name);
      const bIsYear = /^\d{4}$/.test(b.name);
      if (aIsYear && bIsYear) {
        return parseInt(b.name) - parseInt(a.name); // Descending: 2025, 2024, 2023...
      }

      // 5. Fallback: Alphabetical by name
      return a.name.localeCompare(b.name);
    });

    // Recursively sort children
    nodes.forEach(node => {
      if (node.children.length > 0) {
        sortNodes(node.children);
      }
    });
  };

  sortNodes(rootMailboxes);

  return rootMailboxes;
}

// Flatten a mailbox tree for rendering with proper depth info
export function flattenMailboxTree(nodes: MailboxNode[]): MailboxNode[] {
  const result: MailboxNode[] = [];

  const traverse = (nodes: MailboxNode[], depth: number = 0) => {
    nodes.forEach(node => {
      result.push({ ...node, depth });
      if (node.children.length > 0) {
        traverse(node.children, depth + 1);
      }
    });
  };

  traverse(nodes);
  return result;
}

export function getMailboxPath(
  mailbox: Pick<Mailbox, 'id' | 'name' | 'parentId'>,
  allMailboxes: Array<Pick<Mailbox, 'id' | 'name' | 'parentId'>>,
  separator = ' › ',
): string {
  const byId = new Map(allMailboxes.map(m => [m.id, m]));
  const names: string[] = [mailbox.name];
  const visited = new Set<string>([mailbox.id]);
  let parentId = mailbox.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(separator);
}