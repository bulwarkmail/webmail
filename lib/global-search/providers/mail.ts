import { matchesTerms, type ParsedQuery } from '@/lib/global-search/query-parser';
import { getActiveLocalAccountId, indexAccounts } from '@/lib/global-search/accounts';
import type { MailHit, SearchAccount, SearchProvider } from '@/lib/global-search/types';
import { andFilters, buildJMAPFilter } from '@/lib/jmap/search-utils';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { findMailboxByRole, jmapMailboxIdOf, resolveSourceFolderName, trashAndJunkExclusion, type UnifiedAccountClient } from '@/lib/unified-mailbox';
import { buildUnifiedAccountClients, useEmailStore } from '@/stores/email-store';
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

/** The structured operators, applied to an already-loaded message. */
export function emailMatchesFilters(email: Email, parsed: ParsedQuery): boolean {
  const { mail } = parsed;
  if (mail.from && !includesCi(addressFields(email.from), mail.from)) return false;
  if (mail.to && !includesCi([...addressFields(email.to), ...addressFields(email.cc)], mail.to)) return false;
  if (mail.subject && !includesCi([email.subject ?? ''], mail.subject)) return false;
  if (mail.hasAttachment !== null && Boolean(email.hasAttachment) !== mail.hasAttachment) return false;
  if (mail.isUnread !== null && Boolean(email.keywords?.$seen) === mail.isUnread) return false;
  if (mail.isStarred !== null && Boolean(email.keywords?.$flagged) !== mail.isStarred) return false;
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
 * exclusion. Servers without those role folders just search everything.
 */
export function mailFilterFor(parsed: ParsedQuery, entry: UnifiedAccountClient): JmapFilter {
  const base = buildJMAPFilter(parsed.text, parsed.mail);
  if (parsed.mailboxRole) {
    const mailbox = findMailboxByRole(entry.mailboxes, parsed.mailboxRole);
    return mailbox ? andFilters(base, { inMailbox: jmapMailboxIdOf(entry, mailbox) }) : base;
  }
  if (parsed.includeTrashAndJunk) return base;
  return andFilters(base, trashAndJunkExclusion(entry));
}

export const mailProvider: SearchProvider = {
  kind: 'mail',

  supports: () => true,

  local: (parsed, accounts, limit) => {
    const byId = indexAccounts(accounts);
    const active = getActiveLocalAccountId();
    const { emails, mailboxes } = useEmailStore.getState();
    const hits: MailHit[] = [];
    for (const email of emails) {
      const localAccountId = email.sourceClientAccountId ?? active;
      if (!localAccountId) continue;
      const account = byId.get(localAccountId);
      if (!account) continue;
      if (!matchesTerms(parsed.terms, emailFields(email))) continue;
      if (!emailMatchesFilters(email, parsed)) continue;
      const mailbox = mailboxes.find((mb) => email.mailboxIds?.[mb.id]);
      const jmapAccountId = email.sourceAccountId
        ?? (mailbox?.isShared && mailbox.accountId ? mailbox.accountId : account.client.getAccountId());
      hits.push(toHit(email, account, jmapAccountId, folderOf(email, mailboxes), 'local'));
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
      const result = await entry.client.advancedSearchEmails(
        mailFilterFor(parsed, entry),
        entry.isShared ? entry.jmapAccountId : undefined,
        limit,
        position,
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
