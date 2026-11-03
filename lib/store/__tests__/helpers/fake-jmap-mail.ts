/**
 * FakeJmap with what the mail answers and the outbox talk to: identities,
 * quotas, Email/set and submissions. Follows what was measured on Stalwart
 * (stalwart-changes-prf.md section 1): `header` and `text` filters find no
 * Message-ID, a second create or submission of the same message is accepted,
 * a canceled submission still shows in EmailSubmission/query.
 */

import { FakeJmap, type FakeEmail } from './fake-jmap';

export interface FakeSubmission {
  id: string;
  emailId: string;
  identityId?: string;
  undoStatus: 'pending' | 'final' | 'canceled';
}

type Filter = Record<string, unknown>;

export class FakeJmapMail extends FakeJmap {
  readonly identities = new Map<string, Record<string, unknown> & { id: string }>();
  readonly quotas: Array<Record<string, unknown> & { id: string }> = [];
  readonly submissions = new Map<string, FakeSubmission>();
  /** Email/set update or destroy of these ids is refused with this error. */
  readonly refuse = new Map<string, { type: string; description?: string }>();
  /** A method answered with a per-call error once. */
  readonly failNext = new Map<string, string>();
  identityState = 0;
  nextSubmission = 1;

  private matches(email: FakeEmail, filter: Filter | undefined): boolean {
    if (!filter) return true;
    if (filter.operator === 'AND') return (filter.conditions as Filter[]).every((c) => this.matches(email, c));
    if (filter.operator === 'OR') return (filter.conditions as Filter[]).some((c) => this.matches(email, c));
    if (filter.operator === 'NOT') return !(filter.conditions as Filter[]).some((c) => this.matches(email, c));
    for (const [key, value] of Object.entries(filter)) {
      switch (key) {
        case 'inMailbox':
          if (!(email.mailboxIds as Record<string, boolean>)[value as string]) return false;
          break;
        case 'after':
          if (Date.parse(String(email.receivedAt)) < Date.parse(String(value))) return false;
          break;
        // The filters that find nothing on Stalwart for a Message-ID.
        case 'header':
        case 'text':
          return false;
        default:
          throw new Error(`FakeJmapMail: filter ${key} isn't modelled`);
      }
    }
    return true;
  }

  private applyPatch(email: FakeEmail, patch: Record<string, unknown>): void {
    const keywords = { ...(email.keywords as Record<string, boolean>) };
    const boxes = { ...(email.mailboxIds as Record<string, boolean>) };
    let wholeKeywords = keywords;
    let wholeBoxes = boxes;
    for (const [path, value] of Object.entries(patch)) {
      if (path === 'keywords') wholeKeywords = { ...(value as Record<string, boolean>) };
      else if (path === 'mailboxIds') wholeBoxes = { ...(value as Record<string, boolean>) };
      else if (path.startsWith('keywords/')) {
        const name = path.slice('keywords/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
        if (value) wholeKeywords[name] = true;
        else delete wholeKeywords[name];
      } else if (path.startsWith('mailboxIds/')) {
        const name = path.slice('mailboxIds/'.length);
        if (value) wholeBoxes[name] = true;
        else delete wholeBoxes[name];
      }
    }
    this.updateEmail(email.id, { keywords: wholeKeywords, mailboxIds: wholeBoxes });
  }

  protected override handle(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const failure = this.failNext.get(name);
    if (failure) {
      this.failNext.delete(name);
      throw Object.assign(new Error(failure), { jmapError: failure });
    }
    switch (name) {
      case 'Identity/get': {
        const ids = args.ids as string[] | null;
        const all = [...this.identities.values()];
        return { accountId: args.accountId, state: `s${this.identityState}`, list: ids ? all.filter((i) => ids.includes(i.id)) : all, notFound: [] };
      }
      case 'Identity/changes':
        return {
          accountId: args.accountId,
          oldState: args.sinceState,
          newState: `s${this.identityState}`,
          hasMoreChanges: false,
          created: args.sinceState === `s${this.identityState}` ? [] : [...this.identities.keys()],
          updated: [],
          destroyed: [],
        };
      case 'Quota/get':
        return { accountId: args.accountId, list: this.quotas, notFound: [] };
      case 'Email/query': {
        const matched = [...this.emails.values()]
          .filter((email) => this.matches(email, args.filter as Filter | undefined))
          .sort((a, b) => Date.parse(String(b.receivedAt)) - Date.parse(String(a.receivedAt)));
        return {
          accountId: args.accountId,
          queryState: this.coll.Email.state(),
          canCalculateChanges: true,
          ...this.pageOf(matched.map((email) => email.id), args),
          ...(args.calculateTotal ? { total: matched.length } : {}),
        };
      }
      case 'Email/set': {
        const out: Record<string, unknown> = { accountId: args.accountId };
        if (args.update) {
          const updated: Record<string, null> = {};
          const notUpdated: Record<string, unknown> = {};
          for (const [id, patch] of Object.entries(args.update as Record<string, Record<string, unknown>>)) {
            const email = this.emails.get(id);
            if (this.refuse.has(id)) notUpdated[id] = this.refuse.get(id);
            else if (!email) notUpdated[id] = { type: 'notFound' };
            else {
              this.applyPatch(email, patch);
              updated[id] = null;
            }
          }
          out.updated = updated;
          if (Object.keys(notUpdated).length > 0) out.notUpdated = notUpdated;
        }
        if (args.destroy) {
          const destroyed: string[] = [];
          const notDestroyed: Record<string, unknown> = {};
          for (const id of args.destroy as string[]) {
            if (this.refuse.has(id)) notDestroyed[id] = this.refuse.get(id);
            else if (!this.emails.has(id)) notDestroyed[id] = { type: 'notFound' };
            else {
              this.destroyEmail(id);
              destroyed.push(id);
            }
          }
          out.destroyed = destroyed;
          if (Object.keys(notDestroyed).length > 0) out.notDestroyed = notDestroyed;
        }
        return out;
      }
      case 'EmailSubmission/query': {
        const emailIds = ((args.filter as Filter | undefined)?.emailIds ?? []) as string[];
        const ids = [...this.submissions.values()].filter((s) => emailIds.includes(s.emailId)).map((s) => s.id);
        return { accountId: args.accountId, queryState: 'q', canCalculateChanges: false, position: 0, ids };
      }
      case 'EmailSubmission/get': {
        const ids = (args.ids ?? []) as string[];
        return {
          accountId: args.accountId,
          state: 'q',
          list: ids.flatMap((id) => (this.submissions.has(id) ? [this.submissions.get(id)] : [])),
          notFound: ids.filter((id) => !this.submissions.has(id)),
        };
      }
      default:
        return super.handle(name, args);
    }
  }

  /** A submission record, as if a send got that far. */
  addSubmission(emailId: string, undoStatus: FakeSubmission['undoStatus'] = 'pending'): FakeSubmission {
    const submission: FakeSubmission = { id: `sub${this.nextSubmission++}`, emailId, undoStatus };
    this.submissions.set(submission.id, submission);
    return submission;
  }
}
