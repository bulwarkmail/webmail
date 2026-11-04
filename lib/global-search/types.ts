import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent, ContactCard, Email, FileNode } from '@/lib/jmap/types';
import type { ParsedQuery } from '@/lib/global-search/query-parser';

/**
 * Global search ("Search everything", #641): one query across mail, contacts,
 * calendar events and files of every logged-in account.
 *
 * Every hit carries BOTH the login it is reachable through (`localAccountId`,
 * an `AccountEntry.id`) and the JMAP account that owns it (`jmapAccountId`) plus
 * the raw server id - bare ids collide across accounts (#847), so no code path
 * may ever re-find a hit by id alone.
 */
export type SearchKind = 'mail' | 'contacts' | 'calendar' | 'files';

export const SEARCH_KINDS: readonly SearchKind[] = ['mail', 'contacts', 'calendar', 'files'];

/** Where a hit came from. Remote hits win over local ones when both exist (they carry snippets). */
export type HitSource = 'local' | 'remote';

interface HitBase {
  kind: SearchKind;
  /** Login (`AccountEntry.id`) whose client reaches this item. */
  localAccountId: string;
  /** JMAP account that owns the item (the login's primary, or a shared owner). */
  jmapAccountId: string;
  /** Raw server id - never namespaced. */
  id: string;
  /** Display label of the login (`AccountEntry.label || email`). */
  accountLabel: string;
  title: string;
  /** Folder / address book / calendar / drive path - shown after the account label. */
  subtitle: string;
  /**
   * The calendar or address book in `subtitle`, and what follows it, so the screen can
   * call Stalwart's default one "Calendar" or "Contacts" in the user's language (p2-3).
   */
  collection?: { kind: 'calendar' | 'addressBook'; name: string; isShared?: boolean; rest: string };
  /** ISO timestamp used for recency ordering (receivedAt, event start, file modified). */
  date: string | null;
  source: HitSource;
  /**
   * Server the item lives on (the login's serverUrl). Lets the merge collapse
   * the same object reached through several logins to ONE result, while ids
   * from different servers stay apart (#847). Optional for injected test hits.
   */
  serverUrl?: string;
}

export interface MailHit extends HitBase {
  kind: 'mail';
  email: Email;
  /** Server-side snippet with `<mark>` around the matched terms, when the server gave one. */
  snippet: { subject: string | null; preview: string | null } | null;
}

export interface ContactHit extends HitBase {
  kind: 'contacts';
  contact: ContactCard;
  /**
   * Id under which the contact store knows this card in the Pro shell
   * (`${localAccountId}::${id}`, or `${owner}:${id}` for a shared book inside
   * that). This is what the contacts surface's deep link expects.
   */
  storeId: string;
}

export interface CalendarHit extends HitBase {
  kind: 'calendar';
  event: CalendarEvent;
  /** Master of a recurring series (server FTS returns masters, not occurrences). */
  isRecurring: boolean;
}

export interface FileHit extends HitBase {
  kind: 'files';
  node: FileNode;
  /** Absolute folder path the node lives in (`/` for the root), for the files deep link. */
  folderPath: string;
  isFolder: boolean;
}

export type GlobalSearchHit = MailHit | ContactHit | CalendarHit | FileHit;

/** One login the search fans out to. */
export interface SearchAccount {
  localAccountId: string;
  label: string;
  email: string;
  client: IJMAPClient;
  /** Server this login talks to (AccountEntry.serverUrl). */
  serverUrl?: string;
}

export interface RemoteSearchOptions {
  limit: number;
  /** Mail only: `Email/query` position for "load more". */
  position?: number;
  signal: AbortSignal;
}

export interface RemoteSearchResult {
  hits: GlobalSearchHit[];
  /** More results exist beyond `limit` (mail pagination). */
  hasMore: boolean;
}

export interface SearchProvider {
  kind: SearchKind;
  /** Synchronous hits from the caches already in memory - substring match, so partial words work. */
  local: (parsed: ParsedQuery, accounts: SearchAccount[], limit: number) => GlobalSearchHit[];
  /** One login's server hits. Throws on failure; the orchestrator turns that into a per-account error row. */
  remote: (parsed: ParsedQuery, account: SearchAccount, options: RemoteSearchOptions) => Promise<RemoteSearchResult>;
  /** False when the login's server lacks the capability - skipped without an error row. */
  supports: (account: SearchAccount) => boolean;
}

export interface SearchAccountError {
  localAccountId: string;
  accountLabel: string;
  message: string;
}

export interface KindStatus {
  /** `loading` while any account is still pending for this kind. */
  status: 'idle' | 'loading' | 'done';
  errors: SearchAccountError[];
  /** Mail: some account reported more results than were fetched. */
  hasMore: boolean;
}

export interface SearchOutcome {
  hits: Record<SearchKind, GlobalSearchHit[]>;
  status: Record<SearchKind, KindStatus>;
}

export function emptyOutcome(): SearchOutcome {
  return {
    hits: { mail: [], contacts: [], calendar: [], files: [] },
    status: {
      mail: { status: 'idle', errors: [], hasMore: false },
      contacts: { status: 'idle', errors: [], hasMore: false },
      calendar: { status: 'idle', errors: [], hasMore: false },
      files: { status: 'idle', errors: [], hasMore: false },
    },
  };
}

/** Stable identity of a hit across local/remote sources. */
export function hitKey(hit: Pick<GlobalSearchHit, 'kind' | 'localAccountId' | 'id'>): string {
  return `${hit.kind}\0${hit.localAccountId}\0${hit.id}`;
}
