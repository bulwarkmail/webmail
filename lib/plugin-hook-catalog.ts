// Every plugin hook the host offers: what kind it is, which permission a
// plugin needs for it, what it receives, and where the host fires it.
//
// This is the single source of truth. The permission table in
// plugin-sandbox/permissions.ts, the hook reference in the plugin docs and
// the "every hook is fired" test (lib/__tests__/plugin-hook-catalog.test.ts)
// all read it, so a hook can't be declared without a call site, a permission
// and a description.
//
// Kinds:
// - observer: told after something happened; the return value is ignored.
// - intercept: asked before something happens; return false to stop it.
// - transform: handed a value and returns a changed one (or undefined to
//   leave it alone); handlers run in order, each sees the previous result.
// - takeover: may do the action itself instead of the host (onComposeSend).
//
// Payloads cross into a sandboxed iframe, so they are plain data. Changing a
// payload object in place has no effect on the host; use the return value.

import type { Permission } from './plugin-types';

export type HookKind = 'observer' | 'intercept' | 'transform' | 'takeover';

export type HookGroup =
  | 'mail-list' | 'mail-read' | 'mail-compose' | 'mail-send' | 'mail-organize' | 'mail-mailboxes'
  | 'mail-search' | 'mail-attachments' | 'mail-sync'
  | 'calendar' | 'contacts' | 'tasks' | 'files'
  | 'settings' | 'identities' | 'filters' | 'vacation' | 'templates'
  | 'auth' | 'security' | 'navigation' | 'theme' | 'notifications' | 'app' | 'ui' | 'keyboard' | 'tabs';

export interface HookSpec {
  group: HookGroup;
  kind: HookKind;
  permission: Permission;
  /** What the handler receives (and, for transforms, returns). */
  payload: string;
  /** When the host fires it. */
  when: string;
}

const H = (group: HookGroup, kind: HookKind, permission: Permission, payload: string, when: string): HookSpec =>
  ({ group, kind, permission, payload, when });

export const HOOK_CATALOG = {
  // ─── Mail: message list ────────────────────────────────────
  onEmailsFetched: H('mail-list', 'transform', 'email:render-takeover', 'Email[] (list rows), { mailboxId }', 'after a page of the message list is loaded, before it is shown'),
  onEmailListItemRender: H('mail-list', 'transform', 'email:read', 'EmailListBadge[], { email: EmailSummary }', 'for each visible row; returned badges are shown next to the subject'),
  onEmailSelectionChange: H('mail-list', 'observer', 'email:read', '{ emailIds: string[] }', 'when the set of selected messages changes'),
  onMailboxChange: H('mail-list', 'observer', 'email:read', '{ mailboxId, role, previousMailboxId }', 'when the user opens another folder'),

  // ─── Mail: reading ─────────────────────────────────────────
  onEmailOpen: H('mail-read', 'observer', 'email:read', 'EmailReadView', 'when a message is opened'),
  onEmailClose: H('mail-read', 'observer', 'email:read', '{ emailId }', 'when the open message is closed or replaced'),
  onRenderEmailBody: H('mail-read', 'transform', 'email:render-takeover', 'RenderableBody, MessageContext', 'before the body of an opened message is rendered'),
  onEmailContentRender: H('mail-read', 'observer', 'email:read', '{ emailId, hasHtml, hasExternalContent }', 'after the body of an opened message is on screen'),
  onThreadExpand: H('mail-read', 'observer', 'email:read', '{ threadId, emailIds, expanded }', 'when a conversation is expanded or collapsed'),
  onBeforeReply: H('mail-read', 'intercept', 'email:read', 'ReplyContext', 'when Reply is chosen, before the composer opens'),
  onBeforeReplyAll: H('mail-read', 'intercept', 'email:read', 'ReplyContext', 'when Reply all is chosen, before the composer opens'),
  onBeforeForward: H('mail-read', 'intercept', 'email:read', 'ReplyContext', 'when Forward is chosen, before the composer opens'),
  onBeforeExternalLink: H('mail-read', 'intercept', 'ui:observe', 'ExternalLinkContext', 'when a link in a message is clicked; return false to stop it or { href } to change it'),
  onAvatarResolve: H('mail-read', 'transform', 'email:read', 'string | null (avatar URL), { email, name }', 'when a sender avatar is needed'),

  // ─── Mail: composing ───────────────────────────────────────
  onBeforeCompose: H('mail-compose', 'intercept', 'email:send', 'ComposeOptions', 'before the composer opens; return false to stop it or a ComposeOptions to prefill it'),
  onComposerOpen: H('mail-compose', 'observer', 'email:read', 'ComposerContext', 'after the composer opened'),
  onComposerClose: H('mail-compose', 'observer', 'email:read', '{ draftId, sent: boolean }', 'after the composer closed'),
  onDraftChange: H('mail-compose', 'observer', 'email:read', 'DraftView', 'while the user writes (debounced)'),
  onBeforeDraftAutoSave: H('mail-compose', 'transform', 'email:send', 'AlmostSavedDraft', 'before a draft is saved; return a changed draft, or false to skip a save while typing (saves on close and before send always run)'),
  onDraftAutoSave: H('mail-compose', 'observer', 'email:read', '{ draftId, subject }', 'after a draft was saved'),
  onBeforeEditDraft: H('mail-compose', 'transform', 'email:send', 'Email', 'before a saved draft is opened in the composer'),
  onBuildQuoteHeader: H('mail-compose', 'transform', 'email:send', 'QuoteHeader, QuoteHeaderContext', 'when a reply or forward is set up'),
  onRecipientChipsChange: H('mail-compose', 'transform', 'email:send', 'Recipient[]', 'when the recipient fields change'),
  onBeforeComposeOpenToReply: H('mail-compose', 'transform', 'email:send', 'Email (the original)', 'before a reply is filled in'),
  onBeforeComposeOpenToReplyAll: H('mail-compose', 'transform', 'email:send', 'Email (the original)', 'before a reply-all is filled in'),
  onBeforeComposeOpenToForward: H('mail-compose', 'transform', 'email:send', 'Email (the original)', 'before a forward is filled in'),
  onBeforeComposeOpenToForwardAsAttachment: H('mail-compose', 'transform', 'email:send', 'Email (the original)', 'before a forward-as-attachment is filled in'),
  onMailtoIntercept: H('mail-compose', 'intercept', 'email:read', 'MailtoContext', 'when a mailto: link is opened; return false to stop the composer'),

  // ─── Mail: sending ─────────────────────────────────────────
  onBeforeEmailSend: H('mail-send', 'intercept', 'email:send', 'OutgoingEmail', 'when Send is pressed; a handler that fails or times out stops the send'),
  onTransformOutgoingEmail: H('mail-send', 'transform', 'email:send', 'OutgoingEmail', 'right before the message is submitted'),
  onComposeSend: H('mail-send', 'takeover', 'email:send', 'ComposeSendRequest', 'at the start of sending; may send the message itself'),
  onAfterEmailSend: H('mail-send', 'observer', 'email:read', '{ emailId, submissionId, to, cc, bcc, subject, scheduledFor }', 'after the server accepted the message'),

  // ─── Mail: organizing ──────────────────────────────────────
  onBeforeEmailDelete: H('mail-organize', 'intercept', 'email:write', '{ emailIds, permanent }', 'before messages are deleted or moved to Trash'),
  onAfterEmailDelete: H('mail-organize', 'observer', 'email:read', '{ emailIds, permanent }', 'after messages were deleted'),
  onBeforeEmailMove: H('mail-organize', 'intercept', 'email:write', '{ emailIds, fromMailboxId, toMailboxId }', 'before messages are moved (toMailboxId null: removed from fromMailboxId only, still in other folders)'),
  onAfterEmailMove: H('mail-organize', 'observer', 'email:read', '{ emailIds, fromMailboxId, toMailboxId }', 'after messages were moved (toMailboxId null: removed from fromMailboxId only, still in other folders)'),
  onBeforeEmailArchive: H('mail-organize', 'intercept', 'email:write', '{ emailIds }', 'before messages are archived'),
  onEmailArchive: H('mail-organize', 'observer', 'email:read', '{ emailIds }', 'after messages were archived'),
  onEmailUnarchive: H('mail-organize', 'observer', 'email:read', '{ emailIds, toMailboxId }', 'after messages were moved out of the archive'),
  onBeforeEmailSpamToggle: H('mail-organize', 'intercept', 'email:write', '{ emailIds, spam }', 'before messages are marked as spam or not spam'),
  onEmailSpamToggle: H('mail-organize', 'observer', 'email:read', '{ emailIds, spam }', 'after messages were marked as spam or not spam'),
  onBeforeEmailReadStateChange: H('mail-organize', 'intercept', 'email:write', '{ emailIds, read }', 'before messages are marked read or unread'),
  onEmailReadStateChange: H('mail-organize', 'observer', 'email:read', '{ emailIds, read }', 'after messages were marked read or unread'),
  onBeforeEmailStarToggle: H('mail-organize', 'intercept', 'email:write', '{ emailIds, starred }', 'before messages are starred or unstarred'),
  onEmailStarToggle: H('mail-organize', 'observer', 'email:read', '{ emailIds, starred }', 'after messages were starred or unstarred'),
  onBeforeEmailKeywordChange: H('mail-organize', 'intercept', 'email:write', '{ emailIds, added: string[], removed: string[] }', 'before tags or other keywords are changed'),
  onEmailKeywordChange: H('mail-organize', 'observer', 'email:read', '{ emailIds, added: string[], removed: string[] }', 'after tags or other keywords changed'),
  onBeforeEmailCategorize: H('mail-organize', 'intercept', 'email:read', 'EmailCategorizeContext', 'before messages are moved to another inbox tab'),
  onEmailCategorize: H('mail-organize', 'observer', 'email:read', 'EmailCategorizeContext', 'after messages were moved to another inbox tab'),

  // ─── Mail: folders ─────────────────────────────────────────
  onMailboxesRefresh: H('mail-mailboxes', 'observer', 'email:read', 'MailboxView[]', 'after the folder list was loaded or refreshed'),
  onBeforeMailboxCreate: H('mail-mailboxes', 'intercept', 'email:write', '{ name, parentId }', 'before a folder is created'),
  onMailboxCreate: H('mail-mailboxes', 'observer', 'email:read', '{ mailboxId, name, parentId }', 'after a folder was created'),
  onBeforeMailboxRename: H('mail-mailboxes', 'intercept', 'email:write', '{ mailboxId, name }', 'before a folder is renamed'),
  onMailboxRename: H('mail-mailboxes', 'observer', 'email:read', '{ mailboxId, name, previousName }', 'after a folder was renamed'),
  onBeforeMailboxDelete: H('mail-mailboxes', 'intercept', 'email:write', '{ mailboxId, name }', 'before a folder is deleted'),
  onMailboxDelete: H('mail-mailboxes', 'observer', 'email:read', '{ mailboxId, name }', 'after a folder was deleted'),
  onBeforeMailboxEmpty: H('mail-mailboxes', 'intercept', 'email:write', '{ mailboxId, role }', 'before a folder (usually Trash or Spam) is emptied'),
  onMailboxEmpty: H('mail-mailboxes', 'observer', 'email:read', '{ mailboxId, role, count }', 'after a folder was emptied'),
  onQuotaChange: H('mail-mailboxes', 'observer', 'email:read', 'QuotaView', 'when the storage quota was read and changed'),

  // ─── Mail: search ──────────────────────────────────────────
  onSearch: H('mail-search', 'transform', 'email:read', '{ query, filters: SearchFilters }', 'before a search runs; may change the query and filters'),
  onSearchResults: H('mail-search', 'transform', 'email:read', 'string[], { query, filters, emailIds }', 'after search results arrived; return ids of further messages to add to them (at most 100)'),
  onProvideSearchResults: H('mail-search', 'transform', 'email:read', 'ExternalSearchResult[], { query, filters }', 'to add results from elsewhere to a search; drawn above its message list; an entry naming a message (email) opens it on a click, any other click comes back as onAction with surface "search-results" and the entry\'s key'),

  // ─── Mail: attachments ─────────────────────────────────────
  onBeforeAttachmentUpload: H('mail-attachments', 'intercept', 'email:read', 'AttachmentInfo', 'before a file is attached in the composer'),
  onBeforeBlobUpload: H('mail-attachments', 'transform', 'email:blob-write', '{ file, blobId } | ExternalAttachmentResult', 'before an attachment is uploaded; may offload it'),
  onAfterAttachmentUpload: H('mail-attachments', 'observer', 'email:read', 'AttachmentInfo', 'after an attachment was uploaded'),
  onAttachmentDownload: H('mail-attachments', 'observer', 'email:read', 'AttachmentInfo', 'when an attachment of a message is downloaded'),
  onAttachmentPreview: H('mail-attachments', 'transform', 'email:render-takeover', 'AttachmentPreview, AttachmentInfo', 'when an attachment preview opens'),

  // ─── Mail: new mail and sync ───────────────────────────────
  onNewEmailReceived: H('mail-sync', 'observer', 'email:read', 'EmailSummary', 'for each new message in the inbox (push or poll)'),
  onPushConnectionChange: H('mail-sync', 'observer', 'email:read', '{ connected: boolean }', 'when live updates connect or drop'),
  onSyncStateChange: H('mail-sync', 'observer', 'email:read', '{ state: "syncing" | "idle" | "error", error? }', 'when the app starts or finishes fetching changes from the server'),

  // ─── Calendar ──────────────────────────────────────────────
  onCalendarEventOpen: H('calendar', 'observer', 'calendar:read', 'CalendarEventView', 'when an event is opened'),
  onCalendarEventFormOpen: H('calendar', 'observer', 'calendar:read', 'CalendarEventFormView', 'when the event form opens'),
  onCalendarEventFormSave: H('calendar', 'transform', 'calendar:write', 'CalendarEventFormSavePatch, CalendarEventFormView', 'while the event form is saved'),
  onCheckEventConflicts: H('calendar', 'transform', 'calendar:read', 'ConflictWarning[], { event }', 'while start or end change in the event form'),
  onBeforeEventCreate: H('calendar', 'intercept', 'calendar:write', 'CalendarEventView', 'before an event is created'),
  onAfterEventCreate: H('calendar', 'observer', 'calendar:read', 'CalendarEventView', 'after an event was created'),
  onBeforeEventUpdate: H('calendar', 'intercept', 'calendar:write', '{ eventId, patch }', 'before an event is changed'),
  onAfterEventUpdate: H('calendar', 'observer', 'calendar:read', 'CalendarEventView', 'after an event was changed'),
  onBeforeEventDelete: H('calendar', 'intercept', 'calendar:write', '{ eventId, title }', 'before an event is deleted'),
  onAfterEventDelete: H('calendar', 'observer', 'calendar:read', '{ eventId, title }', 'after an event was deleted'),
  onBeforeEventRsvp: H('calendar', 'intercept', 'calendar:write', '{ eventId, status }', 'before an invitation is answered'),
  onEventRsvp: H('calendar', 'observer', 'calendar:read', '{ eventId, status }', 'after an invitation was answered'),
  onBeforeEventsImport: H('calendar', 'intercept', 'calendar:write', '{ calendarId, count }', 'before events from a file are imported'),
  onEventsImport: H('calendar', 'observer', 'calendar:read', '{ calendarId, imported, skipped }', 'after events were imported'),
  onCalendarDateChange: H('calendar', 'observer', 'calendar:read', '{ date }', 'when the shown date changes'),
  onCalendarViewChange: H('calendar', 'observer', 'calendar:read', '{ view }', 'when day, week, month or agenda view is chosen'),
  onCalendarChange: H('calendar', 'observer', 'calendar:read', '{ calendarId, change: "created" | "updated" | "removed" }', 'after a calendar was created, changed or removed'),
  onCalendarVisibilityToggle: H('calendar', 'observer', 'calendar:read', '{ calendarId, visible }', 'when a calendar is shown or hidden'),
  onICalSubscriptionChange: H('calendar', 'observer', 'calendar:read', '{ subscriptionId, change: "added" | "updated" | "removed" | "refreshed" }', 'when a calendar subscription changes'),
  onCalendarAlert: H('calendar', 'observer', 'calendar:read', 'CalendarAlertView', 'when an event reminder fires'),
  onCalendarAlertAcknowledge: H('calendar', 'observer', 'calendar:read', '{ alertId, eventId }', 'when a reminder is dismissed'),

  // ─── Contacts ──────────────────────────────────────────────
  onContactOpen: H('contacts', 'observer', 'contacts:read', 'ContactView', 'when a contact is opened'),
  onBeforeContactCreate: H('contacts', 'intercept', 'contacts:write', 'ContactView', 'before a contact is created'),
  onAfterContactCreate: H('contacts', 'observer', 'contacts:read', 'ContactView', 'after a contact was created'),
  onBeforeContactUpdate: H('contacts', 'intercept', 'contacts:write', '{ contactId, patch }', 'before a contact is changed'),
  onAfterContactUpdate: H('contacts', 'observer', 'contacts:read', 'ContactView', 'after a contact was changed'),
  onBeforeContactDelete: H('contacts', 'intercept', 'contacts:write', '{ contactIds }', 'before contacts are deleted'),
  onAfterContactDelete: H('contacts', 'observer', 'contacts:read', '{ contactIds }', 'after contacts were deleted'),
  onContactsImport: H('contacts', 'observer', 'contacts:read', '{ addressBookId, imported }', 'after contacts were imported'),
  onContactSelectionChange: H('contacts', 'observer', 'contacts:read', '{ contactIds }', 'when the selected contacts change'),
  onContactGroupChange: H('contacts', 'observer', 'contacts:read', '{ groupId, change: "created" | "updated" | "deleted" }', 'after a contact group changed'),
  onContactGroupMemberChange: H('contacts', 'observer', 'contacts:read', '{ groupId, added, removed }', 'after members were added to or removed from a group'),
  onContactMove: H('contacts', 'observer', 'contacts:read', '{ contactId, toAddressBookId }', 'after a contact moved to another address book'),
  onProvideRecipientSuggestions: H('contacts', 'transform', 'contacts:read', 'RecipientSuggestion[], { query }', 'to add suggestions to recipient autocomplete'),

  // ─── Tasks ─────────────────────────────────────────────────
  onTasksLoaded: H('tasks', 'observer', 'tasks:read', 'TaskView[]', 'after the task list was loaded'),
  onBeforeTaskCreate: H('tasks', 'intercept', 'tasks:write', 'TaskView', 'before a task is created'),
  onTaskCreate: H('tasks', 'observer', 'tasks:read', 'TaskView', 'after a task was created'),
  onBeforeTaskUpdate: H('tasks', 'intercept', 'tasks:write', '{ taskId, patch }', 'before a task is changed'),
  onTaskUpdate: H('tasks', 'observer', 'tasks:read', 'TaskView', 'after a task was changed'),
  onBeforeTaskDelete: H('tasks', 'intercept', 'tasks:write', '{ taskId, title }', 'before a task is deleted'),
  onTaskDelete: H('tasks', 'observer', 'tasks:read', '{ taskId, title }', 'after a task was deleted'),
  onTaskToggleComplete: H('tasks', 'observer', 'tasks:read', '{ taskId, complete }', 'after a task was checked off or reopened'),
  onTaskFilterChange: H('tasks', 'observer', 'tasks:read', '{ filter, showCompleted }', 'when the task filter changes'),

  // ─── Files ─────────────────────────────────────────────────
  onFileNavigate: H('files', 'observer', 'files:read', '{ path }', 'when another folder is opened'),
  onBeforeFileUpload: H('files', 'intercept', 'files:write', '{ name, size, type, path }', 'before a file is uploaded'),
  onAfterFileUpload: H('files', 'observer', 'files:read', 'FileResourceView', 'after a file was uploaded'),
  onFileUploadCancel: H('files', 'observer', 'files:read', '{ name, path }', 'when an upload is cancelled'),
  onFileDownload: H('files', 'observer', 'files:read', 'FileResourceView', 'when a file is downloaded'),
  onDirectoryCreate: H('files', 'observer', 'files:read', 'FileResourceView', 'after a folder was created'),
  onBeforeFileDelete: H('files', 'intercept', 'files:write', '{ files: FileResourceView[] }', 'before files are deleted'),
  onAfterFileDelete: H('files', 'observer', 'files:read', '{ files: FileResourceView[] }', 'after files were deleted'),
  onBeforeFileRename: H('files', 'intercept', 'files:write', '{ file, newName }', 'before a file is renamed'),
  onFileRename: H('files', 'observer', 'files:read', '{ file, previousName }', 'after a file was renamed'),
  onBeforeFileMove: H('files', 'intercept', 'files:write', '{ files, toPath }', 'before files are moved'),
  onFileMove: H('files', 'observer', 'files:read', '{ files, toPath }', 'after files were moved'),
  onFileCopy: H('files', 'observer', 'files:read', '{ files, toPath }', 'after files were copied'),
  onFileDuplicate: H('files', 'observer', 'files:read', 'FileResourceView', 'after a file was duplicated'),
  onFileFavoriteToggle: H('files', 'observer', 'files:read', '{ file, favorite }', 'when a file is starred or unstarred'),
  onFileSelectionChange: H('files', 'observer', 'files:read', '{ files: FileResourceView[] }', 'when the selected files change'),
  onFileUndo: H('files', 'observer', 'files:read', '{ action }', 'after the last file action was undone'),

  // ─── Settings ──────────────────────────────────────────────
  onBeforeSettingChange: H('settings', 'intercept', 'settings:write', '{ key, value, previous }', 'before a preference is changed'),
  onSettingChange: H('settings', 'observer', 'settings:read', '{ key, value, previous }', 'after a preference changed'),
  onSettingsExport: H('settings', 'observer', 'settings:read', '{ keys: string[] }', 'after settings were exported'),
  onSettingsImport: H('settings', 'observer', 'settings:read', '{ keys: string[] }', 'after settings were imported'),
  onSettingsReset: H('settings', 'observer', 'settings:read', '{}', 'after settings were reset to defaults'),
  onSettingsSync: H('settings', 'observer', 'settings:read', '{ direction: "pulled" | "pushed" }', 'after settings were synced with the server'),
  onKeywordChange: H('settings', 'observer', 'settings:read', '{ keywords: KeywordView[] }', 'after the tag definitions changed'),
  onTrustedSenderChange: H('settings', 'observer', 'settings:read', '{ email, trusted }', 'after a sender was trusted or untrusted for remote content'),

  // ─── Identities ────────────────────────────────────────────
  onIdentitiesLoaded: H('identities', 'observer', 'identity:read', 'IdentityView[]', 'after sender identities were loaded'),
  onBeforeIdentityChange: H('identities', 'intercept', 'identity:write', '{ identityId?, change: "create" | "update" | "delete", identity? }', 'before an identity is created, changed or deleted'),
  onIdentityCreate: H('identities', 'observer', 'identity:read', 'IdentityView', 'after an identity was created'),
  onIdentityUpdate: H('identities', 'observer', 'identity:read', 'IdentityView', 'after an identity was changed'),
  onIdentityDelete: H('identities', 'observer', 'identity:read', '{ identityId }', 'after an identity was deleted'),
  onIdentitySelect: H('identities', 'observer', 'identity:read', 'IdentityView', 'when another From identity is chosen in the composer'),
  onSignatureRender: H('identities', 'transform', 'identity:read', '{ html, text }, { identityId }', 'when a signature is inserted into the composer'),

  // ─── Filters ───────────────────────────────────────────────
  onFiltersLoaded: H('filters', 'observer', 'filters:read', 'FilterRuleView[]', 'after filter rules were loaded'),
  onFilterRuleChange: H('filters', 'observer', 'filters:read', '{ ruleId, change: "added" | "updated" | "deleted" | "reordered" | "toggled" }', 'after a filter rule changed in the editor'),
  onBeforeFiltersSave: H('filters', 'intercept', 'filters:write', '{ rules: FilterRuleView[] }', 'before filter rules are saved to the server'),
  onFiltersSave: H('filters', 'observer', 'filters:read', '{ accountId }', 'after the filter script was saved'),
  onSieveScriptChange: H('filters', 'observer', 'filters:read', '{ accountId }', 'after the active script changed'),
  onSieveScriptGenerate: H('filters', 'transform', 'filters:write', 'string (Sieve script), SieveScriptGenerateContext', 'before the generated script is uploaded'),

  // ─── Out of office ─────────────────────────────────────────
  onVacationLoaded: H('vacation', 'observer', 'vacation:read', 'VacationView', 'after the out-of-office reply was loaded'),
  onBeforeVacationUpdate: H('vacation', 'intercept', 'vacation:write', 'VacationView', 'before the out-of-office reply is changed'),
  onVacationUpdate: H('vacation', 'observer', 'vacation:read', 'VacationView', 'after the out-of-office reply was changed'),

  // ─── Templates ─────────────────────────────────────────────
  onTemplateCreate: H('templates', 'observer', 'templates:read', 'TemplateView', 'after a template was created'),
  onTemplateUpdate: H('templates', 'observer', 'templates:read', 'TemplateView', 'after a template was changed'),
  onTemplateDelete: H('templates', 'observer', 'templates:read', '{ templateId }', 'after a template was deleted'),
  onTemplatesImport: H('templates', 'observer', 'templates:read', '{ count }', 'after templates were imported'),
  onTemplateApply: H('templates', 'observer', 'templates:read', 'TemplateView', 'after a template was inserted into the composer'),
  onTemplateRender: H('templates', 'transform', 'templates:read', '{ subject, html, text }, { templateId }', 'before a template is inserted; may change the text'),

  // ─── Sign-in and accounts ──────────────────────────────────
  onLogin: H('auth', 'observer', 'auth:observe', '{ accountId, username }', 'after a sign-in'),
  onAuthReady: H('auth', 'observer', 'auth:observe', '{ accountId }', 'when the session is ready after start or sign-in'),
  onTokenRefresh: H('auth', 'observer', 'auth:observe', '{ accountId }', 'after the access token was renewed'),
  onAccountAdd: H('auth', 'observer', 'auth:observe', '{ accountId }', 'after another account was added'),
  onAccountRemove: H('auth', 'observer', 'auth:observe', '{ accountId }', 'after an account was removed'),
  onAccountSwitch: H('auth', 'observer', 'app:lifecycle', '{ accountId, previousAccountId }', 'after another account was made active'),
  onBeforeLogout: H('auth', 'observer', 'app:lifecycle', '{ accountId }', 'just before signing out'),
  onAfterLogout: H('auth', 'observer', 'app:lifecycle', '{ accountId }', 'after signing out'),
  onOAuthCallback: H('auth', 'observer', 'http:fetch', 'OAuthCallbackPayload', 'when a third-party OAuth flow this plugin started returns'),

  // ─── Account security ──────────────────────────────────────
  onPasswordChange: H('security', 'observer', 'security:read', '{}', 'after the account password was changed'),
  onTotpChange: H('security', 'observer', 'security:read', '{ enabled }', 'after two-factor sign-in was turned on or off'),
  onAppPasswordChange: H('security', 'observer', 'security:read', '{ change: "created" | "removed" }', 'after an app password was created or removed'),
  onEncryptionChange: H('security', 'observer', 'security:read', '{ enabled }', 'after encryption at rest was changed'),
  onDisplayNameChange: H('security', 'observer', 'security:read', '{ displayName }', 'after the account display name was changed'),

  // ─── Navigation ────────────────────────────────────────────
  onNavigate: H('navigation', 'observer', 'ui:observe', 'RouteContext', 'after the app moved to another page'),
  onRouteEnter: H('navigation', 'observer', 'ui:observe', 'RouteContext', 'when a page is entered'),
  onRouteLeave: H('navigation', 'observer', 'ui:observe', 'RouteContext', 'when a page is left'),

  // ─── Theme and language ────────────────────────────────────
  onThemeChange: H('theme', 'observer', 'ui:observe', '{ theme: "light" | "dark" | "system", resolved: "light" | "dark" }', 'after the colour scheme changed'),
  onCustomThemeChange: H('theme', 'observer', 'ui:observe', '{ themeId }', 'after another theme was activated'),
  onThemeBeforeApply: H('theme', 'transform', 'ui:observe', 'string (CSS), { themeId, variant }', 'before theme CSS is applied'),
  onLocaleChange: H('theme', 'observer', 'ui:observe', '{ locale }', 'after the app language changed'),

  // ─── Notifications ─────────────────────────────────────────
  onToastShow: H('notifications', 'observer', 'ui:observe', '{ id, type, title, message }', 'when the app shows a toast'),
  onToastDismiss: H('notifications', 'observer', 'ui:observe', '{ id }', 'when a toast is dismissed'),
  onNotificationClick: H('notifications', 'observer', 'ui:notifications', '{ tag }', 'when a notification the plugin showed, or one from the app, is clicked'),

  // ─── App lifecycle ─────────────────────────────────────────
  onAppReady: H('app', 'observer', 'app:lifecycle', '{ accountId }', 'once after the app has started and the mail data is loaded'),
  onVisibilityChange: H('app', 'observer', 'app:lifecycle', '{ visible }', 'when the tab is hidden or shown'),
  onWindowFocus: H('app', 'observer', 'app:lifecycle', '{}', 'when the window gains focus'),
  onWindowBlur: H('app', 'observer', 'app:lifecycle', '{}', 'when the window loses focus'),
  onOnline: H('app', 'observer', 'app:lifecycle', '{}', 'when the network comes back'),
  onOffline: H('app', 'observer', 'app:lifecycle', '{}', 'when the network goes away'),
  onBeforeUnload: H('app', 'observer', 'app:lifecycle', '{}', 'when the page is about to close'),
  onAppError: H('app', 'observer', 'app:lifecycle', '{ message }', 'when an unhandled error occurs in the app'),
  onInterval: H('app', 'observer', 'app:lifecycle', '{ now }', 'once a minute while the app is open'),

  // ─── Layout ────────────────────────────────────────────────
  onViewChange: H('ui', 'observer', 'ui:observe', '{ view: "sidebar" | "list" | "viewer" }', 'when the phone layout switches between folders, message list and message'),
  onSidebarToggle: H('ui', 'observer', 'ui:observe', '{ open }', 'when the sidebar is opened or closed'),
  onSidebarCollapse: H('ui', 'observer', 'ui:observe', '{ collapsed }', 'when the sidebar is collapsed or expanded'),
  onDeviceTypeChange: H('ui', 'observer', 'ui:observe', '{ deviceType: "mobile" | "tablet" | "desktop" }', 'when the layout switches between phone, tablet and desktop'),
  onColumnResize: H('ui', 'observer', 'ui:observe', '{ column: "sidebar" | "email-list" | "email-list-height", width }', 'after a column was resized or reset'),
  onMobileBack: H('ui', 'observer', 'ui:observe', '{}', 'when Back is used on the phone layout'),
  onTextSelectionChange: H('ui', 'observer', 'email:read', 'SelectionContext', 'when the user selects text (debounced)'),
  onDragStart: H('ui', 'observer', 'email:read', '{ kind: "email", ids }', 'when messages start being dragged'),
  onDragEnd: H('ui', 'observer', 'email:read', '{ kind, ids, dropped }', 'when a drag ends'),
  onEmailDrop: H('ui', 'observer', 'email:read', '{ emailIds, targetMailboxId }', 'after messages were dropped on a folder'),
  onTagDrop: H('ui', 'observer', 'email:read', '{ emailIds, keyword }', 'after a tag was dropped on messages'),
  onSidebarAppOpen: H('ui', 'observer', 'ui:observe', '{ appId }', 'when a sidebar app is opened'),
  onSidebarAppClose: H('ui', 'observer', 'ui:observe', '{ appId }', 'when a sidebar app is closed'),

  // ─── Keyboard ──────────────────────────────────────────────
  onBeforeShortcut: H('keyboard', 'intercept', 'ui:keyboard', '{ key, action }', 'before an app shortcut runs; return false to stop it'),
  onAfterShortcut: H('keyboard', 'observer', 'ui:keyboard', '{ key, action }', 'after an app shortcut ran'),

  // ─── Inbox tabs ────────────────────────────────────────────
  onTabsChange: H('tabs', 'observer', 'ui:message-list-tabs', 'MessageListTab[]', 'after the set of inbox tabs changed'),
  onTabActivate: H('tabs', 'observer', 'ui:message-list-tabs', 'TabActivateContext', 'when another inbox tab is chosen'),
  onTabCountsRefresh: H('tabs', 'observer', 'ui:message-list-tabs', 'Record<tabId, number>', 'after the unread counts per tab were refreshed'),
} satisfies Record<string, HookSpec>;

export type HookName = keyof typeof HOOK_CATALOG;

export function hookSpec(name: string): HookSpec | null {
  return Object.prototype.hasOwnProperty.call(HOOK_CATALOG, name) ? HOOK_CATALOG[name as HookName] : null;
}
