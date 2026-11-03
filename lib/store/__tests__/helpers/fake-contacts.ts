/**
 * FakeJmap with contacts, as measured on both Stalwarts (2026-11-03): uid is a
 * query filter, a second card with a uid is refused with invalidProperties,
 * unknown ids give per-record notFound, AddressBook state doesn't move when
 * cards change, `ContactCard/get` with ids null stops at 500.
 */

import { TransportError, type JmapResponse, type MethodCall, type StoreSession } from '../../engine/transport';
import { Collection, FAKE_SESSION, FakeJmap, JMAP_ACCOUNT } from './fake-jmap';

export const CONTACTS = 'urn:ietf:params:jmap:contacts';
export const SHARED_ACCOUNT = 'shared1';
export const MAIL_ONLY_ACCOUNT = 'mailonly';

export const CONTACTS_SESSION: StoreSession = {
  ...FAKE_SESSION,
  primaryAccounts: { ...FAKE_SESSION.primaryAccounts, [CONTACTS]: JMAP_ACCOUNT },
  accounts: {
    [JMAP_ACCOUNT]: { name: 'a@example.org', isPersonal: true, accountCapabilities: { [CONTACTS]: {} } },
    [SHARED_ACCOUNT]: { name: 'team@example.org', isPersonal: false, accountCapabilities: { [CONTACTS]: {} } },
    [MAIL_ONLY_ACCOUNT]: { name: 'list@example.org', isPersonal: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } },
  },
  capabilities: { [CONTACTS]: {} },
};

type Obj = Record<string, unknown> & { id: string };

/** The /changes rules of the base fake, for another collection. */
export function changesFor(coll: Collection, args: Record<string, unknown>): Record<string, unknown> {
  const since = String(args.sinceState);
  if (!/^s\d+$/.test(since)) throw Object.assign(new Error('bad state'), { jmapError: 'invalidArguments' });
  const from = Number(since.slice(1));
  if (from < coll.truncatedBelow || from > coll.log.length) {
    throw Object.assign(new Error('log truncated'), { jmapError: 'cannotCalculateChanges' });
  }
  const maxChanges = Math.min(Number(args.maxChanges ?? 5000) || 5000, 5000);
  return { accountId: args.accountId, oldState: since, ...coll.changes(since, maxChanges) };
}

function applyServerPatch(card: Obj, patch: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(patch)) {
    const steps = path.split('/');
    let node = card as Record<string, unknown>;
    for (const step of steps.slice(0, -1)) node = node[step] as Record<string, unknown>;
    const last = steps[steps.length - 1];
    if (value === null) delete node[last];
    else node[last] = value;
  }
}

class ContactAccount {
  readonly books = new Map<string, Obj>();
  readonly cards = new Map<string, Obj>();
  readonly coll = { AddressBook: new Collection(), ContactCard: new Collection() };
}

export class FakeContacts extends FakeJmap {
  private readonly contactAccounts = new Map<string, ContactAccount>();
  private nextCard = 1;
  /** Set to apply the next ContactCard/set and then lose its response. */
  loseNextSet = false;
  /** Card ids (or creation ids) whose next set is refused with this error. */
  readonly refuse = new Map<string, { type: string; description?: string; properties?: string[] }>();
  /** A server that lets two cards have one uid, as nothing in the RFC forbids it. */
  allowDuplicateUids = false;

  constructor(books: string[] = ['book1']) {
    super();
    for (const id of books) this.addBook({ id, name: id, isDefault: id === books[0] });
  }

  account(id: string = JMAP_ACCOUNT): ContactAccount {
    let found = this.contactAccounts.get(id);
    if (!found) {
      found = new ContactAccount();
      this.contactAccounts.set(id, found);
    }
    return found;
  }

  addBook(book: Obj, accountId: string = JMAP_ACCOUNT): void {
    const account = this.account(accountId);
    account.books.set(book.id, book);
    account.coll.AddressBook.push('created', book.id);
  }

  addCard(partial: Partial<Obj> = {}, accountId: string = JMAP_ACCOUNT): Obj {
    const account = this.account(accountId);
    const n = this.nextCard++;
    const card: Obj = {
      '@type': 'Card',
      version: '1.0',
      id: `c${n}`,
      uid: `urn:uuid:card-${n}`,
      addressBookIds: { [[...account.books.keys()][0] ?? 'book1']: true },
      kind: 'individual',
      name: { full: `Person ${n}` },
      ...partial,
    };
    account.cards.set(card.id, card);
    account.coll.ContactCard.push('created', card.id);
    return card;
  }

  editCard(id: string, patch: Record<string, unknown>, accountId: string = JMAP_ACCOUNT): void {
    const account = this.account(accountId);
    applyServerPatch(account.cards.get(id) as Obj, patch);
    account.coll.ContactCard.push('updated', id);
  }

  removeCard(id: string, accountId: string = JMAP_ACCOUNT): void {
    const account = this.account(accountId);
    account.cards.delete(id);
    account.coll.ContactCard.push('destroyed', id);
  }

  private contactSet(account: ContactAccount, args: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = { accountId: args.accountId, oldState: account.coll.ContactCard.state() };
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    for (const [cid, raw] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
      const refused = this.refuse.get(cid) ?? this.refuse.get(String(raw.uid));
      const clash = [...account.cards.values()].find((card) => card.uid === raw.uid);
      if (refused) {
        notCreated[cid] = refused;
      } else if (clash && !this.allowDuplicateUids) {
        notCreated[cid] = { type: 'invalidProperties', description: `Contact with UID ${String(raw.uid)} already exists with id ${clash.id}.`, properties: ['uid'] };
      } else {
        const id = `c${this.nextCard++}`;
        account.cards.set(id, { '@type': 'Card', version: '1.0', ...raw, id });
        account.coll.ContactCard.push('created', id);
        created[cid] = { id };
      }
    }
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
      const card = account.cards.get(id);
      const refused = this.refuse.get(id);
      if (refused) notUpdated[id] = refused;
      else if (!card) notUpdated[id] = { type: 'notFound' };
      else {
        applyServerPatch(card, patch);
        account.coll.ContactCard.push('updated', id);
        updated[id] = null;
      }
    }
    for (const id of (args.destroy ?? []) as string[]) {
      const refused = this.refuse.get(id);
      if (refused) notDestroyed[id] = refused;
      else if (!account.cards.has(id)) notDestroyed[id] = { type: 'notFound' };
      else {
        account.cards.delete(id);
        account.coll.ContactCard.push('destroyed', id);
        destroyed.push(id);
      }
    }
    for (const [key, value] of Object.entries({ created, notCreated, updated, notUpdated, notDestroyed })) {
      if (Object.keys(value).length > 0) result[key] = value;
    }
    if (destroyed.length > 0) result.destroyed = destroyed;
    result.newState = account.coll.ContactCard.state();
    return result;
  }

  protected override handle(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const account = this.account(String(args.accountId));
    switch (name) {
      case 'AddressBook/get': {
        const ids = args.ids as string[] | null | undefined;
        const all = [...account.books.values()];
        return {
          accountId: args.accountId,
          state: account.coll.AddressBook.state(),
          list: ids ? all.filter((b) => ids.includes(b.id)) : all,
          notFound: ids ? ids.filter((id) => !account.books.has(id)) : [],
        };
      }
      case 'AddressBook/changes':
        return changesFor(account.coll.AddressBook, args);
      case 'ContactCard/changes':
        return changesFor(account.coll.ContactCard, args);
      case 'ContactCard/query': {
        const filter = (args.filter ?? {}) as { uid?: string; inAddressBook?: string };
        let list = [...account.cards.values()];
        if (filter.uid) list = list.filter((c) => c.uid === filter.uid);
        if (filter.inAddressBook) list = list.filter((c) => (c.addressBookIds as Record<string, boolean>)[filter.inAddressBook as string]);
        const position = Number(args.position ?? 0);
        const limit = Number(args.limit ?? 5000) || 5000;
        return {
          accountId: args.accountId,
          queryState: account.coll.ContactCard.state(),
          canCalculateChanges: true,
          position,
          ids: list.slice(position, position + Math.min(limit, 5000)).map((c) => c.id),
          ...(args.calculateTotal ? { total: list.length } : {}),
        };
      }
      case 'ContactCard/get': {
        const ids = args.ids as string[] | null | undefined;
        if (ids && ids.length > 500) throw Object.assign(new Error('requestTooLarge'), { jmapError: 'requestTooLarge' });
        const chosen = ids ?? [...account.cards.keys()].slice(0, 500);
        return {
          accountId: args.accountId,
          state: account.coll.ContactCard.state(),
          list: chosen.filter((id) => account.cards.has(id)).map((id) => structuredClone(account.cards.get(id))),
          notFound: chosen.filter((id) => !account.cards.has(id)),
        };
      }
      case 'ContactCard/set':
        return this.contactSet(account, args);
      default:
        return super.handle(name, args);
    }
  }

  override async request(calls: MethodCall[], using?: string[]): Promise<JmapResponse> {
    // The real server fails the whole request for a capability it doesn't list.
    void using;
    const response = await super.request(calls);
    if (this.loseNextSet && calls.some(([name]) => name === 'ContactCard/set')) {
      this.loseNextSet = false;
      throw new TransportError('network', 'Connection dropped after the server took the request');
    }
    return response;
  }
}
