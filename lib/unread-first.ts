import type { Email } from '@/lib/jmap/types';
import type { InterfaceLayout, MvInboxType } from '@/stores/settings-store';
import { threadKeyFor } from '@/lib/thread-utils';
import { compareEmails } from '@/lib/message-list-order';

/**
 * Mountain View's "Unread first" inbox, as Gmail has it: the newest unread
 * mail in a section of its own above "Everything else", which is the rest
 * of the inbox, read mail only.
 *
 * Both sections live in the one loaded list (`emails` in the email store),
 * since every action on a message looks it up there. The section's rows go
 * first and are named by `UnreadSection.ids`; they are not part of the
 * server order of the main query, so paging leaves them out of its offset.
 */

/** How many unread messages the section shows, as in Gmail. */
export const UNREAD_SECTION_SIZE = 25;

/** The main query of the view: what is not in the Unread section. */
export const READ_FILTER: Record<string, unknown> = { hasKeyword: '$seen' };
export const UNREAD_FILTER: Record<string, unknown> = { notKeyword: '$seen' };

export interface UnreadSection {
  /** The folder the section was loaded for. */
  mailboxId: string;
  /** The rows of `emails` that are the section's. */
  ids: Set<string>;
  /** How many unread messages the folder has in all. */
  total: number;
}

export interface UnreadFirstView {
  interfaceLayout: InterfaceLayout;
  mvInboxType: MvInboxType;
  mailboxRole?: string | null;
  /** A search, tag, unified or cross view shows something else than the folder. */
  otherView: boolean;
}

export function isUnreadFirstView(view: UnreadFirstView): boolean {
  return view.interfaceLayout === 'mountain-view'
    && view.mvInboxType === 'unread-first'
    && view.mailboxRole === 'inbox'
    && !view.otherView;
}

/** Two filter fragments ANDed; either may be missing. */
export function andFilters(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return { operator: 'AND', conditions: [a, b] };
}

/** How many rows of the list are the section's, which the main query's offset must not count. */
export function unreadSectionRowCount(emails: Email[], section: UnreadSection | null): number {
  if (!section || section.ids.size === 0) return 0;
  let count = 0;
  for (const email of emails) if (section.ids.has(email.id)) count++;
  return count;
}

/**
 * The section's rows of the open conversation. They stay in the section,
 * read or not, until something else is opened: the message read is still
 * where it was opened, so the next one after it is the next unread one
 * (#1453), and "mark as unread" finds it there.
 */
export function openSectionRows(emails: Email[], section: UnreadSection | null, openThreadKey: string | null): Set<string> {
  const ids = new Set<string>();
  if (!section || !openThreadKey) return ids;
  for (const email of emails) {
    if (section.ids.has(email.id) && threadKeyFor(email) === openThreadKey) ids.add(email.id);
  }
  return ids;
}

/** The section without the rows a page of the main query has just reached, but for the `kept` ones. */
export function withoutReached(
  section: UnreadSection | null,
  reached: Iterable<string>,
  kept?: ReadonlySet<string>,
): UnreadSection | null {
  if (!section) return section;
  let ids: Set<string> | null = null;
  for (const id of reached) {
    if (!section.ids.has(id) || kept?.has(id)) continue;
    ids ??= new Set(section.ids);
    ids.delete(id);
  }
  return ids ? { ...section, ids } : section;
}

/**
 * Put a freshly loaded section into the list. Rows of the old section that
 * are gone from it leave the list, except the open conversation's: every
 * action looks its message up in the list, so "mark as unread" on the mail
 * just read must still find it. They keep their place in the section, the
 * order it is loaded in, or the message after the one archived would be
 * the first read one (#1453).
 */
export function mergeUnreadSection(
  emails: Email[],
  previous: UnreadSection | null,
  fresh: Email[],
  openThreadKey: string | null,
): { emails: Email[]; ids: Set<string> } {
  const freshIds = new Set(fresh.map((e) => e.id));
  const ids = new Set(freshIds);
  const kept: Email[] = [];
  const rest: Email[] = [];
  for (const email of emails) {
    if (freshIds.has(email.id)) continue;
    if (previous?.ids.has(email.id)) {
      if (openThreadKey && threadKeyFor(email) === openThreadKey) {
        kept.push(email);
        ids.add(email.id);
      }
      continue;
    }
    rest.push(email);
  }
  const section = [...fresh];
  for (const email of kept) {
    const at = section.findIndex((other) => sectionOrder(email, other) < 0);
    section.splice(at === -1 ? section.length : at, 0, email);
  }
  return { emails: [...section, ...rest], ids };
}

/** The order loadUnreadSection asks the server for. */
const sectionOrder = compareEmails([], { pinnedFirst: true });

/** A section put back together from a list remembered or restored without one: its unread rows. */
export function sectionFromUnreadRows(emails: Email[], mailboxId: string, total?: number): UnreadSection {
  const ids = new Set(emails.filter((e) => !e.keywords?.$seen).map((e) => e.id));
  return { mailboxId, ids, total: Math.max(total ?? 0, ids.size) };
}
