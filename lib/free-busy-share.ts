/**
 * Sharing the user's free/busy with a group.
 *
 * Stalwart answers Principal/getAvailability only from calendars shared with
 * the person asking (mayReadFreeBusy or mayReadItems, to them or a group they
 * are in), so on a fresh server "Suggest times" sees nobody busy
 * (local-data/enterprise-pack-facts.md part 6 §1). Two ways to fix that:
 *
 * - the admin names a group in organisation.calendars.freeBusyGroup, and
 *   Bulwark shares each user's default calendar with it at sign-in;
 * - a user shares their own with one click (Calendar settings, the Find a
 *   time note).
 *
 * Both only add: an existing share of the group keeps its rights, with
 * mayReadFreeBusy added when it lacked it, and no other share is touched.
 * The share is an ordinary one, so it shows in the calendar's sharing list.
 */

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar, CalendarRights } from '@/lib/jmap/types';
import { CALENDAR_PRESETS } from '@/lib/jmap/share-rights';

type ShareClient = Pick<IJMAPClient, 'getAllCalendars' | 'setCalendarShare' | 'getSharedAccounts' | 'getAccountInfo' | 'findPrincipalByEmail'>;

export type FreeBusyShareResult = 'shared' | 'already' | 'no-calendar' | 'no-group';

/** The user's own default calendar: the server's default, else the first event calendar. */
export function ownDefaultCalendar(calendars: Calendar[]): Calendar | null {
  const own = calendars.filter((c) => !c.isShared && !c.isTasksOnly);
  return own.find((c) => c.isDefault) ?? own[0] ?? null;
}

/**
 * The principal id of a group address: the group account in the session
 * (Stalwart uses the account id as the principal id), else a directory
 * lookup. Null when neither knows it.
 */
export async function groupPrincipalId(client: ShareClient, address: string): Promise<string | null> {
  const wanted = address.trim().toLowerCase();
  if (!wanted) return null;
  const account = (typeof client.getSharedAccounts === 'function' ? client.getSharedAccounts() : [])
    .find((a) => !a.isPrimary && a.name.trim().toLowerCase() === wanted && client.getAccountInfo?.(a.id)?.isPersonal === false);
  if (account) return account.id;
  if (!client.findPrincipalByEmail) return null;
  const found = await client.findPrincipalByEmail(wanted).catch(() => null);
  const principal = found?.principal;
  // Only a principal that says it is a group: an address typed by mistake
  // must not share everyone's free/busy with one person.
  return principal?.type === 'group' ? principal.id : null;
}

/** Whether `calendar` already lets the principal see its free/busy. */
export function sharesFreeBusyWith(calendar: Pick<Calendar, 'shareWith'>, principalId: string): boolean {
  const rights = calendar.shareWith?.[principalId];
  return !!rights && (rights.mayReadFreeBusy || rights.mayReadItems);
}

/** The rights to write for the principal: what it has plus mayReadFreeBusy. */
export function withFreeBusy(existing: CalendarRights | undefined): CalendarRights {
  return existing ? { ...existing, mayReadFreeBusy: true } : { ...CALENDAR_PRESETS.freeBusy };
}

/** Share the user's default calendar's free/busy with the group at `address`. */
export async function ensureFreeBusyShare(client: ShareClient, address: string): Promise<FreeBusyShareResult> {
  const principalId = await groupPrincipalId(client, address);
  if (!principalId) return 'no-group';
  const calendar = ownDefaultCalendar(await client.getAllCalendars());
  if (!calendar) return 'no-calendar';
  if (sharesFreeBusyWith(calendar, principalId)) return 'already';
  await client.setCalendarShare(calendar.originalId ?? calendar.id, principalId, withFreeBusy(calendar.shareWith?.[principalId]));
  return 'shared';
}

/**
 * Whether the user's default calendar shares free/busy with the group, or
 * null when that can't be told (no calendar, unknown group).
 */
export async function freeBusyShareState(client: ShareClient, address: string): Promise<boolean | null> {
  const principalId = await groupPrincipalId(client, address);
  if (!principalId) return null;
  const calendar = ownDefaultCalendar(await client.getAllCalendars());
  return calendar ? sharesFreeBusyWith(calendar, principalId) : null;
}

/**
 * The groups a user can share with from the button: the admin's group when
 * one is set, else the group accounts in the session.
 */
export function freeBusyShareGroups(client: Pick<IJMAPClient, 'getSharedAccounts' | 'getAccountInfo'> | null, adminGroup: string): string[] {
  if (adminGroup) return [adminGroup.toLowerCase()];
  if (!client || typeof client.getSharedAccounts !== 'function') return [];
  return client.getSharedAccounts()
    .filter((a) => !a.isPrimary && a.name.includes('@') && client.getAccountInfo?.(a.id)?.isPersonal === false)
    .map((a) => a.name.trim().toLowerCase())
    .sort();
}

// Once per page load and account: the admin's share is applied at sign-in,
// and a user who removes it later gets it back at the next one.
const applied = new Set<string>();

/**
 * Apply the admin's free/busy group to the signed-in account. Never throws;
 * a failure is tried again on the next sign-in or page load.
 */
export async function applyAdminFreeBusyShare(client: ShareClient & Pick<IJMAPClient, 'getAccountId'>, group: string): Promise<FreeBusyShareResult | null> {
  if (!group) return null;
  const key = `${client.getAccountId()}|${group.toLowerCase()}`;
  if (applied.has(key)) return null;
  applied.add(key);
  try {
    return await ensureFreeBusyShare(client, group);
  } catch {
    applied.delete(key);
    return null;
  }
}

/** For tests. */
export function resetAppliedFreeBusyShares(): void {
  applied.clear();
}
