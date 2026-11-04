// Area c of the assistant's host APIs: its permissions, its flags in
// api.host.features and the shapes its calls take and return (see
// README.md). Pure: no imports from the app.

/**
 * Permissions this area adds to ALL_PERMISSIONS. Both are high risk:
 * answering an invitation sends a reply to the organiser, and changing
 * settings changes how the app behaves for the user.
 */
export const PERMISSIONS = ['calendar:respond', 'settings:change'] as const;

/** Flags this area adds to api.host.features (missing on older hosts). */
export interface AreaHostFeaturesC {
  /** calendar.respond answers an invitation the way the reader's banner does. */
  answerInvitation?: boolean;
  /** filters.list / create / undo over Settings > Filters (the server supports Sieve). */
  filterRules?: boolean;
  /** email.batch / undoBatch: one change to many messages, one Undo. */
  batchMail?: boolean;
  /** app.describeSettings / setSettings / undoSettings. */
  changeSettings?: boolean;
}

// ─── Invitations ──────────────────────────────────────────────

export type InvitationAnswer = 'accepted' | 'tentative' | 'declined';

/** What calendar.respond answered. */
export interface InvitationResponseView {
  status: InvitationAnswer;
  /** The event's title. */
  title: string;
  /** Its start as the invitation gives it (local date-time, or a date), or null. */
  start: string | null;
  /** The organiser's address, or null when the invitation names none. */
  organizer: string | null;
}

/** What calendar.deleteEvent returns now: a token for calendar.undoDelete, or null when it can't be undone. */
export interface EventDeleteResult {
  undoToken: string | null;
}

// ─── Filters ──────────────────────────────────────────────────

export type FilterRuleField = 'from' | 'to' | 'cc' | 'subject' | 'body' | 'header' | 'size' | 'attachment';
export type FilterRuleOp =
  | 'contains' | 'not_contains' | 'is' | 'not_is' | 'starts_with' | 'ends_with'
  | 'address_is' | 'domain_is' | 'greater_than' | 'less_than' | 'has_any' | 'has_type';
/** The actions a plugin may put in a rule. Forward, reject, discard and keep don't exist here. */
export type FilterRuleActionType = 'move' | 'copy' | 'mark_read' | 'star' | 'add_label' | 'stop';

export interface FilterRuleConditionInput {
  field: FilterRuleField;
  op: FilterRuleOp;
  /** A string, or several (any of them matches). Size in bytes. None for has_any. */
  value?: string | string[];
  /** For field 'header'. */
  headerName?: string;
}

export interface FilterRuleActionInput {
  type: FilterRuleActionType;
  /** move / copy: a folder of the filters' own account, not a shared one. */
  mailboxId?: string;
  /** add_label: the id of one of the user's tags (keywords.list). */
  tagId?: string;
}

/** filters.create's rule. */
export interface FilterRuleInput {
  name: string;
  /** All conditions must match (default) or any one. */
  match?: 'all' | 'any';
  conditions: FilterRuleConditionInput[];
  actions: FilterRuleActionInput[];
}

/** A rule as filters.list shows it. */
export interface FilterRuleInfo {
  id: string;
  name: string;
  isActive: boolean;
  /** False for rules written elsewhere (kept as they are). */
  editable: boolean;
  match: 'all' | 'any';
  conditions: { field: string; op: string; value: string | string[]; headerName?: string }[];
  /** `folder` is the folder's path for move/copy, `tagId` the tag of add_label, `value` the address of a forward. */
  actions: { type: string; mailboxId?: string; folder?: string; tagId?: string; value?: string }[];
}

export interface FiltersListView {
  /** The server has filters (Sieve). */
  supported: boolean;
  /** Rules can be added: false when the script was edited by hand. */
  editable: boolean;
  rules: FilterRuleInfo[];
}

export interface FilterCreateResult {
  id: string;
  undoToken: string;
}

// ─── Batches ──────────────────────────────────────────────────

export type MailBatchAction = 'archive' | 'move' | 'read' | 'unread' | 'tag' | 'untag';

export interface MailBatchInput {
  /** Messages of the signed-in account, at most 200. */
  emailIds: string[];
  action: MailBatchAction;
  /** move: a folder of the signed-in account, not a shared one and not the trash. */
  mailboxId?: string;
  /** tag / untag: one of the user's tags. */
  tagId?: string;
}

export interface MailBatchResult {
  /** Messages changed. */
  done: number;
  /** Messages not found or not changed. */
  failed: number;
  /** For email.undoBatch; null when nothing changed. */
  undoToken: string | null;
}

// ─── Out-of-office ────────────────────────────────────────────

/** What vacation.get adds to VacationView. */
export interface VacationForwardField {
  /**
   * The out-of-office forwards mail to another address while it is on (set
   * in Settings > Out of office); null when the filters couldn't be read.
   * vacation.set refuses to switch the reply on unless this is false.
   */
  forwardActive: boolean | null;
}

// ─── Settings ─────────────────────────────────────────────────

export type SettingValue = string | number | boolean | (string | number)[];

/** Why a setting can't be changed. */
export type SettingRefusal = 'unknown' | 'not_allowed' | 'bad_value' | 'locked' | 'hidden' | 'unavailable' | 'stopped';

/** One setting, in the user's language (app.describeSettings). */
export interface SettingDescription {
  key: string;
  /** The setting's name as its row shows it. */
  label: string;
  /** The settings page it is on (its id and its name). */
  page: string;
  pageLabel: string;
  current: SettingValue | null;
  currentLabel: string;
  /** The value asked about, when one was given. */
  next?: SettingValue;
  nextLabel?: string;
  /** Whether the change may be made now (for a key alone: whether the setting may be changed). */
  allowed: boolean;
  reason?: SettingRefusal;
  /** The values it may take, for a setting with a short list of them. */
  options?: { value: string | number | boolean; label: string }[];
}

export interface SettingsChangeResult {
  applied: Record<string, { old: SettingValue | null; new: SettingValue }>;
  refused: Record<string, SettingRefusal>;
  /** For app.undoSettings; null when nothing changed. */
  undoToken: string | null;
}

export interface SettingsUndoResult {
  restored: string[];
  refused: Record<string, SettingRefusal>;
}
