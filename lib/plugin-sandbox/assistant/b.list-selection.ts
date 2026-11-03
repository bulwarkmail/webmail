// Area b of the assistant's host APIs: the messages ticked in the list, as
// the reader panel's `listSelection` prop, so the assistant can work on
// several at once ("summarise these").

import { useMemo } from 'react';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { resolveEmailBlobContext, resolveSelectedEmails, useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import type { ListSelectionView } from './b.types';

/** Most messages the prop names; `total` still counts them all. */
export const MAX_LIST_SELECTION = 50;

type SelectionState = Parameters<typeof resolveSelectedEmails>[0];

/**
 * The ticked messages when two or more are, else null. Each names the
 * account it is in, so api.email.get and getThread read it from there.
 * Rows of another connected login are left out of `emails` (this login
 * can't read them) but counted in `total`.
 */
export function listSelectionOf(state: SelectionState, client: IJMAPClient | null): ListSelectionView | null {
  const total = state.selectedEmailKeys.size;
  if (total < 2) return null;
  const emails: ListSelectionView['emails'] = [];
  for (const email of resolveSelectedEmails(state)) {
    if (emails.length >= MAX_LIST_SELECTION) break;
    const owner = client ? resolveEmailBlobContext(email, client) : null;
    if (owner && owner.client !== client) continue;
    const accountId = owner?.accountId ?? email.sourceAccountId ?? client?.getAccountId();
    emails.push({ id: email.id, ...(accountId ? { accountId } : {}) });
  }
  return { emails, total };
}

/**
 * listSelectionOf for the list on screen; the same object while the
 * selection stays the same. The store is read through one selector that
 * answers a string, so new mail, a search or a moved message re-render the
 * caller only when the ticked messages change. `enabled` false (a Pro tab,
 * whose panel isn't about the main list) always answers null.
 */
export function useListSelection(enabled = true): ListSelectionView | null {
  const client = useAuthStore((s) => s.client);
  const key = useEmailStore((s) => (enabled ? JSON.stringify(listSelectionOf(s, client)) : 'null'));
  return useMemo(() => JSON.parse(key) as ListSelectionView | null, [key]);
}
