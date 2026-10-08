export interface SieveScript {
  id: string;
  name: string;
  blobId: string;
  isActive: boolean;
}

export interface SieveCapabilities {
  implementation: string;
  maxSizeScript: number;
  sieveExtensions: string[];
  notificationMethods: string[];
  externalLists: string[];
  /** RFC 9661: redirects run per message; extra ones are skipped silently. */
  maxNumberRedirects?: number | null;
}

export type FilterConditionField =
  | 'from' | 'to' | 'cc' | 'subject' | 'header' | 'size' | 'body'
  | 'attachment'
  // Every message (Sieve `true`): no value, and always the comparator 'any'.
  | 'all';

export type FilterComparator =
  | 'contains' | 'not_contains'
  | 'is' | 'not_is'
  | 'starts_with' | 'ends_with'
  | 'matches'
  | 'greater_than' | 'less_than'
  // For field === 'attachment':
  //   has_any  → message has any attachment (Content-Disposition: attachment)
  //   has_type → message has an attachment whose Content-Type matches `value`
  //              (substring match, e.g. "application/pdf" or "image/")
  | 'has_any' | 'has_type'
  // For field === 'from' | 'to' | 'cc', compared against the parsed address
  // with the Sieve `address` test rather than the raw header text:
  //   address_is → the whole address equals `value` (anna@acme.com, but not
  //                joanna@acme.com)
  //   domain_is  → the domain part equals `value` (acme.com, but neither
  //                sub.acme.com nor acme.com.evil)
  // Older Bulwark versions read these as `header :contains`, so a script
  // they save keeps working, only less strictly.
  | 'address_is' | 'domain_is'
  // For field === 'all': any message at all.
  | 'any';

export type FilterActionType =
  | 'move' | 'copy' | 'forward'
  | 'mark_read' | 'star' | 'add_label'
  | 'discard' | 'reject' | 'keep' | 'stop';

export interface FilterCondition {
  field: FilterConditionField;
  comparator: FilterComparator;
  /**
   * Match value. Use a string array for OR-within-condition semantics
   * (e.g. `["@domain1.com", "@domain2.com"]` matches mail from either).
   * Sieve emits the array as a list literal which the implementation
   * treats as "matches any item". Use a plain string for single-value
   * conditions; existing single-value rules continue to work unchanged.
   *
   * Not supported for: size (numeric), has_any (no value).
   */
  value: string | string[];
  headerName?: string;
}

export interface FilterAction {
  type: FilterActionType;
  value?: string;
  /**
   * move/copy: JMAP id of the target folder. `value` keeps the path as the
   * fallback; the id keeps the rule working after the folder is renamed.
   */
  mailboxId?: string;
  /** forward: also keep the message (`redirect :copy`). */
  keepCopy?: boolean;
}

export type FilterOrigin = 'bulwark' | 'external' | 'opaque';

export interface FilterRule {
  id: string;
  name: string;
  enabled: boolean;
  matchType: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
  stopProcessing: boolean;
  /**
   * Also move/copy messages the server marked as spam. Off by default, so a
   * folder rule does not pull spam out of Junk.
   */
  includeSpam?: boolean;
  /**
   * The rule only acts on mail that arrives from `activeFrom` until
   * `activeUntil`, both inclusive, either one open-ended. Absolute moments
   * as ISO 8601 UTC ("2026-10-05T06:00:00.000Z"), so the script does not
   * depend on the time zone of whoever saves it next. Compiled to Sieve
   * `currentdate` tests (RFC 5260), which need "date" and "relational".
   */
  activeFrom?: string;
  activeUntil?: string;
  origin?: FilterOrigin;
  originLabel?: string;
  rawBlock?: string;
}

export interface VacationSieveConfig {
  isEnabled: boolean;
  subject: string;
  textBody: string;
}

/**
 * Forwarding set up in the vacation card: mail goes on to one address, with
 * or without the auto-reply, in the vacation's period. It is not a filter
 * rule and the filter list does not show it; it runs ahead of the rules.
 */
export interface VacationForward {
  /** The forwarding switch, independent of the auto-reply's. */
  enabled: boolean;
  /** The one address mail is forwarded to. */
  to: string;
  /**
   * Keep the message in this mailbox too (`redirect :copy`). Otherwise it
   * is only forwarded, and no filter rule runs on it.
   */
  keepCopy: boolean;
  /** The auto-reply's period when it was saved, as for FilterRule.activeFrom. */
  activeFrom?: string;
  activeUntil?: string;
}

/**
 * Who gets the auto-reply when not everyone should: only senders from the
 * account's own domains, or only senders from elsewhere. It is decided on
 * the From address while the auto-reply runs from the filters script.
 */
export interface VacationAudience {
  only: 'internal' | 'external';
  /** The account's own domains (from its identities) when it was saved. */
  domains: string[];
}

export interface FilterMetadata {
  /**
   * 2 once a rule has a period or the vacation's forwarding or recipients are
   * stored. Older builds only take version 1 as their own and would write
   * such a script back without these fields; anything else they leave alone.
   */
  version: 1 | 2;
  rules: FilterRule[];
  vacation?: VacationSieveConfig;
  /** See VacationAudience; absent when everyone gets the auto-reply. */
  vacationAudience?: VacationAudience;
  /** See VacationForward; kept while switched off, so the card remembers it. */
  vacationForward?: VacationForward;
  /**
   * The script runs the server-managed "vacation" script via `include`.
   * Servers like Stalwart keep one active script, so a VacationResponse
   * that activates its own script would otherwise switch the filters off.
   */
  includeVacation?: boolean;
}
