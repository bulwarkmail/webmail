import { matchesTerms, type ParsedQuery } from '@/lib/global-search/query-parser';
import { getActiveLocalAccountId, indexAccounts } from '@/lib/global-search/accounts';
import type { MailHit, SearchAccount, SearchProvider } from '@/lib/global-search/types';
import { andFilters, buildJMAPFilter } from '@/lib/jmap/search-utils';
import { knownTagIds } from '@/lib/known-tag-ids';
import { getEmailTagIds } from '@/lib/thread-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { findMailboxByRole, jmapMailboxIdOf, resolveSourceFolderName, withFolderlessExclusion, type UnifiedAccountClient } from '@/lib/unified-mailbox';
import { accountFolders, buildUnifiedAccountClients, listRowSource, useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';

function addressFields(addresses: Email['from']): string[] {
  const out: string[] = [];
  for (const address of addresses ?? []) {
    if (address.name) out.push(address.name);
    if (address.email) out.push(address.email);
  }
  return out;
}

function emailFields(email: Email): string[] {
  return [email.subject ?? '', email.preview ?? '', ...addressFields(email.from), ...addressFields(email.to)];
}

function includesCi(haystack: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return haystack.some((h) => h.toLowerCase().includes(n));
}

/** Whether a message carries a defined tag: what `is:untagged` leaves out on the server. */
function hasKnownTag(email: Email): boolean {
  const ids = getEmailTagIds(email.keywords);
  if (ids.length === 0) return false;
  const known = new Set(knownTagIds().map((id) => id.toLowerCase()));
  return ids.some((id) => known.has(id.toLowerCase()));
}

/** The structured operators, applied to an already-loaded message. */
export function emailMatchesFilters(email: Email, parsed: ParsedQuery): boolean {
  const { mail } = parsed;
  if (mail.from && !includesCi(addressFields(email.from), mail.from)) return false;
  if (mail.to && !includesCi([...addressFields(email.to), ...addressFields(email.cc)], mail.to)) return false;
  if (mail.subject && !includesCi([email.subject ?? ''], mail.subject)) return false;
  if (mail.hasAttachment !== null && Boolean(email.hasAttachment) !== mail.hasAttachment) return false;
  if (mail.isUnread !== null && Boolean(email.keywords?.$seen) === mail.isUnread) return false;
  if (mail.isStarred !== null && Boolean(email.keywords?.$flagged) !== mail.isStarred) return false;
  if (mail.untagged && hasKnownTag(email)) return false;
  const day = email.receivedAt?.slice(0, 10) ?? '';
  if (mail.dateAfter && day < mail.dateAfter) return false;
  if (mail.dateBefore && day > mail.dateBefore) return false;
  return true;
}

function folderOf(email: Email, mailboxes: Mailbox[]): string {
  if (email.sourceFolder) return email.sourceFolder;
  return resolveSourceFolderName(email, mailboxes) ?? '';
}

function toHit(email: Email, account: SearchAccount, jmapAccountId: string, folder: string, source: 'local' | 'remote'): MailHit {
  return {
    kind: 'mail',
    serverUrl: account.serverUrl,
    localAccountId: account.localAccountId,
    jmapAccountId,
    id: email.id,
    accountLabel: account.label,
    title: email.subject ?? '',
    subtitle: folder,
    date: email.receivedAt ?? null,
    source,
    email,
    snippet: email.searchSnippet ?? null,
  };
}

type JmapFilter = Record<string, unknown>;

/**
 * The default scope is "everything but Trash and Junk" (#641's "Most");
 * `in:trash` / `in:junk` search that folder alone and `is:anything` lifts the
 * exclusion. An account without the requested role has nothing to search.
 */
export function mailFilterFor(parsed: ParsedQuery, entry: UnifiedAccountClient): JmapFilter | null {
  const base = buildJMAPFilter(parsed.text, parsed.mail, undefined, knownTagIds());
  if (parsed.mailboxRole) {
    const mailbox = findMailboxByRole(entry.mailboxes, parsed.mailboxRole);
    return mailbox ? andFilters(base, { inMailbox: jmapMailboxIdOf(entry, mailbox) }) : null;
  }
  // `is:anything` lifts Trash and Junk, never the team notes.
  return withFolderlessExclusion(base, entry, !parsed.includeTrashAndJunk);
}

export const mailProvider: SearchProvider = {
  kind: 'mail',

  supports: () => true,

  local: (parsed, accounts, limit) => {
    const byId = indexAccounts(accounts);
    const active = getActiveLocalAccountId();
    const state = useEmailStore.getState();
    const { emails, mailboxes } = state;
    const role = parsed.mailboxRole;
    const sourceOf = role ? listRowSource(state) : null;
    const hits: MailHit[] = [];
    for (const email of emails) {
      const source = sourceOf?.(email);
      const localAccountId = source ? source.login : email.sourceClientAccountId ?? active;
      if (!localAccountId) continue;
      const account = byId.get(localAccountId);
      if (!account) continue;
      if (!matchesTerms(parsed.terms, emailFields(email))) continue;
      if (!emailMatchesFilters(email, parsed)) continue;
      if (role) {
        // Mailbox ids can repeat across logins and JMAP owners. Only publish a
        // cached hit when the folders of the message's own source confirm it.
        const ownAccountId = account.client.getAccountId();
        const jmapAccountId = source?.account ?? ownAccountId;
        const mailbox = findMailboxByRole(accountFolders(state, localAccountId, jmapAccountId, ownAccountId), role);
        if (!mailbox || !(email.mailboxIds?.[mailbox.id] || (mailbox.originalId && email.mailboxIds?.[mailbox.originalId]))) continue;
        hits.push(toHit(email, account, jmapAccountId, mailbox.name, 'local'));
      } else {
        const mailbox = mailboxes.find((mb) => email.mailboxIds?.[mb.id]);
        const jmapAccountId = email.sourceAccountId
          ?? (mailbox?.isShared && mailbox.accountId ? mailbox.accountId : account.client.getAccountId());
        hits.push(toHit(email, account, jmapAccountId, folderOf(email, mailboxes), 'local'));
      }
      if (hits.length >= limit) break;
    }
    return hits;
  },

  remote: async (parsed, account, { limit, position = 0, signal }) => {
    const includeGroup = useSettingsStore.getState().includeGroupInUnified ?? true;
    const entries = await buildUnifiedAccountClients({ includeGroup, scopeToClientAccountId: account.localAccountId });
    const hits: MailHit[] = [];
    let hasMore = false;
    // Sequential on purpose: the orchestrator already runs logins in
    // parallel, and every request here pins one of the login's sockets (#702).
    for (const entry of entries) {
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const filter = mailFilterFor(parsed, entry);
      if (!filter) continue;
      const result = await entry.client.advancedSearchEmails(
        filter,
        entry.isShared ? entry.jmapAccountId : undefined,
        limit,
        position,
        { palette: true },
      );
      if (result.hasMore) hasMore = true;
      for (const raw of result.emails) {
        const email: Email = {
          ...raw,
          accountId: entry.accountId,
          accountLabel: entry.accountLabel,
          sourceClientAccountId: entry.clientAccountId,
          sourceAccountId: entry.jmapAccountId,
          sourceFolder: resolveSourceFolderName(raw, entry.mailboxes),
        };
        hits.push(toHit(email, account, entry.jmapAccountId, email.sourceFolder ?? '', 'remote'));
      }
    }
    return { hits, hasMore };
  },
};
