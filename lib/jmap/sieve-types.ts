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
  | 'attachment';

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
  | 'has_any' | 'has_type';

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
  origin?: FilterOrigin;
  originLabel?: string;
  rawBlock?: string;
}

export interface VacationSieveConfig {
  isEnabled: boolean;
  subject: string;
  textBody: string;
}

export interface FilterMetadata {
  version: 1;
  rules: FilterRule[];
  vacation?: VacationSieveConfig;
  /**
   * The script runs the server-managed "vacation" script via `include`.
   * Servers like Stalwart keep one active script, so a VacationResponse
   * that activates its own script would otherwise switch the filters off.
   */
  includeVacation?: boolean;
}
