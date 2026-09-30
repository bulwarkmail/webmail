import type { InstalledPlugin, Permission, SlotName } from '../plugin-types';
import { IMPLICIT_PERMISSIONS } from '../plugin-types';

/**
 * Whether `plugin` may use `perm`: the manifest must declare it, and an
 * admin must have installed the plugin (managed) or the user must have
 * granted it in the consent dialog. Implicit permissions always pass.
 */
export function pluginHasPermission(plugin: InstalledPlugin, perm: Permission): boolean {
  if ((IMPLICIT_PERMISSIONS as readonly string[]).includes(perm)) return true;
  if (!plugin.permissions.includes(perm)) return false;
  // Defense-in-depth: even if the manifest declares a permission, the host
  // refuses it unless an admin has marked the plugin as managed, or the user
  // has explicitly granted it via the consent dialog.
  if (plugin.managed) return true;
  return (plugin.grantedPermissions ?? []).includes(perm);
}

// ─── Hooks ────────────────────────────────────────────────────

/**
 * The permission each hook needs. A hook hands the plugin data (an opened
 * message, the outgoing mail) or lets it change what the host does with it,
 * so registering one is as much an API call as `email.get` and is gated the
 * same way. A hook missing from this table is refused.
 */
const HOOK_PERMISSIONS: Record<string, Permission> = {
  // Email: reading
  onEmailOpen: 'email:read',
  onEmailClose: 'email:read',
  onEmailContentRender: 'email:read',
  onThreadExpand: 'email:read',
  onComposerOpen: 'email:read',
  onAfterEmailSend: 'email:read',
  onDraftAutoSave: 'email:read',
  onAfterEmailDelete: 'email:read',
  onAfterEmailMove: 'email:read',
  onEmailArchive: 'email:read',
  onEmailUnarchive: 'email:read',
  onEmailReadStateChange: 'email:read',
  onEmailStarToggle: 'email:read',
  onEmailSpamToggle: 'email:read',
  onEmailKeywordChange: 'email:read',
  onMailboxChange: 'email:read',
  onMailboxesRefresh: 'email:read',
  onMailboxCreate: 'email:read',
  onMailboxRename: 'email:read',
  onMailboxDelete: 'email:read',
  onMailboxEmpty: 'email:read',
  onSearch: 'email:read',
  onSearchResults: 'email:read',
  onEmailSelectionChange: 'email:read',
  onNewEmailReceived: 'email:read',
  onPushConnectionChange: 'email:read',
  onQuotaChange: 'email:read',
  onMailtoIntercept: 'email:read',
  onBeforeReply: 'email:read',
  onBeforeReplyAll: 'email:read',
  onBeforeForward: 'email:read',
  onBeforeAttachmentUpload: 'email:read',
  onAfterAttachmentUpload: 'email:read',
  onAttachmentDownload: 'email:read',
  onProvideSearchResults: 'email:read',
  onDraftChange: 'email:read',
  // Email: changing mail in the mailbox
  onBeforeEmailDelete: 'email:write',
  onBeforeEmailMove: 'email:write',
  // Email: changing what is sent (recipients, body, drafts, the submission)
  onBeforeCompose: 'email:send',
  onBeforeEmailSend: 'email:send',
  onTransformOutgoingEmail: 'email:send',
  onComposeSend: 'email:send',
  onBeforeDraftAutoSave: 'email:send',
  onBeforeEditDraft: 'email:send',
  onBuildQuoteHeader: 'email:send',
  onRecipientChipsChange: 'email:send',
  onBeforeComposeOpenToForwardAsAttachment: 'email:send',
  onBeforeComposeOpenToReply: 'email:send',
  onBeforeComposeOpenToReplyAll: 'email:send',
  onBeforeComposeOpenToForward: 'email:send',
  onBeforeBlobUpload: 'email:blob-write',
  // Email: changing what is displayed
  onEmailsFetched: 'email:render-takeover',
  onAttachmentPreview: 'email:render-takeover',
  onEmailListItemRender: 'email:render-takeover',
  onRenderEmailBody: 'email:render-takeover',
  // Email data reached through other surfaces
  onAvatarResolve: 'email:read',
  onDragStart: 'email:read',
  onDragEnd: 'email:read',
  onEmailDrop: 'email:read',
  onTagDrop: 'email:read',
  onBrowserNotification: 'email:read',
  onNotificationClick: 'email:read',
  onTextSelectionChange: 'email:read',
  onBeforeEmailCategorize: 'email:read',
  onEmailCategorize: 'email:read',

  // Calendar
  onCalendarEventOpen: 'calendar:read',
  onAfterEventCreate: 'calendar:read',
  onAfterEventUpdate: 'calendar:read',
  onAfterEventDelete: 'calendar:read',
  onEventRsvp: 'calendar:read',
  onEventsImport: 'calendar:read',
  onCalendarDateChange: 'calendar:read',
  onCalendarViewChange: 'calendar:read',
  onCalendarChange: 'calendar:read',
  onCalendarVisibilityToggle: 'calendar:read',
  onICalSubscriptionChange: 'calendar:read',
  onCalendarAlert: 'calendar:read',
  onCalendarAlertAcknowledge: 'calendar:read',
  onCheckEventConflicts: 'calendar:read',
  onCalendarEventFormOpen: 'calendar:read',
  onBeforeEventCreate: 'calendar:write',
  onBeforeEventUpdate: 'calendar:write',
  onBeforeEventDelete: 'calendar:write',
  onCalendarEventFormSave: 'calendar:write',

  // Contacts
  onContactOpen: 'contacts:read',
  onAfterContactCreate: 'contacts:read',
  onAfterContactUpdate: 'contacts:read',
  onAfterContactDelete: 'contacts:read',
  onContactsImport: 'contacts:read',
  onContactSelectionChange: 'contacts:read',
  onContactGroupChange: 'contacts:read',
  onContactGroupMemberChange: 'contacts:read',
  onContactMove: 'contacts:read',
  onProvideRecipientSuggestions: 'contacts:read',
  onBeforeContactCreate: 'contacts:write',
  onBeforeContactUpdate: 'contacts:write',
  onBeforeContactDelete: 'contacts:write',

  // Files
  onFileNavigate: 'files:read',
  onAfterFileUpload: 'files:read',
  onFileDownload: 'files:read',
  onFileUploadCancel: 'files:read',
  onDirectoryCreate: 'files:read',
  onAfterFileDelete: 'files:read',
  onFileRename: 'files:read',
  onFileMove: 'files:read',
  onFileCopy: 'files:read',
  onFileDuplicate: 'files:read',
  onFileFavoriteToggle: 'files:read',
  onFileSelectionChange: 'files:read',
  onFileUndo: 'files:read',
  onBeforeFileUpload: 'files:write',
  onBeforeFileDelete: 'files:write',
  onBeforeFileRename: 'files:write',

  // Sign-in state. Logout and account switches are lifecycle events every
  // plugin needs to drop per-account state, so they stay implicit.
  onLogin: 'auth:observe',
  onAccountAdd: 'auth:observe',
  onAccountRemove: 'auth:observe',
  onTokenRefresh: 'auth:observe',
  onAuthReady: 'auth:observe',
  onBeforeLogout: 'app:lifecycle',
  onAfterLogout: 'app:lifecycle',
  onAccountSwitch: 'app:lifecycle',
  // Carries the code of a plugin's own OAuth flow with a third party.
  onOAuthCallback: 'http:fetch',

  // Settings
  onSettingChange: 'settings:read',
  onSettingsExport: 'settings:read',
  onSettingsReset: 'settings:read',
  onSettingsSync: 'settings:read',
  onKeywordChange: 'settings:read',
  onTrustedSenderChange: 'settings:read',
  onSettingsImport: 'settings:write',

  // Identities
  onIdentitiesLoaded: 'identity:read',
  onIdentityCreate: 'identity:read',
  onIdentityUpdate: 'identity:read',
  onIdentityDelete: 'identity:read',
  onIdentitySelect: 'identity:read',
  onSignatureRender: 'identity:read',

  // Filters
  onFiltersLoaded: 'filters:read',
  onFilterRuleChange: 'filters:read',
  onFiltersSave: 'filters:read',
  onSieveScriptChange: 'filters:read',
  onSieveScriptGenerate: 'filters:write',

  // Tasks, templates, S/MIME, vacation, account security
  onTasksLoaded: 'tasks:read',
  onTaskCreate: 'tasks:read',
  onTaskUpdate: 'tasks:read',
  onTaskDelete: 'tasks:read',
  onTaskToggleComplete: 'tasks:read',
  onTaskFilterChange: 'tasks:read',
  onTemplateCreate: 'templates:read',
  onTemplateUpdate: 'templates:read',
  onTemplateDelete: 'templates:read',
  onTemplateApply: 'templates:read',
  onTemplatesImport: 'templates:read',
  onTemplateRender: 'templates:read',
  onSmimeKeyImport: 'smime:read',
  onSmimeCertImport: 'smime:read',
  onSmimeKeyStateChange: 'smime:read',
  onSmimeDefaultsChange: 'smime:read',
  onVacationLoaded: 'vacation:read',
  onVacationUpdate: 'vacation:read',
  onPasswordChange: 'security:read',
  onTotpChange: 'security:read',
  onAppPasswordChange: 'security:read',
  onEncryptionChange: 'security:read',
  onDisplayNameChange: 'security:read',

  // UI and app state
  onViewChange: 'ui:observe',
  onSidebarToggle: 'ui:observe',
  onSidebarCollapse: 'ui:observe',
  onDeviceTypeChange: 'ui:observe',
  onColumnResize: 'ui:observe',
  onMobileBack: 'ui:observe',
  onMobileViewSwitch: 'ui:observe',
  onBeforeExternalLink: 'ui:observe',
  onThemeChange: 'ui:observe',
  onCustomThemeChange: 'ui:observe',
  onLocaleChange: 'ui:observe',
  onThemeBeforeApply: 'ui:observe',
  onToastShow: 'ui:observe',
  onToastDismiss: 'ui:observe',
  onSidebarAppOpen: 'ui:observe',
  onSidebarAppClose: 'ui:observe',
  onSidebarAppChange: 'ui:observe',
  onNavigate: 'ui:observe',
  onRouteEnter: 'ui:observe',
  onRouteLeave: 'ui:observe',
  onTabsChange: 'ui:message-list-tabs',
  onTabActivate: 'ui:message-list-tabs',
  onTabCountsRefresh: 'ui:message-list-tabs',
  onBeforeShortcut: 'ui:keyboard',
  onAfterShortcut: 'ui:keyboard',
  onAppReady: 'app:lifecycle',
  onVisibilityChange: 'app:lifecycle',
  onBeforeUnload: 'app:lifecycle',
  onAppError: 'app:lifecycle',
  onInterval: 'app:lifecycle',
  onWindowFocus: 'app:lifecycle',
  onWindowBlur: 'app:lifecycle',
  onOnline: 'app:lifecycle',
  onOffline: 'app:lifecycle',
};

export function hookPermission(hookName: string): Permission | null {
  return Object.prototype.hasOwnProperty.call(HOOK_PERMISSIONS, hookName) ? HOOK_PERMISSIONS[hookName] : null;
}

export function mayRegisterHook(plugin: InstalledPlugin, hookName: string): boolean {
  const perm = hookPermission(hookName);
  return perm !== null && pluginHasPermission(plugin, perm);
}

// ─── Slots ────────────────────────────────────────────────────

/**
 * Permissions that allow rendering into each slot (any one suffices). Slot
 * components receive the data of the surface they sit on (the open message,
 * the draft), so they are gated like hooks.
 */
const SLOT_PERMISSIONS: Record<SlotName, readonly Permission[]> = {
  'toolbar-actions': ['ui:toolbar'],
  'app-top-banner': ['ui:app-top-banner'],
  'email-banner': ['ui:email-banner'],
  'email-footer': ['ui:email-footer'],
  'composer-toolbar': ['ui:composer-toolbar'],
  'composer-sidebar': ['ui:composer-sidebar'],
  'composer-sidebar-right': ['ui:composer-sidebar'],
  'composer-attachment-source': ['ui:composer-toolbar', 'ui:composer-sidebar'],
  'sidebar-widget': ['ui:sidebar-widget'],
  'email-detail-sidebar': ['ui:email-details'],
  'email-details-section': ['ui:email-details'],
  'settings-section': ['ui:settings-section'],
  'context-menu-email': ['ui:context-menu'],
  'navigation-rail-bottom': ['ui:navigation-rail'],
  'calendar-event-actions': ['ui:calendar-action'],
  'admin-plugin-page': ['ui:admin-page', 'admin:config'],
  'contact-cryptokeys': ['ui:contact-cryptokeys'],
  'attachment-actions': ['email:read'],
  // Only shown inside a dialog the plugin opened through the host API.
  'plugin-dialog': ['ui:observe'],
};

export function mayOfferSlot(plugin: InstalledPlugin, slot: string): boolean {
  const perms = Object.prototype.hasOwnProperty.call(SLOT_PERMISSIONS, slot)
    ? SLOT_PERMISSIONS[slot as SlotName]
    : null;
  return !!perms && perms.some((perm) => pluginHasPermission(plugin, perm));
}
