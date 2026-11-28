import type { Email } from '@/lib/jmap/types';
import { emailKeyFor } from '@/lib/thread-utils';

/** One row of the message list: its own key and the keys it stands for. */
export interface ListStepRow {
  key: string;
  members: string[];
}

/**
 * The message j / k open: the one after (`direction` 1) or before (-1) the
 * message `fromKey` names, staying put at either end. `fromKey` is the open
 * message, or the last one opened when the reader was closed, so j after
 * Escape goes on from there. Without a place in the list, j starts at the
 * top and k at the bottom.
 *
 * With `rows` (the list's rows in screen order) a conversation counts once,
 * and opens at its newest message, as a click on its row does: the reading
 * pane shows the rest of it.
 */
export function stepListEmail(
  emails: readonly Email[],
  fromKey: string | null | undefined,
  direction: 1 | -1,
  rows?: readonly ListStepRow[] | null,
): Email | null {
  const byKey = new Map(emails.map((e) => [emailKeyFor(e), e] as const));
  const order: readonly ListStepRow[] = rows && rows.length > 0
    ? rows.filter((row) => byKey.has(row.key))
    : emails.map((e) => ({ key: emailKeyFor(e), members: [] }));
  if (order.length === 0) return null;
  // A message's own row first: an unfolded conversation lists its messages
  // under the conversation's row.
  const own = fromKey ? order.findIndex((row) => row.key === fromKey) : -1;
  const at = own >= 0 || !fromKey ? own : order.findIndex((row) => row.members.includes(fromKey));
  if (at < 0) return byKey.get(order[direction === 1 ? 0 : order.length - 1].key) ?? null;
  // The conversation's row and its newest message's row open the same
  // message: step past it instead of staying put.
  let target = at + direction;
  while (target >= 0 && target < order.length && order[target].key === order[at].key) target += direction;
  if (target < 0 || target >= order.length) target = at;
  return byKey.get(order[target].key) ?? null;
}

/**
 * The messages the list's rows show, in `emails`' order: a message under a
 * folded list header (a collapsed date group, a folded "Unread first"
 * section) has no row, so j / k pass it by. Without rows, all of them.
 */
export function shownListEmails(emails: readonly Email[], rows?: readonly ListStepRow[] | null): readonly Email[] {
  if (!rows) return emails;
  const shown = new Set<string>();
  for (const row of rows) {
    shown.add(row.key);
    for (const member of row.members) shown.add(member);
  }
  return emails.filter((e) => shown.has(emailKeyFor(e)));
}
