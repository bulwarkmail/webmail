/**
 * The people of a team mailbox: names for the principal ids in `$assigned:*`
 * keywords (lib/team-mailboxes/keywords.ts) and the people "Assign to…"
 * offers. JMAP has no group member list, so these are the people known to be
 * in the team, best source first:
 *
 * - the user themself, from the session;
 * - the names list in the group Inbox's shared metadata (Stalwart 1.0 and
 *   later): each member adds themselves the first time they open the team
 *   mailbox, and whoever assigns adds the assignee and themselves. Read from
 *   the team-inbox plugin's entry and from core's (core wins per id),
 *   written only under core's: `org.bulwarkmail.team`, as
 *   `{ v: 1, people: { "<id>": { n: name, e: email } } }`, under 3,584 bytes,
 *   oldest dropped first, a changed person moved to the end. 0.16 keeps no
 *   metadata, so there is no list there;
 * - authors of the team's notes (address and name, and the principal id
 *   notes written since 1.22 carry) and
 *   assignees named in its timeline (id, no name);
 * - the server's directory where the administrator allows lookups, with the
 *   admin policy's directory rules (lib/directory-scope.ts).
 *
 * Metadata reads and writes can fail (a 1.0 test build panics on metadata
 * reads; the client then pauses metadata for ten minutes). Nothing here ever
 * throws: names are best effort and never stop an assignment.
 */

import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { debug } from '@/lib/debug';
import { directoryScopeFor, inDirectoryScope, loadScopedPrincipalDirectory, principalAddress } from '@/lib/directory-scope';
import { isAssigneeId, recentAssignees } from './keywords';
import type { NoteEntry } from './note-format';
import type { TeamRef } from './team';

/** Core's entry: org.bulwarkmail.team (lib/jmap/bulwark-metadata.ts namespaceFor). */
export const TEAM_NAMES_KEY = 'team';
/**
 * The team-inbox plugin's entry, org.bulwarkmail.plugin.team-inbox: the host
 * keeps plugin data under `plugin.<id>` (lib/plugin-sandbox/host-api-account.ts
 * pluginDataKey), and getBulwarkMetadata hands entries back without the
 * org.bulwarkmail. prefix.
 */
export const PLUGIN_NAMES_KEY = 'plugin.team-inbox';
/** The list stays under this many bytes of JSON, as the plugin's did. */
export const MAX_NAMES_BYTES = 3584;
export const NAMES_VERSION = 1;

export interface Person {
  name: string;
  email: string;
}

export type PeopleById = Record<string, Person>;

/** One person of a team. `id` is null for someone known only by address (a note's author). */
export interface TeamPerson {
  id: string | null;
  name: string;
  email: string;
}

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

function clean(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

/** One person as the list keeps them, or null. */
export function person(entry: unknown): Person | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as { name?: unknown; n?: unknown; email?: unknown; e?: unknown };
  const name = clean(e.name ?? e.n, 80);
  const email = clean(e.email ?? e.e, 254).toLowerCase();
  if (!name && !email) return null;
  return { name: name || email, email };
}

/** The people of a stored list value, by id; {} for anything else. */
export function readNames(value: unknown): PeopleById {
  const out: PeopleById = {};
  const people = value && typeof value === 'object' ? (value as { people?: unknown }).people : null;
  if (!people || typeof people !== 'object') return out;
  for (const [id, entry] of Object.entries(people as Record<string, unknown>)) {
    const p = person(entry);
    if (p && isAssigneeId(id)) out[id.toLowerCase()] = p;
  }
  return out;
}

/** Both entries of the group Inbox: the plugin's, with core's on top (core wins per id). */
export function namesFromEntries(entries: Record<string, unknown> | null | undefined): PeopleById {
  if (!entries) return {};
  const plugin = readNames(entries[PLUGIN_NAMES_KEY]);
  const core = readNames(entries[TEAM_NAMES_KEY]);
  const out: PeopleById = {};
  // Core's order wins as well: its entries are the ones written last.
  for (const [id, p] of Object.entries(plugin)) if (!core[id]) out[id] = p;
  for (const [id, p] of Object.entries(core)) out[id] = p;
  return out;
}

/** The value to store for `people` (newest last): the oldest go until it is under MAX_NAMES_BYTES. */
export function writeNames(people: PeopleById): { v: number; people: Record<string, { n: string; e: string }> } {
  const entries = Object.entries(people).map(([id, p]) => [id, { n: p.name, e: p.email }] as const);
  let value = { v: NAMES_VERSION, people: Object.fromEntries(entries) };
  while (entries.length > 0 && jsonBytes(value) >= MAX_NAMES_BYTES) {
    entries.shift();
    value = { v: NAMES_VERSION, people: Object.fromEntries(entries) };
  }
  return value;
}

/** `current` with `additions` merged in (a changed person moves to the end), or null when nothing changes. */
export function mergeNames(current: PeopleById, additions: Record<string, unknown>): PeopleById | null {
  let changed = false;
  const next: PeopleById = { ...current };
  for (const [id, entry] of Object.entries(additions)) {
    const p = person(entry);
    if (!p || !isAssigneeId(id)) continue;
    const key = id.toLowerCase();
    const before = next[key];
    if (before && before.name === p.name && before.email === p.email) continue;
    delete next[key];
    next[key] = p;
    changed = true;
  }
  return changed ? next : null;
}

/** The short form for a chip: the first name, else the address's local part. */
export function shortName(p: { name?: string; email?: string } | null | undefined): string {
  if (!p) return '';
  const name = (p.name ?? '').trim();
  if (name && !name.includes('@')) return name.split(/\s+/)[0];
  return (p.email || name).split('@')[0];
}

/** The person with this address, with their id, or null. */
export function findByEmail(people: PeopleById, address: string | null | undefined): (Person & { id: string }) | null {
  const wanted = String(address ?? '').trim().toLowerCase();
  if (!wanted) return null;
  for (const [id, p] of Object.entries(people)) {
    if (p.email === wanted) return { id, ...p };
  }
  return null;
}

// ── Merging the sources ───────────────────────────────────────────────

export interface TeamPeople {
  /** The user's own principal id, lower case. */
  selfId: string | null;
  /** Everyone known, the user first, then the names list, note authors and assignees, the directory. */
  people: TeamPerson[];
  /** Ids messages here were assigned to lately (from the timeline), most often first, without the user. */
  recent: string[];
  /** The person with this principal id; their name and address may be empty when unknown. */
  byId: (id: string | null | undefined) => TeamPerson | null;
}

export interface TeamPeopleSources {
  self: (Person & { id: string }) | null;
  list?: PeopleById | null;
  notes?: readonly NoteEntry[];
  directory?: PeopleById | null;
}

/**
 * One list of the team's people from every source. A person met twice keeps
 * the better source's name; an author known only by address gets an id when
 * another source has that address.
 */
export function mergeTeamPeople({ self, list, notes = [], directory }: TeamPeopleSources): TeamPeople {
  const people: TeamPerson[] = [];
  const byId = new Map<string, TeamPerson>();
  const byEmail = new Map<string, TeamPerson>();
  const add = (rawId: string | null, p: { name?: string; email?: string }) => {
    const id = rawId && isAssigneeId(rawId) ? rawId.toLowerCase() : null;
    const email = (p.email ?? '').trim().toLowerCase();
    const name = (p.name ?? '').trim();
    let found = id ? byId.get(id) : undefined;
    if (!found && email) {
      const other = byEmail.get(email);
      // Two ids with one address stay two people.
      if (other && (!id || !other.id)) found = other;
    }
    if (found) {
      if (id && !found.id) {
        found.id = id;
        byId.set(id, found);
      }
      if (!found.email && email) {
        found.email = email;
        byEmail.set(email, found);
      }
      if (!found.name && name) found.name = name;
      return;
    }
    const entry: TeamPerson = { id, name, email };
    people.push(entry);
    if (id) byId.set(id, entry);
    if (email) byEmail.set(email, entry);
  };
  if (self) add(self.id, self);
  for (const [id, p] of Object.entries(list ?? {})) add(id, p);
  const newestFirst = [...notes].sort((a, b) => b.at - a.at);
  const counts = new Map<string, number>();
  for (const note of newestFirst) {
    add(note.author.id ?? null, note.author);
    if (note.kind === 'assigned' && note.mentions[0]) {
      add(note.mentions[0], {});
      counts.set(note.mentions[0], (counts.get(note.mentions[0]) ?? 0) + 1);
    }
  }
  for (const [id, p] of Object.entries(directory ?? {})) add(id, p);
  const selfId = self?.id.toLowerCase() ?? null;
  return {
    selfId,
    people,
    recent: recentAssignees(counts, { exclude: selfId ? [selfId] : [] }),
    byId: (id) => (id ? byId.get(id.toLowerCase()) ?? null : null),
  };
}

// ── The names list on the server ──────────────────────────────────────

interface TeamNamesState {
  /** Per team key: the names list; null where the server keeps none. Absent until read. */
  lists: Record<string, PeopleById | null>;
  /** Per login: names the directory gave for ids seen on messages. */
  directory: Record<string, PeopleById>;
}

export const useTeamNamesStore = create<TeamNamesState>()(() => ({ lists: {}, directory: {} }));

function setList(key: string, list: PeopleById | null): void {
  useTeamNamesStore.setState((s) => ({ lists: { ...s.lists, [key]: list } }));
}

function hasMetadata(client: IJMAPClient, accountId: string): boolean {
  return typeof client.getBulwarkMetadata === 'function' && client.supportsBulwarkMetadata?.(accountId) === true;
}

/** Reads the team's names list from the server. Null where there is none to read (0.16, a failed read). */
export async function loadTeamNames(ref: TeamRef, client: IJMAPClient): Promise<PeopleById | null> {
  if (!hasMetadata(client, ref.accountId)) {
    if (!(ref.key in useTeamNamesStore.getState().lists)) setList(ref.key, null);
    return null;
  }
  try {
    const entries = await client.getBulwarkMetadata!(ref.accountId);
    if (!entries) return null;
    const list = namesFromEntries(entries);
    setList(ref.key, list);
    return list;
  } catch (error) {
    debug.warn('team-mailboxes', 'Reading the team names failed:', error);
    return null;
  }
}

const loadsOnce = new WeakMap<IJMAPClient, Map<string, Promise<PeopleById | null>>>();

/** The names list, read once per session (later calls get the first read). */
export function ensureTeamNames(ref: TeamRef, client: IJMAPClient): Promise<PeopleById | null> {
  let byKey = loadsOnce.get(client);
  if (!byKey) {
    byKey = new Map();
    loadsOnce.set(client, byKey);
  }
  const running = byKey.get(ref.key);
  if (running) return running;
  const load = loadTeamNames(ref, client).then((list) => {
    // Nothing read: the next open asks again (the client itself pauses a failing server).
    if (list === null) byKey.delete(ref.key);
    return list;
  });
  byKey.set(ref.key, load);
  return load;
}

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Adds people to the team's names list: reads the list again right before
 * writing (so what another member added since isn't lost), writes only when
 * something changes. Resolves with whether it wrote; never rejects.
 */
export function addToTeamNames(ref: TeamRef, client: IJMAPClient, additions: Record<string, Person>): Promise<boolean> {
  const previous = writeQueues.get(ref.key) ?? Promise.resolve();
  const run = previous.then(async () => {
    if (!hasMetadata(client, ref.accountId) || typeof client.setBulwarkMetadata !== 'function') return false;
    if (client.getAccountInfo?.(ref.accountId)?.isReadOnly === true) return false;
    const current = await loadTeamNames(ref, client);
    if (!current) return false;
    const next = mergeNames(current, additions);
    if (!next) return false;
    try {
      const value = writeNames(next);
      await client.setBulwarkMetadata(ref.accountId, TEAM_NAMES_KEY, value);
      setList(ref.key, readNames(value));
      return true;
    } catch (error) {
      debug.warn('team-mailboxes', 'Saving the team names failed:', error);
      return false;
    }
  }).catch((error) => {
    debug.warn('team-mailboxes', 'Updating the team names failed:', error);
    return false;
  });
  writeQueues.set(ref.key, run);
  return run;
}

/** The user as the names list keeps them: the identity with the login's address, else the address. */
export async function selfPerson(client: IJMAPClient): Promise<Person & { id: string }> {
  const email = client.getUsername().trim().toLowerCase();
  let name = '';
  try {
    const identities = await client.getIdentities();
    name = identities.find((i) => i.email?.trim().toLowerCase() === email)?.name?.trim() ?? '';
  } catch {
    // The address stands in for the name.
  }
  return { id: client.getAccountId().toLowerCase(), name: name || email, email };
}

const registered = new WeakMap<IJMAPClient, Set<string>>();

/**
 * Adds the user to the team's names list, the first time they open the team
 * mailbox in this session, so others can pick them before they were ever
 * assigned anything. Only where the server keeps metadata; never rejects.
 */
export async function registerSelf(ref: TeamRef, client: IJMAPClient): Promise<void> {
  let done = registered.get(client);
  if (!done) {
    done = new Set();
    registered.set(client, done);
  }
  if (done.has(ref.key) || !hasMetadata(client, ref.accountId)) return;
  done.add(ref.key);
  try {
    const list = await ensureTeamNames(ref, client);
    if (!list) {
      // Couldn't read: try again on a later open.
      done.delete(ref.key);
      return;
    }
    const self = await selfPerson(client);
    const known = list[self.id];
    if (known && known.name === self.name && known.email === self.email) return;
    await addToTeamNames(ref, client, { [self.id]: { name: self.name, email: self.email } });
  } catch (error) {
    debug.warn('team-mailboxes', 'Adding the user to the team names failed:', error);
  }
}

// ── The directory ─────────────────────────────────────────────────────

/** Directory searches start at this many characters. */
export const MIN_DIRECTORY_SEARCH = 3;
/** Most matches a search shows. */
export const MAX_DIRECTORY_MATCHES = 20;
/** Ids asked for in one lookup, and the least time between two lookups (as for plugins). */
export const LOOKUP_BATCH = 20;
export const LOOKUP_MIN_GAP_MS = 10_000;
/** Ids seen on rows are gathered this long before a lookup. */
export const LOOKUP_DELAY_MS = 1500;

function asTeamPerson(p: { id: string; type?: string; name?: string | null; description?: string | null; email?: string | null }): TeamPerson | null {
  if (p.type === 'group' || !isAssigneeId(p.id)) return null;
  const email = principalAddress({ email: p.email, name: p.name }).toLowerCase();
  const name = (p.description || p.name || email).trim();
  if (!name && !email) return null;
  return { id: p.id.toLowerCase(), name: name || email, email };
}

/**
 * People in the directory whose name or address contains `text`, from 3
 * characters, without groups. Empty where the server doesn't allow directory
 * lookups (Stalwart 1.0's default). The listing is shared and kept for a few
 * minutes (lib/jmap/principal-directory.ts), so typing asks the server once.
 */
export async function searchDirectory(client: IJMAPClient, text: string): Promise<TeamPerson[]> {
  const query = text.trim().toLowerCase();
  if (query.length < MIN_DIRECTORY_SEARCH || !client.supportsPrincipals?.()) return [];
  try {
    const listing = await loadScopedPrincipalDirectory(client);
    if (listing.status !== 'ok') return [];
    const out: TeamPerson[] = [];
    for (const principal of listing.principals) {
      const p = asTeamPerson(principal);
      if (p && (p.name.toLowerCase().includes(query) || p.email.includes(query))) out.push(p);
      if (out.length >= MAX_DIRECTORY_MATCHES) break;
    }
    return out;
  } catch (error) {
    debug.warn('team-mailboxes', 'Searching the directory failed:', error);
    return [];
  }
}

/** Most people the @ list takes from the directory. */
export const MAX_DIRECTORY_PEOPLE = 500;

/**
 * Everyone in the directory the user may see (without groups), for the @
 * list, which filters as the user types from the first letter. Empty where
 * the server doesn't allow directory lookups. The listing is shared and kept
 * for a few minutes (lib/jmap/principal-directory.ts).
 */
export async function listDirectoryPeople(client: IJMAPClient): Promise<TeamPerson[]> {
  if (!client.supportsPrincipals?.()) return [];
  try {
    const listing = await loadScopedPrincipalDirectory(client);
    if (listing.status !== 'ok') return [];
    const out: TeamPerson[] = [];
    for (const principal of listing.principals) {
      const p = asTeamPerson(principal);
      if (p) out.push(p);
      if (out.length >= MAX_DIRECTORY_PEOPLE) break;
    }
    return out;
  } catch (error) {
    debug.warn('team-mailboxes', 'Listing the directory failed:', error);
    return [];
  }
}

interface LookupState {
  pending: Set<string>;
  asked: Set<string>;
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const lookups = new WeakMap<IJMAPClient, LookupState>();

/**
 * Asks the server for the names of these principal ids (assignees seen on
 * messages whose names nobody listed), at most 20 at a time and one lookup
 * every 10 seconds, each id once per session. Principal/get by id; the admin
 * policy's directory rules apply. Results land in useTeamNamesStore.
 */
export function lookUpNames(loginId: string, client: IJMAPClient, ids: readonly string[]): void {
  if (typeof client.getAccountOwners !== 'function' || !client.supportsPrincipals?.()) return;
  let state = lookups.get(client);
  if (!state) {
    state = { pending: new Set(), asked: new Set(), last: 0, timer: null };
    lookups.set(client, state);
  }
  const known = useTeamNamesStore.getState().directory[loginId] ?? {};
  for (const raw of ids) {
    if (!isAssigneeId(raw)) continue;
    const id = raw.toLowerCase();
    if (!state.asked.has(id) && !known[id]) state.pending.add(id);
  }
  schedule(loginId, client, state);
}

function schedule(loginId: string, client: IJMAPClient, state: LookupState): void {
  if (state.timer || state.pending.size === 0) return;
  const wait = Math.max(LOOKUP_DELAY_MS, state.last + LOOKUP_MIN_GAP_MS - Date.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    void runLookup(loginId, client, state);
  }, wait);
}

async function runLookup(loginId: string, client: IJMAPClient, state: LookupState): Promise<void> {
  const ids = [...state.pending].slice(0, LOOKUP_BATCH);
  for (const id of ids) {
    state.pending.delete(id);
    state.asked.add(id);
  }
  if (ids.length === 0) return;
  state.last = Date.now();
  try {
    const owners = Object.values(await client.getAccountOwners!(ids));
    const scope = await directoryScopeFor(client, owners);
    const found: PeopleById = {};
    for (const owner of owners) {
      const p = asTeamPerson(owner);
      if (!p?.id || !ids.includes(p.id)) continue;
      if (scope && !inDirectoryScope(p.email, scope)) continue;
      found[p.id] = { name: p.name, email: p.email };
    }
    if (Object.keys(found).length > 0) {
      useTeamNamesStore.setState((s) => ({ directory: { ...s.directory, [loginId]: { ...s.directory[loginId], ...found } } }));
    }
  } catch (error) {
    debug.warn('team-mailboxes', 'Looking up names failed:', error);
  }
  schedule(loginId, client, state);
}

/** For tests: forget every list, lookup and registration. */
export function resetTeamNames(): void {
  useTeamNamesStore.setState({ lists: {}, directory: {} });
  writeQueues.clear();
}
