/**
 * Every setting an admin can lock, hide or limit (SettingRestriction in
 * lib/admin/types.ts), with where the admin panel offers it. The User policy
 * page lists the ones with page `policy`; each Organisation page lists its
 * own next to the settings they belong to. New user-facing options add their
 * key here instead of a lock flag of their own.
 */

import type { AdminPageId } from './admin-nav';

export interface RestrictionKeyDef {
  key: string;
  label: string;
  /** One sentence for the admin: what locking or hiding it does for users. */
  description?: string;
  category: string;
  type: 'boolean' | 'number' | 'enum';
  allowedValues?: string[];
  /** The admin page that lists it. */
  page: AdminPageId;
  /**
   * Which of locked, hidden, allowed values and a minimum make sense for
   * it. A lock always comes with the value users get (`restriction.value`);
   * `min` keeps users at or above a number (`restriction.min`).
   */
  modes?: ReadonlyArray<'locked' | 'hidden' | 'allowedValues' | 'min'>;
  /** The build's default for the setting (stores/settings-store.ts), for the User policy page. */
  defaultValue?: boolean | number | string;
}

export const RESTRICTION_KEYS: readonly RestrictionKeyDef[] = [
  // Text size, motion, contrast and the other reading aids are left out on
  // purpose: an admin can preset them (policy defaults) but not lock or hide
  // them, see UNLOCKABLE_SETTING_KEYS in lib/accessibility-settings.ts. The
  // presets live in lib/admin/policy-settings.ts.
  { key: 'density', label: 'Density', category: 'Appearance', type: 'enum', allowedValues: ['extra-compact', 'compact', 'regular', 'comfortable'], page: 'policy', defaultValue: 'regular' },
  { key: 'interfaceLayout', label: 'Interface Layout', category: 'Appearance', type: 'enum', allowedValues: ['default', 'mountain-view'], page: 'policy', defaultValue: 'default' },
  {
    key: 'singleKeyShortcuts',
    label: 'Single-key shortcuts',
    description: 'Lock: users keep the shortcuts as set here. Turning them off helps people who use speech input, where a dictated letter can delete or archive mail.',
    category: 'Accessibility',
    type: 'boolean',
    page: 'policy',
    modes: ['locked'],
    defaultValue: true,
  },
  {
    key: 'toastDuration',
    label: 'Notification duration',
    description: 'A minimum for how long messages such as "Moved to Archive" with their Undo button stay. Users can make them stay longer, not shorter.',
    category: 'Accessibility',
    type: 'number',
    page: 'policy',
    modes: ['min'],
    defaultValue: 5,
  },
  {
    key: 'sendConfirmation',
    label: 'Confirm before sending',
    description: 'Lock: users are asked before a message goes out, or not, as set here. Hide removes the option from their settings.',
    category: 'Accessibility',
    type: 'boolean',
    page: 'policy',
    defaultValue: false,
  },
  { key: 'markAsReadDelay', label: 'Mark as Read Delay', category: 'Email', type: 'number', page: 'policy', defaultValue: 0 },
  { key: 'deleteAction', label: 'Delete Action', category: 'Email', type: 'enum', allowedValues: ['trash', 'trash-and-read', 'permanent'], page: 'policy', defaultValue: 'trash' },
  { key: 'showPreview', label: 'Show Preview', category: 'Email', type: 'boolean', page: 'policy', defaultValue: true },
  { key: 'showAttachmentChips', label: 'Show Attachments in List', category: 'Email', type: 'boolean', page: 'policy', defaultValue: true },
  { key: 'showTagChips', label: 'Show Tags in List', category: 'Email', type: 'boolean', page: 'policy', defaultValue: true },
  { key: 'groupListByDate', label: 'Group List by Date', category: 'Email', type: 'boolean', page: 'policy', defaultValue: false },
  { key: 'mailLayout', label: 'Mail Layout', category: 'Email', type: 'enum', allowedValues: ['split', 'focus', 'horizontal'], page: 'policy', defaultValue: 'split' },
  { key: 'emailsPerPage', label: 'Emails Per Page', category: 'Email', type: 'number', page: 'policy', defaultValue: 50 },
  { key: 'externalContentPolicy', label: 'External Content Policy', category: 'Email', type: 'enum', allowedValues: ['allow', 'block', 'ask'], page: 'policy', defaultValue: 'ask' },
  {
    key: 'trustedSendersAddressBook',
    label: 'Keep trusted senders in an address book',
    description: 'On: the senders whose pictures users always load are kept in a "Trusted Senders" address book on the mail server, the same on every device. Off: each device keeps its own list. Servers without address books always keep the list on the device.',
    category: 'Email',
    type: 'boolean',
    page: 'policy',
    defaultValue: true,
  },
  {
    key: 'searchDefaultScope',
    label: 'Search in',
    description: 'Where a new search looks: in all folders, or only in the folder that is open. Users can still pick another folder in the search filters.',
    category: 'Email',
    type: 'enum',
    allowedValues: ['all', 'folder'],
    page: 'policy',
    defaultValue: 'all',
  },
  { key: 'replyUnderMessage', label: 'Replies under the message', category: 'Composer', type: 'boolean', page: 'policy', defaultValue: true },
  { key: 'defaultReplyMode', label: 'Default Reply Mode', category: 'Composer', type: 'enum', allowedValues: ['reply', 'replyAll'], page: 'policy', defaultValue: 'reply' },
  { key: 'autoSelectReplyIdentity', label: 'Auto-select Reply Identity', category: 'Composer', type: 'boolean', page: 'policy', defaultValue: false },
  { key: 'replyIdentityMatch', label: 'Reply Identity Matching', category: 'Composer', type: 'enum', allowedValues: ['exact', 'domain'], page: 'policy', defaultValue: 'domain' },
  { key: 'plainTextMode', label: 'Plain Text Only', category: 'Composer', type: 'boolean', page: 'policy', defaultValue: false },
  // Set on Organisation > Proofreading, with per-plugin keys `proofreading.<pluginId>` (lib/proofreading/gate.ts).
  { key: 'proofreading', label: 'Proofreading', description: 'Locked off, no proofreading plugin gets any text; locked on, it checks in every composer.', category: 'Composer', type: 'boolean', page: 'org-proofreading' },
  { key: 'writingLanguage', label: 'Writing language', category: 'Composer', type: 'enum', page: 'org-proofreading' },
  { key: 'emailNotificationsEnabled', label: 'Email Notifications', category: 'Notifications', type: 'boolean', page: 'policy', defaultValue: true },
  { key: 'calendarNotificationsEnabled', label: 'Calendar Notifications', category: 'Notifications', type: 'boolean', page: 'policy', defaultValue: true },
  { key: 'pushNotifyInboxOnly', label: 'Inbox-only Push Notifications', category: 'Notifications', type: 'boolean', page: 'policy', defaultValue: false },
  {
    key: 'showContactsDirectory',
    label: 'Directory in Contacts',
    description: 'Off hides the Directory entry that lists the accounts and groups on the mail server. Recipient suggestions, sharing and free/busy still use the directory.',
    category: 'Contacts',
    type: 'boolean',
    page: 'policy',
    defaultValue: true,
  },
  { key: 'debugMode', label: 'Debug Mode', category: 'Advanced', type: 'boolean', page: 'policy', defaultValue: false },
  {
    key: 'signature',
    label: 'Signatures',
    description: "Lock: users can't change signatures, and the organisation signature replaces their own. Hide: users get no signature editor at all.",
    category: 'Composer',
    type: 'boolean',
    page: 'org-signatures',
    modes: ['locked', 'hidden'],
  },
  {
    key: 'personalTemplates',
    label: 'Personal templates',
    description: "Hide: users get only the organisation and team templates and can't save templates of their own. The ones they have are kept, not deleted.",
    category: 'Composer',
    type: 'boolean',
    page: 'org-templates',
    modes: ['hidden'],
  },
  {
    key: 'teamTemplates',
    label: 'Team templates',
    description: 'Lock: members of a group mailbox can use its templates but not add, change or delete them.',
    category: 'Composer',
    type: 'boolean',
    page: 'org-templates',
    modes: ['locked'],
  },
  {
    key: 'sharedTags',
    label: 'Shared tags',
    description: "Lock: users can tag mail with the shared tags of their group mailboxes but can't add, rename or delete them. Unlock it in a group scope for the people who look after the tags.",
    category: 'Sharing',
    type: 'boolean',
    page: 'org-sharing',
    modes: ['locked'],
  },
  { key: 'delegation', label: 'Delegates', description: 'Hide removes Settings > Sharing > Delegates, so users can no longer give someone access to mail, calendars and contacts in one step.', category: 'Sharing', type: 'boolean', page: 'org-sharing', modes: ['hidden'] },
  { key: 'sharingRights', label: 'Rights users can give', description: 'Untick "write" and every share dialog in Bulwark (folders, calendars, address books, files, Delegates) offers read access only.', category: 'Sharing', type: 'enum', allowedValues: ['read', 'write'], page: 'org-sharing', modes: ['allowedValues'] },
  { key: 'deletedItemsRecovery', label: 'Recover deleted items', description: 'Hide removes Settings > Recover deleted items and its link in Trash, so users can no longer restore mail they deleted for good.', category: 'Sharing', type: 'boolean', page: 'org-sharing', modes: ['hidden'] },
  {
    key: 'vacationBlockCalendar',
    label: 'Out-of-office blocks the calendar',
    description: 'Lock: an out-of-office reply with dates puts a busy event in the user\'s calendar, or never does, as set here. Users see the choice as set by the organisation.',
    category: 'Calendar',
    type: 'boolean',
    page: 'org-calendars',
    modes: ['locked'],
    defaultValue: true,
  },
];

export function restrictionKeysForPage(page: AdminPageId): RestrictionKeyDef[] {
  return RESTRICTION_KEYS.filter((def) => def.page === page);
}
