"use client";

import { useState, useEffect, useCallback, useRef, useMemo, useSyncExternalStore } from 'react';
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
  PalmtreeIcon,
  Calendar,
  Filter,
  FolderOpen,
  HardDrive,
  BookUser,
  Bell,
  Puzzle,
  BookOpen,
  PenLine,
  LayoutList,
  Database,
  X,
  type AppIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppearanceSettings } from '@/components/settings/appearance-settings';
import { AppTopBannerSlot } from '@/components/plugins/app-top-banner-slot';
import { GeneralSettings } from '@/components/settings/general-settings';
import { ReadingSettings } from '@/components/settings/reading-settings';
import { MessageListSettings } from '@/components/settings/message-list-settings';
import { ComposingSettings } from '@/components/settings/composing-settings';
import { AccountSettings } from '@/components/settings/account-settings';
import { VacationSettings } from '@/components/settings/vacation-settings';
import { CalendarSettings } from '@/components/settings/calendar-settings';
import { CalendarManagementSettings } from '@/components/settings/calendar-management-settings';
import { AddressBookManagementSettings } from '@/components/settings/address-book-management-settings';
import { FilterSettings } from '@/components/settings/filter-settings';
import { AboutDataSettings, AboutFooter } from '@/components/settings/about-data-settings';
import { OrganizeSettings } from '@/components/settings/organize-settings';
import { AccountSecuritySettings } from '@/components/settings/account-security-settings';
import { FilesSettingsComponent } from '@/components/settings/files-settings';
import { ContactsSettings } from '@/components/settings/contacts-settings';
import { AddonsSettings } from '@/components/settings/addons-settings';
import { NotificationSettings } from '@/components/settings/notification-settings';
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { offersForSlot as pluginOffersForSlot, subscribe as pluginRegistrySubscribe, get as getActivePlugin } from '@/lib/plugin-sandbox/registry';
import { AdvancedSettingsProvider, AdvancedSettingsSwitch, SectionNav, scrollToSettingsSection } from '@/components/settings/settings-section';
import { appPath, buildSettingsPath, parseSettingsPath, parseSettingsSection } from '@/lib/deep-links';
import { consumePendingDeepLink, subscribePendingDeepLink } from '@/lib/deep-link-handoff';
import { useDeepLinkUrl } from '@/hooks/use-deep-link-url';
import { useProInterfaceActive } from '@/components/pro/pro-interface-redirect';
import { useAuthStore, redirectToLogin, saveRedirectAfterLogin } from '@/stores/auth-store';
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
import { useResolvedSidebarApps } from '@/hooks/use-resolved-sidebar-apps';
import { useIsEmbedded } from '@/hooks/use-is-embedded';
import { useIsFocusedProTab } from '@/hooks/use-pane-context';
import { ResizeHandle } from '@/components/layout/resize-handle';
import { useConfig } from '@/hooks/use-config';
import { usePolicyStore } from '@/stores/policy-store';
import { cn } from '@/lib/utils';
import {
  type SettingsSearchTab,
  type SubResult,
  collectSubResults,
  flattenStrings,
  getByPath,
  tabKeywords,
  tabSearchPaths,
  archiveActionSearchPaths,
} from '@/lib/settings-search';
import { useLiteLinkSegments } from '@/hooks/use-lite-link-segments';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { MvTopBar } from "@/components/layout/mv-top-bar";
import { useMountainViewShell } from "@/hooks/use-mountain-view-shell";

type Tab = SettingsSearchTab;

// `top` and `bottom` have no heading: the first five pages, and Backup & reset
// after a rule at the end.
type TabGroup = 'top' | 'mail' | 'apps' | 'bottom';

// A plugin that exposes a `settings-section` slot gets its own first-class
// Settings entry, keyed `plugin:<id>`, so its UI (e.g. S/MIME key import) is
// discoverable as a menu point rather than buried inside another panel.
type PluginTabId = `plugin:${string}`;
// A plugin that offers a `settings-page` slot gets a page of its own under the
// "Plugins" group, keyed `plugin-page:<id>`, drawn at the full content width.
type PluginPageTabId = `plugin-page:${string}`;
type SettingsTabId = Tab | PluginTabId | PluginPageTabId;
const PLUGIN_PAGE_PREFIX = 'plugin-page:';

interface TabDef {
  id: SettingsTabId;
  label: string;
  icon: AppIcon;
  group: TabGroup;
  /** Indented under the entry before it (plugin pages under Add-ons). */
  sub?: boolean;
}

const tabIcons: Record<Tab, AppIcon> = {
  account: User,
  general: SettingsIcon,
  notifications: Bell,
  appearance: Palette,
  message_list: LayoutList,
  reading: BookOpen,
  composing: PenLine,
  vacation: PalmtreeIcon,
  filters: Filter,
  organize: FolderOpen,
  security: Shield,
  calendar: Calendar,
  contacts: BookUser,
  files: HardDrive,
  addons: Puzzle,
  backup: Database,
};

const tabGroupOrder: TabGroup[] = ['top', 'mail', 'apps', 'bottom'];

// Map legacy tab IDs to current ones; runs once on read of localStorage and
// for every deep link, so old bookmarks, connector links and sidebar gears
// land on the page that now holds the setting.
export const LEGACY_TAB_MAP: Record<string, Tab> = {
  email: 'reading',
  advanced: 'backup',
  layout: 'appearance',
  themes: 'appearance',
  content_senders: 'reading',
  identities: 'account',
  language: 'general',
  protocol_handlers: 'general',
  templates: 'composing',
  folders: 'organize',
  keywords: 'organize',
  downloads: 'reading',
  sidebar_apps: 'addons',
  plugins: 'addons',
  about_data: 'backup',
  debug: 'backup',
};

// Where on the new page a legacy tab's settings now sit, so an old link
// lands on that section rather than at the top of the page.
const LEGACY_SECTION_MAP: Record<string, string> = {
  layout: 'layout',
  themes: 'theme',
  content_senders: 'images',
  identities: 'addresses',
  language: 'language',
  protocol_handlers: 'links',
  templates: 'templates',
  folders: 'folders',
  keywords: 'tags',
  downloads: 'downloads',
  sidebar_apps: 'sidebar-apps',
  plugins: 'plugins',
  about_data: 'backup',
  debug: 'debug',
};

/** A tab and, optionally, the section of it a link or event names. */
interface SettingsTarget {
  tab: SettingsTabId;
  section: string | null;
}

/**
 * Migrates a legacy tab id to the page and section that hold it now. An
 * explicit section wins over the legacy one.
 */
function migrateTarget(raw: string, section: string | null = null): { tab: string; section: string | null } {
  const tab = raw in LEGACY_TAB_MAP ? LEGACY_TAB_MAP[raw] : raw;
  return { tab, section: section ?? (raw in LEGACY_SECTION_MAP ? LEGACY_SECTION_MAP[raw] : null) };
}

function readPersistedTab(): SettingsTabId {
  try {
    // One-shot deep link from the sidebar section gears (Folders / Tags).
    // Used only as the initial tab and intentionally NOT written to
    // 'settings-active-tab', so a gear click never becomes the persisted
    // default that the regular Settings button lands on. Cleared on mount.
    const deepLink = sessionStorage.getItem('settings-deep-link-tab');
    if (deepLink) {
      return (deepLink in LEGACY_TAB_MAP ? LEGACY_TAB_MAP[deepLink] : deepLink) as SettingsTabId;
    }
    const saved = localStorage.getItem('settings-active-tab');
    if (!saved) return 'appearance';
    if (saved in LEGACY_TAB_MAP) {
      const migrated = LEGACY_TAB_MAP[saved];
      try { localStorage.setItem('settings-active-tab', migrated); } catch { /* ignore */ }
      return migrated;
    }
    return saved as SettingsTabId;
  } catch {
    return 'appearance';
  }
}

/**
 * The tab a `/settings/<tab>` deep link names (#733), or null when the URL
 * names nothing we recognise - an old link to a tab that has since been
 * renamed falls back to the persisted tab rather than rendering an empty pane.
 * Legacy ids are migrated the same way the stored value is.
 */
function targetFromDeepLink(segments: string[] | null | undefined): SettingsTarget | null {
  const raw = parseSettingsPath(segments ?? []);
  if (!raw) return null;
  const { tab, section } = migrateTarget(raw, parseSettingsSection(segments ?? []));
  if (tab in tabIcons || tab.startsWith('plugin:') || tab.startsWith(PLUGIN_PAGE_PREFIX)) {
    return { tab: tab as SettingsTabId, section };
  }
  return null;
}

// Toggling the Pro interface remounts the whole settings surface (enabling
// replaces the route with /pro, which hosts its own SettingsApp; disabling
// leaves /pro through a full page load back to /settings). The active tab
// survives via localStorage, but the content pane's scroll offset would not -
// and the toggle itself sits at the bottom of a long tab, so the user would
// land back at the top of the page they were just on. Module scope covers the
// client-side navigation; sessionStorage carries the offset across the full
// page load, with a TTL so a stray unconsumed entry can't scroll a visit
// minutes later.
let parkedContentScroll: { tab: SettingsTabId; top: number; ts: number } | null = null;
const SCROLL_RESTORE_KEY = 'settings-scroll-restore';

export interface SettingsAppProps {
  /** Path segments after `/settings` - `['<tabId>']`. */
  linkSegments?: string[];
}

export function SettingsApp({ linkSegments: routeSegments }: SettingsAppProps = {}) {
  // Static Lite build: the route params are empty, read the link from the URL.
  const linkSegments = useLiteLinkSegments('settings', routeSegments);
  const router = useRouter();
  const t = useTranslations('settings');
  const tSidebar = useTranslations('sidebar');
  useDocumentTitle(tSidebar('settings'));
  const { client, isAuthenticated, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const isEmbedded = useIsEmbedded();
  // Mountain View's desktop chrome: its top bar in place of the left rail.
  const mvShell = useMountainViewShell(isEmbedded);
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const { stalwartFeaturesEnabled } = useConfig();
  const { isFeatureEnabled } = usePolicyStore();
  const archiveActionEnabled = isFeatureEnabled('archiveActionEnabled');
  // A tab in the URL wins over the persisted one; without it, nothing changes.
  const [activeTab, setActiveTab] = useState<SettingsTabId>(
    () => targetFromDeepLink(linkSegments)?.tab ?? readPersistedTab(),
  );
  // The section a link or event asked for; scrolled to once the page shows it.
  const [pendingSection, setPendingSection] = useState<{ tab: SettingsTabId; id: string } | null>(() => {
    const target = targetFromDeepLink(linkSegments);
    return target?.section ? { tab: target.tab, id: target.section } : null;
  });
  const goTo = useCallback((target: SettingsTarget) => {
    setActiveTab(target.tab);
    setPendingSection(target.section ? { tab: target.tab, id: target.section } : null);
  }, []);
  // Active plugins that expose a `settings-section` slot — each becomes its own
  // Settings menu entry. Referentially stable per registry mutation, so it is
  // safe to feed useSyncExternalStore directly.
  const pluginSettingsOffers = useSyncExternalStore(
    pluginRegistrySubscribe,
    () => pluginOffersForSlot('settings-section'),
    () => pluginOffersForSlot('settings-section'),
  );
  // Active plugins that offer a `settings-page` slot: one page each.
  const pluginPageOffers = useSyncExternalStore(
    pluginRegistrySubscribe,
    () => pluginOffersForSlot('settings-page'),
    () => pluginOffersForSlot('settings-page'),
  );
  const pluginPageIds = useMemo(() => new Set(pluginPageOffers.map((offer) => offer.pluginId)), [pluginPageOffers]);
  const pluginSectionIds = useMemo(() => new Set(pluginSettingsOffers.map((offer) => offer.pluginId)), [pluginSettingsOffers]);
  // Consume the one-shot deep-link key so a section gear only steers this one
  // open, never the persisted default for future Settings-button clicks.
  useEffect(() => {
    try { sessionStorage.removeItem('settings-deep-link-tab'); } catch { /* ignore */ }
  }, []);
  // Inside the Pro shell there is no route to read the tab from, so it arrives
  // through the handoff the redirect parked (#733).
  useEffect(() => {
    if (linkSegments) return;
    const target = targetFromDeepLink(consumePendingDeepLink('settings'));
    if (target) goTo(target);
  }, [linkSegments, goTo]);
  // Pro shell only: this surface stays mounted for the whole session, so links
  // arriving later (e.g. the sidebar's folder-settings gear) are delivered
  // live instead of being parked for a mount that already happened.
  useEffect(() => {
    if (!isEmbedded) return;
    return subscribePendingDeepLink('settings', (segments) => {
      const target = targetFromDeepLink(segments);
      if (target) goTo(target);
    });
  }, [isEmbedded, goTo]);
  const [mobileShowContent, setMobileShowContent] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingHighlight, setPendingHighlight] = useState<{ tab: SettingsTabId; label: string; pluginId?: string } | null>(null);
  const isDesktop = useIsDesktop();

  const messages = useMessages() as Record<string, unknown>;
  const installedPlugins = usePluginStore((s) => s.plugins);
  const installedThemes = useThemeStore((s) => s.installedThemes);
  // Admin-pinned apps are searchable too - users can't add them, but they're listed.
  const sidebarAppsList = useResolvedSidebarApps();
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
        if (!archiveActionEnabled && archiveActionSearchPaths.has(path)) continue;
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
      haystacks.addons = `${haystacks.addons ?? ''} ${haystackText}`.toLowerCase();
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
      subs.addons = [...(subs.addons ?? []), ...pluginSubs];
    }
    // Themes are a section of Appearance now, so installed themes match there.
    if (installedThemes.length) {
      const text = installedThemes.map((th) => `${th.name} ${th.description} ${th.author}`).join(' ');
      haystacks.appearance = `${haystacks.appearance ?? ''} ${text}`.toLowerCase();
      subs.appearance = [
        ...(subs.appearance ?? []),
        ...installedThemes.map((th) => ({ label: th.name, description: th.description })),
      ];
    }
    if (sidebarAppsList.length) {
      const text = sidebarAppsList.map((a) => `${a.name} ${a.url}`).join(' ');
      haystacks.addons = `${haystacks.addons ?? ''} ${text}`.toLowerCase();
      subs.addons = [
        ...(subs.addons ?? []),
        ...sidebarAppsList.map((a) => ({ label: a.name, description: a.url })),
      ];
    }
    return { tabSearchHaystacks: haystacks, tabSubResults: subs };
  }, [messages, installedPlugins, installedThemes, sidebarAppsList, archiveActionEnabled]);

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

  // Listen for tab change events from child components (with legacy
  // migration). The detail is a tab id, or `{ tab, section }` to land on one
  // section of the page.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as string | { tab?: string; section?: string } | null;
      const raw = typeof detail === 'string' ? detail : detail?.tab;
      if (!raw) return;
      const { tab, section } = migrateTarget(raw, typeof detail === 'object' && detail?.section ? detail.section : null);
      goTo({ tab: tab as SettingsTabId, section });
      try { localStorage.setItem('settings-active-tab', tab); } catch { /* ignore */ }
    };
    window.addEventListener('settings-tab-change', handler);
    return () => window.removeEventListener('settings-tab-change', handler);
  }, [goTo]);

  // Scroll to the section a link or event asked for once the page has it.
  // Pages fetch and render their sections after a loading state, so retry;
  // an advanced section stays hidden until the switch is on, so after a
  // short wait turn it on rather than give up.
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  useEffect(() => {
    if (!pendingSection || pendingSection.tab !== activeTab) return;
    if (typeof window === 'undefined') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const deadline = started + 2000;
    const attempt = () => {
      if (cancelled) return;
      if (scrollToSettingsSection(pendingSection.id)) { setPendingSection(null); return; }
      if (Date.now() - started > 400 && !useSettingsStore.getState().showAdvancedSettings) {
        updateSetting('showAdvancedSettings', true);
      }
      if (Date.now() < deadline) timer = setTimeout(attempt, 80);
      else setPendingSection(null);
    };
    const raf = window.requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [pendingSection, activeTab, updateSetting]);

  // Leaving the settings panel drops any shared-account scope so it never
  // leaks into the next visit or another session.
  useEffect(() => () => clearManagedAccount(), [clearManagedAccount]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      saveRedirectAfterLogin();
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
    // Collapsed lists (the theme gallery) open when the result is inside them.
    window.dispatchEvent(new CustomEvent('settings-reveal', { detail: { label: pendingHighlight.label } }));

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
        // The row may be an advanced one the switch hides: reveal, then keep looking.
        if (Date.now() > deadline - 1600 && !useSettingsStore.getState().showAdvancedSettings) {
          useSettingsStore.getState().updateSetting('showAdvancedSettings', true);
        }
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

  // The permalink for the open tab (#733). Suppressed inside the Pro shell,
  // where /pro owns the address bar. On mobile the tab list is its own screen,
  // so the tab is only in the URL once the user is looking at its content.
  // Must sit above the early return below - it is a hook.
  const proInterfaceActive = useProInterfaceActive();
  const isFocusedProTab = useIsFocusedProTab();
  const settingsLinkPath = appPath(buildSettingsPath(!isDesktop && !mobileShowContent ? null : activeTab));
  useDeepLinkUrl(
    !isAuthenticated
      ? null
      : isEmbedded
        ? (isFocusedProTab ? settingsLinkPath : null)
        : proInterfaceActive ? null : settingsLinkPath,
  );

  // Park the content-pane scroll offset when the Pro toggle flips (the flip
  // remounts this component - see parkedContentScroll above). The ref only
  // exists in the desktop layout, which is also the only place the remount
  // can happen - on mobile `el` stays null and nothing is parked.
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const prevProInterface = useRef(proInterface);
  useEffect(() => {
    if (prevProInterface.current === proInterface) return;
    prevProInterface.current = proInterface;
    const el = contentScrollRef.current;
    if (!el) return;
    parkedContentScroll = { tab: activeTab, top: el.scrollTop, ts: Date.now() };
    try { sessionStorage.setItem(SCROLL_RESTORE_KEY, JSON.stringify(parkedContentScroll)); } catch { /* ignore */ }
  }, [proInterface, activeTab]);
  // Restore when the container mounts. A callback ref rather than a mount
  // effect: after the Pro-off reload this component first renders without the
  // container (auth check pending), so a mount-time effect would consume the
  // parked offset before there is anything to scroll.
  const attachContentScroll = useCallback((el: HTMLDivElement | null) => {
    contentScrollRef.current = el;
    if (!el) return;
    let parked = parkedContentScroll;
    parkedContentScroll = null;
    try {
      const raw = sessionStorage.getItem(SCROLL_RESTORE_KEY);
      if (raw) {
        sessionStorage.removeItem(SCROLL_RESTORE_KEY);
        parked = parked ?? (JSON.parse(raw) as NonNullable<typeof parkedContentScroll>);
      }
    } catch { /* ignore */ }
    if (parked && parked.tab === activeTab && Date.now() - parked.ts < 60_000) {
      el.scrollTop = parked.top;
    }
  }, [activeTab]);

  if (!isAuthenticated) {
    return null;
  }

  const supportsVacation = client?.supportsVacationResponse() ?? false;
  const supportsCalendar = client?.supportsCalendars() ?? false;
  const supportsSieve = client?.supportsSieve() ?? false;
  const supportsFiles = client?.supportsFiles() ?? false;

  const tabs: TabDef[] = [
    // You and the app
    { id: 'account', label: t('tabs.account'), icon: tabIcons.account, group: 'top' },
    ...(stalwartFeaturesEnabled ? [{ id: 'security' as Tab, label: t('tabs.security'), icon: tabIcons.security, group: 'top' as TabGroup }] : []),
    { id: 'notifications', label: t('tabs.notifications'), icon: tabIcons.notifications, group: 'top' },
    { id: 'general', label: t('tabs.general'), icon: tabIcons.general, group: 'top' },
    { id: 'appearance', label: t('tabs.appearance'), icon: tabIcons.appearance, group: 'top' },

    // Mail
    { id: 'message_list', label: t('tabs.message_list'), icon: tabIcons.message_list, group: 'mail' },
    { id: 'reading', label: t('tabs.reading'), icon: tabIcons.reading, group: 'mail' },
    { id: 'composing', label: t('tabs.composing'), icon: tabIcons.composing, group: 'mail' },
    { id: 'organize', label: isFeatureEnabled('customKeywordsEnabled') ? t('tabs.organize') : t('tabs.folders'), icon: tabIcons.organize, group: 'mail' },
    ...(supportsSieve ? [{ id: 'filters' as Tab, label: t('tabs.filters'), icon: tabIcons.filters, group: 'mail' as TabGroup }] : []),
    ...(supportsVacation ? [{ id: 'vacation' as Tab, label: t('tabs.vacation'), icon: tabIcons.vacation, group: 'mail' as TabGroup }] : []),

    // Apps
    ...(supportsCalendar && isFeatureEnabled('calendarEnabled') ? [{ id: 'calendar' as Tab, label: t('tabs.calendar'), icon: tabIcons.calendar, group: 'apps' as TabGroup }] : []),
    ...(isFeatureEnabled('contactsEnabled') ? [{ id: 'contacts' as Tab, label: t('tabs.contacts'), icon: tabIcons.contacts, group: 'apps' as TabGroup }] : []),
    ...(supportsFiles && isFeatureEnabled('filesEnabled') ? [{ id: 'files' as Tab, label: t('tabs.files'), icon: tabIcons.files, group: 'apps' as TabGroup }] : []),
    ...(isFeatureEnabled('sidebarAppsEnabled') || isFeatureEnabled('pluginsEnabled') ? [{ id: 'addons' as Tab, label: t('tabs.addons'), icon: tabIcons.addons, group: 'apps' as TabGroup }] : []),
    // Plugin-contributed pages nest under Add-ons: a page of its own for each
    // plugin that offers one, and an entry for each plugin that offers only a
    // `settings-section` slot (e.g. S/MIME key & certificate manager). A plugin
    // with both gets the page entry only, with the section on its page.
    ...pluginPageOffers.map((offer): TabDef => ({
      id: `${PLUGIN_PAGE_PREFIX}${offer.pluginId}` as PluginPageTabId,
      label: getActivePlugin(offer.pluginId)?.plugin.name || offer.pluginId,
      icon: Puzzle,
      group: 'apps',
      sub: true,
    })),
    ...pluginSettingsOffers.filter((offer) => !pluginPageIds.has(offer.pluginId)).map((offer): TabDef => ({
      id: `plugin:${offer.pluginId}` as PluginTabId,
      label: getActivePlugin(offer.pluginId)?.plugin.name ?? offer.pluginId,
      icon: Puzzle,
      group: 'apps',
      sub: true,
    })),

    // After a rule at the end, with no heading.
    { id: 'backup', label: t('tabs.backup'), icon: tabIcons.backup, group: 'bottom' },
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
    ? tabs.filter((tab) => scopedTabIds.includes(tab.id as Tab))
    : tabs;

  // Group tabs by category. Only Mail and Apps carry a heading.
  const groupedTabs = tabGroupOrder
    .map((group) => ({
      group,
      label: group === 'mail' || group === 'apps' ? t(`tab_groups.${group}`) : null,
      items: visibleTabs.filter((tab) => tab.group === group),
    }))
    .filter((g) => g.items.length > 0);

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = (tab: TabDef) => {
    if (!trimmedQuery) return true;
    if (tab.label.toLowerCase().includes(trimmedQuery)) return true;
    return tabSearchHaystacks[tab.id as Tab]?.includes(trimmedQuery) ?? false;
  };

  const subResultsForTab = (tabId: SettingsTabId): SubResult[] => {
    if (!trimmedQuery) return [];
    const list = tabSubResults[tabId as Tab] ?? [];
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
  // An old link or remembered tab to the section of a plugin that now has a
  // page of its own opens that page, where the section is.
  const sectionPluginId = activeTab.startsWith('plugin:') ? activeTab.slice('plugin:'.length) : null;
  const requestedTab: SettingsTabId = sectionPluginId && pluginPageIds.has(sectionPluginId)
    ? (`${PLUGIN_PAGE_PREFIX}${sectionPluginId}` as PluginPageTabId)
    : activeTab;
  const isActiveVisible = visibleTabs.some((tab) => tab.id === requestedTab);
  const effectiveActiveTab: SettingsTabId = isActiveVisible
    ? requestedTab
    : (managedAccountId ? (visibleTabs[0]?.id ?? 'appearance') : 'appearance');

  const handleTabSelect = (tabId: SettingsTabId) => {
    setActiveTab(tabId);
    setPendingSection(null);
    try { localStorage.setItem('settings-active-tab', tabId); } catch { /* ignore */ }
    if (!isDesktop) {
      setMobileShowContent(true);
    }
  };

  const handleSubResultSelect = (tabId: SettingsTabId, sub: SubResult) => {
    handleTabSelect(tabId);
    setPendingHighlight({ tab: tabId, label: sub.label, pluginId: sub.pluginId });
  };

  const activeTabLabel = visibleTabs.find((tab) => tab.id === effectiveActiveTab)?.label ?? '';

  const renderTabContent = () => (
    <AdvancedSettingsProvider key={effectiveActiveTab}>
      <SectionNav />
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
      {effectiveActiveTab === 'general' && <GeneralSettings supportsCalendar={supportsCalendar} />}
      {effectiveActiveTab === 'notifications' && <NotificationSettings />}
      {effectiveActiveTab === 'appearance' && <AppearanceSettings />}
      {effectiveActiveTab === 'message_list' && <MessageListSettings />}
      {effectiveActiveTab === 'reading' && <ReadingSettings />}
      {effectiveActiveTab === 'composing' && <ComposingSettings />}
      {effectiveActiveTab === 'vacation' && <VacationSettings />}
      {effectiveActiveTab === 'filters' && <FilterSettings />}
      {effectiveActiveTab === 'organize' && <OrganizeSettings />}
      {effectiveActiveTab === 'security' && <AccountSecuritySettings />}
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
      {effectiveActiveTab === 'addons' && <AddonsSettings />}
      {effectiveActiveTab === 'backup' && <AboutDataSettings />}
      {effectiveActiveTab.startsWith('plugin:') && (
        <PluginIframeSlot
          key={effectiveActiveTab}
          pluginId={effectiveActiveTab.slice('plugin:'.length)}
          slot="settings-section"
        />
      )}
      {effectiveActiveTab.startsWith(PLUGIN_PAGE_PREFIX) && (
        <>
          {/* The plugin's settings-section, on its page rather than as a
              second entry with the same name. */}
          {pluginSectionIds.has(effectiveActiveTab.slice(PLUGIN_PAGE_PREFIX.length)) && (
            <div className="max-w-3xl mb-6" data-plugin-slot="settings-section">
              <PluginIframeSlot
                key={`${effectiveActiveTab}:section`}
                pluginId={effectiveActiveTab.slice(PLUGIN_PAGE_PREFIX.length)}
                slot="settings-section"
              />
            </div>
          )}
          <div className="w-full" data-plugin-slot="settings-page">
            <PluginIframeSlot
              key={effectiveActiveTab}
              pluginId={effectiveActiveTab.slice(PLUGIN_PAGE_PREFIX.length)}
              slot="settings-page"
            />
          </div>
        </>
      )}
    </AdvancedSettingsProvider>
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
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('search_placeholder')}
                className={cn("ps-9 h-9 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none", searchQuery && "pe-8")}
                aria-label={t('search_placeholder')}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute end-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
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
                {group.label && (
                  <div className="px-5 pt-3 pb-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </span>
                  </div>
                )}
                {group.items.map((tab) => {
                  const Icon = tab.icon;
                  const subs = subResultsForTab(tab.id);
                  return (
                    <div key={tab.id}>
                      <button
                        data-testid={`settings-tab-${tab.id}`}
                        onClick={() => handleTabSelect(tab.id)}
                        className={cn(
                          'w-full flex items-center justify-between py-3.5 pe-5 text-sm text-foreground hover:bg-muted transition-colors duration-150',
                          tab.sub ? 'ps-12' : 'ps-5',
                        )}
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

          <div className="border-t border-border px-2 py-2">
            <AdvancedSettingsSwitch />
            <AboutFooter />
          </div>
          <div className="border-t border-border px-5 py-3">
            <button
              onClick={() => logout()}
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
    <div data-app-shell="" className={cn("flex flex-col pt-[env(safe-area-inset-top)]", mvShell ? "bg-[var(--mv-canvas)]" : "bg-background", isEmbedded ? "h-full" : "h-dvh")}>
      <AppTopBannerSlot />
      {mvShell && (
        <MvTopBar
          showMenuButton={false}
          onManageApps={handleManageApps}
          onInlineApp={handleInlineApp}
          onCloseInlineApp={closeInlineApp}
          activeAppId={inlineApp?.id ?? null}
        />
      )}
      <div data-mv-card={mvShell ? "" : undefined} className={cn("flex flex-1 min-h-0", mvShell && "mb-4 mx-4")}>
      {!isEmbedded && !mvShell && (
        <div data-app-rail="" className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
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
        data-app-sidebar=""
        className={cn(
          "border-e border-border bg-secondary flex flex-col",
          !isResizing && "transition-[width] duration-300"
        )}
        style={{ width: `${settingsSidebarWidth}px` }}
      >
        {!proInterface && (
          // Same h-14 box as the mail sidebar's account switcher, so the apps line up.
          <div className="border-b border-border">
            <div className="flex items-center h-14 px-2">
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
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-2" data-tour="settings-tabs">
          <div className="px-3 pt-1 pb-1">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('search_placeholder')}
                className={cn("ps-9 h-9 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none", searchQuery && "pe-8")}
                aria-label={t('search_placeholder')}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute end-2 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={t('search_clear')}
                >
                  <X className="w-4 h-4" />
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
                {group.label && (
                  <div className="px-3 pt-2.5 pb-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </span>
                  </div>
                )}
                {group.items.map((tab) => {
                  const Icon = tab.icon;
                  const subs = subResultsForTab(tab.id);
                  return (
                    <div key={tab.id}>
                      <button
                        data-testid={`settings-tab-${tab.id}`}
                        aria-current={effectiveActiveTab === tab.id ? 'page' : undefined}
                        onClick={() => handleTabSelect(tab.id)}
                        className={cn(
                          'w-full text-start py-2 pe-3 rounded-md text-sm transition-colors duration-150 flex items-center gap-2.5',
                          tab.sub ? 'ps-9' : 'ps-3',
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
        <div className="border-t border-border px-1 py-1">
          <AdvancedSettingsSwitch />
          <AboutFooter />
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

      <div ref={attachContentScroll} className="flex-1 overflow-y-auto">
        <div className={effectiveActiveTab.startsWith(PLUGIN_PAGE_PREFIX) ? "px-6 py-6" : "max-w-3xl mx-auto px-6 py-6"}>
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
