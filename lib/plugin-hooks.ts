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
// Intercept hooks frequently block on user confirmation modals (send,
// reply-all, mailto, attachment upload), so they need a much longer budget
// than observer / transform hooks.
const INTERCEPT_TIMEOUT_MS = 60_000;

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
        const result = await withTimeout(handler(...args), INTERCEPT_TIMEOUT_MS);
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
  // Transform hook - fires before the draft is auto-saved to the server.
  // Receive fields passed to client.createDraft and may mutate fields in place.
  // Return false to cancel the auto-save or a the fields.
  onBeforeDraftAutoSave: new HookBus(),
  onDraftAutoSave: new HookBus(),
  // Transform hook - fires before a draft is created from an email in draft mailbox.
  // Receive a Email object and may mutate fields in place.
  onBeforeEditDraft: new HookBus(),
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
  // Transform hook - fires after onBeforeEmailSend has not cancelled,
  // immediately before the message is handed to the JMAP submission. Handlers
  // receive an OutgoingEmail and return a modified copy (or undefined to pass
  // through). Use to inject signatures, scrub tracking pixels from forwarded
  // bodies, encrypt content, or rewrite links.
  onTransformOutgoingEmail: new HookBus(),
  // Intercept hooks fired when the user clicks Reply / Reply-All / Forward.
  // Handler receives a ReplyContext; return false to cancel.
  onBeforeReply: new HookBus(),
  onBeforeReplyAll: new HookBus(),
  onBeforeForward: new HookBus(),
  // Transform hook - lets plugins replace the quote header block ("On X,
  // Y wrote:" / "---------- Forwarded message ----------") used when opening
  // a reply or forward. Initial value: QuoteHeader (host default), second
  // argument: QuoteHeaderContext. Handlers return a QuoteHeader (or
  // undefined to pass through). Fires once per composer open.
  onBuildQuoteHeader: new HookBus(),
  // Intercept hook fired before a file is added to the composer as an
  // attachment. Handler receives AttachmentInfo (size/type/name only - the
  // raw file is not exposed). Return false to refuse the upload.
  onBeforeAttachmentUpload: new HookBus(),
  // Intercept hook fired before a file is uploaded to JMAP server. 
  // It is fired after onBeforeAttachmentUpload.
  // Handler receive the {file: File, blobId: 'undefined'} object. 
  // If it uploaded, it must return the object with true blobId. 
  // Here, the raw file sended is exposed and can be modified or replaced. 
  onBeforeBlobUpload: new HookBus(),
  // Observer fired after an attachment has been uploaded and its blobId is
  // available. Handler receives AttachmentInfo with `blobId` populated.
  onAfterAttachmentUpload: new HookBus(),
  // Observer fired when the user downloads an attachment from a message.
  onAttachmentDownload: new HookBus(),
  // Transform hook - lets plugins replace the preview URL or supply a custom
  // renderer for an attachment. Initial value: AttachmentPreview, second
  // argument: AttachmentInfo.
  onAttachmentPreview: new HookBus(),
  // Transform hook - lets plugins contribute additional results to the global
  // search panel. Initial value: ExternalSearchResult[]. Second argument:
  // { query: string, filters: SearchFilters }.
  onProvideSearchResults: new HookBus(),
  // Observer fired (debounced) when the composer draft body, subject, or
  // recipients change. Handler receives a DraftView snapshot. Use for AI
  // assistants, grammar checkers, etc.
  onDraftChange: new HookBus(),
  // Intercept hook - fires at the very TOP of the composer send path, before
  // the host builds and submits the message. Handler receives a ComposeSend
  // request (draft fields, recipients, identityId, attachments, and the user's
  // sign/encrypt intent) and may TAKE OVER sending entirely: build a raw MIME
  // message, sign/encrypt it, and submit it via `api.jmap.sendRaw`. Returning
  // false signals "I handled the send" and the host SKIPS its default
  // submission. Returning anything else (incl. undefined) lets the host send
  // normally. This is the send-takeover hook used by the S/MIME plugin to
  // replace the former native sign+encrypt+sendRaw pipeline.
  onComposeSend: new HookBus(),
  // Transform hook - receive Email[] or ScheduledEmail[] just after there are fetched to 
  // lets plugin edit emails before they are shown in row. Used to populate preview 
  // field for encryption plugins.
  onEmailsFetched: new HookBus(),
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
  // Transform hook - fires when the event form is open and start/end change.
  // Initial value: ConflictWarning[], second argument: { event: CalendarEventFormView }.
  // Plugins return an extended array; the form renders each warning inline.
  onCheckEventConflicts: new HookBus(),
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
  // Transform hook - lets plugins contribute extra recipient suggestions to
  // the composer's autocomplete. Initial value: RecipientSuggestion[],
  // second argument: { query: string }.
  onProvideRecipientSuggestions: new HookBus(),
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
  // Intercept hook - fires when the user clicks an external link inside the
  // app (typically inside an email body iframe). Handler receives
  // ExternalLinkContext; return false to cancel the navigation. Mutate
  // `href` in place to rewrite (e.g. strip UTM params, route via a proxy).
  onBeforeExternalLink: new HookBus(),
  // Observer (debounced) fired when the user changes the active text
  // selection inside an app surface. Receives SelectionContext.
  onTextSelectionChange: new HookBus(),
};

// §7.14 Theme Hooks
export const themeHooks = {
  onThemeChange: new HookBus(),
  onCustomThemeChange: new HookBus(),
  onLocaleChange: new HookBus(),
  /**
   * Transform hook fired immediately before a theme's compiled CSS is
   * injected into the document.
   *
   *   handler(css: string, ctx: { themeId: string | null; variant: 'light' | 'dark' }): string | undefined
   *
   * Return a new CSS string to override what gets injected, or `undefined`
   * to pass through unchanged. Use this to inject extra `@font-face` rules,
   * patch a third-party theme's variables for accessibility, or implement
   * site-wide design-token overrides.
   */
  onThemeBeforeApply: new HookBus(),
};

// §7.15 Toast Hooks
export const toastHooks = {
  onToastShow: new HookBus(),
  onToastDismiss: new HookBus(),
  onBrowserNotification: new HookBus(),
  // Observer fired when the user clicks an OS-level browser notification
  // dispatched by the host. Handler receives { tag: string, data?: unknown }
  // matching the original notification options.
  onNotificationClick: new HookBus(),
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
  // Observer fired when the browser window receives focus / blur. Useful for
  // refresh-on-focus behaviour (re-poll, recheck staleness, pause timers).
  onWindowFocus: new HookBus(),
  onWindowBlur: new HookBus(),
  // Observer fired when network connectivity transitions. Mirrors the
  // navigator online / offline events.
  onOnline: new HookBus(),
  onOffline: new HookBus(),
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

// §7.23 Router Hooks
// Observers fired by the app router. Handlers receive a RouteContext; on
// onNavigate the previous path is exposed via `from`.
export const routerHooks = {
  onNavigate: new HookBus(),
  onRouteEnter: new HookBus(),
  onRouteLeave: new HookBus(),
};

// §7.22 Render Hooks
export const renderHooks = {
  // Transform hook - runs for each visible email list row.
  // Initial value: EmailListBadge[]  (always starts as [])
  // Second argument: { emailId: string; email: EmailReadView }
  // Handlers return a new (or extended) badges array.
  // Rendered by the email list row component next to the subject line.
  onEmailListItemRender: new HookBus(),
  // Transform hook - runs when an email is opened, BEFORE the viewer computes
  // the body it will render. Initial value: RenderableBody { html, text,
  // attachments, handledBy? }. Second argument: MessageContext { id,
  // bodyStructure, attachments, blobId, contentType, from }. A handler may
  // inspect the message (e.g. detect S/MIME), fetch the raw blob via
  // `api.jmap.fetchBlob`, decrypt/verify in-frame, and return a REPLACED body
  // with `handledBy` set plus optional `verification` status. Return undefined
  // (or the unchanged value) to pass through. The host still runs the returned
  // HTML through its sanitizer — plugin output is not trusted blindly. This is
  // the render-takeover hook used by the S/MIME plugin to replace the former
  // native detect/decrypt/verify path in the viewer.
  onRenderEmailBody: new HookBus(),
};

// ─── Aggregate: remove all handlers for a plugin across all buses ───

const allHookGroups = [
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks, sidebarAppHooks,
  avatarHooks, renderHooks, routerHooks,
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
