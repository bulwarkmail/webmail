import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useThemeStore } from './theme-store';
import { useLocaleStore } from './locale-store';

// Use console directly to avoid circular dependency with lib/debug.ts
// (debug.ts imports useSettingsStore for debugMode check)
const syncLog = (...args: unknown[]) => console.log('[SETTINGS_SYNC]', ...args);
const syncWarn = (...args: unknown[]) => console.warn('[SETTINGS_SYNC]', ...args);
const syncError = (...args: unknown[]) => console.error('[SETTINGS_SYNC]', ...args);

// Settings sync state (module-level, not persisted)
let syncEnabled = false;
let syncUsername: string | null = null;
let syncServerUrl: string | null = null;
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let isLoadingFromServer = false;

const SYNC_DEBOUNCE_MS = 2000;

export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';
/** @deprecated Use Density instead */
export type ListDensity = Density;
export type DeleteAction = 'trash' | 'permanent';
export type ReplyMode = 'reply' | 'replyAll';
export type DateFormat = 'regional' | 'iso' | 'custom';
export type TimeFormat = '12h' | '24h';
export type FirstDayOfWeek = 0 | 1; // 0 = Sunday, 1 = Monday
export type ExternalContentPolicy = 'ask' | 'block' | 'allow';
export type MailAttachmentAction = 'preview' | 'download';
export type AttachmentPosition = 'beside-sender' | 'below-header';
export type ToolbarPosition = 'top' | 'below-subject';
export type ArchiveMode = 'single' | 'year' | 'month';

export interface KeywordDefinition {
  id: string;     // Used as JMAP keyword suffix: $label:<id>
  label: string;  // Display name
  color: string;  // Key from KEYWORD_PALETTE
}

export interface SidebarApp {
  id: string;
  name: string;
  url: string;
  icon: string;       // Lucide icon name (e.g. 'Globe', 'Rss')
  openMode: 'tab' | 'inline'; // Open in new tab or embed inline
}

// Available color palette for keywords
export const KEYWORD_PALETTE: Record<string, { dot: string; bg: string }> = {
  red: { dot: 'bg-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
  orange: { dot: 'bg-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
  yellow: { dot: 'bg-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
  green: { dot: 'bg-green-500', bg: 'bg-green-50 dark:bg-green-950/30' },
  blue: { dot: 'bg-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
  purple: { dot: 'bg-purple-500', bg: 'bg-purple-50 dark:bg-purple-950/30' },
  pink: { dot: 'bg-pink-500', bg: 'bg-pink-50 dark:bg-pink-950/30' },
  teal: { dot: 'bg-teal-500', bg: 'bg-teal-50 dark:bg-teal-950/30' },
  cyan: { dot: 'bg-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-950/30' },
  indigo: { dot: 'bg-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-950/30' },
  amber: { dot: 'bg-amber-500', bg: 'bg-amber-50 dark:bg-amber-950/30' },
  lime: { dot: 'bg-lime-500', bg: 'bg-lime-50 dark:bg-lime-950/30' },
  gray: { dot: 'bg-gray-500', bg: 'bg-gray-50 dark:bg-gray-950/30' },
} as const;

export const DEFAULT_KEYWORDS: KeywordDefinition[] = [
  { id: 'red', label: 'Red', color: 'red' },
  { id: 'orange', label: 'Orange', color: 'orange' },
  { id: 'yellow', label: 'Yellow', color: 'yellow' },
  { id: 'green', label: 'Green', color: 'green' },
  { id: 'blue', label: 'Blue', color: 'blue' },
  { id: 'purple', label: 'Purple', color: 'purple' },
  { id: 'pink', label: 'Pink', color: 'pink' },
];

interface SettingsState {
  // Appearance
  fontSize: FontSize;
  density: Density;
  animationsEnabled: boolean;

  // Language & Region
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  firstDayOfWeek: FirstDayOfWeek;

  // Email Behavior
  markAsReadDelay: number; // milliseconds (0 = instant, -1 = never)
  deleteAction: DeleteAction;
  permanentlyDeleteJunk: boolean; // Permanently delete emails from junk/spam instead of moving to trash
  showPreview: boolean;
  emailsPerPage: number;
  externalContentPolicy: ExternalContentPolicy;
  mailAttachmentAction: MailAttachmentAction;
  attachmentPosition: AttachmentPosition;
  emailAlwaysLightMode: boolean; // Always render email content in light mode
  archiveMode: ArchiveMode; // How to organize archived emails: single folder, by year, or by year+month

  // Composer
  autoSaveDraftInterval: number; // milliseconds
  sendConfirmation: boolean;
  defaultReplyMode: ReplyMode;

  // Privacy & Security
  sessionTimeout: number; // minutes (0 = never)
  trustedSenders: string[]; // Email addresses that can load external content

  // Calendar Notifications
  calendarNotificationsEnabled: boolean;
  calendarNotificationSound: boolean;
  calendarInvitationParsingEnabled: boolean;

  // Layout
  toolbarPosition: ToolbarPosition;
  showToolbarLabels: boolean;

  // Experimental
  senderFavicons: boolean;

  // Folders
  folderIcons: Record<string, string>; // mailboxId -> icon name

  // Keywords (labels/tags)
  emailKeywords: KeywordDefinition[];

  // Sidebar Apps
  sidebarApps: SidebarApp[];
  keepAppsLoaded: boolean;

  // Advanced
  debugMode: boolean;
  settingsSyncDisabled: boolean;

  // Actions
  updateSetting: <K extends keyof SettingsState>(
    key: K,
    value: SettingsState[K]
  ) => void;
  resetToDefaults: () => void;
  exportSettings: () => string;
  importSettings: (json: string) => boolean;

  // Folder icons
  setFolderIcon: (mailboxId: string, icon: string) => void;
  removeFolderIcon: (mailboxId: string) => void;

  // Trusted senders
  addTrustedSender: (email: string) => void;
  removeTrustedSender: (email: string) => void;
  isSenderTrusted: (email: string) => boolean;

  // Keywords
  addKeyword: (keyword: KeywordDefinition) => void;
  updateKeyword: (id: string, updates: Partial<Omit<KeywordDefinition, 'id'>>) => void;
  removeKeyword: (id: string) => void;
  reorderKeywords: (keywords: KeywordDefinition[]) => void;
  getKeywordById: (id: string) => KeywordDefinition | undefined;

  // Sidebar Apps
  addSidebarApp: (app: SidebarApp) => void;
  updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => void;
  removeSidebarApp: (id: string) => void;
  reorderSidebarApps: (apps: SidebarApp[]) => void;

  // Settings sync
  enableSync: (username: string, serverUrl: string) => void;
  disableSync: () => void;
  loadFromServer: (username: string, serverUrl: string) => Promise<boolean>;
}

const DEFAULT_SETTINGS = {
  // Appearance
  fontSize: 'medium' as FontSize,
  density: 'regular' as Density,
  animationsEnabled: true,

  // Language & Region
  dateFormat: 'regional' as DateFormat,
  timeFormat: '24h' as TimeFormat,
  firstDayOfWeek: 1 as FirstDayOfWeek, // Monday

  // Email Behavior
  markAsReadDelay: 0, // Instant
  deleteAction: 'trash' as DeleteAction,
  permanentlyDeleteJunk: false,
  showPreview: true,
  emailsPerPage: 50,
  externalContentPolicy: 'ask' as ExternalContentPolicy,
  mailAttachmentAction: 'preview' as MailAttachmentAction,
  attachmentPosition: 'beside-sender' as AttachmentPosition,
  emailAlwaysLightMode: false,
  archiveMode: 'single' as ArchiveMode,

  // Composer
  autoSaveDraftInterval: 60000, // 1 minute
  sendConfirmation: false,
  defaultReplyMode: 'reply' as ReplyMode,

  // Privacy & Security
  sessionTimeout: 0, // Never
  trustedSenders: [] as string[],

  // Calendar Notifications
  calendarNotificationsEnabled: true,
  calendarNotificationSound: true,
  calendarInvitationParsingEnabled: true,

  // Layout
  toolbarPosition: 'top' as ToolbarPosition,
  showToolbarLabels: true,

  // Experimental
  senderFavicons: true,

  // Folders
  folderIcons: {} as Record<string, string>,

  // Keywords
  emailKeywords: DEFAULT_KEYWORDS,

  // Sidebar Apps
  sidebarApps: [] as SidebarApp[],
  keepAppsLoaded: false,

  // Advanced
  debugMode: false,
  settingsSyncDisabled: false,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,

      updateSetting: (key, value) => {
        set({ [key]: value });

        // Apply font size to document root
        if (key === 'fontSize') {
          applyFontSize(value as FontSize);
        }

        // Apply density to document root
        if (key === 'density') {
          applyDensity(value as Density);
        }

        // Apply animations to document root
        if (key === 'animationsEnabled') {
          applyAnimations(value as boolean);
        }
      },

      resetToDefaults: () => {
        set(DEFAULT_SETTINGS);
        applyFontSize(DEFAULT_SETTINGS.fontSize);
        applyDensity(DEFAULT_SETTINGS.density);
        applyAnimations(DEFAULT_SETTINGS.animationsEnabled);
      },

      exportSettings: () => {
        const state = get();
        const settings = {
          fontSize: state.fontSize,
          density: state.density,
          animationsEnabled: state.animationsEnabled,
          dateFormat: state.dateFormat,
          timeFormat: state.timeFormat,
          firstDayOfWeek: state.firstDayOfWeek,
          markAsReadDelay: state.markAsReadDelay,
          deleteAction: state.deleteAction,
          showPreview: state.showPreview,
          emailsPerPage: state.emailsPerPage,
          externalContentPolicy: state.externalContentPolicy,
          mailAttachmentAction: state.mailAttachmentAction,
          attachmentPosition: state.attachmentPosition,
          archiveMode: state.archiveMode,
          trustedSenders: state.trustedSenders,
          autoSaveDraftInterval: state.autoSaveDraftInterval,
          sendConfirmation: state.sendConfirmation,
          defaultReplyMode: state.defaultReplyMode,
          sessionTimeout: state.sessionTimeout,
          calendarNotificationsEnabled: state.calendarNotificationsEnabled,
          calendarNotificationSound: state.calendarNotificationSound,
          calendarInvitationParsingEnabled: state.calendarInvitationParsingEnabled,
          toolbarPosition: state.toolbarPosition,
          senderFavicons: state.senderFavicons,
          folderIcons: state.folderIcons,
          emailKeywords: state.emailKeywords,
          sidebarApps: state.sidebarApps,
          keepAppsLoaded: state.keepAppsLoaded,
          debugMode: state.debugMode,
          settingsSyncDisabled: state.settingsSyncDisabled,
          // Cross-store settings
          theme: useThemeStore.getState().theme,
          locale: useLocaleStore.getState().locale,
        };
        return JSON.stringify(settings, null, 2);
      },

      importSettings: (json: string) => {
        try {
          const settings = JSON.parse(json);

          // Validate settings
          if (typeof settings !== 'object' || settings === null) {
            return false;
          }

          // Apply settings
          Object.keys(settings).forEach((key) => {
            if (key in DEFAULT_SETTINGS) {
              set({ [key]: settings[key] });
            }
          });

          // Apply visual settings
          applyFontSize(get().fontSize);
          applyDensity(get().density);
          applyAnimations(get().animationsEnabled);

          // Apply cross-store settings
          if (settings.theme) {
            useThemeStore.getState().setTheme(settings.theme);
          }
          if (settings.locale) {
            useLocaleStore.getState().setLocale(settings.locale);
          }

          return true;
        } catch (error) {
          console.error('Failed to import settings:', error);
          return false;
        }
      },

      // Folder icon methods
      setFolderIcon: (mailboxId: string, icon: string) => {
        set({ folderIcons: { ...get().folderIcons, [mailboxId]: icon } });
      },

      removeFolderIcon: (mailboxId: string) => {
        const { [mailboxId]: _, ...rest } = get().folderIcons;
        set({ folderIcons: rest });
      },

      // Trusted senders methods
      addTrustedSender: (email: string) => {
        const normalizedEmail = email.toLowerCase().trim();
        const current = get().trustedSenders;
        if (!current.includes(normalizedEmail)) {
          set({ trustedSenders: [...current, normalizedEmail] });
        }
      },

      removeTrustedSender: (email: string) => {
        const normalizedEmail = email.toLowerCase().trim();
        set({
          trustedSenders: get().trustedSenders.filter(e => e !== normalizedEmail)
        });
      },

      isSenderTrusted: (email: string) => {
        const normalizedEmail = email.toLowerCase().trim();
        return get().trustedSenders.includes(normalizedEmail);
      },

      // Keyword methods
      addKeyword: (keyword: KeywordDefinition) => {
        const current = get().emailKeywords;
        if (current.some(k => k.id === keyword.id)) return;
        set({ emailKeywords: [...current, keyword] });
      },

      updateKeyword: (id: string, updates: Partial<Omit<KeywordDefinition, 'id'>>) => {
        set({
          emailKeywords: get().emailKeywords.map(k =>
            k.id === id ? { ...k, ...updates } : k
          ),
        });
      },

      removeKeyword: (id: string) => {
        set({ emailKeywords: get().emailKeywords.filter(k => k.id !== id) });
      },

      reorderKeywords: (keywords: KeywordDefinition[]) => {
        set({ emailKeywords: keywords });
      },

      getKeywordById: (id: string) => {
        return get().emailKeywords.find(k => k.id === id);
      },

      // Sidebar Apps methods
      addSidebarApp: (app: SidebarApp) => {
        const current = get().sidebarApps;
        if (current.some(a => a.id === app.id)) return;
        set({ sidebarApps: [...current, app] });
      },

      updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => {
        set({
          sidebarApps: get().sidebarApps.map(a =>
            a.id === id ? { ...a, ...updates } : a
          ),
        });
      },

      removeSidebarApp: (id: string) => {
        set({ sidebarApps: get().sidebarApps.filter(a => a.id !== id) });
      },

      reorderSidebarApps: (apps: SidebarApp[]) => {
        set({ sidebarApps: apps });
      },

      // Settings sync methods
      enableSync: (username: string, serverUrl: string) => {
        syncUsername = username;
        syncServerUrl = serverUrl;
        syncEnabled = true;
        syncLog('Settings sync enabled for', username);
      },

      disableSync: () => {
        syncEnabled = false;
        syncUsername = null;
        syncServerUrl = null;
        if (syncTimeout) {
          clearTimeout(syncTimeout);
          syncTimeout = null;
        }
        syncLog('Settings sync disabled');
      },

      loadFromServer: async (username: string, serverUrl: string) => {
        try {
          syncLog('Loading settings from server for', username);
          const res = await fetch('/api/settings', {
            headers: {
              'x-settings-username': username,
              'x-settings-server': serverUrl,
            },
          });
          if (!res.ok) {
            syncLog('No server settings found (status', res.status + ')');
            return false;
          }
          const { settings } = await res.json();
          if (settings && typeof settings === 'object') {
            isLoadingFromServer = true;
            get().importSettings(JSON.stringify(settings));
            isLoadingFromServer = false;
            syncLog('Settings loaded from server successfully');
            return true;
          }
          return false;
        } catch (error) {
          syncError('Failed to load settings from server:', error);
          isLoadingFromServer = false;
          return false;
        }
      },
    }),
    {
      name: 'settings-storage',
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        if (version < 2 && state.listDensity) {
          state.density = state.listDensity;
          delete state.listDensity;
        }
        return state as unknown as SettingsState;
      },
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            applyFontSize(state.fontSize);
            applyDensity(state.density);
            applyAnimations(state.animationsEnabled);
          }
        };
      },
    }
  )
);

// Helper functions to apply settings to DOM
function applyFontSize(size: FontSize) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const sizeMap = {
    small: '14px',
    medium: '16px',
    large: '18px',
  };
  root.style.setProperty('--font-size-base', sizeMap[size]);
}

function applyDensity(density: Density) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  const densityValues = {
    'extra-compact': {
      '--list-item-height': 'auto',
      '--density-item-py': '2px',
      '--density-item-gap': '6px',
      '--density-header-py': '4px',
      '--density-card-p': '8px',
      '--density-sidebar-py': '0px',
    },
    compact: {
      '--list-item-height': 'auto',
      '--density-item-py': '4px',
      '--density-item-gap': '8px',
      '--density-header-py': '6px',
      '--density-card-p': '10px',
      '--density-sidebar-py': '1px',
    },
    regular: {
      '--list-item-height': '48px',
      '--density-item-py': '12px',
      '--density-item-gap': '12px',
      '--density-header-py': '12px',
      '--density-card-p': '16px',
      '--density-sidebar-py': '4px',
    },
    comfortable: {
      '--list-item-height': '64px',
      '--density-item-py': '16px',
      '--density-item-gap': '16px',
      '--density-header-py': '16px',
      '--density-card-p': '20px',
      '--density-sidebar-py': '6px',
    },
  };

  const values = densityValues[density];
  for (const [prop, val] of Object.entries(values)) {
    root.style.setProperty(prop, val);
  }
}

function applyAnimations(enabled: boolean) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  if (enabled) {
    root.style.removeProperty('--transition-duration');
  } else {
    root.style.setProperty('--transition-duration', '0s');
  }
}

// Initialize settings on load
if (typeof window !== 'undefined') {
  const store = useSettingsStore.getState();
  applyFontSize(store.fontSize);
  applyDensity(store.density);
  applyAnimations(store.animationsEnabled);

  // Shared sync function used by all store subscribers
  const syncToServer = async (retries = 1): Promise<void> => {
    const settings = JSON.parse(useSettingsStore.getState().exportSettings());
    syncLog('Syncing settings to server...');
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: syncUsername, serverUrl: syncServerUrl, settings }),
    });
    if (res.status === 404) {
      syncWarn('Settings sync endpoint returned 404, disabling sync');
      syncEnabled = false;
    } else if (res.status >= 500 && retries > 0) {
      syncWarn('Settings sync got server error, retrying...');
      await new Promise((r) => setTimeout(r, 2000));
      return syncToServer(retries - 1);
    } else if (!res.ok) {
      syncError('Settings sync failed with status', res.status);
    } else {
      syncLog('Settings synced to server successfully');
    }
  };

  const triggerSync = () => {
    if (!syncEnabled || !syncUsername || !syncServerUrl || isLoadingFromServer) return;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
      try {
        await syncToServer();
      } catch (error) {
        syncError('Settings sync error:', error);
      }
    }, SYNC_DEBOUNCE_MS);
  };

  // Auto-sync settings to server on any state change
  let prevSyncDisabled = useSettingsStore.getState().settingsSyncDisabled;
  useSettingsStore.subscribe(() => {
    const currentSyncDisabled = useSettingsStore.getState().settingsSyncDisabled;
    const syncToggleChanged = currentSyncDisabled !== prevSyncDisabled;
    prevSyncDisabled = currentSyncDisabled;
    // Skip sync if disabled, unless the toggle itself just changed
    if (currentSyncDisabled && !syncToggleChanged) return;
    triggerSync();
  });

  // Also sync when theme or locale changes
  useThemeStore.subscribe(triggerSync);
  useLocaleStore.subscribe(triggerSync);
}
