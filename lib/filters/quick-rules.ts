import type { Email, Mailbox } from '@/lib/jmap/types';
import type { FilterAction, FilterCondition, FilterRule } from '@/lib/jmap/sieve-types';

/**
 * Rules made from a message: "Always move messages from Anna to…", "Block
 * sender", and the values the rule editor starts from. Pure functions; the
 * account plumbing lives in quick-rule-flow.ts.
 */

export interface RuleSender {
  /** Lower-cased address. */
  email: string;
  name?: string;
}

/** A folder a rule files into: the JMAP id plus the Sieve path fallback. */
export interface RuleMailbox {
  id: string;
  path: string;
  name: string;
}

export type QuickRulePreset =
  | { kind: 'move_sender'; mailbox: RuleMailbox }
  | { kind: 'move_domain'; mailbox: RuleMailbox }
  | { kind: 'move_list'; mailbox: RuleMailbox }
  | { kind: 'mark_read' }
  | { kind: 'tag'; tagId: string; tagName: string }
  | { kind: 'block'; junk: RuleMailbox };

/** What the presets are made from. */
export interface QuickRuleSubject {
  senders: RuleSender[];
  /** The one domain every sender shares. */
  domain: string | null;
  /** The one List-Id every message carries. */
  listId: string | null;
}

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export function normalizeAddress(address: string | null | undefined): string {
  return (address ?? '').trim().toLowerCase();
}

export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).toLowerCase();
}

/**
 * Every distinct sender of `emails`, compared case-insensitively, with the
 * first display name seen for each. The user's own addresses are dropped: a
 * rule against yourself would file your own replies away.
 */
export function collectSenders(emails: Array<Pick<Email, 'from'>>, ownAddresses: ReadonlySet<string>): RuleSender[] {
  const byAddress = new Map<string, RuleSender>();
  for (const email of emails) {
    for (const from of email.from ?? []) {
      const address = normalizeAddress(from.email);
      if (!address || !address.includes('@') || ownAddresses.has(address)) continue;
      const existing = byAddress.get(address);
      const name = from.name?.trim() || undefined;
      if (!existing) byAddress.set(address, { email: address, ...(name ? { name } : {}) });
      else if (!existing.name && name) existing.name = name;
    }
  }
  return [...byAddress.values()];
}

/** The domain every sender shares, or null when they differ (or there are none). */
export function sharedDomain(senders: RuleSender[]): string | null {
  let domain: string | null = null;
  for (const sender of senders) {
    const d = addressDomain(sender.email);
    if (!d) return null;
    if (domain === null) domain = d;
    else if (d !== domain) return null;
  }
  return domain;
}

/**
 * The list identifier of a List-Id header (RFC 2919): the part inside the
 * angle brackets, so "Weekly news <news.example.org>" gives
 * "news.example.org". A header without brackets is taken whole.
 */
export function extractListId(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const bracketed = value.match(/<([^<>]+)>\s*$/);
  const id = (bracketed ? bracketed[1] : value).trim();
  if (!id || /\s/.test(id)) return null;
  return id;
}

/**
 * A raw header value (JMAP `header:Name` without a form) as one line: folding
 * undone, surrounding whitespace dropped. Encoded words stay encoded.
 */
export function unfoldHeader(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.replace(/\r?\n[ \t]+/g, ' ').trim();
}

/** The List-Id every message has, or null when one lacks it or they differ. */
export function sharedListId(listIds: Array<string | null | undefined>): string | null {
  let shared: string | null = null;
  for (const id of listIds) {
    if (!id) return null;
    if (shared === null) shared = id;
    else if (shared.toLowerCase() !== id.toLowerCase()) return null;
  }
  return shared;
}

/** The value of `name` in a parsed header record, whatever its case. */
export function headerValue(headers: Email['headers'], name: string): string | string[] | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

const SUBJECT_PREFIX = /^\s*(?:re|fwd?|aw|wg)\s*(?:\[\d+\])?\s*:\s*/i;

/** The subject without its reply/forward prefixes (Re:, Fwd:, AW:, WG:). */
export function stripSubjectPrefixes(subject: string | null | undefined): string {
  let s = (subject ?? '').trim();
  let previous;
  do {
    previous = s;
    s = s.replace(SUBJECT_PREFIX, '');
  } while (s !== previous);
  return s.trim();
}

/**
 * The Sieve path of a folder, as the rule editor writes it: parent names
 * joined with "/", with the inbox as the IMAP-canonical "INBOX".
 */
export function mailboxSievePath(mailboxes: Mailbox[], mailboxId: string): string {
  const byId = new Map(mailboxes.map(m => [m.id, m]));
  const segments: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(mailboxId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    segments.unshift(current.role === 'inbox' ? 'INBOX' : current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return segments.join('/');
}

export function toRuleMailbox(mailboxes: Mailbox[], mailbox: Mailbox): RuleMailbox {
  return { id: mailbox.originalId || mailbox.id, path: mailboxSievePath(mailboxes, mailbox.id), name: mailbox.name };
}

/**
 * Folders an "Always move" rule can file into: the account's own folders
 * that accept mail, without Drafts. Unlike "Move to", the current folder and
 * the Inbox stay in.
 */
export function ruleTargetMailboxIds(mailboxes: Mailbox[]): Set<string> {
  return new Set(
    mailboxes
      .filter(m => !m.isShared && !m.id.startsWith('shared-') && m.role !== 'drafts' && m.myRights?.mayAddItems)
      .map(m => m.id),
  );
}

export function findJunkMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  return mailboxes.find(m => !m.isShared && m.role === 'junk');
}

function senderValue(senders: RuleSender[]): string | string[] {
  const addresses = senders.map(s => s.email);
  return addresses.length === 1 ? addresses[0] : addresses;
}

/** The condition "from one of these senders", matched on the exact address. */
export function senderCondition(senders: RuleSender[]): FilterCondition {
  return { field: 'from', comparator: 'address_is', value: senderValue(senders) };
}

export function domainCondition(domain: string): FilterCondition {
  return { field: 'from', comparator: 'domain_is', value: domain };
}

export function listIdCondition(listId: string): FilterCondition {
  return { field: 'header', headerName: 'List-Id', comparator: 'contains', value: listId };
}

/** How rule names refer to the senders: the address, or "3 senders". */
export function senderNameFor(senders: RuleSender[], t: Translate): string {
  return senders.length === 1 ? senders[0].email : t('quick_rule_names.senders', { count: senders.length });
}

function moveAction(mailbox: RuleMailbox): FilterAction {
  return { type: 'move', value: mailbox.path, mailboxId: mailbox.id };
}

/**
 * The rule a one-click preset saves. `t` is the settings.filters translator,
 * which names it ("Move from anna@acme.com to Newsletters").
 */
export function buildPresetRule(
  preset: QuickRulePreset,
  subject: QuickRuleSubject,
  t: Translate,
  id: string,
): FilterRule {
  const sender = senderNameFor(subject.senders, t);
  const base = { id, enabled: true, matchType: 'all' as const, stopProcessing: true };
  switch (preset.kind) {
    case 'move_sender':
      return {
        ...base,
        name: t('quick_rule_names.move_sender', { sender, folder: preset.mailbox.name }),
        conditions: [senderCondition(subject.senders)],
        actions: [moveAction(preset.mailbox)],
      };
    case 'move_domain':
      return {
        ...base,
        name: t('quick_rule_names.move_domain', { domain: subject.domain ?? '', folder: preset.mailbox.name }),
        conditions: [domainCondition(subject.domain ?? '')],
        actions: [moveAction(preset.mailbox)],
      };
    case 'move_list':
      return {
        ...base,
        name: t('quick_rule_names.move_list', { list: subject.listId ?? '', folder: preset.mailbox.name }),
        conditions: [listIdCondition(subject.listId ?? '')],
        actions: [moveAction(preset.mailbox)],
      };
    case 'mark_read':
      return {
        ...base,
        name: t('quick_rule_names.mark_read', { sender }),
        conditions: [senderCondition(subject.senders)],
        actions: [{ type: 'mark_read' }],
      };
    case 'tag':
      return {
        ...base,
        name: t('quick_rule_names.tag', { sender, tag: preset.tagName }),
        conditions: [senderCondition(subject.senders)],
        actions: [{ type: 'add_label', value: preset.tagId }],
      };
    case 'block':
      // The spam guard would skip exactly the mail this rule is for.
      return {
        ...base,
        name: t('quick_rule_names.block', { sender }),
        conditions: [senderCondition(subject.senders)],
        actions: [moveAction(preset.junk)],
        includeSpam: true,
      };
  }
}

/**
 * The rule "Create rule…" opens with: From = the senders, one Move with no
 * folder chosen yet, stop after it.
 */
export function buildPrefillRule(subject: QuickRuleSubject, t: Translate, id: string): FilterRule {
  const hasSenders = subject.senders.length > 0;
  return {
    id,
    name: hasSenders
      ? t('quick_rule_names.custom', { sender: senderNameFor(subject.senders, t) })
      : t('quick_rule_names.custom_plain'),
    enabled: true,
    matchType: 'all',
    conditions: hasSenders ? [senderCondition(subject.senders)] : [],
    actions: [{ type: 'move', value: '' }],
    stopProcessing: true,
  };
}

export function isBulwarkRule(rule: FilterRule): boolean {
  return !rule.origin || rule.origin === 'bulwark';
}

/**
 * New rules made from a message go first, so an older, broader rule does not
 * catch the mail before them. The generator writes the vacation block and the
 * external/opaque blocks where they always go, so the front of the list is
 * the top of Bulwark's own section.
 */
export function insertRuleAtTop(rules: FilterRule[], rule: FilterRule): FilterRule[] {
  return [rule, ...rules];
}

/** Replace the rule with the same id in place, or add it at the top. */
export function replaceOrInsertRule(rules: FilterRule[], rule: FilterRule): FilterRule[] {
  return rules.some(r => r.id === rule.id)
    ? rules.map(r => (r.id === rule.id ? rule : r))
    : insertRuleAtTop(rules, rule);
}

function valueList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value]).filter(v => typeof v === 'string' && v.length > 0);
}

function sameConditionKind(a: FilterCondition, b: FilterCondition): boolean {
  return a.field === b.field
    && a.comparator === b.comparator
    && (a.headerName ?? '').toLowerCase() === (b.headerName ?? '').toLowerCase();
}

function sameAction(a: FilterAction, b: FilterAction): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'move':
    case 'copy':
      return a.mailboxId && b.mailboxId ? a.mailboxId === b.mailboxId : (a.value ?? '') === (b.value ?? '');
    case 'add_label':
    case 'forward':
    case 'reject':
      return (a.value ?? '') === (b.value ?? '');
    default:
      return true;
  }
}

function sameActions(a: FilterAction[], b: FilterAction[]): boolean {
  if (a.length !== b.length) return false;
  const unmatched = [...b];
  for (const action of a) {
    const index = unmatched.findIndex(other => sameAction(action, other));
    if (index === -1) return false;
    unmatched.splice(index, 1);
  }
  return true;
}

export type QuickRuleOutcome =
  /** No rule did this yet: `rule` is new, at the top. */
  | { kind: 'created'; rules: FilterRule[]; rule: FilterRule; added: FilterRule }
  /** `rule` already did this for other values and now covers these too. */
  | { kind: 'merged'; rules: FilterRule[]; rule: FilterRule; added: FilterRule }
  /** `rule` already covers every value; nothing to write. */
  | { kind: 'covered'; rule: FilterRule };

/**
 * Save a one-click rule without piling up near-duplicates: an enabled
 * Bulwark rule with a single condition of the same kind and the same actions
 * takes the new values into its value list and keeps its name and place.
 * `added` is the part of the rule that is new (the candidate itself, or the
 * merged rule narrowed to the added values), which is what the "apply to
 * existing messages" pass runs.
 */
export function applyQuickRule(rules: FilterRule[], candidate: FilterRule): QuickRuleOutcome {
  const condition = candidate.conditions[0];
  const target = candidate.conditions.length === 1
    ? rules.find(r =>
        isBulwarkRule(r)
        && r.enabled
        && r.conditions.length === 1
        && sameConditionKind(r.conditions[0], condition)
        && sameActions(r.actions, candidate.actions))
    : undefined;

  if (!target) {
    return { kind: 'created', rules: insertRuleAtTop(rules, candidate), rule: candidate, added: candidate };
  }

  const existing = valueList(target.conditions[0].value);
  const known = new Set(existing.map(v => v.toLowerCase()));
  const added: string[] = [];
  for (const value of valueList(condition.value)) {
    const key = value.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    added.push(value);
  }
  if (added.length === 0) return { kind: 'covered', rule: target };

  const merged: FilterRule = {
    ...target,
    conditions: [{ ...target.conditions[0], value: [...existing, ...added] }],
  };
  return {
    kind: 'merged',
    rules: rules.map(r => (r.id === target.id ? merged : r)),
    rule: merged,
    added: {
      ...merged,
      conditions: [{ ...merged.conditions[0], value: added.length === 1 ? added[0] : added }],
    },
  };
}

/** Where a message's rule would be saved, as far as the menu needs to know. */
export interface RuleAccountInfo {
  /** Identifies the login + JMAP account, so a selection can be compared. */
  key: string;
  /** A shared or group account: its filters are not the user's to set. */
  shared: boolean;
  supportsSieve: boolean;
}

export type RulesMenuAvailability = 'hidden' | 'cross_account' | 'available';

/**
 * Whether the Rules entry shows. A shared account or one without Sieve gets
 * none; a selection that spans accounts gets a disabled entry, because one
 * rule can only go into one account's script.
 */
export function rulesMenuAvailability(accounts: Array<RuleAccountInfo | null>): RulesMenuAvailability {
  if (accounts.length === 0 || accounts.some(a => a === null)) return 'hidden';
  const known = accounts as RuleAccountInfo[];
  if (new Set(known.map(a => a.key)).size > 1) return 'cross_account';
  const [account] = known;
  if (account.shared || !account.supportsSieve) return 'hidden';
  return 'available';
}

/** A condition the rule editor offers as a one-click chip. */
export interface RuleSuggestion {
  id: 'subject' | 'to' | 'list' | 'domain';
  label: string;
  condition: FilterCondition;
  /** Put the condition in place of the first one this matches, instead of adding it. */
  replaces?: (condition: FilterCondition) => boolean;
}

/**
 * The chips "Create rule…" offers for `anchor`, the message it was opened on:
 * its subject (without Re:/Fwd:), the own address it was delivered to, its
 * List-Id, and the senders' shared domain in place of the sender condition.
 * `t` is the settings.filters translator.
 */
export function buildSuggestions(
  anchor: Pick<Email, 'subject' | 'to' | 'cc'>,
  subject: QuickRuleSubject,
  ownAddresses: ReadonlySet<string>,
  t: Translate,
): RuleSuggestion[] {
  const suggestions: RuleSuggestion[] = [];

  const topic = stripSubjectPrefixes(anchor.subject);
  if (topic) {
    suggestions.push({
      id: 'subject',
      label: t('suggest_subject', { subject: topic.length > 40 ? `${topic.slice(0, 39)}…` : topic }),
      // The editor reads a comma in a plain value as a list separator.
      condition: { field: 'subject', comparator: 'contains', value: topic.includes(',') ? [topic] : topic },
    });
  }

  const inTo = (anchor.to ?? []).find(a => ownAddresses.has(normalizeAddress(a.email)));
  const inCc = inTo ? undefined : (anchor.cc ?? []).find(a => ownAddresses.has(normalizeAddress(a.email)));
  const delivered = inTo ?? inCc;
  if (delivered) {
    const address = normalizeAddress(delivered.email);
    suggestions.push({
      id: 'to',
      label: t(inTo ? 'suggest_to' : 'suggest_cc', { address }),
      condition: { field: inTo ? 'to' : 'cc', comparator: 'address_is', value: address },
    });
  }

  if (subject.listId) {
    suggestions.push({ id: 'list', label: t('suggest_list'), condition: listIdCondition(subject.listId) });
  }

  if (subject.domain && subject.senders.length > 0) {
    suggestions.push({
      id: 'domain',
      label: t('suggest_domain', { domain: subject.domain }),
      condition: domainCondition(subject.domain),
      replaces: (c) => c.field === 'from' && c.comparator === 'address_is',
    });
  }

  return suggestions;
}
