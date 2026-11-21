import { DEFAULT_SEARCH_FILTERS, type SearchFilters } from '@/lib/jmap/search-utils';
import type { SearchKind } from '@/lib/global-search/types';

/**
 * Query syntax for global search (plan §3.3, the v1 subset of the Pro
 * features doc §8.2):
 *
 *   in:mail|contacts|calendar|files   scope (also in:trash / in:junk for mail)
 *   account:<label|email>             restrict to one login
 *   from: to: subject:                mail filters (1:1 onto SearchFilters)
 *   has:attachment                    mail
 *   has:notag|notags                  mail without a tag (same as is:untagged)
 *   is:unread|read|starred|unstarred  mail
 *   is:untagged                       mail without a tag
 *   is:anything                       mail, including Trash/Junk
 *   after:YYYY-MM-DD before:YYYY-MM-DD mail + calendar date bounds
 *   "quoted phrase"                   kept as a phrase for the server
 *
 * Everything else - including unknown `key:value` pairs and malformed dates -
 * stays free text, so a colon in a normal query never silently drops words.
 */
export type SearchScope = 'all' | SearchKind;

export interface ParsedQuery {
  raw: string;
  /** Free text for the server: words and quoted phrases, operators removed. */
  text: string;
  /** Lower-cased words and phrases for local substring matching. Empty when the query has only operators. */
  terms: string[];
  scope: SearchScope;
  /** `account:` value, lower-cased; matched against the login label / email. */
  account: string | null;
  /** Mail structured filters (`from:` … `is:starred`). Dates are mirrored in `after`/`before`. */
  mail: SearchFilters;
  /** `YYYY-MM-DD` bounds shared by mail and calendar. */
  after: string | null;
  before: string | null;
  /** `in:trash` / `in:junk`: search that role folder only. */
  mailboxRole: 'trash' | 'junk' | null;
  /** `is:anything`: do not exclude Trash and Junk from the default mail scope. */
  includeTrashAndJunk: boolean;
  /** True when any operator narrowed the query (drives the palette's "syntax" hint). */
  hasOperators: boolean;
}

const SCOPE_ALIASES: Record<string, SearchScope> = {
  all: 'all',
  everything: 'all',
  mail: 'mail',
  email: 'mail',
  emails: 'mail',
  messages: 'mail',
  contacts: 'contacts',
  contact: 'contacts',
  people: 'contacts',
  calendar: 'calendar',
  calendars: 'calendar',
  events: 'calendar',
  event: 'calendar',
  files: 'files',
  file: 'files',
  drive: 'files',
};

const OPERATORS = new Set(['in', 'account', 'from', 'to', 'subject', 'has', 'is', 'after', 'before']);

/** Accepts `YYYY-MM-DD` that names a real calendar day. */
export function isValidLinkDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return date.getMonth() === Number(m) - 1 && date.getDate() === Number(d);
}

interface Token {
  key: string | null;
  value: string;
  quoted: boolean;
  /** The token exactly as typed, for putting unknown operators back into the text. */
  original: string;
}

// `key:"quoted value"`, `key:value`, `"quoted phrase"`, or a bare word. A
// trailing unmatched quote is tolerated (the user is still typing).
const TOKEN_RE = /([A-Za-z]+):(?:"([^"]*)"?|(\S+))|"([^"]*)"?|(\S+)/g;

export function tokenizeQuery(raw: string): Token[] {
  const tokens: Token[] = [];
  for (const match of raw.matchAll(TOKEN_RE)) {
    const [original, key, quotedValue, bareValue, phrase, word] = match;
    if (key !== undefined) {
      tokens.push({
        key: key.toLowerCase(),
        value: quotedValue ?? bareValue ?? '',
        quoted: quotedValue !== undefined,
        original,
      });
    } else if (phrase !== undefined) {
      tokens.push({ key: null, value: phrase, quoted: true, original });
    } else if (word !== undefined) {
      tokens.push({ key: null, value: word, quoted: false, original });
    }
  }
  return tokens;
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const textParts: string[] = [];
  const terms: string[] = [];
  const mail: SearchFilters = { ...DEFAULT_SEARCH_FILTERS };
  let scope: SearchScope = 'all';
  let account: string | null = null;
  let after: string | null = null;
  let before: string | null = null;
  let mailboxRole: 'trash' | 'junk' | null = null;
  let includeTrashAndJunk = false;
  let hasOperators = false;

  const pushText = (value: string, quoted: boolean) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    textParts.push(quoted ? `"${trimmed}"` : trimmed);
    terms.push(trimmed.toLowerCase());
  };

  for (const token of tokenizeQuery(raw)) {
    if (token.key === null || !OPERATORS.has(token.key)) {
      // Bare word, phrase, or an unknown `foo:bar` - all free text.
      if (token.key !== null) pushText(token.original, false);
      else pushText(token.value, token.quoted);
      continue;
    }
    const value = token.value.trim();
    const lower = value.toLowerCase();
    let consumed = true;
    switch (token.key) {
      case 'in': {
        const alias = SCOPE_ALIASES[lower];
        if (alias) {
          scope = alias;
        } else if (lower === 'trash' || lower === 'bin') {
          scope = 'mail';
          mailboxRole = 'trash';
        } else if (lower === 'junk' || lower === 'spam') {
          scope = 'mail';
          mailboxRole = 'junk';
        } else {
          consumed = false;
        }
        break;
      }
      case 'account':
        if (lower) account = lower;
        else consumed = false;
        break;
      case 'from':
        if (value) mail.from = value;
        else consumed = false;
        break;
      case 'to':
        if (value) mail.to = value;
        else consumed = false;
        break;
      case 'subject':
        if (value) mail.subject = value;
        else consumed = false;
        break;
      case 'has':
        if (lower === 'attachment' || lower === 'attachments' || lower === 'file') mail.hasAttachment = true;
        else if (lower === 'notag' || lower === 'notags') mail.untagged = true;
        else consumed = false;
        break;
      case 'is':
        if (lower === 'unread') mail.isUnread = true;
        else if (lower === 'read') mail.isUnread = false;
        else if (lower === 'starred' || lower === 'flagged') mail.isStarred = true;
        else if (lower === 'unstarred') mail.isStarred = false;
        else if (lower === 'untagged') mail.untagged = true;
        else if (lower === 'anything' || lower === 'any') includeTrashAndJunk = true;
        else consumed = false;
        break;
      case 'after':
        if (isValidLinkDate(value)) {
          after = value;
          mail.dateAfter = value;
        } else consumed = false;
        break;
      case 'before':
        if (isValidLinkDate(value)) {
          before = value;
          mail.dateBefore = value;
        } else consumed = false;
        break;
    }
    if (consumed) hasOperators = true;
    else pushText(token.original, false);
  }

  return {
    raw,
    text: textParts.join(' '),
    terms,
    scope,
    account,
    mail,
    after,
    before,
    mailboxRole,
    includeTrashAndJunk,
    hasOperators,
  };
}

/**
 * Rewrites the `in:` / `account:` operators of a raw query - the palette's
 * scope and account chips are sugar over the syntax, so the two never drift.
 */
export function withScopeAndAccount(raw: string, scope: SearchScope, accountLabel: string | null): string {
  const kept = tokenizeQuery(raw)
    .filter((t) => !(t.key === 'in' && SCOPE_ALIASES[t.value.toLowerCase()]) && t.key !== 'account')
    .map((t) => t.original);
  if (scope !== 'all') kept.push(`in:${scope}`);
  if (accountLabel) kept.push(/\s/.test(accountLabel) ? `account:"${accountLabel}"` : `account:${accountLabel}`);
  return kept.join(' ');
}

/** Does a login match the `account:` operator (label substring or email prefix/equality)? */
export function accountMatches(pattern: string | null, account: { label: string; email: string; localAccountId: string }): boolean {
  if (!pattern) return true;
  const p = pattern.toLowerCase();
  const email = account.email.toLowerCase();
  const label = account.label.toLowerCase();
  return email === p || email.startsWith(p) || label.includes(p) || account.localAccountId.toLowerCase() === p;
}

/** Local matching helper: every term is a substring of at least one of the given fields. */
export function matchesTerms(terms: string[], fields: Array<string | null | undefined>): boolean {
  if (terms.length === 0) return false;
  const haystack = fields.filter((f): f is string => typeof f === 'string' && f.length > 0).map((f) => f.toLowerCase());
  if (haystack.length === 0) return false;
  return terms.every((term) => haystack.some((field) => field.includes(term)));
}
