import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { Mailbox, UNIFIED_MAILBOX_IDS } from "./jmap/types";
import type { UnifiedMailboxRole } from "./jmap/types";
import { debug } from "./debug";
import { getEffectiveLocale } from '@/i18n/detect-locale';
import { useSettingsStore } from "@/stores/settings-store";
import type { DateLocale } from "@/stores/settings-store";

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

/**
 * Formats a received-at date for the email list. The output style is
 * controlled by the `dateFormat` user setting:
 *
 *   - `smart` (default) — locale-aware, age-bucketed:
 *       today        → time only           ("15:31" or "3:31 PM")
 *       last 7 days  → short weekday+time  ("Fr 15:31", "Fri 3:31 PM")
 *       older        → full locale date    ("28.04.2026", "04/28/2026")
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
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const now = new Date();

  const locale = getEffectiveLocale();
  // Names (weekday, month) follow the UI language: `en` alone resolves to
  // en-US in Intl; everything else uses the language subtag as-is and lets
  // the runtime pick a sensible default region.
  const uiLocale = locale === "en" ? "en-US" : locale;
  const { dateFormat, dateLocale, timeFormat } = useSettingsStore.getState();
  // Numeric dates additionally honour the regional `dateLocale` override
  // (defaults to `auto` = the UI language, preserving prior behaviour). (#456)
  const numericLocale = resolveDateLocale(dateLocale, uiLocale);
  const hour12 = timeFormat === "12h";

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
    return d.toLocaleDateString(uiLocale, {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  }

  if (dateFormat === "full") {
    return d.toLocaleString(numericLocale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12,
    });
  }

  // 'smart' (default)
  const timeStr = d.toLocaleTimeString(uiLocale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12,
  });

  const isSameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isSameDay) return timeStr;

  const daysAgo = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (daysAgo < 7) {
    // German Intl outputs "Fr." with a trailing dot for `weekday: 'short'`;
    // strip it so the result reads cleanly next to the time.
    const weekday = d
      .toLocaleDateString(uiLocale, { weekday: "short" })
      .replace(/\.$/, "");
    return `${weekday} ${timeStr}`;
  }

  return d.toLocaleDateString(numericLocale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * Format a date/time string respecting the user's 12h/24h time format preference.
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

  const localeOptions: Intl.DateTimeFormatOptions = {};
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

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength).trim() + "...";
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
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
    const lowerName = mb.name.toLowerCase();
    const matchedRole = accountRoles.find(roleMb => {
      const roleLowerName = roleMb.name.toLowerCase();
      // Check for common duplicates: "Sent Mail" vs "Sent", etc.
      return lowerName.includes(roleLowerName) || roleLowerName.includes(lowerName);
    });
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

      // 2. Priority: Role-based ordering (inbox first, trash last, etc.)
      const aPriority = a.role ? (ROLE_PRIORITY[a.role] ?? 999) : 999;
      const bPriority = b.role ? (ROLE_PRIORITY[b.role] ?? 999) : 999;
      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // 3. Priority: Year folders (e.g., "2025", "2024") sorted numerically descending
      const aIsYear = /^\d{4}$/.test(a.name);
      const bIsYear = /^\d{4}$/.test(b.name);
      if (aIsYear && bIsYear) {
        return parseInt(b.name) - parseInt(a.name); // Descending: 2025, 2024, 2023...
      }

      // 4. Fallback: Server sortOrder
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
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

/**
 * Builds virtual MailboxNode entries for unified mailbox roles with aggregated counts.
 */
export function buildUnifiedMailboxNodes(
  counts: Array<{ role: UnifiedMailboxRole; unreadEmails: number; totalEmails: number }>,
): MailboxNode[] {
  return counts.map((count) => ({
    id: UNIFIED_MAILBOX_IDS[count.role],
    name: count.role, // Display name is handled by i18n in the component
    role: count.role,
    parentId: undefined,
    sortOrder: 0,
    totalEmails: count.totalEmails,
    unreadEmails: count.unreadEmails,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: false,
      mayRemoveItems: false,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: false,
      mayRename: false,
      mayDelete: false,
      maySubmit: false,
    },
    isSubscribed: true,
    children: [],
    depth: 0,
  }));
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