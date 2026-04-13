// PluginAPI factory â€” builds the sandboxed API facade for each plugin

import type {
  Disposable,
  InstalledPlugin,
  Permission,
  ToolbarAction,
  BannerFactory,
  SettingsSection,
  ComposerAction,
  SidebarWidget,
  ContextMenuItem,
  KeyboardShortcut,
  AdminPageSection,
  CalendarEventAction,
  SlotName,
} from './plugin-types';
import { IMPLICIT_PERMISSIONS as IMPLICIT } from './plugin-types';
import {
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks,
} from './plugin-hooks';
import { toast as appToast } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { apiFetch } from '@/lib/browser-navigation';

// --- Permission helpers --------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPluginExternals(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).__PLUGIN_EXTERNALS__;
}

function hasPermission(plugin: InstalledPlugin, perm: Permission): boolean {
  if ((IMPLICIT as readonly string[]).includes(perm)) return true;
  return plugin.permissions.includes(perm);
}

function requirePermission(plugin: InstalledPlugin, perm: Permission): void {
  if (!hasPermission(plugin, perm)) {
    throw new Error(`Plugin "${plugin.id}" lacks permission "${perm}"`);
  }
}

/** Returns a no-op disposable when permission is missing (silent failure) */
function guardedHook<T extends (...args: never[]) => unknown>(
  plugin: InstalledPlugin,
  perm: Permission,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bus: { register: (pluginId: string, handler: any, order?: number) => Disposable },
  handler: T,
  order: number = 100,
): Disposable {
  if (!hasPermission(plugin, perm)) {
    return { dispose: () => {} };
  }
  return bus.register(plugin.id, handler, order);
}

// --- Plugin-scoped storage -----------------------------------

function createPluginStorage(pluginId: string) {
  const prefix = `plugin:${pluginId}:`;

  return {
    get: <T>(key: string): T | null => {
      if (typeof window === 'undefined') return null;
      const raw = localStorage.getItem(prefix + key);
      if (raw === null) return null;
      try { return JSON.parse(raw) as T; } catch { return null; }
    },
    set: <T>(key: string, value: T): void => {
      if (typeof window === 'undefined') return;
      localStorage.setItem(prefix + key, JSON.stringify(value));
    },
    remove: (key: string): void => {
      if (typeof window === 'undefined') return;
      localStorage.removeItem(prefix + key);
    },
    keys: (): string[] => {
      if (typeof window === 'undefined') return [];
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) keys.push(k.slice(prefix.length));
      }
      return keys;
    },
  };
}

// --- Plugin-scoped logger ------------------------------------

function createPluginLogger(pluginId: string) {
  const tag = `[plugin:${pluginId}]`;
  return {
    debug: (...args: unknown[]) => console.debug(tag, ...args),
    info: (...args: unknown[]) => console.info(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}

// --- PluginAPI interface -------------------------------------

export interface PluginAPI {
  plugin: { id: string; version: string; settings: Record<string, unknown> };
  ui: {
    registerToolbarAction: (action: ToolbarAction) => Disposable;
    registerEmailBanner: (factory: BannerFactory) => Disposable;
    registerEmailFooter: (component: React.ComponentType) => Disposable;
    registerSettingsSection: (section: SettingsSection) => Disposable;
    registerComposerAction: (action: ComposerAction) => Disposable;
    registerSidebarWidget: (widget: SidebarWidget) => Disposable;
    registerDetailSidebar: (widget: SidebarWidget) => Disposable;
    registerContextMenuItem: (item: ContextMenuItem) => Disposable;
    registerNavigationRailItem: (component: React.ComponentType) => Disposable;
    registerCalendarEventAction: (action: CalendarEventAction) => Disposable;
    registerAdminPage: (page: AdminPageSection) => Disposable;
  };
  hooks: PluginHooksAPI;
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    warning: (message: string) => void;
  };
  http: {
    post: (path: string, body: Record<string, unknown>) => Promise<{ ok: boolean; status: number; data: unknown }>;
  };
  storage: ReturnType<typeof createPluginStorage>;
  log: ReturnType<typeof createPluginLogger>;
  admin: {
    getConfig: (key: string) => Promise<unknown>;
    getAllConfig: () => Promise<Record<string, unknown>>;
    setConfig: (key: string, value: unknown) => Promise<void>;
    deleteConfig: (key: string) => Promise<void>;
  };
}

// Simplified hooks API type (all hooks return Disposable)
export interface PluginHooksAPI {
  // Email
  onEmailOpen: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEmailClose: (handler: () => void) => Disposable;
  onEmailContentRender: (handler: (...args: unknown[]) => unknown) => Disposable;
  onThreadExpand: (handler: (...args: unknown[]) => unknown) => Disposable;
  onComposerOpen: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeEmailSend: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterEmailSend: (handler: (...args: unknown[]) => unknown) => Disposable;
  onDraftAutoSave: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeEmailDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterEmailDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeEmailMove: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterEmailMove: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEmailReadStateChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEmailStarToggle: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEmailSpamToggle: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEmailKeywordChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onMailboxChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onMailboxesRefresh: (handler: (...args: unknown[]) => unknown) => Disposable;
  onMailboxCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onMailboxRename: (handler: (...args: unknown[]) => unknown) => Disposable;
  onMailboxDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onMailboxEmpty: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSearch: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSearchResults: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEmailSelectionChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onNewEmailReceived: (handler: (...args: unknown[]) => unknown) => Disposable;
  onPushConnectionChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onQuotaChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Calendar
  onCalendarEventOpen: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeEventCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterEventCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeEventUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterEventUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeEventDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterEventDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEventRsvp: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEventsImport: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCalendarDateChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCalendarViewChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCalendarChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCalendarVisibilityToggle: (handler: (...args: unknown[]) => unknown) => Disposable;
  onICalSubscriptionChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCalendarAlert: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCalendarAlertAcknowledge: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Calendar Form
  onCalendarEventFormOpen: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCalendarEventFormSave: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Contacts
  onContactOpen: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeContactCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterContactCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeContactUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterContactUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeContactDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterContactDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onContactsImport: (handler: (...args: unknown[]) => unknown) => Disposable;
  onContactSelectionChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onContactGroupChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onContactGroupMemberChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onContactMove: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Files
  onFileNavigate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeFileUpload: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterFileUpload: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileDownload: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileUploadCancel: (handler: (...args: unknown[]) => unknown) => Disposable;
  onDirectoryCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeFileDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterFileDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileRename: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileMove: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileCopy: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileDuplicate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileFavoriteToggle: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileSelectionChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFileUndo: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Auth
  onLogin: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeLogout: (handler: () => void) => Disposable;
  onAfterLogout: (handler: () => void) => Disposable;
  onAccountSwitch: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAccountAdd: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAccountRemove: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTokenRefresh: (handler: () => void) => Disposable;
  onAuthReady: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Settings
  onSettingChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSettingsExport: (handler: () => void) => Disposable;
  onSettingsImport: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSettingsReset: (handler: () => void) => Disposable;
  onSettingsSync: (handler: (...args: unknown[]) => unknown) => Disposable;
  onKeywordChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTrustedSenderChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Identity
  onIdentitiesLoaded: (handler: (...args: unknown[]) => unknown) => Disposable;
  onIdentityCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onIdentityUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onIdentityDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onIdentitySelect: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSignatureRender: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Filters
  onFiltersLoaded: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFilterRuleChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onFiltersSave: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSieveScriptChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Tasks
  onTasksLoaded: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTaskCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTaskUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTaskDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTaskToggleComplete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTaskFilterChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Templates
  onTemplateCreate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTemplateUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTemplateDelete: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTemplateApply: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTemplatesImport: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTemplateRender: (handler: (...args: unknown[]) => unknown) => Disposable;
  // S/MIME
  onSmimeKeyImport: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSmimeCertImport: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSmimeKeyStateChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSmimeDefaultsChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Vacation
  onVacationLoaded: (handler: (...args: unknown[]) => unknown) => Disposable;
  onVacationUpdate: (handler: (...args: unknown[]) => unknown) => Disposable;
  // UI
  onViewChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSidebarToggle: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSidebarCollapse: (handler: (...args: unknown[]) => unknown) => Disposable;
  onDeviceTypeChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onColumnResize: (handler: (...args: unknown[]) => unknown) => Disposable;
  onMobileBack: (handler: () => void) => Disposable;
  onMobileViewSwitch: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Theme
  onThemeChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onCustomThemeChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onLocaleChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Toast
  onToastShow: (handler: (...args: unknown[]) => unknown) => Disposable;
  onToastDismiss: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBrowserNotification: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Drag & Drop
  onDragStart: (handler: (...args: unknown[]) => unknown) => Disposable;
  onDragEnd: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEmailDrop: (handler: (...args: unknown[]) => unknown) => Disposable;
  onTagDrop: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Keyboard
  registerShortcut: (shortcut: KeyboardShortcut) => Disposable;
  onBeforeShortcut: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAfterShortcut: (handler: (...args: unknown[]) => unknown) => Disposable;
  // App Lifecycle
  onAppReady: (handler: () => void) => Disposable;
  onVisibilityChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onBeforeUnload: (handler: () => void) => Disposable;
  onAppError: (handler: (...args: unknown[]) => unknown) => Disposable;
  onInterval: (handler: () => void, intervalMs: number) => Disposable;
  // Account Security
  onPasswordChange: (handler: () => void) => Disposable;
  onTotpChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onAppPasswordChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  onEncryptionChange: (handler: () => void) => Disposable;
  onDisplayNameChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Sidebar Apps
  onSidebarAppOpen: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSidebarAppClose: (handler: (...args: unknown[]) => unknown) => Disposable;
  onSidebarAppChange: (handler: (...args: unknown[]) => unknown) => Disposable;
  // Avatar
  onAvatarResolve: (handler: (...args: unknown[]) => unknown) => Disposable;
}

// --- Permission mapping for hooks ----------------------------

const HOOK_PERMISSIONS: Record<string, Permission> = {
  // Email
  onEmailOpen: 'email:read', onEmailClose: 'email:read',
  onEmailContentRender: 'email:read', onThreadExpand: 'email:read',
  onComposerOpen: 'email:read', onDraftAutoSave: 'email:read',
  onMailboxChange: 'email:read', onMailboxesRefresh: 'email:read',
  onSearch: 'email:read', onSearchResults: 'email:read',
  onEmailSelectionChange: 'email:read', onNewEmailReceived: 'email:read',
  onPushConnectionChange: 'email:read', onQuotaChange: 'email:read',
  onBeforeEmailSend: 'email:send', onAfterEmailSend: 'email:send',
  onBeforeEmailDelete: 'email:write', onAfterEmailDelete: 'email:write',
  onBeforeEmailMove: 'email:write', onAfterEmailMove: 'email:write',
  onEmailReadStateChange: 'email:write', onEmailStarToggle: 'email:write',
  onEmailSpamToggle: 'email:write', onEmailKeywordChange: 'email:write',
  onMailboxCreate: 'email:write', onMailboxRename: 'email:write',
  onMailboxDelete: 'email:write', onMailboxEmpty: 'email:write',
  // Calendar
  onCalendarEventOpen: 'calendar:read', onCalendarDateChange: 'calendar:read',
  onCalendarViewChange: 'calendar:read', onCalendarVisibilityToggle: 'calendar:read',
  onCalendarAlert: 'calendar:read', onCalendarAlertAcknowledge: 'calendar:read',
  onCalendarEventFormOpen: 'calendar:read', onCalendarEventFormSave: 'calendar:write',
  onBeforeEventCreate: 'calendar:write', onAfterEventCreate: 'calendar:write',
  onBeforeEventUpdate: 'calendar:write', onAfterEventUpdate: 'calendar:write',
  onBeforeEventDelete: 'calendar:write', onAfterEventDelete: 'calendar:write',
  onEventRsvp: 'calendar:write', onEventsImport: 'calendar:write',
  onCalendarChange: 'calendar:write', onICalSubscriptionChange: 'calendar:write',
  // Contacts
  onContactOpen: 'contacts:read', onContactSelectionChange: 'contacts:read',
  onBeforeContactCreate: 'contacts:write', onAfterContactCreate: 'contacts:write',
  onBeforeContactUpdate: 'contacts:write', onAfterContactUpdate: 'contacts:write',
  onBeforeContactDelete: 'contacts:write', onAfterContactDelete: 'contacts:write',
  onContactsImport: 'contacts:write', onContactGroupChange: 'contacts:write',
  onContactGroupMemberChange: 'contacts:write', onContactMove: 'contacts:write',
  // Files
  onFileNavigate: 'files:read', onFileDownload: 'files:read', onFileSelectionChange: 'files:read',
  onBeforeFileUpload: 'files:write', onAfterFileUpload: 'files:write',
  onFileUploadCancel: 'files:write', onDirectoryCreate: 'files:write',
  onBeforeFileDelete: 'files:write', onAfterFileDelete: 'files:write',
  onFileRename: 'files:write', onFileMove: 'files:write', onFileCopy: 'files:write',
  onFileDuplicate: 'files:write', onFileFavoriteToggle: 'files:write', onFileUndo: 'files:write',
  // Auth
  onLogin: 'auth:observe', onBeforeLogout: 'auth:observe', onAfterLogout: 'auth:observe',
  onAccountSwitch: 'auth:observe', onAccountAdd: 'auth:observe', onAccountRemove: 'auth:observe',
  onTokenRefresh: 'auth:observe', onAuthReady: 'auth:observe',
  // Settings
  onSettingChange: 'settings:read', onSettingsExport: 'settings:read',
  onSettingsImport: 'settings:read', onSettingsReset: 'settings:read',
  onSettingsSync: 'settings:read', onKeywordChange: 'settings:read',
  onTrustedSenderChange: 'settings:read',
  // Identity
  onIdentitiesLoaded: 'identity:read', onIdentitySelect: 'identity:read',
  onSignatureRender: 'identity:read',
  onIdentityCreate: 'identity:write', onIdentityUpdate: 'identity:write',
  onIdentityDelete: 'identity:write',
  // Filters
  onFiltersLoaded: 'filters:read',
  onFilterRuleChange: 'filters:write', onFiltersSave: 'filters:write',
  onSieveScriptChange: 'filters:write',
  // Tasks
  onTasksLoaded: 'tasks:read', onTaskFilterChange: 'tasks:read',
  onTaskCreate: 'tasks:write', onTaskUpdate: 'tasks:write',
  onTaskDelete: 'tasks:write', onTaskToggleComplete: 'tasks:write',
  // Templates
  onTemplateApply: 'templates:read', onTemplateRender: 'templates:read',
  onTemplateCreate: 'templates:write', onTemplateUpdate: 'templates:write',
  onTemplateDelete: 'templates:write', onTemplatesImport: 'templates:write',
  // S/MIME
  onSmimeKeyImport: 'smime:read', onSmimeCertImport: 'smime:read',
  onSmimeKeyStateChange: 'smime:read', onSmimeDefaultsChange: 'smime:read',
  // Vacation
  onVacationLoaded: 'vacation:read', onVacationUpdate: 'vacation:write',
  // UI
  onViewChange: 'ui:observe', onSidebarToggle: 'ui:observe',
  onSidebarCollapse: 'ui:observe', onDeviceTypeChange: 'ui:observe',
  onColumnResize: 'ui:observe', onMobileBack: 'ui:observe',
  onMobileViewSwitch: 'ui:observe',
  // Theme
  onThemeChange: 'ui:observe', onCustomThemeChange: 'ui:observe',
  onLocaleChange: 'ui:observe',
  // Toast
  onToastShow: 'ui:observe', onToastDismiss: 'ui:observe',
  onBrowserNotification: 'ui:observe',
  // Drag & Drop
  onDragStart: 'ui:observe', onDragEnd: 'ui:observe',
  onEmailDrop: 'ui:observe', onTagDrop: 'ui:observe',
  // Keyboard
  registerShortcut: 'ui:keyboard', onBeforeShortcut: 'ui:keyboard',
  onAfterShortcut: 'ui:keyboard',
  // App Lifecycle
  onAppReady: 'app:lifecycle', onVisibilityChange: 'app:lifecycle',
  onBeforeUnload: 'app:lifecycle', onAppError: 'app:lifecycle',
  onInterval: 'app:lifecycle',
  // Account Security
  onPasswordChange: 'security:read', onTotpChange: 'security:read',
  onAppPasswordChange: 'security:read', onEncryptionChange: 'security:read',
  onDisplayNameChange: 'security:read',
  // Sidebar Apps
  onSidebarAppOpen: 'ui:observe', onSidebarAppClose: 'ui:observe',
  onSidebarAppChange: 'ui:observe',
  // Avatar
  onAvatarResolve: 'email:read',
};

// Map hook names â†’ actual HookBus instances
const HOOK_BUSES: Record<string, { register: (pluginId: string, handler: (...args: unknown[]) => unknown, order?: number) => Disposable }> = {
  // Email
  ...Object.fromEntries(Object.entries(emailHooks)),
  // Calendar
  ...Object.fromEntries(Object.entries(calendarHooks)),
  // Calendar Form
  ...Object.fromEntries(Object.entries(calendarFormHooks)),
  // Contacts
  ...Object.fromEntries(Object.entries(contactHooks)),
  // Files
  ...Object.fromEntries(Object.entries(fileHooks)),
  // Auth
  ...Object.fromEntries(Object.entries(authHooks)),
  // Settings
  ...Object.fromEntries(Object.entries(settingsHooks)),
  // Identity
  ...Object.fromEntries(Object.entries(identityHooks)),
  // Filters
  ...Object.fromEntries(Object.entries(filterHooks)),
  // Tasks
  ...Object.fromEntries(Object.entries(taskHooks)),
  // Templates
  ...Object.fromEntries(Object.entries(templateHooks)),
  // S/MIME
  ...Object.fromEntries(Object.entries(smimeHooks)),
  // Vacation
  ...Object.fromEntries(Object.entries(vacationHooks)),
  // UI
  ...Object.fromEntries(Object.entries(uiHooks)),
  // Theme
  ...Object.fromEntries(Object.entries(themeHooks)),
  // Toast
  ...Object.fromEntries(Object.entries(toastHooks)),
  // Drag & Drop
  ...Object.fromEntries(Object.entries(dragDropHooks)),
  // Keyboard
  ...Object.fromEntries(Object.entries(keyboardHooks)),
  // App Lifecycle
  ...Object.fromEntries(Object.entries(appLifecycleHooks)),
  // Account Security
  ...Object.fromEntries(Object.entries(accountSecurityHooks)),
  // Sidebar Apps
  ...Object.fromEntries(Object.entries(sidebarAppHooks)),
  // Avatar
  ...Object.fromEntries(Object.entries(avatarHooks)),
};

// --- Slot registration bridge --------------------------------
// Lazy import to avoid circular dependency â€” plugin-store imports plugin-api indirectly

let registerSlotFn: ((name: SlotName, reg: { pluginId: string; component: React.ComponentType<Record<string, unknown>>; order: number }) => Disposable) | null = null;

export function setSlotRegistrationBridge(fn: typeof registerSlotFn): void {
  registerSlotFn = fn;
}

function registerSlot(
  pluginId: string,
  slotName: SlotName,
  component: React.ComponentType<Record<string, unknown>>,
  order: number = 100,
): Disposable {
  if (!registerSlotFn) {
    console.warn(`[plugin:${pluginId}] Slot registration not available yet`);
    return { dispose: () => {} };
  }
  return registerSlotFn(slotName, { pluginId, component, order });
}

// --- Factory -------------------------------------------------

export function createPluginAPI(plugin: InstalledPlugin): PluginAPI {
  // Build hooks proxy â€” each hook method checks permission and registers on the right bus
  const hooks: PluginHooksAPI = {} as PluginHooksAPI;

  for (const [hookName, bus] of Object.entries(HOOK_BUSES)) {
    const perm = HOOK_PERMISSIONS[hookName];
    if (!perm) continue;

    if (hookName === 'onInterval') {
      // Special: onInterval takes (handler, intervalMs)
      (hooks as unknown as Record<string, unknown>)[hookName] = (handler: () => void, intervalMs: number) => {
        if (!hasPermission(plugin, perm)) return { dispose: () => {} };
        const safeMs = Math.max(intervalMs, 60_000); // min 60s
        const id = setInterval(handler, safeMs);
        return { dispose: () => clearInterval(id) };
      };
    } else if (hookName === 'registerShortcut') {
      // Special: registerShortcut takes a KeyboardShortcut object
      (hooks as unknown as Record<string, unknown>)[hookName] = (shortcut: KeyboardShortcut) => {
        return guardedHook(plugin, perm, bus, shortcut.handler);
      };
    } else {
      (hooks as unknown as Record<string, unknown>)[hookName] = (handler: (...args: unknown[]) => unknown) => {
        return guardedHook(plugin, perm, bus, handler);
      };
    }
  }

  return {
    plugin: {
      id: plugin.id,
      version: plugin.version,
      settings: { ...plugin.settings },
    },

    ui: {
      registerToolbarAction: (action: ToolbarAction) => {
        requirePermission(plugin, 'ui:toolbar');
        const Component = () => {
          const externals = getPluginExternals();
          const React = externals?.React;
          if (!React) return null;
          const createElement = (React as { createElement: typeof import('react').createElement }).createElement;
          return createElement('button', {
            onClick: action.onClick,
            className: 'plugin-toolbar-action',
            title: action.label,
          }, action.label);
        };
        return registerSlot(plugin.id, 'toolbar-actions', Component as React.ComponentType<Record<string, unknown>>, action.order ?? 100);
      },

      registerEmailBanner: (factory: BannerFactory) => {
        requirePermission(plugin, 'ui:email-banner');
        return registerSlot(plugin.id, 'email-banner', factory.render as unknown as React.ComponentType<Record<string, unknown>>, 100);
      },

      registerEmailFooter: (component: React.ComponentType) => {
        requirePermission(plugin, 'ui:email-footer');
        return registerSlot(plugin.id, 'email-footer', component as React.ComponentType<Record<string, unknown>>, 100);
      },

      registerSettingsSection: (section: SettingsSection) => {
        requirePermission(plugin, 'ui:settings-section');
        return registerSlot(plugin.id, 'settings-section', section.render as React.ComponentType<Record<string, unknown>>, 100);
      },

      registerComposerAction: (action: ComposerAction) => {
        requirePermission(plugin, 'ui:composer-toolbar');
        const Component = () => {
          const externals = getPluginExternals();
          const React = externals?.React;
          if (!React) return null;
          const createElement = (React as { createElement: typeof import('react').createElement }).createElement;
          return createElement('button', {
            onClick: action.onClick,
            className: 'plugin-composer-action',
            title: action.label,
          }, action.label);
        };
        return registerSlot(plugin.id, 'composer-toolbar', Component as React.ComponentType<Record<string, unknown>>, action.order ?? 100);
      },

      registerSidebarWidget: (widget: SidebarWidget) => {
        requirePermission(plugin, 'ui:sidebar-widget');
        return registerSlot(plugin.id, 'sidebar-widget', widget.render as React.ComponentType<Record<string, unknown>>, widget.order ?? 100);
      },

      registerDetailSidebar: (widget: SidebarWidget) => {
        requirePermission(plugin, 'ui:sidebar-widget');
        return registerSlot(plugin.id, 'email-detail-sidebar', widget.render as React.ComponentType<Record<string, unknown>>, widget.order ?? 100);
      },

      registerContextMenuItem: (item: ContextMenuItem) => {
        requirePermission(plugin, 'ui:context-menu');
        const Component = () => {
          const externals = getPluginExternals();
          const React = externals?.React;
          if (!React) return null;
          const createElement = (React as { createElement: typeof import('react').createElement }).createElement;
          return createElement('button', {
            onClick: () => item.onClick([]),
            className: 'plugin-context-menu-item',
          }, item.label);
        };
        return registerSlot(plugin.id, 'context-menu-email', Component as React.ComponentType<Record<string, unknown>>, item.order ?? 100);
      },

      registerNavigationRailItem: (component: React.ComponentType) => {
        requirePermission(plugin, 'ui:navigation-rail');
        return registerSlot(plugin.id, 'navigation-rail-bottom', component as React.ComponentType<Record<string, unknown>>, 100);
      },

      registerCalendarEventAction: (action: CalendarEventAction) => {
        requirePermission(plugin, 'ui:calendar-action');
        const Component = (props: Record<string, unknown>) => {
          const externals = getPluginExternals();
          const React = externals?.React;
          if (!React) return null;
          const createElement = (React as { createElement: typeof import('react').createElement }).createElement;
          const iconSpan = createElement('span', {
            'aria-hidden': 'true',
            style: { display: 'contents' },
            dangerouslySetInnerHTML: {
              __html: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8z"/><rect x="2" y="8" width="14" height="12" rx="2"/></svg>',
            },
          });
          return createElement('button', {
            onClick: () => action.onClick(
              props.eventData as import('./plugin-types').CalendarEventFormView,
              { setVirtualLocation: props.setVirtualLocation as (url: string) => void },
            ),
            className: 'inline-flex items-center gap-1.5 h-9 px-3 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background cursor-pointer',
            title: action.label,
            type: 'button',
          }, iconSpan, action.label);
        };
        return registerSlot(plugin.id, 'calendar-event-actions', Component as React.ComponentType<Record<string, unknown>>, action.order ?? 100);
      },

      registerAdminPage: (page: AdminPageSection) => {
        requirePermission(plugin, 'ui:admin-page');
        return registerSlot(plugin.id, 'admin-plugin-page', page.render as React.ComponentType<Record<string, unknown>>, 100);
      },
    },

    hooks,

    toast: {
      success: (message: string) => appToast.success(message),
      error: (message: string) => appToast.error(message),
      info: (message: string) => appToast.info(message),
      warning: (message: string) => appToast.warning(message),
    },

    http: {
      post: async (path: string, body: Record<string, unknown>) => {
        requirePermission(plugin, 'http:post');
        if (typeof path !== 'string' || !path.startsWith('/api/')) {
          throw new Error('path must start with /api/');
        }
        const url = new URL(path, globalThis.location.origin);
        if (url.origin !== globalThis.location.origin) {
          throw new Error('path must resolve to the same origin');
        }
        const { client } = useAuthStore.getState();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (client) {
          headers['Authorization'] = client.getAuthHeader();
          headers['X-JMAP-Username'] = client.getUsername();
        }
        const res = await fetch(url.pathname + url.search, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, data };
      },
    },

    storage: createPluginStorage(plugin.id),
    log: createPluginLogger(plugin.id),

    admin: {
      getConfig: async (key: string) => {
        requirePermission(plugin, 'admin:config');
        const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/config`);
        if (!res.ok) return null;
        const data = await res.json();
        return data[key] ?? null;
      },
      getAllConfig: async () => {
        requirePermission(plugin, 'admin:config');
        const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/config`);
        if (!res.ok) return {};
        return res.json();
      },
      setConfig: async (key: string, value: unknown) => {
        requirePermission(plugin, 'admin:config');
        await apiFetch(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
      },
      deleteConfig: async (key: string) => {
        requirePermission(plugin, 'admin:config');
        await apiFetch(`/api/admin/plugins/${encodeURIComponent(plugin.id)}/config`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        });
      },
    },
  };
}
