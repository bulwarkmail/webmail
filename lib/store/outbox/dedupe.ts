/**
 * Before a send whose response got lost goes out again: did it reach the
 * server? JMAP has no idempotency key and a second create or submission is
 * simply accepted, so this looks. The `header` and `text` filters find no
 * Message-ID on either Stalwart, so it reads the recent Drafts and Sent and
 * matches on the client (stalwart-changes-prf.md section 1, decision 4).
 *
 * | Lookup                            | Decision                             |
 * | no match                          | send it again                        |
 * | in Drafts, no submission          | submit the copy that's there         |
 * | in Sent                           | done                                 |
 * | in Drafts, a submission waiting   | done, it's scheduled                 |
 * | in Drafts, a canceled submission  | done, someone decided against it     |
 *
 * It answers "undecided" when it can't tell, and the entry stays with the user.
 */

import { responseFor, type JmapResponse, type MethodCall } from '../engine/transport';
import { MAIL_USING } from '../mail/records';

/**
 * `after` compares the server's receivedAt with this device's clock, so it
 * looks a day further back than the attempt. Only an exact Message-ID matches,
 * so looking further costs nothing but a page or two.
 */
export const CLOCK_SKEW_MARGIN_MS = 24 * 60 * 60 * 1000;
/**
 * Stalwart drops submissions after 3 days (`expungeSubmissionsAfter`). Past
 * this, "no submission" and "not found" no longer say the send never happened.
 */
export const LOOKUP_TRUSTED_MS = 2 * 24 * 60 * 60 * 1000;
const PAGE = 500;
const MAX_PAGES = 5;
const SUBMISSION_USING = [...MAIL_USING, 'urn:ietf:params:jmap:submission'];

export type RetryDecision =
  | { action: 'send' }
  | { action: 'submit'; emailId: string }
  | { action: 'done'; emailId: string; why: 'sent' | 'scheduled' | 'canceled' }
  | { action: 'undecided'; why: 'no-message-id' | 'no-folders' | 'too-many' | 'too-old' | 'no-copy-kept' | 'unexpected' };

export interface LookupIo {
  request(calls: MethodCall[], using: string[]): Promise<JmapResponse>;
}

export interface LookupArgs {
  /** The JMAP account the send creates its copy in. */
  jmap: string;
  submissionJmap: string;
  messageId: string | undefined;
  /** When the first attempt was handed to the server. */
  attemptAt: number;
  now: number;
  /**
   * False when a successful send leaves no copy (no copy in Sent, a submit-only
   * raw send): then finding nothing doesn't mean it never arrived.
   */
  copyKept: boolean;
}

interface FoundEmail {
  id: string;
  messageId?: string[] | null;
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
}

function bare(id: string): string {
  return id.trim().replace(/^<|>$/g, '');
}

async function findCopies(io: LookupIo, args: LookupArgs, folders: { drafts?: string; sent?: string }): Promise<FoundEmail[] | 'too-many'> {
  const boxes = [folders.drafts, folders.sent].filter((box): box is string => Boolean(box));
  const wanted = bare(args.messageId as string);
  const filter = {
    operator: 'AND',
    conditions: [
      { operator: 'OR', conditions: boxes.map((inMailbox) => ({ inMailbox })) },
      { after: new Date(args.attemptAt - CLOCK_SKEW_MARGIN_MS).toISOString() },
    ],
  };
  const found: FoundEmail[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await io.request([
      ['Email/query', {
        accountId: args.jmap,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        position: page * PAGE,
        limit: PAGE,
      }, 'q'],
      ['Email/get', {
        accountId: args.jmap,
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['id', 'messageId', 'mailboxIds', 'keywords'],
      }, 'g'],
    ], MAIL_USING);
    const ids = responseFor(response, 'q')[1].ids as string[];
    const list = responseFor(response, 'g')[1].list as FoundEmail[];
    found.push(...list.filter((email) => (email.messageId ?? []).some((id) => bare(id) === wanted)));
    if (ids.length < PAGE) return found;
  }
  // More than this since the attempt, and nothing matched so far: it may be further on.
  return found.length > 0 ? found : 'too-many';
}

async function submissionsOf(io: LookupIo, jmap: string, emailId: string): Promise<Array<{ undoStatus?: string }>> {
  const response = await io.request([
    ['EmailSubmission/query', { accountId: jmap, filter: { emailIds: [emailId] } }, 'q'],
    ['EmailSubmission/get', {
      accountId: jmap,
      '#ids': { resultOf: 'q', name: 'EmailSubmission/query', path: '/ids' },
      properties: ['id', 'undoStatus'],
    }, 'g'],
  ], SUBMISSION_USING);
  return responseFor(response, 'g')[1].list as Array<{ undoStatus?: string }>;
}

/** What to do with a send that may have reached the server. Throws when the lookup itself fails. */
export async function decideRetry(io: LookupIo, args: LookupArgs): Promise<RetryDecision> {
  if (!args.messageId) return { action: 'undecided', why: 'no-message-id' };
  const boxesResponse = await io.request([['Mailbox/get', { accountId: args.jmap, properties: ['id', 'role'] }, 'm']], MAIL_USING);
  const boxes = responseFor(boxesResponse, 'm')[1].list as Array<{ id: string; role?: string | null }>;
  const folders = { drafts: boxes.find((box) => box.role === 'drafts')?.id, sent: boxes.find((box) => box.role === 'sent')?.id };
  if (!folders.drafts && !folders.sent) return { action: 'undecided', why: 'no-folders' };

  const copies = await findCopies(io, args, folders);
  if (copies === 'too-many') return { action: 'undecided', why: 'too-many' };
  const trusted = args.now - args.attemptAt <= LOOKUP_TRUSTED_MS;

  const inSent = copies.find((email) => folders.sent && email.mailboxIds?.[folders.sent]);
  if (inSent) return { action: 'done', emailId: inSent.id, why: 'sent' };

  const inDrafts = copies.find((email) => folders.drafts && email.mailboxIds?.[folders.drafts]);
  if (inDrafts) {
    const submissions = await submissionsOf(io, args.submissionJmap, inDrafts.id);
    if (submissions.length > 0) {
      const live = submissions.some((submission) => submission.undoStatus !== 'canceled');
      return { action: 'done', emailId: inDrafts.id, why: live ? 'scheduled' : 'canceled' };
    }
    if (!trusted) return { action: 'undecided', why: 'too-old' };
    if (!inDrafts.keywords?.$draft) return { action: 'undecided', why: 'unexpected' };
    return { action: 'submit', emailId: inDrafts.id };
  }

  if (!args.copyKept) return { action: 'undecided', why: 'no-copy-kept' };
  if (!trusted) return { action: 'undecided', why: 'too-old' };
  return { action: 'send' };
}
