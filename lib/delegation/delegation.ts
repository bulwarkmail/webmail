/**
 * Delegates (Settings > Sharing): give one person access to mail, calendars
 * and contacts in one step, list who has access to what, and take it away
 * everywhere. Pure functions over the user's shareable items
 * (JMAPClient.getShareTargets); JMAPClient.applyShareChanges sends what they
 * build.
 *
 * Stalwart has no "send as" or "send on behalf" for a person's own account,
 * so delegates get no submission right; the dialog says so.
 */

import type { ShareChange, ShareChangeResult, ShareTarget } from '@/lib/jmap/share-batch';
import { accessLevelOf, accessRights, detectPreset, type AccessLevel, type ShareKind } from '@/lib/jmap/share-rights';

/** `keep`: "Keep as it is", offered by Change when what the person has fits no other choice. */
export type MailScope = 'all' | 'inbox' | 'none' | 'keep';
export type CollectionScope = 'default' | 'all' | 'none' | 'keep';
export type LevelChoice = AccessLevel | 'keep';

/** What a delegate gets: which folders, calendars and address books. */
export interface DelegateScope {
  mail: MailScope;
  calendars: CollectionScope;
  addressBooks: CollectionScope;
}

type DelegateKind = 'mailbox' | 'calendar' | 'addressBook';
const SCOPE_KEY: Record<DelegateKind, keyof DelegateScope> = { mailbox: 'mail', calendar: 'calendars', addressBook: 'addressBooks' };
const DELEGATE_KINDS: DelegateKind[] = ['mailbox', 'calendar', 'addressBook'];

export const DEFAULT_DELEGATE_SCOPE: DelegateScope = { mail: 'all', calendars: 'default', addressBooks: 'default' };

export const ACCESS_LEVELS: readonly AccessLevel[] = ['read', 'write'];

// Bulwark's own list of senders whose images load (stores/contact-store.ts,
// TRUSTED_SENDERS_BOOK_NAME). It is an address book on the server, but not
// one a delegate needs.
const TRUSTED_SENDERS_BOOK_NAME = 'Trusted Senders';

function ofKind(targets: ShareTarget[], kind: ShareKind): ShareTarget[] {
  return targets.filter((t) => t.kind === kind);
}

function defaultOf(collections: ShareTarget[]): ShareTarget[] {
  const flagged = collections.find((c) => c.isDefault);
  return flagged ? [flagged] : collections.slice(0, 1);
}

function delegableAddressBooks(targets: ShareTarget[]): ShareTarget[] {
  return ofKind(targets, 'addressBook').filter((b) => b.name !== TRUSTED_SENDERS_BOOK_NAME || b.isDefault);
}

/** The items of one type the dialog's choices are about. */
function itemsOfType(targets: ShareTarget[], kind: DelegateKind): ShareTarget[] {
  return kind === 'addressBook' ? delegableAddressBooks(targets) : ofKind(targets, kind);
}

const isInbox = (t: ShareTarget) => t.role?.toLowerCase() === 'inbox';

/** The items one choice covers; null for "Keep as it is". */
function itemsFor(targets: ShareTarget[], kind: DelegateKind, choice: MailScope | CollectionScope): ShareTarget[] | null {
  if (choice === 'keep') return null;
  const items = itemsOfType(targets, kind);
  if (choice === 'none') return [];
  if (choice === 'all') return items;
  if (choice === 'inbox') return items.filter(isInbox);
  return defaultOf(items);
}

/** The items a scope covers. Files are never part of it, nor types left as they are. */
export function selectTargets(targets: ShareTarget[], scope: DelegateScope): ShareTarget[] {
  return DELEGATE_KINDS.flatMap((kind) => itemsFor(targets, kind, scope[SCOPE_KEY[kind]]) ?? []);
}

function change(target: ShareTarget, principalId: string, rights: ShareChange['rights']): ShareChange {
  return { kind: target.kind, accountId: target.accountId, id: target.id, name: target.name, principalId, rights };
}

/** read or write when every grant of one type has exactly that preset, otherwise null. */
function uniformLevel(items: ShareTarget[], kind: ShareKind, principalId: string): AccessLevel | null {
  const presets = new Set(items.filter((t) => principalId in t.shareWith).map((t) => detectPreset(kind, t.shareWith[principalId])));
  if (presets.size !== 1) return null;
  const [preset] = [...presets];
  return preset === 'read' ? 'read' : preset === 'readWrite' ? 'write' : null;
}

/**
 * The changes that give `principalId` access to what `scope` covers at
 * `level`. A type left as it is ("keep") gets no change at all. With
 * `replace` (the "Change" of someone who already has access), the items of a
 * chosen type outside the scope lose their access; shared files stay as they
 * are, since the dialog doesn't offer them. With level "keep", items the
 * person has keep their rights and items added get the rights the rest of
 * that type has, or read.
 */
export function buildGrantChanges(
  targets: ShareTarget[],
  principalId: string,
  scope: DelegateScope,
  level: LevelChoice,
  options: { replace?: boolean } = {},
): ShareChange[] {
  const changes: ShareChange[] = [];
  for (const kind of DELEGATE_KINDS) {
    const chosen = itemsFor(targets, kind, scope[SCOPE_KEY[kind]]);
    if (!chosen) continue;
    const all = itemsOfType(targets, kind);
    const typeLevel = uniformLevel(all, kind, principalId) ?? 'read';
    const ids = new Set(chosen.map((t) => t.id));
    for (const t of chosen) {
      if (level === 'keep') {
        if (principalId in t.shareWith) continue;
        changes.push(change(t, principalId, accessRights(kind, typeLevel)));
      } else {
        changes.push(change(t, principalId, accessRights(kind, level)));
      }
    }
    if (options.replace) {
      for (const t of all) {
        if (!ids.has(t.id) && principalId in t.shareWith) changes.push(change(t, principalId, null));
      }
    }
  }
  return changes;
}

/** The changes that take every grant of `principalId` away, files included. */
export function buildRevokeChanges(targets: ShareTarget[], principalId: string): ShareChange[] {
  return targets.filter((t) => principalId in t.shareWith).map((t) => change(t, principalId, null));
}

export interface DelegateItem {
  kind: ShareKind;
  id: string;
  name: string;
  /** null: shared without read access (calendar free/busy only). */
  level: AccessLevel | null;
}

export interface DelegateSummary {
  principalId: string;
  /** "mixed" when some items are read only and others writable; null when nothing is readable. */
  level: AccessLevel | 'mixed' | null;
  mail: { shared: number; total: number; inbox: boolean };
  calendars: { shared: number; total: number };
  addressBooks: { shared: number; total: number };
  files: number;
  items: DelegateItem[];
}

/**
 * Everyone who has access to something of the user's, one entry per person
 * or group, in the order they first appear. `excludeIds` leaves out the
 * user's own principal, should a server list it.
 */
export function summarizeDelegates(targets: ShareTarget[], excludeIds: string[] = []): DelegateSummary[] {
  const exclude = new Set(excludeIds);
  const byPrincipal = new Map<string, DelegateItem[]>();
  for (const target of targets) {
    for (const [principalId, rights] of Object.entries(target.shareWith)) {
      if (exclude.has(principalId) || !rights) continue;
      const items = byPrincipal.get(principalId) ?? [];
      items.push({ kind: target.kind, id: target.id, name: target.name, level: accessLevelOf(target.kind, rights) });
      byPrincipal.set(principalId, items);
    }
  }

  const totals = {
    mailbox: ofKind(targets, 'mailbox').length,
    calendar: ofKind(targets, 'calendar').length,
    addressBook: delegableAddressBooks(targets).length,
  };
  const inboxIds = new Set(ofKind(targets, 'mailbox').filter((m) => m.role?.toLowerCase() === 'inbox').map((m) => m.id));

  return [...byPrincipal.entries()].map(([principalId, items]) => {
    const count = (kind: ShareKind) => items.filter((i) => i.kind === kind).length;
    const levels = new Set(items.map((i) => i.level).filter((l): l is AccessLevel => l !== null));
    return {
      principalId,
      level: levels.size === 0 ? null : levels.size > 1 ? 'mixed' : [...levels][0],
      mail: { shared: count('mailbox'), total: totals.mailbox, inbox: items.some((i) => i.kind === 'mailbox' && inboxIds.has(i.id)) },
      calendars: { shared: count('calendar'), total: totals.calendar },
      addressBooks: { shared: count('addressBook'), total: totals.addressBook },
      files: count('file'),
      items,
    };
  });
}

/** One thing the user shares and everyone who has it (#1171). */
export interface SharedItem {
  target: ShareTarget;
  /** Mail folders: the folders above it, outermost first. */
  parents: ShareTarget[];
  grants: { principalId: string; level: AccessLevel | null }[];
}

const KIND_ORDER: ShareKind[] = ['mailbox', 'calendar', 'addressBook', 'file'];

/**
 * Every folder, calendar, address book and file shared with someone, with
 * whom and at which level: mail first, then calendars, contacts and files,
 * each in the server's order. `excludeIds` as in summarizeDelegates.
 */
export function sharedItems(targets: ShareTarget[], excludeIds: string[] = []): SharedItem[] {
  const exclude = new Set(excludeIds);
  const mailboxes = new Map(ofKind(targets, 'mailbox').map((t) => [t.id, t]));
  const parentsOf = (target: ShareTarget): ShareTarget[] => {
    const parents: ShareTarget[] = [];
    const seen = new Set<string>([target.id]);
    let parentId = target.parentId;
    while (parentId && !seen.has(parentId)) {
      const parent = mailboxes.get(parentId);
      if (!parent) break;
      seen.add(parentId);
      parents.unshift(parent);
      parentId = parent.parentId;
    }
    return parents;
  };
  const items: SharedItem[] = [];
  for (const kind of KIND_ORDER) {
    for (const target of ofKind(targets, kind)) {
      const grants = Object.entries(target.shareWith)
        .filter(([principalId, rights]) => !exclude.has(principalId) && !!rights)
        .map(([principalId, rights]) => ({ principalId, level: accessLevelOf(kind, rights) }));
      if (grants.length === 0) continue;
      items.push({ target, parents: kind === 'mailbox' ? parentsOf(target) : [], grants });
    }
  }
  return items;
}

export interface ChangeStart {
  scope: DelegateScope;
  level: LevelChoice;
}

/**
 * The dialog's starting point for "Change". A type gets a choice only when
 * the person's grants match it exactly (every folder for "all", exactly the
 * Inbox for "Inbox only", exactly the default calendar, ...), all with the
 * read or the read-and-write preset. Anything else (a folder added since,
 * another single folder, free/busy only, manager or custom rights) starts
 * as "Keep as it is", which leaves that type out of the patch. The level is
 * read or write when every grant has that preset, else "keep". Without
 * write among `allowed`, a level that would keep or give write starts at
 * read: saving then lowers the types the user chose to read.
 */
export function changeStartFor(targets: ShareTarget[], principalId: string, allowed: AccessLevel[] = [...ACCESS_LEVELS]): ChangeStart {
  const scopeFor = (kind: DelegateKind): MailScope | CollectionScope => {
    // Address books Delegates doesn't offer still count: a grant there isn't one the dialog can express.
    const relevant = kind === 'addressBook' ? ofKind(targets, kind) : itemsOfType(targets, kind);
    const shared = relevant.filter((t) => principalId in t.shareWith);
    if (shared.length === 0) return 'none';
    if (shared.some((t) => !['read', 'readWrite'].includes(detectPreset(kind, t.shareWith[principalId])))) return 'keep';
    const ids = shared.map((t) => t.id).sort().join('\n');
    const exact = (choice: MailScope | CollectionScope) => {
      const covered = itemsFor(targets, kind, choice) ?? [];
      return covered.length > 0 && covered.map((t) => t.id).sort().join('\n') === ids;
    };
    if (kind === 'mailbox') return exact('all') ? 'all' : exact('inbox') ? 'inbox' : 'keep';
    return exact('default') ? 'default' : exact('all') ? 'all' : 'keep';
  };
  const scope: DelegateScope = {
    mail: scopeFor('mailbox') as MailScope,
    calendars: scopeFor('calendar') as CollectionScope,
    addressBooks: scopeFor('addressBook') as CollectionScope,
  };

  const granted = targets.filter((t) => t.kind !== 'file' && principalId in t.shareWith);
  const presets = new Set(granted.map((t) => detectPreset(t.kind, t.shareWith[principalId])));
  let level: LevelChoice = presets.size === 1 && presets.has('read') ? 'read'
    : presets.size === 1 && presets.has('readWrite') ? 'write'
      : 'keep';
  const hasWrite = granted.some((t) => accessLevelOf(t.kind, t.shareWith[principalId]) === 'write');
  if (!allowed.includes('write') && (level === 'write' || (level === 'keep' && hasWrite))) level = 'read';
  else if (level !== 'keep' && !allowed.includes(level)) level = 'keep';
  return { scope, level };
}

/**
 * The levels the admin allows (`sharingRights.allowedValues`). Values
 * other than "read" and "write" are ignored; a list with neither leaves
 * read only, the safe end.
 */
export function allowedLevels(allowedValues: unknown[] | null): AccessLevel[] {
  if (!allowedValues) return [...ACCESS_LEVELS];
  const allowed = ACCESS_LEVELS.filter((level) => allowedValues.includes(level));
  return allowed.length > 0 ? allowed : ['read'];
}

/** Whether a scope gives access to nothing at all. */
export function scopeIsEmpty(scope: DelegateScope): boolean {
  return Object.values(scope).every((choice) => choice === 'none');
}

/** The changes that failed, for the report and for "Try again". */
export function failedChanges(results: ShareChangeResult[]): ShareChangeResult[] {
  return results.filter((r) => !r.ok);
}
