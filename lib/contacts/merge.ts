/**
 * Duplicate contacts: finding them and merging several cards into one.
 *
 * Merging keeps the most recently changed card and adds to it what the
 * others have and it lacks: every e-mail address, phone, address, note and
 * the like that isn't already there, and single fields (name, language…) it
 * has none of, from the newest card that has one. Entries are copied as they
 * are, structured parts and order included; nothing of the kept card is
 * rewritten. The other cards are deleted and their group memberships move
 * to the kept card.
 */

import type { ContactCard } from '@/lib/jmap/types';

// ─── Finding duplicates ─────────────────────────────────────────────────────

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The name as a key: case, accents, order and commas don't count ("Müller, Anna" = "anna muller"). */
export function nameKey(card: ContactCard): string {
  const components = card.name?.components ?? [];
  const parts = components
    .filter((c) => c.kind === 'given' || c.kind === 'surname' || c.kind === 'given2')
    .map((c) => c.value);
  const text = parts.length > 0 ? parts.join(' ') : card.name?.full ?? '';
  const words = fold(text).split(/[\s,]+/).filter(Boolean).sort();
  const key = words.join(' ');
  return key.length >= 3 ? key : '';
}

/** The phone's last eight digits, so "+49 30 550000" and "030 550000" match. */
export function phoneKey(number: string): string {
  const digits = number.replace(/\D/g, '');
  return digits.length >= 7 ? digits.slice(-8) : '';
}

/** Cards of one account and the same shared account can be merged. */
export function ownerKey(card: ContactCard): string {
  return `${card.localAccountId ?? ''}|${card.isShared ? card.accountId ?? '' : ''}`;
}

/** Groups of likely duplicates: the same name, e-mail address or phone, within one account. */
export function findDuplicateGroups(contacts: ContactCard[]): ContactCard[][] {
  const cards = contacts.filter((c) => c.kind !== 'group');
  const parent = cards.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const seen = new Map<string, number>();
  const link = (key: string, i: number) => {
    const first = seen.get(key);
    if (first === undefined) seen.set(key, i);
    else parent[find(i)] = find(first);
  };
  cards.forEach((card, i) => {
    const owner = ownerKey(card);
    const name = nameKey(card);
    if (name) link(`n|${owner}|${name}`, i);
    for (const email of Object.values(card.emails ?? {})) {
      const address = email?.address?.trim().toLowerCase();
      if (address) link(`e|${owner}|${address}`, i);
    }
    for (const phone of Object.values(card.phones ?? {})) {
      const key = phone?.number ? phoneKey(phone.number) : '';
      if (key) link(`p|${owner}|${key}`, i);
    }
  });
  const groups = new Map<number, ContactCard[]>();
  cards.forEach((card, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), card]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

// ─── Merging ────────────────────────────────────────────────────────────────

/** Maps of entries: everything the cards have, without exact repeats. */
const MULTI_KEYS = [
  'emails', 'phones', 'addresses', 'onlineServices', 'notes', 'nicknames', 'organizations', 'titles',
  'anniversaries', 'personalInfo', 'relatedTo', 'cryptoKeys', 'links', 'directories', 'preferredLanguages',
  'calendars', 'schedulingAddresses',
] as const;

/** One value per card: the kept card's, else the newest other card's. */
const SINGLE_KEYS = ['name', 'language', 'speakToAs'] as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((k) => k !== 'pref' && (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function addressText(entry: Record<string, unknown>): string {
  const components = entry.components as Array<{ kind: string; value: string }> | undefined;
  const parts = components?.length
    ? components.filter((c) => c.kind !== 'separator').map((c) => c.value)
    : ['street', 'locality', 'region', 'postcode', 'country'].map((k) => entry[k] as string | undefined);
  const text = parts.filter(Boolean).join(' ') || (entry.full as string | undefined) || (entry.fullAddress as string | undefined) || '';
  return fold(text);
}

/** What makes two entries of a map the same thing. */
function entrySignature(key: typeof MULTI_KEYS[number], entry: Record<string, unknown>): string {
  switch (key) {
    case 'emails': return String(entry.address ?? '').trim().toLowerCase();
    case 'phones': return phoneKey(String(entry.number ?? '')) || String(entry.number ?? '').replace(/\s/g, '');
    case 'addresses': return addressText(entry);
    case 'onlineServices': return String(entry.uri ?? entry.user ?? '').trim().toLowerCase();
    case 'notes': return String(entry.note ?? '').trim();
    case 'nicknames': return fold(String(entry.name ?? ''));
    case 'organizations': return fold(`${entry.name ?? ''} ${stable(entry.units ?? [])}`);
    case 'titles': return fold(String(entry.name ?? ''));
    default: return stable(entry);
  }
}

function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.length > 0;
    const name = value as { components?: unknown[]; full?: string };
    if ('components' in name || 'full' in name) return (name.components?.length ?? 0) > 0 || !!name.full?.trim();
    return Object.keys(value).length > 0;
  }
  return true;
}

function updatedAt(card: ContactCard): number {
  const t = card.updated ? Date.parse(card.updated) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

function freeKey(map: Record<string, unknown>, key: string): string {
  if (!(key in map)) return key;
  for (let n = 1; ; n++) if (!(`${key}m${n}` in map)) return `${key}m${n}`;
}

export interface MergePlan {
  /** The card that stays: the most recently changed one. */
  keep: ContactCard;
  /** The cards that are deleted, newest first. */
  others: ContactCard[];
  /** What the kept card gets: only the properties that change, each in full. */
  patch: Partial<ContactCard>;
  /** The kept card as it will be. */
  result: ContactCard;
}

/** How the cards become one; the first card stays when none says when it changed. */
export function planMerge(cards: ContactCard[]): MergePlan {
  const order = cards.map((card, i) => ({ card, i }))
    .sort((a, b) => updatedAt(b.card) - updatedAt(a.card) || a.i - b.i)
    .map((x) => x.card);
  const [keep, ...others] = order;
  const result = structuredClone(keep) as ContactCard;
  const record = result as unknown as Record<string, unknown>;

  for (const other of others) {
    const source = other as unknown as Record<string, unknown>;
    // Organisation ids of this card as the merged card has them, for its titles.
    const orgIds = new Map<string, string>();

    for (const key of MULTI_KEYS) {
      const from = source[key] as Record<string, Record<string, unknown>> | undefined;
      if (!from || Object.keys(from).length === 0) continue;
      const into = (record[key] ?? {}) as Record<string, Record<string, unknown>>;
      const signatures = new Map(Object.entries(into).map(([k, e]) => [entrySignature(key, e ?? {}), k]));
      const hasPref = Object.values(into).some((e) => e?.pref != null);
      let changed = false;
      for (const [entryKey, entry] of Object.entries(from)) {
        if (!entry) continue;
        const signature = entrySignature(key, entry);
        const existing = signatures.get(signature);
        if (existing !== undefined && signature !== '') {
          if (key === 'organizations') orgIds.set(entryKey, existing);
          continue;
        }
        const copy = structuredClone(entry);
        if (hasPref) delete copy.pref;
        if (key === 'titles' && typeof copy.organizationId === 'string') {
          const mapped = orgIds.get(copy.organizationId);
          if (mapped) copy.organizationId = mapped;
        }
        const newKey = freeKey(into, entryKey);
        if (key === 'organizations') orgIds.set(entryKey, newKey);
        into[newKey] = copy;
        signatures.set(signature, newKey);
        changed = true;
      }
      if (changed) record[key] = into;
    }

    // Categories: all of them.
    for (const [keyword, on] of Object.entries(other.keywords ?? {})) {
      if (on && !result.keywords?.[keyword]) result.keywords = { ...(result.keywords ?? {}), [keyword]: true };
    }

    for (const key of SINGLE_KEYS) {
      if (!hasValue(record[key]) && hasValue(source[key])) record[key] = structuredClone(source[key]);
    }

    // A photo only when the kept card has none.
    const hasPhoto = Object.values(result.media ?? {}).some((m) => m?.kind === 'photo');
    const photo = Object.entries(other.media ?? {}).find(([, m]) => m?.kind === 'photo');
    if (!hasPhoto && photo) {
      result.media = { ...(result.media ?? {}), [freeKey(result.media ?? {}, photo[0])]: structuredClone(photo[1]) };
    }
  }

  const patch: Partial<ContactCard> = {};
  const before = keep as unknown as Record<string, unknown>;
  for (const key of [...MULTI_KEYS, ...SINGLE_KEYS, 'keywords', 'media'] as const) {
    if (stable(record[key] ?? null) !== stable(before[key] ?? null)) {
      (patch as Record<string, unknown>)[key] = record[key];
    }
  }
  return { keep, others, patch, result };
}

/** The keys a group's `members` may list a card under. */
export function memberKeys(card: ContactCard): string[] {
  const keys = new Set<string>();
  const uid = card.uid;
  if (uid) {
    keys.add(uid);
    if (uid.startsWith('urn:uuid:')) keys.add(uid.slice(9));
    else keys.add(`urn:uuid:${uid}`);
  }
  if (card.originalId) keys.add(card.originalId);
  keys.add(card.id);
  return [...keys];
}

/**
 * The groups that list one of the merged cards, with their new members: the
 * merged cards out, the kept card in (under its uid, as "Add to group" does).
 */
export function planGroupMoves(
  groups: ContactCard[],
  keep: ContactCard,
  others: ContactCard[],
): Array<{ group: ContactCard; members: Record<string, boolean> }> {
  const otherKeys = new Set(others.flatMap(memberKeys));
  const keepKeys = memberKeys(keep);
  const moves: Array<{ group: ContactCard; members: Record<string, boolean> }> = [];
  for (const group of groups) {
    if (group.kind !== 'group' || !group.members) continue;
    const listed = Object.keys(group.members).filter((k) => group.members![k] && otherKeys.has(k));
    if (listed.length === 0) continue;
    const members = { ...group.members };
    for (const key of listed) delete members[key];
    if (!keepKeys.some((k) => members[k])) members[keep.uid || keep.originalId || keep.id] = true;
    moves.push({ group, members });
  }
  return moves;
}
