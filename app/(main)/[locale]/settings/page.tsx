"use client";

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations, useMessages } from 'next-intl';
import {
  ArrowLeft,
  ChevronRight,
  LogOut,
  Settings as SettingsIcon,
  Palette,
  Search,
  User,
  Shield,
  UserPen,
  PalmtreeIcon,
  Calendar,
  Filter,
  FileText,
  FolderOpen,
  Tags,
  HardDrive,
  BookUser,
  PanelLeftClose,
  Bell,
  Puzzle,
  LayoutGrid,
  Link as LinkIcon,
  BookOpen,
  PenLine,
  EyeOff,
  Languages,
  Info,
  Bug,
  SwatchBook,
  Download,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppearanceSettings } from '@/components/settings/appearance-settings';
import { AppTopBannerSlot } from '@/components/plugins/app-top-banner-slot';
import { LayoutSettings } from '@/components/settings/layout-settings';
import { LanguageSettings } from '@/components/settings/language-settings';
import { ReadingSettings } from '@/components/settings/reading-settings';
import { ComposingSettings } from '@/components/settings/composing-settings';
import { ContentSendersSettings } from '@/components/settings/content-senders-settings';
import { AccountSettings } from '@/components/settings/account-settings';
import { IdentitySettings } from '@/components/settings/identity-settings';
import { VacationSettings } from '@/components/settings/vacation-settings';
import { CalendarSettings } from '@/components/settings/calendar-settings';
import { CalendarManagementSettings } from '@/components/settings/calendar-management-settings';
import { AddressBookManagementSettings } from '@/components/settings/address-book-management-settings';
import { FilterSettings } from '@/components/settings/filter-settings';
import { TemplateSettings } from '@/components/settings/template-settings';
import { AboutDataSettings } from '@/components/settings/about-data-settings';
import { DebugSettings } from '@/components/settings/debug-settings';
import { FolderSettings } from '@/components/settings/folder-settings';
import { KeywordSettings } from '@/components/settings/keyword-settings';
import { AccountSecuritySettings } from '@/components/settings/account-security-settings';
import { FilesSettingsComponent } from '@/components/settings/files-settings';
import { DownloadsSettings } from '@/components/settings/downloads-settings';
import { ContactsSettings } from '@/components/settings/contacts-settings';
import { SidebarAppsSettings } from '@/components/settings/sidebar-apps-settings';
import { NotificationSettings } from '@/components/settings/notification-settings';
import { ThemesSettings } from '@/components/settings/themes-settings';
import { PluginsSettings } from '@/components/settings/plugins-settings';
import { ProtocolHandlerSettings } from '@/components/settings/protocol-handler-settings';
import { useAuthStore, redirectToLogin } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useThemeStore } from '@/stores/theme-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useManagedAccountStore } from '@/stores/managed-account-store';
import { useIsDesktop } from '@/hooks/use-media-query';
import { NavigationRail } from '@/components/layout/navigation-rail';
import { SidebarAppsModal } from '@/components/layout/sidebar-apps-modal';
import { InlineAppView } from '@/components/layout/inline-app-view';
import { useSidebarApps } from '@/hooks/use-sidebar-apps';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { ResizeHandle } from '@/components/layout/resize-handle';
import { useConfig } from '@/hooks/use-config';
import { usePolicyStore } from '@/stores/policy-store';
import { cn } from '@/lib/utils';

type Tab =
  | 'account'
  | 'language'
  | 'notifications'
  | 'appearance'
  | 'layout'
  | 'reading'
  | 'composing'
  | 'downloads'
  | 'identities'
  | 'vacation'
  | 'filters'
  | 'templates'
  | 'folders'
  | 'keywords'
  | 'security'
  | 'content_senders'
  | 'calendar'
  | 'contacts'
  | 'files'
  | 'protocol_handlers'
  | 'sidebar_apps'
  | 'about_data'
  | 'themes'
  | 'plugins'
  | 'debug';

type TabGroup = 'general' | 'appearance' | 'mail' | 'privacy' | 'apps' | 'advanced';

interface TabDef {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: TabGroup;
}

const tabIcons: Record<Tab, LucideIcon> = {
  account: User,
  language: Languages,
  notifications: Bell,
  appearance: Palette,
  layout: LayoutGrid,
  reading: BookOpen,
  composing: PenLine,
  downloads: Download,
  identities: UserPen,
  vacation: PalmtreeIcon,
  filters: Filter,
  templates: FileText,
  folders: FolderOpen,
  keywords: Tags,
  security: Shield,
  content_senders: EyeOff,
  calendar: Calendar,
  contacts: BookUser,
  files: HardDrive,
  protocol_handlers: LinkIcon,
  sidebar_apps: PanelLeftClose,
  about_data: Info,
  themes: SwatchBook,
  plugins: Puzzle,
  debug: Bug,
};

const tabGroupOrder: TabGroup[] = ['general', 'appearance', 'mail', 'privacy', 'apps', 'advanced'];

// Translation paths per tab. Tabs that share a namespace (email_behavior,
// appearance) explicitly list the subkeys they actually render so sub-results
// are attributed to the correct tab. Tabs with their own namespace just point
// at the namespace root.
const tabSearchPaths: Record<Tab, string[]> = {
  account: [
    'settings.account.name_label',
    'settings.account.username_label',
    'settings.account.account_type_label',
    'settings.account.auth_method_label',
    'settings.account.email',
    'settings.account.server',
    'settings.account.storage',
    'settings.account.accounts',
  ],
  language: ['settings.appearance.language'],
  notifications: ['settings.notifications'],
  appearance: [
    'settings.appearance.theme',
    'settings.appearance.font_size',
    'settings.appearance.list_density',
    'settings.appearance.animations',
  ],
  layout: [
    'settings.appearance.toolbar_position',
    'settings.appearance.toolbar_labels',
    'settings.appearance.hide_account_switcher',
    'settings.appearance.show_rail_account_list',
    'settings.appearance.unified_mailbox',
    'settings.appearance.all_mail',
    'settings.appearance.colorful_sidebar_icons',
    'settings.email_behavior.mail_layout',
  ],
  reading: [
    'settings.email_behavior.mark_read',
    'settings.email_behavior.archive_mode',
    'settings.email_behavior.delete_action',
    'settings.email_behavior.attachment_click_action',
    'settings.email_behavior.attachment_image_previews',
    'settings.email_behavior.attachment_position',
    'settings.email_behavior.disable_threading',
    'settings.email_behavior.emails_per_page',
    'settings.email_behavior.hide_inline_image_attachments',
    'settings.email_behavior.hover_actions',
    'settings.email_behavior.permanently_delete_junk',
    'settings.email_behavior.show_preview',
  ],
  composing: [
    'settings.email_behavior.attachment_reminder',
    'settings.email_behavior.auto_select_reply_identity',
    'settings.email_behavior.plain_text_mode',
    'settings.email_behavior.default_mail_program',
    'settings.email_behavior.signature_position',
    'settings.email_behavior.sub_address_delimiter',
  ],
  downloads: ['settings.downloads'],
  identities: ['settings.identities'],
  vacation: ['settings.vacation'],
  filters: ['settings.filters'],
  templates: ['settings.templates'],
  folders: ['settings.folders'],
  keywords: ['settings.keywords'],
  security: ['settings.security'],
  content_senders: [
    'settings.email_behavior.always_light_mode',
    'settings.email_behavior.external_content',
    'settings.email_behavior.trusted_senders',
  ],
  calendar: ['calendar.settings', 'calendar.management'],
  contacts: ['settings.contacts', 'contacts'],
  files: ['settings.files'],
  protocol_handlers: ['protocol_handlers'],
  sidebar_apps: ['settings.sidebar_apps', 'sidebar_apps'],
  about_data: ['settings.advanced'],
  themes: [],
  plugins: [],
  debug: ['settings.advanced'],
};

// Extra English keywords per tab so common search terms hit even when the
// translation doesn't contain the literal word.
const tabKeywords: Record<Tab, string> = {
  account: 'profile email password user signin signout reorder rearrange drag dropdown switcher multi-account',
  language: 'locale region timezone date time format',
  notifications: 'sound alert push badge',
  appearance: 'theme dark light font size accent color animation density',
  layout: 'toolbar sidebar account switcher unified mailbox icons rail',
  reading: 'mark read preview thread conversation archive delete attachment open',
  composing: 'editor signature plain text reply forward draft compose',
  downloads: 'download filename template eml attachment save export',
  identities: 'from address signature email',
  vacation: 'auto reply away out of office holiday responder',
  filters: 'sieve rules block junk forward',
  templates: 'snippet quick reply',
  folders: 'mailbox subscribe',
  keywords: 'tags labels colors',
  security: 'password 2fa two-factor passkey app password mfa',
  content_senders: 'block sender remote images privacy tracking',
  calendar: 'event schedule appointment meeting timezone',
  contacts: 'address book contact',
  files: 'attachments cloud drive storage upload',
  protocol_handlers: 'mailto webcal links default app protocol handler',
  sidebar_apps: 'apps webview iframe',
  about_data: 'export import storage quota privacy backup',
  themes: 'custom theme css skin appearance',
  plugins: 'extensions addons',
  debug: 'logs developer console diagnostic',
};

function flattenStrings(node: unknown, sink: string[]): void {
  if (typeof node === 'string') {
    sink.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) flattenStrings(item, sink);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) flattenStrings(value, sink);
  }
}

interface SubResult {
  label: string;
  description?: string;
  // For plugin setting fields: the id of the plugin whose card needs to be
  // expanded before the field becomes visible in the DOM.
  pluginId?: string;
}

// Walk a translation subtree and emit sub-results for renderable settings.
// Picks up:
//   - bare string leaves (when a tab path points directly at a flat label)
//   - objects with a `label` or `title` field (the standard pattern)
//   - flat `*_label` string keys at any object level (e.g. `name_label`)
function collectSubResults(node: unknown, sink: SubResult[]): void {
  if (typeof node === 'string') {
    sink.push({ label: node });
    return;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const label = typeof obj.label === 'string' ? obj.label : (typeof obj.title === 'string' ? obj.title : undefined);
  if (label) {
    sink.push({
      label,
      description: typeof obj.description === 'string' ? obj.description : undefined,
    });
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && key !== 'label' && key !== 'title' && key.endsWith('_label')) {
      sink.push({ label: value });
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectSubResults(value, sink);
    }
  }
}

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

// Map legacy tab IDs to current ones; runs once on read of localStorage.
const LEGACY_TAB_MAP: Record<string, Tab> = {
  email: 'reading',
  advanced: 'about_data',
};

function readPersistedTab(): Tab {
  try {
    // One-shot deep link from the sidebar section gears (Folders / Tags).
    // Used only as the initial tab and intentionally NOT written to
    // 'settings-active-tab', so a gear click never becomes the persisted
    // default that the regular Settings button lands on. Cleared on mount.
    const deepLink = sessionStorage.getItem('settings-deep-link-tab');
    if (deepLink) {
      return (deepLink in LEGACY_TAB_MAP ? LEGACY_TAB_MAP[deepLink] : deepLink) as Tab;
    }
    const saved = localStorage.getItem('settings-active-tab');
    if (!saved) return 'appearance';
    if (saved in LEGACY_TAB_MAP) {
      const migrated = LEGACY_TAB_MAP[saved];
      try { localStorage.setItem('settings-active-tab', migrated); } catch { /* ignore */ }
      return migrated;
    }
    return saved as Tab;
  } catch {
    return 'appearance';
  }
}

export default function SettingsPage() {
  const router = useRouter();
  const t = useTranslations('settings');
  const tSidebar = useTranslations('sidebar');
  const { client, isAuthenticated, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const isEmbedded = useIsEmbedded();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const { stalwartFeaturesEnabled } = useConfig();
  const { isFeatureEnabled } = usePolicyStore();
  const [activeTab, setActiveTab] = useState<Tab>(readPersistedTab);
  // Consume the one-shot deep-link key so a section gear only steers this one
  // open, never the persisted default for future Settings-button clicks.
  useEffect(() => {
    try { sessionStorage.removeItem('settings-deep-link-tab'); } catch { /* ignore */ }
  }, []);
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingHighlight, setPendingHighlight] = useState<{ tab: Tab; label: string; pluginId?: string } | null>(null);
  const isDesktop = useIsDesktop();

  const messages = useMessages() as Record<string, unknown>;
  const installedPlugins = usePluginStore((s) => s.plugins);
  const installedThemes = useThemeStore((s) => s.installedThemes);
  const sidebarAppsList = useSettingsStore((s) => s.sidebarApps);
  const proInterface = useSettingsStore((s) => s.proInterface);

  // When set, the settings panel is scoped to a shared/group account: a reduced
  // tab list and a "Managing: <name>" header. null = the user's own account.
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);
  const managedAccount = useManagedAccountStore((s) => s.managedAccount);
  const clearManagedAccount = useManagedAccountStore((s) => s.clear);

  // Build a per-tab haystack for fulltext search and a list of sub-results
  // (individual settings) per tab. Sub-results come from translation entries
  // that have a `label`/`title` field, plus dynamic content (installed
  // plugins/themes/sidebar apps).
  const { tabSearchHaystacks, tabSubResults } = useMemo(() => {
    const haystacks: Partial<Record<Tab, string>> = {};
    const subs: Partial<Record<Tab, SubResult[]>> = {};
    const tabIds = Object.keys(tabSearchPaths) as Tab[];
    for (const tabId of tabIds) {
      const strings: string[] = [tabId.replace(/_/g, ' '), tabKeywords[tabId] ?? ''];
      const list: SubResult[] = [];
      for (const path of tabSearchPaths[tabId]) {
        const node = getByPath(messages, path);
        flattenStrings(node, strings);
        collectSubResults(node, list);
      }
      // Dedupe sub-results by label
      const seen = new Set<string>();
      subs[tabId] = list.filter((r) => {
        if (seen.has(r.label)) return false;
        seen.add(r.label);
        return true;
      });
      haystacks[tabId] = strings.join(' ').toLowerCase();
    }
    if (installedPlugins.length) {
      const haystackText = installedPlugins.map((p) => {
        const fieldText = p.settingsSchema
          ? Object.values(p.settingsSchema)
              .map((s) => `${s.label} ${s.description ?? ''}`)
              .join(' ')
          : '';
        return `${p.name} ${p.description} ${p.author} ${fieldText}`;
      }).join(' ');
      haystacks.plugins = `${haystacks.plugins ?? ''} ${haystackText}`.toLowerCase();
      const pluginSubs: SubResult[] = installedPlugins.flatMap((p) => {
        const items: SubResult[] = [{ label: p.name, description: p.description }];
        if (p.settingsSchema) {
          for (const schema of Object.values(p.settingsSchema)) {
            items.push({
              label: schema.label,
              description: schema.description,
              pluginId: p.id,
            });
          }
        }
        return items;
      });
      subs.plugins = [...(subs.plugins ?? []), ...pluginSubs];
    }
    if (installedThemes.length) {
      const text = installedThemes.map((th) => `${th.name} ${th.description} ${th.author}`).join(' ');
      haystacks.themes = `${haystacks.themes ?? ''} ${text}`.toLowerCase();
      subs.themes = [
        ...(subs.themes ?? []),
        ...installedThemes.map((th) => ({ label: th.name, description: th.description })),
      ];
    }
    if (sidebarAppsList.length) {
      const text = sidebarAppsList.map((a) => `${a.name} ${a.url}`).join(' ');
      haystacks.sidebar_apps = `${haystacks.sidebar_apps ?? ''} ${text}`.toLowerCase();
      subs.sidebar_apps = [
        ...(subs.sidebar_apps ?? []),
        ...sidebarAppsList.map((a) => ({ label: a.name, description: a.url })),
      ];
    }
    return { tabSearchHaystacks: haystacks, tabSubResults: subs };
  }, [messages, installedPlugins, installedThemes, sidebarAppsList]);

  // Sidebar resize state
  const [settingsSidebarWidth, setSettingsSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem('settings-sidebar-width'); return v ? Number(v) : 256; } catch { return 256; }
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(256);

  // Check auth on mount – skip when already authenticated so that navigating
  // between routes doesn't retrigger checkAuth's transient `{ client: null,
  // isLoading: true }` reset, which was flashing the spinner on every nav.
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  // Listen for tab change events from child components (with legacy migration)
  useEffect(() => {
    const handler = (e: Event) => {
      const raw = (e as CustomEvent).detail as string;
      if (!raw) return;
      const tab = (LEGACY_TAB_MAP[raw] ?? raw) as Tab;
      setActiveTab(tab);
      try { localStorage.setItem('settings-active-tab', tab); } catch { /* ignore */ }
    };
    window.addEventListener('settings-tab-change', handler);
    return () => window.removeEventListener('settings-tab-change', handler);
  }, []);

  // Leaving the settings panel drops any shared-account scope so it never
  // leaks into the next visit or another session.
  useEffect(() => () => clearManagedAccount(), [clearManagedAccount]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  // Sync the mobile submenu view with browser history so the system back
  // button (or gesture) returns to the settings list before exiting /settings.
  useEffect(() => {
    if (isDesktop) return;
    if (typeof window === 'undefined') return;
    if (!mobileShowContent) return;

    window.history.pushState({ __settingsSubmenu: true }, '');

    const handlePop = () => {
      setMobileShowContent(false);
    };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, [isDesktop, mobileShowContent]);

  // After clicking a search sub-result, scroll the matching setting into view
  // and add a temporary highlight class. Some tabs fetch data and render
  // their SettingItems only after a loading state, so retry until the element
  // shows up (or we give up after ~2s).
  useEffect(() => {
    if (!pendingHighlight) return;
    if (pendingHighlight.tab !== activeTab) return;
    if (typeof window === 'undefined') return;

    // For plugin-setting sub-results, ask the plugins tab to expand the
    // matching card so the field becomes part of the DOM. Dispatched here
    // (not in the click handler) because PluginsSettings only mounts after
    // the tab switches, and its listener registers in its own useEffect -
    // child effects run before parent effects, so by the time we get here
    // the listener is guaranteed to be in place.
    if (pendingHighlight.pluginId) {
      window.dispatchEvent(
        new CustomEvent('settings-plugin-expand', { detail: { pluginId: pendingHighlight.pluginId } })
      );
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let highlightedEl: HTMLElement | null = null;

    const escaped = pendingHighlight.label.replace(/"/g, '\\"');
    const selector = `[data-search-label="${escaped}"]`;
    const deadline = Date.now() + 2000;

    const tryHighlight = () => {
      if (cancelled) return;
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) {
        if (Date.now() < deadline) {
          retryTimer = setTimeout(tryHighlight, 80);
        }
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Remove + reflow + add restarts the CSS animation if the class was
      // already present (re-clicking the same sub-result).
      el.classList.remove('settings-search-highlight');
      void el.offsetWidth;
      el.classList.add('settings-search-highlight');
      highlightedEl = el;
      cleanupTimer = setTimeout(() => {
        el.classList.remove('settings-search-highlight');
        highlightedEl = null;
      }, 1800);
    };

    // First attempt next frame so the freshly-mounted tab content is in DOM.
    const raf = window.requestAnimationFrame(tryHighlight);

    // Do NOT reset pendingHighlight here - that would retrigger this effect
    // and the cleanup below would strip the class right after we added it.
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      if (retryTimer) clearTimeout(retryTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (highlightedEl) highlightedEl.classList.remove('settings-search-highlight');
    };
  }, [pendingHighlight, activeTab]);

  if (!isAuthenticated) {
    return null;
  }

  const supportsVacation = client?.supportsVacationResponse() ?? false;
  const supportsCalendar = client?.supportsCalendars() ?? false;
  const supportsSieve = client?.supportsSieve() ?? false;
  const supportsFiles = client?.supportsFiles() ?? false;

  const tabs: TabDef[] = [
    // General
    { id: 'account', label: t('tabs.account'), icon: tabIcons.account, group: 'general' },
    { id: 'language', label: t('tabs.language'), icon: tabIcons.language, group: 'general' },
    { id: 'notifications', label: t('tabs.notifications'), icon: tabIcons.notifications, group: 'general' },
    { id: 'protocol_handlers', label: t('tabs.protocol_handlers'), icon: tabIcons.protocol_handlers, group: 'general' },

    // Appearance
    { id: 'appearance', label: t('tabs.appearance'), icon: tabIcons.appearance, group: 'appearance' },
    { id: 'layout', label: t('tabs.layout'), icon: tabIcons.layout, group: 'appearance' },
    ...(isFeatureEnabled('themesEnabled') ? [{ id: 'themes' as Tab, label: 'Themes', icon: tabIcons.themes, group: 'appearance' as TabGroup }] : []),

    // Mail
    { id: 'reading', label: t('tabs.reading'), icon: tabIcons.reading, group: 'mail' },
    { id: 'composing', label: t('tabs.composing'), icon: tabIcons.composing, group: 'mail' },
    { id: 'downloads', label: t('tabs.downloads'), icon: tabIcons.downloads, group: 'mail' },
    { id: 'identities', label: t('tabs.identities'), icon: tabIcons.identities, group: 'mail' },
    ...(supportsVacation ? [{ id: 'vacation' as Tab, label: t('tabs.vacation'), icon: tabIcons.vacation, group: 'mail' as TabGroup }] : []),
    ...(supportsSieve ? [{ id: 'filters' as Tab, label: t('tabs.filters'), icon: tabIcons.filters, group: 'mail' as TabGroup }] : []),
    ...(isFeatureEnabled('templatesEnabled') ? [{ id: 'templates' as Tab, label: t('tabs.templates'), icon: tabIcons.templates, group: 'mail' as TabGroup }] : []),
    { id: 'folders', label: t('tabs.folders'), icon: tabIcons.folders, group: 'mail' },
    ...(isFeatureEnabled('customKeywordsEnabled') ? [{ id: 'keywords' as Tab, label: t('tabs.keywords'), icon: tabIcons.keywords, group: 'mail' as TabGroup }] : []),

    // Privacy & Security
    ...(stalwartFeaturesEnabled ? [{ id: 'security' as Tab, label: t('tabs.security'), icon: tabIcons.security, group: 'privacy' as TabGroup }] : []),
    { id: 'content_senders', label: t('tabs.content_senders'), icon: tabIcons.content_senders, group: 'privacy' },

    // Apps
    ...(supportsCalendar && isFeatureEnabled('calendarEnabled') ? [{ id: 'calendar' as Tab, label: t('tabs.calendar'), icon: tabIcons.calendar, group: 'apps' as TabGroup }] : []),
    ...(isFeatureEnabled('contactsEnabled') ? [{ id: 'contacts' as Tab, label: t('tabs.contacts'), icon: tabIcons.contacts, group: 'apps' as TabGroup }] : []),
    ...(supportsFiles && isFeatureEnabled('filesEnabled') ? [{ id: 'files' as Tab, label: t('tabs.files'), icon: tabIcons.files, group: 'apps' as TabGroup }] : []),
    ...(isFeatureEnabled('sidebarAppsEnabled') ? [{ id: 'sidebar_apps' as Tab, label: t('tabs.sidebar_apps'), icon: tabIcons.sidebar_apps, group: 'apps' as TabGroup }] : []),

    // Advanced
    { id: 'about_data', label: t('tabs.about_data'), icon: tabIcons.about_data, group: 'advanced' },
    ...(isFeatureEnabled('pluginsEnabled') ? [{ id: 'plugins' as Tab, label: 'Plugins', icon: tabIcons.plugins, group: 'advanced' as TabGroup }] : []),
    ...(isFeatureEnabled('debugModeEnabled') ? [{ id: 'debug' as Tab, label: t('tabs.debug'), icon: tabIcons.debug, group: 'advanced' as TabGroup }] : []),
  ];

  // In scoped (shared-account) mode, restrict to the account-relevant tabs the
  // account actually advertises. Folders is intentionally excluded (mailbox CRUD
  // is hardwired to the active account). Gated on both the per-account
  // capability and the session-level support/feature flags.
  const scopedTabIds: Tab[] = managedAccount
    ? ([
        managedAccount.capabilities.sieve && supportsSieve ? 'filters' : null,
        managedAccount.capabilities.mail && supportsVacation ? 'vacation' : null,
        managedAccount.capabilities.calendars && supportsCalendar && isFeatureEnabled('calendarEnabled') ? 'calendar' : null,
        managedAccount.capabilities.contacts && isFeatureEnabled('contactsEnabled') ? 'contacts' : null,
      ].filter(Boolean) as Tab[])
    : [];
  const visibleTabs = managedAccountId
    ? tabs.filter((tab) => scopedTabIds.includes(tab.id))
    : tabs;

  // Group tabs by category
  const groupedTabs = tabGroupOrder
    .map((group) => ({
      group,
      label: t(`tab_groups.${group}`),
      items: visibleTabs.filter((tab) => tab.group === group),
    }))
    .filter((g) => g.items.length > 0);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = (tab: TabDef) => {
    if (!trimmedQuery) return true;
    if (tab.label.toLowerCase().includes(trimmedQuery)) return true;
    return tabSearchHaystacks[tab.id]?.includes(trimmedQuery) ?? false;
  };

  const subResultsForTab = (tabId: Tab): SubResult[] => {
    if (!trimmedQuery) return [];
    const list = tabSubResults[tabId] ?? [];
    return list
      .filter((r) =>
        r.label.toLowerCase().includes(trimmedQuery) ||
        (r.description?.toLowerCase().includes(trimmedQuery) ?? false)
      )
      .slice(0, 6);
  };

  const filteredGroupedTabs = trimmedQuery
    ? groupedTabs
        .map((g) => ({ ...g, items: g.items.filter(matchesQuery) }))
        .filter((g) => g.items.length > 0)
    : groupedTabs;

  // If active tab is not in the visible list (e.g., feature disabled, or scoped
  // mode hides it), fall back. In scoped mode fall back to the first scoped tab;
  // otherwise the usual 'appearance' default.
  const isActiveVisible = visibleTabs.some((tab) => tab.id === activeTab);
  const effectiveActiveTab: Tab = isActiveVisible
    ? activeTab
    : (managedAccountId ? (visibleTabs[0]?.id ?? 'appearance') : 'appearance');

  const handleTabSelect = (tabId: Tab) => {
    setActiveTab(tabId);
    try { localStorage.setItem('settings-active-tab', tabId); } catch { /* ignore */ }
    if (!isDesktop) {
      setMobileShowContent(true);
    }
  };

  const handleSubResultSelect = (tabId: Tab, sub: SubResult) => {
    handleTabSelect(tabId);
    setPendingHighlight({ tab: tabId, label: sub.label, pluginId: sub.pluginId });
  };

  const activeTabLabel = visibleTabs.find((tab) => tab.id === effectiveActiveTab)?.label ?? '';

  const renderTabContent = () => (
    <>
      {managedAccountId && managedAccount && (
        <button
          type="button"
          onClick={() => {
            clearManagedAccount();
            handleTabSelect('account');
          }}
          className="flex items-center gap-2 w-full mb-4 px-3 py-2 rounded-md border border-border bg-muted/40 hover:bg-muted text-start transition-colors"
        >
          <ArrowLeft className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <span className="text-sm text-muted-foreground">{t('scoped.back')}</span>
          <span className="ms-auto text-sm font-medium truncate">
            {t('scoped.managing', { name: managedAccount.name })}
          </span>
        </button>
      )}
      {effectiveActiveTab === 'account' && <AccountSettings />}
      {effectiveActiveTab === 'language' && <LanguageSettings />}
      {effectiveActiveTab === 'notifications' && <NotificationSettings />}
      {effectiveActiveTab === 'appearance' && <AppearanceSettings />}
      {effectiveActiveTab === 'layout' && <LayoutSettings />}
      {effectiveActiveTab === 'reading' && <ReadingSettings />}
      {effectiveActiveTab === 'composing' && <ComposingSettings />}
      {effectiveActiveTab === 'downloads' && <DownloadsSettings />}
      {effectiveActiveTab === 'identities' && <IdentitySettings />}
      {effectiveActiveTab === 'vacation' && <VacationSettings />}
      {effectiveActiveTab === 'filters' && <FilterSettings />}
      {effectiveActiveTab === 'templates' && <TemplateSettings />}
      {effectiveActiveTab === 'folders' && <FolderSettings />}
      {effectiveActiveTab === 'keywords' && <KeywordSettings />}
      {effectiveActiveTab === 'security' && <AccountSecuritySettings />}
      {effectiveActiveTab === 'content_senders' && <ContentSendersSettings />}
      {effectiveActiveTab === 'calendar' && (
        managedAccountId
          ? <CalendarManagementSettings />
          : <><CalendarSettings /><div className="mt-8"><CalendarManagementSettings /></div></>
      )}
      {effectiveActiveTab === 'contacts' && (
        managedAccountId
          ? <AddressBookManagementSettings />
          : <><ContactsSettings /><div className="mt-8"><AddressBookManagementSettings /></div></>
      )}
      {effectiveActiveTab === 'files' && <FilesSettingsComponent />}
      {effectiveActiveTab === 'protocol_handlers' && <ProtocolHandlerSettings supportsCalendar={supportsCalendar} />}
      {effectiveActiveTab === 'sidebar_apps' && <SidebarAppsSettings />}
      {effectiveActiveTab === 'about_data' && <AboutDataSettings />}
      {effectiveActiveTab === 'themes' && <ThemesSettings />}
      {effectiveActiveTab === 'plugins' && <PluginsSettings />}
      {effectiveActiveTab === 'debug' && <DebugSettings />}
    </>
  );

  // Mobile layout
  if (!isDesktop) {
    if (mobileShowContent) {
      return (
        <div className={cn("flex flex-col bg-background pt-[env(safe-area-inset-top)]", isEmbedded ? "h-full" : "h-dvh")}>
          <AppTopBannerSlot />
          <div className="flex items-center gap-2 px-4 h-14 border-b border-border bg-background shrink-0">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => window.history.back()}
              className="h-10 w-10"
            >
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="font-semibold text-lg truncate">{activeTabLabel}</h1>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {renderTabContent()}
          </div>

          {!isEmbedded && (
            <NavigationRail
              orientation="horizontal"
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
            />
          )}
          <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
        </div>
      );
    }

    return (
      <div className={cn("flex flex-col bg-background pt-[env(safe-area-inset-top)]", isEmbedded ? "h-full" : "h-dvh")}>
        <AppTopBannerSlot />
        <div className="flex items-center gap-2 px-4 h-14 border-b border-border bg-background shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/')}
            className="h-10 w-10"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-muted-foreground" />
            <h1 className="font-semibold text-lg">{t('title')}</h1>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 pt-3 pb-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('search_placeholder')}
                className="ps-9 pe-9 h-10"
                aria-label={t('search_placeholder')}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:bg-muted"
                  aria-label={t('search_clear')}
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          <div className="py-2">
            {filteredGroupedTabs.length === 0 && (
              <div className="px-5 py-6 text-sm text-muted-foreground text-center">
                {t('search_no_results')}
              </div>
            )}
            {filteredGroupedTabs.map((group, groupIndex) => (
              <div key={group.group}>
                {groupIndex > 0 && <div className="mx-5 my-2 border-t border-border" />}
                <div className="px-5 pt-3 pb-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                {group.items.map((tab) => {
                  const Icon = tab.icon;
                  const subs = subResultsForTab(tab.id);
                  return (
                    <div key={tab.id}>
                      <button
                        onClick={() => handleTabSelect(tab.id)}
                        className="w-full flex items-center justify-between px-5 py-3.5 text-sm text-foreground hover:bg-muted transition-colors duration-150"
                      >
                        <span className="flex items-center gap-3">
                          <Icon className="w-4 h-4 text-muted-foreground" />
                          {tab.label}
                        </span>
                        <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      </button>
                      {subs.map((sub) => (
                        <button
                          key={`${tab.id}:${sub.label}`}
                          onClick={() => handleSubResultSelect(tab.id, sub)}
                          className="w-full flex items-center ps-12 pe-5 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-150 text-start"
                        >
                          <span className="truncate">{sub.label}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="border-t border-border px-5 py-3">
            <button
              onClick={logout}
              className="w-full flex items-center gap-3 py-2.5 text-sm text-destructive hover:bg-muted rounded-md px-2 transition-colors duration-150"
            >
              <LogOut className="w-4 h-4" />
              <span>{tSidebar('sign_out')}</span>
            </button>
          </div>
        </div>

        {!isEmbedded && (
          <NavigationRail
            orientation="horizontal"
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        )}
        <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      </div>
    );
  }

  // Desktop layout
  return (
    <div className={cn("flex flex-col bg-background pt-[env(safe-area-inset-top)]", isEmbedded ? "h-full" : "h-dvh")}>
      <AppTopBannerSlot />
      <div className="flex flex-1 min-h-0">
      {!isEmbedded && (
        <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail
            collapsed
            quota={quota}
            isPushConnected={isPushConnected}
            onLogout={logout}
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        </div>
      )}

      {inlineApp && (
        <InlineAppView apps={loadedApps} activeAppId={inlineApp!.id} onClose={closeInlineApp} className="flex-1" />
      )}
      {!inlineApp && (
      <>
      <div
        className={cn(
          "border-e border-border bg-secondary flex flex-col",
          !isResizing && "transition-[width] duration-300"
        )}
        style={{ width: `${settingsSidebarWidth}px` }}
      >
        {!proInterface && (
          <div className="p-4 border-b border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push('/')}
              className="w-full justify-start"
            >
              <ArrowLeft className="w-4 h-4 me-2" />
              {t('back_to_mail')}
            </Button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2" data-tour="settings-tabs">
          <div className="px-3 pt-1 pb-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('search_placeholder')}
                className="ps-8 pe-8 h-9 text-sm"
                aria-label={t('search_placeholder')}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-muted-foreground hover:bg-muted"
                  aria-label={t('search_clear')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="px-2 space-y-0.5">
            {filteredGroupedTabs.length === 0 && (
              <div className="px-3 py-6 text-sm text-muted-foreground text-center">
                {t('search_no_results')}
              </div>
            )}
            {filteredGroupedTabs.map((group, groupIndex) => (
              <div key={group.group}>
                {groupIndex > 0 && <div className="mx-1 my-2 border-t border-border" />}
                <div className="px-3 pt-2.5 pb-1">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                {group.items.map((tab) => {
                  const Icon = tab.icon;
                  const subs = subResultsForTab(tab.id);
                  return (
                    <div key={tab.id}>
                      <button
                        onClick={() => handleTabSelect(tab.id)}
                        className={cn(
                          'w-full text-start px-3 py-2 rounded-md text-sm transition-colors duration-150 flex items-center gap-2.5',
                          effectiveActiveTab === tab.id
                            ? 'bg-accent text-accent-foreground font-medium'
                            : 'hover:bg-muted text-foreground'
                        )}
                      >
                        <Icon className={cn(
                          'w-4 h-4 shrink-0',
                          effectiveActiveTab === tab.id ? 'text-accent-foreground' : 'text-muted-foreground'
                        )} />
                        {tab.label}
                      </button>
                      {subs.map((sub) => (
                        <button
                          key={`${tab.id}:${sub.label}`}
                          onClick={() => handleSubResultSelect(tab.id, sub)}
                          className="w-full text-start ps-9 pe-3 py-1.5 rounded-md text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-150"
                        >
                          <span className="truncate block">{sub.label}</span>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <ResizeHandle
        onResizeStart={() => { dragStartWidth.current = settingsSidebarWidth; setIsResizing(true); }}
        onResize={(delta) => setSettingsSidebarWidth(Math.max(180, Math.min(400, dragStartWidth.current + delta)))}
        onResizeEnd={() => {
          setIsResizing(false);
          localStorage.setItem('settings-sidebar-width', String(settingsSidebarWidth));
        }}
        onDoubleClick={() => { setSettingsSidebarWidth(256); localStorage.setItem('settings-sidebar-width', '256'); }}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {renderTabContent()}
        </div>
      </div>
      </>
      )}
      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      </div>
    </div>
  );
}
