// Plugin Hook Bus - event bus system for plugin lifecycle hooks

import type { Disposable } from './plugin-types';

// ─── Error Tracker (Circuit Breaker) ─────────────────────────

interface ErrorRecord {
  timestamps: number[];
  disabled: boolean;
}

const ERROR_THRESHOLD = 3;
const ERROR_WINDOW_MS = 60_000;

class PluginErrorTracker {
  private records = new Map<string, ErrorRecord>();
  private onAutoDisable?: (pluginId: string, error: unknown) => void;

  setAutoDisableCallback(cb: (pluginId: string, error: unknown) => void): void {
    this.onAutoDisable = cb;
  }

  record(pluginId: string, error: unknown): void {
    const now = Date.now();
    let rec = this.records.get(pluginId);
    if (!rec) {
      rec = { timestamps: [], disabled: false };
      this.records.set(pluginId, rec);
    }

    // Prune old timestamps
    rec.timestamps = rec.timestamps.filter(t => now - t < ERROR_WINDOW_MS);
    rec.timestamps.push(now);

    console.error(`[plugin:${pluginId}] Hook error:`, error);

    if (rec.timestamps.length >= ERROR_THRESHOLD && !rec.disabled) {
      rec.disabled = true;
      console.error(`[plugin:${pluginId}] Auto-disabled after ${ERROR_THRESHOLD} errors in ${ERROR_WINDOW_MS / 1000}s`);
      this.onAutoDisable?.(pluginId, error);
    }
  }

  isDisabled(pluginId: string): boolean {
    return this.records.get(pluginId)?.disabled ?? false;
  }

  reset(pluginId: string): void {
    this.records.delete(pluginId);
  }

  resetAll(): void {
    this.records.clear();
  }
}

export const pluginErrorTracker = new PluginErrorTracker();

// ─── Timeout Helper ──────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: T | Promise<T>, ms: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  if (!(promise instanceof Promise)) return Promise.resolve(promise);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hook timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ─── HookBus ─────────────────────────────────────────────────

interface HookEntry<T extends (...args: never[]) => unknown> {
  pluginId: string;
  handler: T;
  order: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class HookBus<T extends (...args: any[]) => any> {
  private handlers: HookEntry<T>[] = [];

  register(pluginId: string, handler: T, order: number = 100): Disposable {
    const entry: HookEntry<T> = { pluginId, handler, order };
    this.handlers.push(entry);
    this.handlers.sort((a, b) => a.order - b.order);
    return {
      dispose: () => {
        this.handlers = this.handlers.filter(h => h !== entry);
      },
    };
  }

  /** Remove all handlers for a given plugin */
  removePlugin(pluginId: string): void {
    this.handlers = this.handlers.filter(h => h.pluginId !== pluginId);
  }

  /** Remove all handlers */
  clear(): void {
    this.handlers = [];
  }

  get size(): number {
    return this.handlers.length;
  }

  /** Fire all handlers (observer pattern - no return values used) */
  async emit(...args: Parameters<T>): Promise<void> {
    for (const { pluginId, handler } of this.handlers) {
      if (pluginErrorTracker.isDisabled(pluginId)) continue;
      try {
        await withTimeout(handler(...args));
      } catch (err) {
        pluginErrorTracker.record(pluginId, err);
      }
    }
  }

  /** Synchronous emit for performance-critical paths */
  emitSync(...args: Parameters<T>): void {
    for (const { pluginId, handler } of this.handlers) {
      if (pluginErrorTracker.isDisabled(pluginId)) continue;
      try {
        handler(...args);
      } catch (err) {
        pluginErrorTracker.record(pluginId, err);
      }
    }
  }

  /** Fire handlers as interceptors - any returning false cancels the operation */
  async intercept(...args: Parameters<T>): Promise<boolean> {
    for (const { pluginId, handler } of this.handlers) {
      if (pluginErrorTracker.isDisabled(pluginId)) continue;
      try {
        const result = await withTimeout(handler(...args));
        if (result === false) return false;
      } catch (err) {
        pluginErrorTracker.record(pluginId, err);
      }
    }
    return true;
  }

  /** Fire handlers as transforms - each receives the output of the previous */
  async transform<V>(initial: V, ...rest: unknown[]): Promise<V> {
    let value = initial;
    for (const { pluginId, handler } of this.handlers) {
      if (pluginErrorTracker.isDisabled(pluginId)) continue;
      try {
        const result = await withTimeout(handler(value, ...rest));
        if (result !== undefined && result !== false) {
          value = result as V;
        }
      } catch (err) {
        pluginErrorTracker.record(pluginId, err);
      }
    }
    return value;
  }
}

// ─── All Hook Buses (one per hook across all 20 domains) ─────

// §7.1 Email Hooks
export const emailHooks = {
  onEmailOpen: new HookBus(),
  onEmailClose: new HookBus(),
  onEmailContentRender: new HookBus(),
  onThreadExpand: new HookBus(),
  // Intercept hook - fires before the composer opens.
  // Handlers receive ComposeOptions and may mutate fields in place.
  // Return false to cancel opening the composer.
  onBeforeCompose: new HookBus(),
  onComposerOpen: new HookBus(),
  onBeforeEmailSend: new HookBus(),
  onAfterEmailSend: new HookBus(),
  onDraftAutoSave: new HookBus(),
  onBeforeEmailDelete: new HookBus(),
  onAfterEmailDelete: new HookBus(),
  onBeforeEmailMove: new HookBus(),
  onAfterEmailMove: new HookBus(),
  // Fired after one or more emails are archived to the Archive mailbox
  onEmailArchive: new HookBus(),
  // Fired after one or more emails are moved out of the Archive mailbox
  onEmailUnarchive: new HookBus(),
  onEmailReadStateChange: new HookBus(),
  onEmailStarToggle: new HookBus(),
  onEmailSpamToggle: new HookBus(),
  onEmailKeywordChange: new HookBus(),
  onMailboxChange: new HookBus(),
  onMailboxesRefresh: new HookBus(),
  onMailboxCreate: new HookBus(),
  onMailboxRename: new HookBus(),
  onMailboxDelete: new HookBus(),
  onMailboxEmpty: new HookBus(),
  onSearch: new HookBus(),
  onSearchResults: new HookBus(),
  onEmailSelectionChange: new HookBus(),
  onNewEmailReceived: new HookBus(),
  onPushConnectionChange: new HookBus(),
  onQuotaChange: new HookBus(),
  // Intercept hook - fired when a mailto: link is clicked.
  // Return false to prevent the browser from opening the system mail client.
  onMailtoIntercept: new HookBus(),
};

// §7.2 Calendar Hooks
export const calendarHooks = {
  onCalendarEventOpen: new HookBus(),
  onBeforeEventCreate: new HookBus(),
  onAfterEventCreate: new HookBus(),
  onBeforeEventUpdate: new HookBus(),
  onAfterEventUpdate: new HookBus(),
  onBeforeEventDelete: new HookBus(),
  onAfterEventDelete: new HookBus(),
  onEventRsvp: new HookBus(),
  onEventsImport: new HookBus(),
  onCalendarDateChange: new HookBus(),
  onCalendarViewChange: new HookBus(),
  onCalendarChange: new HookBus(),
  onCalendarVisibilityToggle: new HookBus(),
  onICalSubscriptionChange: new HookBus(),
  onCalendarAlert: new HookBus(),
  onCalendarAlertAcknowledge: new HookBus(),
};

// §7.2b Calendar Form Hooks (UI integration)
export const calendarFormHooks = {
  onCalendarEventFormOpen: new HookBus(),
  onCalendarEventFormSave: new HookBus(),
};

// §7.3 Contact Hooks
export const contactHooks = {
  onContactOpen: new HookBus(),
  onBeforeContactCreate: new HookBus(),
  onAfterContactCreate: new HookBus(),
  onBeforeContactUpdate: new HookBus(),
  onAfterContactUpdate: new HookBus(),
  onBeforeContactDelete: new HookBus(),
  onAfterContactDelete: new HookBus(),
  onContactsImport: new HookBus(),
  onContactSelectionChange: new HookBus(),
  onContactGroupChange: new HookBus(),
  onContactGroupMemberChange: new HookBus(),
  onContactMove: new HookBus(),
};

// §7.4 File Hooks
export const fileHooks = {
  onFileNavigate: new HookBus(),
  onBeforeFileUpload: new HookBus(),
  onAfterFileUpload: new HookBus(),
  onFileDownload: new HookBus(),
  onFileUploadCancel: new HookBus(),
  onDirectoryCreate: new HookBus(),
  onBeforeFileDelete: new HookBus(),
  onAfterFileDelete: new HookBus(),
  // Intercept hook - fires before a file is renamed.
  // Receives { file: FileResourceView, newName: string }.
  // Return false to cancel the rename.
  onBeforeFileRename: new HookBus(),
  onFileRename: new HookBus(),
  onFileMove: new HookBus(),
  onFileCopy: new HookBus(),
  onFileDuplicate: new HookBus(),
  onFileFavoriteToggle: new HookBus(),
  onFileSelectionChange: new HookBus(),
  onFileUndo: new HookBus(),
};

// §7.5 Auth Hooks
export const authHooks = {
  onLogin: new HookBus(),
  onBeforeLogout: new HookBus(),
  onAfterLogout: new HookBus(),
  onAccountSwitch: new HookBus(),
  onAccountAdd: new HookBus(),
  onAccountRemove: new HookBus(),
  onTokenRefresh: new HookBus(),
  onAuthReady: new HookBus(),
};

// §7.6 Settings Hooks
export const settingsHooks = {
  onSettingChange: new HookBus(),
  onSettingsExport: new HookBus(),
  onSettingsImport: new HookBus(),
  onSettingsReset: new HookBus(),
  onSettingsSync: new HookBus(),
  onKeywordChange: new HookBus(),
  onTrustedSenderChange: new HookBus(),
};

// §7.7 Identity Hooks
export const identityHooks = {
  onIdentitiesLoaded: new HookBus(),
  onIdentityCreate: new HookBus(),
  onIdentityUpdate: new HookBus(),
  onIdentityDelete: new HookBus(),
  onIdentitySelect: new HookBus(),
  onSignatureRender: new HookBus(),
};

// §7.8 Filter Hooks
export const filterHooks = {
  onFiltersLoaded: new HookBus(),
  onFilterRuleChange: new HookBus(),
  onFiltersSave: new HookBus(),
  onSieveScriptChange: new HookBus(),
};

// §7.9 Task Hooks
export const taskHooks = {
  onTasksLoaded: new HookBus(),
  onTaskCreate: new HookBus(),
  onTaskUpdate: new HookBus(),
  onTaskDelete: new HookBus(),
  onTaskToggleComplete: new HookBus(),
  onTaskFilterChange: new HookBus(),
};

// §7.10 Template Hooks
export const templateHooks = {
  onTemplateCreate: new HookBus(),
  onTemplateUpdate: new HookBus(),
  onTemplateDelete: new HookBus(),
  onTemplateApply: new HookBus(),
  onTemplatesImport: new HookBus(),
  onTemplateRender: new HookBus(),
};

// §7.11 S/MIME Hooks
export const smimeHooks = {
  onSmimeKeyImport: new HookBus(),
  onSmimeCertImport: new HookBus(),
  onSmimeKeyStateChange: new HookBus(),
  onSmimeDefaultsChange: new HookBus(),
};

// §7.12 Vacation Hooks
export const vacationHooks = {
  onVacationLoaded: new HookBus(),
  onVacationUpdate: new HookBus(),
};

// §7.13 UI Hooks
export const uiHooks = {
  onViewChange: new HookBus(),
  onSidebarToggle: new HookBus(),
  onSidebarCollapse: new HookBus(),
  onDeviceTypeChange: new HookBus(),
  onColumnResize: new HookBus(),
  onMobileBack: new HookBus(),
  onMobileViewSwitch: new HookBus(),
};

// §7.14 Theme Hooks
export const themeHooks = {
  onThemeChange: new HookBus(),
  onCustomThemeChange: new HookBus(),
  onLocaleChange: new HookBus(),
};

// §7.15 Toast Hooks
export const toastHooks = {
  onToastShow: new HookBus(),
  onToastDismiss: new HookBus(),
  onBrowserNotification: new HookBus(),
};

// §7.16 Drag & Drop Hooks
export const dragDropHooks = {
  onDragStart: new HookBus(),
  onDragEnd: new HookBus(),
  onEmailDrop: new HookBus(),
  onTagDrop: new HookBus(),
};

// §7.17 Keyboard Hooks
export const keyboardHooks = {
  registerShortcut: new HookBus(),
  onBeforeShortcut: new HookBus(),
  onAfterShortcut: new HookBus(),
};

// §7.18 App Lifecycle Hooks
export const appLifecycleHooks = {
  onAppReady: new HookBus(),
  onVisibilityChange: new HookBus(),
  onBeforeUnload: new HookBus(),
  onAppError: new HookBus(),
  onInterval: new HookBus(),
};

// §7.19 Account Security Hooks
export const accountSecurityHooks = {
  onPasswordChange: new HookBus(),
  onTotpChange: new HookBus(),
  onAppPasswordChange: new HookBus(),
  onEncryptionChange: new HookBus(),
  onDisplayNameChange: new HookBus(),
};

// §7.20 Sidebar App Hooks
export const sidebarAppHooks = {
  onSidebarAppOpen: new HookBus(),
  onSidebarAppClose: new HookBus(),
  onSidebarAppChange: new HookBus(),
};

// §7.21 Avatar Hooks
// Transform hook: handlers receive (currentUrl: string | null, context: { email: string; name?: string })
// and return a URL string to use as the avatar, or undefined/null to pass through to the next handler.
export const avatarHooks = {
  onAvatarResolve: new HookBus(),
};

// §7.22 Render Hooks
export const renderHooks = {
  // Transform hook - runs for each visible email list row.
  // Initial value: EmailListBadge[]  (always starts as [])
  // Second argument: { emailId: string; email: EmailReadView }
  // Handlers return a new (or extended) badges array.
  // Rendered by the email list row component next to the subject line.
  onEmailListItemRender: new HookBus(),
};

// ─── Aggregate: remove all handlers for a plugin across all buses ───

const allHookGroups = [
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks, sidebarAppHooks,
  avatarHooks, renderHooks,
];

export function removeAllPluginHooks(pluginId: string): void {
  for (const group of allHookGroups) {
    for (const bus of Object.values(group)) {
      (bus as HookBus<never>).removePlugin(pluginId);
    }
  }
}

export function clearAllHooks(): void {
  for (const group of allHookGroups) {
    for (const bus of Object.values(group)) {
      (bus as HookBus<never>).clear();
    }
  }
}
