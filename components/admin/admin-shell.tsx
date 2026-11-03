'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ChevronRight, KeyRound, LogOut, Search, Shield, X } from '@/components/icons';
import { Input } from '@/components/ui/input';
import { NavigationRail } from '@/components/layout/navigation-rail';
import { AboutFooter } from '@/components/settings/about-data-settings';
import { scrollToSettingsSection } from '@/components/settings/settings-section';
import { useIsDesktop } from '@/hooks/use-media-query';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useAdminLocation, navigateAdmin } from '@/hooks/use-admin-navigation';
import { useUpdateStore, selectHasUpdate } from '@/stores/update-store';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';
import { apiFetch, getPathPrefix } from '@/lib/browser-navigation';
import { ADMIN_PAGES, adminPath, type AdminPageDef, type AdminPageId, type AdminSectionDef } from '@/lib/admin/admin-nav';
import { AdminSessionLinksSkeleton, AdminSkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { useSkeletonLabels } from '@/components/boot-skeleton/use-skeleton-labels';
import { ADMIN_GROUPS, ADMIN_GROUP_LABELS, ADMIN_PAGE_ICONS as PAGE_ICONS } from './admin-page-icons';
import { cn } from '@/lib/utils';
import { AdminLink } from './admin-link';
import { AdminShellContext } from './shell-context';

interface AdminShellProps {
  /** Whether the admin session is in place; the sidebar counts load then. */
  authenticated: boolean;
  /** Stalwart admins signed in automatically have no password to change. */
  isStalwartAutoLogin: boolean;
  configReadOnly: boolean;
  onLogout: () => void;
  children: ReactNode;
}

interface Match {
  page: AdminPageDef;
  sections: AdminSectionDef[];
}

const subscribeNothing = () => () => {};

/**
 * The admin panel's frame: the webmail's own navigation rail, the page list
 * laid out like the settings sidebar (search included), the content column
 * and, on phones, the settings' list-then-page flow.
 */
export function AdminShell({ authenticated, isStalwartAutoLogin, configReadOnly, onLogout, children }: AdminShellProps) {
  const pathname = usePathname();
  const tShell = useTranslations('shell');
  const tSettings = useTranslations('settings');
  const tSidebar = useTranslations('sidebar');
  const location = useAdminLocation();
  const { label: loadingLabel, labels: railLabels } = useSkeletonLabels();
  const isDesktop = useIsDesktop();
  // The server can't know the window width, so its HTML would be the phone
  // layout, shown on desktop until hydration swaps it (the rail's Admin link
  // is a full page load).
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const requestLeave = useAdminUnsavedStore((s) => s.requestLeave);
  const [query, setQuery] = useState('');
  const [saveBarHost, setSaveBarHost] = useState<HTMLElement | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [pendingSection, setPendingSection] = useState<{ page: AdminPageId; id: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  // The two layouts are different trees, so a page drawn inside them would be
  // remounted when the window crosses the breakpoint (a tablet turned round)
  // and lose what the admin had typed. It lives in one element instead, which
  // moves into whichever layout is showing. The portal comes after the layout
  // so the element is in the document before the page's effects run.
  const [pageHost] = useState(() => (typeof document === 'undefined' ? null : document.createElement('div')));
  const pageSlot = useCallback((slot: HTMLDivElement | null) => {
    if (slot && pageHost) slot.appendChild(pageHost);
  }, [pageHost]);

  const onChangePassword = pathname === '/admin/change-password';
  const activePage: AdminPageId | null = location.page ?? (isDesktop && !onChangePassword ? 'dashboard' : null);
  const activeDef = location.page ? ADMIN_PAGES.find((p) => p.id === location.page) ?? null : null;
  // "<Page> - Admin - <app>", so the tab and the window list say which
  // admin page is open (WCAG 2.4.2).
  const pageName = onChangePassword ? 'Change password' : ADMIN_PAGES.find((p) => p.id === activePage)?.label;
  useDocumentTitle(pageName ? `${pageName} - ${tSidebar('admin')}` : tSidebar('admin'), { showAccount: false });

  // Match the navigation rail: red for security/deprecated, amber for normal.
  const hasUpdate = useUpdateStore(selectHasUpdate);
  const updateSeverity = useUpdateStore((s) => s.status?.severity);
  const startUpdatePolling = useUpdateStore((s) => s.startPolling);
  useEffect(() => { startUpdatePolling(); }, [startUpdatePolling]);
  const updateImportant = updateSeverity === 'security' || updateSeverity === 'deprecated';

  const refreshBadges = useCallback(() => {
    if (!authenticated) return;
    apiFetch('/api/admin/plugin-approvals')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { entries?: Array<{ status: string }> } | null) => {
        setPendingApprovals(data?.entries?.filter((e) => e.status === 'pending').length ?? 0);
      })
      .catch(() => {});
  }, [authenticated]);
  useEffect(() => { refreshBadges(); }, [refreshBadges]);

  // A new page starts at the top; the back button restores nothing finer.
  const scrollKey = `${location.page ?? ''}/${location.detail ?? ''}`;
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [scrollKey]);

  // A page opened from a link or a reload can be far down the list, under its
  // fold on a laptop: bring its entry into view.
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activePage, isDesktop, hydrated]);

  // A section picked from the search scrolls into view once its page has
  // rendered it; pages fetch first, so retry for a moment.
  useEffect(() => {
    if (!pendingSection || pendingSection.page !== location.page) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 2000;
    const attempt = () => {
      if (cancelled) return;
      if (scrollToSettingsSection(pendingSection.id)) { setPendingSection(null); return; }
      if (Date.now() < deadline) timer = setTimeout(attempt, 80);
      else setPendingSection(null);
    };
    const raf = window.requestAnimationFrame(attempt);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
    };
  }, [pendingSection, location.page]);

  const trimmed = query.trim().toLowerCase();
  const matches = useMemo<Match[]>(() => {
    if (!trimmed) return ADMIN_PAGES.map((page) => ({ page, sections: [] }));
    const words = trimmed.split(/\s+/);
    const hits = (text: string) => words.every((w) => text.includes(w));
    return ADMIN_PAGES.flatMap((page) => {
      const sections = page.sections.filter((s) => hits(`${s.title} ${s.keywords ?? ''}`.toLowerCase()));
      const pageHit = hits(`${page.label} ${page.description} ${page.keywords}`.toLowerCase());
      if (!pageHit && sections.length === 0) return [];
      return [{ page, sections: sections.slice(0, 5) }];
    });
  }, [trimmed]);

  const groups = useMemo(() => (
    ADMIN_GROUPS
      .map((group) => ({ group, label: ADMIN_GROUP_LABELS[group], items: matches.filter((m) => m.page.group === group) }))
      .filter((g) => g.items.length > 0)
  ), [matches]);

  const goTo = (page: AdminPageId, section?: string) => {
    requestLeave(() => {
      setPendingSection(section ? { page, id: section } : null);
      navigateAdmin(adminPath(page));
      setQuery('');
    });
  };

  const prefix = getPathPrefix();
  const contextValue = useMemo(() => ({ saveBarHost, refreshBadges }), [saveBarHost, refreshBadges]);

  const badgeFor = (id: AdminPageId): ReactNode => {
    if (id === 'plugins' && pendingApprovals > 0) {
      return (
        <span className="ms-auto inline-flex min-w-[18px] items-center justify-center rounded-full bg-amber-500 px-1.5 text-[0.625rem] font-semibold leading-[1.125rem] text-white" title={`${pendingApprovals} plugin${pendingApprovals === 1 ? '' : 's'} waiting for approval`}>
          {pendingApprovals}
        </span>
      );
    }
    if (id === 'version' && hasUpdate) {
      // A dot only: role="img" makes screen readers announce its label, which
      // they skip on a plain span; the title shows it on hover.
      // The same words as the dot on the rail's Settings entry.
      const label = tShell(updateImportant ? 'update_important' : 'update_available');
      return (
        <span
          role="img"
          aria-label={label}
          title={label}
          className={cn('ms-auto h-2 w-2 rounded-full', updateImportant ? 'bg-red-500' : 'bg-amber-500')}
        />
      );
    }
    return null;
  };

  const searchBox = (
    <div className="relative">
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={tShell('admin_search')}
        aria-label={tShell('admin_search')}
        className={cn('h-9 ps-9 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none', query && 'pe-8')}
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery('')}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={tSettings('search_clear')}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  const noResults = (
    <div className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches</div>
  );

  // The admin session is its own: a password admin signs out of the panel,
  // not of their mailbox, so these stay with the panel rather than the rail.
  // A Stalwart admin signed in automatically has neither a password to change
  // nor a session worth ending, since opening the panel signs them back in.
  // Which kind of admin this is is known once the session check is done.
  const showSessionLinks = authenticated && !isStalwartAutoLogin;
  const sessionLinks = (mobile: boolean) => (
    <>
      <AdminLink
        href="/admin/change-password"
        aria-current={onChangePassword ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md text-sm transition-colors duration-150',
          mobile ? 'px-3 py-2.5' : 'px-3 py-2',
          onChangePassword ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground hover:bg-muted',
        )}
      >
        <KeyRound className={cn('h-4 w-4 shrink-0', onChangePassword ? 'text-accent-foreground' : 'text-muted-foreground')} />
        Change password
      </AdminLink>
      <button
        type="button"
        onClick={onLogout}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md text-sm text-foreground transition-colors duration-150 hover:bg-muted',
          mobile ? 'px-3 py-2.5' : 'px-3 py-2',
        )}
      >
        <LogOut className="h-4 w-4 shrink-0 text-muted-foreground" />
        Sign out of admin
      </button>
    </>
  );

  const readOnlyBanner = configReadOnly && authenticated && (
    <div role="status" className="mb-6 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
      <p className="font-medium text-foreground">The configuration is read-only</p>
      <p className="mt-1 text-muted-foreground">
        ADMIN_CONFIG_READONLY is set, so you can look at the settings here but not save changes.
        Change them in the mounted config files or environment instead.
      </p>
    </div>
  );

  // The server HTML and the hydration pass: the panel's skeleton, both
  // layouts drawn and picked by CSS until the width is known.
  if (!hydrated) {
    return (
      <AdminSkeleton
        page={location.page}
        label={loadingLabel}
        backLabel={tSettings('back_to_mail')}
        searchLabel={tShell('admin_search')}
        labels={railLabels}
      />
    );
  }

  const showIndex = location.page === null && !onChangePassword;
  const page = pageHost && (isDesktop || !showIndex) ? createPortal(children, pageHost) : null;

  if (!isDesktop) {
    const title = onChangePassword ? 'Change password' : activeDef?.label ?? 'Admin';
    const backHref = location.detail ? adminPath(location.page) : '/admin';
    return (
      <AdminShellContext.Provider value={contextValue}>
        <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)]">
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
            {showIndex ? (
              <a
                href={`${prefix}/`}
                className="flex h-10 w-10 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
                aria-label={tSettings('back_to_mail')}
                title={tSettings('back_to_mail')}
              >
                <ArrowLeft className="h-5 w-5" />
              </a>
            ) : (
              <AdminLink
                href={backHref}
                className="flex h-10 w-10 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted"
                aria-label={tShell('back')}
              >
                <ArrowLeft className="h-5 w-5" />
              </AdminLink>
            )}
            <div className="flex min-w-0 items-center gap-2">
              {showIndex && <Shield className="h-5 w-5 text-muted-foreground" />}
              <h1 className="truncate text-lg font-semibold">{title}</h1>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            {showIndex ? (
              <>
                <div className="px-4 pb-1 pt-3">{searchBox}</div>
                <div className="py-2">
                  {groups.length === 0 && noResults}
                  {groups.map((group, groupIndex) => (
                    <div key={group.group}>
                      {groupIndex > 0 && <div className="mx-5 my-2 border-t border-border" />}
                      {group.label && (
                        <div className="px-5 pb-1.5 pt-3">
                          <span className="text-xs font-semibold text-muted-foreground">{group.label}</span>
                        </div>
                      )}
                      {group.items.map(({ page, sections }) => {
                        const Icon = PAGE_ICONS[page.id];
                        return (
                          <div key={page.id}>
                            <AdminLink
                              href={adminPath(page.id)}
                              onClick={(e) => { e.preventDefault(); goTo(page.id); }}
                              data-testid={`admin-page-${page.id}`}
                              className="flex w-full items-center justify-between py-3.5 pe-5 ps-5 text-sm text-foreground transition-colors duration-150 hover:bg-muted"
                            >
                              <span className="flex items-center gap-3">
                                <Icon className="h-4 w-4 text-muted-foreground" />
                                {page.label}
                                {badgeFor(page.id)}
                              </span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </AdminLink>
                            {sections.map((section) => (
                              <button
                                key={section.id}
                                type="button"
                                onClick={() => goTo(page.id, section.id)}
                                className="flex w-full items-center pe-5 ps-12 py-2 text-start text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                              >
                                <span className="truncate">{section.title}</span>
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {(showSessionLinks || !authenticated) && (
                  <div className="border-t border-border px-2 py-2">
                    {showSessionLinks ? sessionLinks(true) : <AdminSessionLinksSkeleton mobile />}
                  </div>
                )}
                <div className="border-t border-border px-2 py-2"><AboutFooter /></div>
              </>
            ) : (
              <div className="p-4 pb-6">
                {readOnlyBanner}
                <div ref={pageSlot} />
              </div>
            )}
          </div>

          <div ref={setSaveBarHost} className="shrink-0" />

          <NavigationRail orientation="horizontal" adminActive />
        </div>
        {page}
      </AdminShellContext.Provider>
    );
  }

  return (
    <AdminShellContext.Provider value={contextValue}>
      <div className="flex h-dvh bg-background pt-[env(safe-area-inset-top)]">
        {/* The same rail as mail and settings, with Admin as the current app. */}
        <div className="flex w-14 shrink-0 flex-col bg-secondary" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail collapsed adminActive />
        </div>

        {/* The page list, laid out like the settings sidebar. */}
        <aside className="flex w-64 shrink-0 flex-col border-e border-border bg-secondary">
          <div className="border-b border-border">
            <div className="flex h-14 items-center px-2">
              <a
                href={`${prefix}/`}
                className="flex h-9 w-full items-center rounded-md px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <ArrowLeft className="me-2 h-4 w-4" />
                {tSettings('back_to_mail')}
              </a>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            <div className="px-3 pb-1 pt-1">{searchBox}</div>
            <nav ref={navRef} className="space-y-0.5 px-2" aria-label={tShell('admin_pages')}>
              {groups.length === 0 && noResults}
              {groups.map((group, groupIndex) => (
                <div key={group.group}>
                  {groupIndex > 0 && <div className="mx-1 my-2 border-t border-border" />}
                  {group.label && (
                    <div className="px-3 pb-1 pt-2.5">
                      <span className="text-[0.6875rem] font-semibold text-muted-foreground">{group.label}</span>
                    </div>
                  )}
                  {group.items.map(({ page, sections }) => {
                    const Icon = PAGE_ICONS[page.id];
                    const active = activePage === page.id;
                    return (
                      <div key={page.id}>
                        <AdminLink
                          href={adminPath(page.id)}
                          onClick={(e) => { e.preventDefault(); if (!active || location.detail) goTo(page.id); }}
                          aria-current={active ? 'page' : undefined}
                          data-testid={`admin-page-${page.id}`}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-md py-2 pe-3 ps-3 text-start text-sm transition-colors duration-150',
                            active ? 'bg-accent font-medium text-accent-foreground' : 'text-foreground hover:bg-muted',
                          )}
                        >
                          <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-accent-foreground' : 'text-muted-foreground')} />
                          <span className="truncate">{page.label}</span>
                          {badgeFor(page.id)}
                        </AdminLink>
                        {sections.map((section) => (
                          <button
                            key={section.id}
                            type="button"
                            onClick={() => goTo(page.id, section.id)}
                            className="w-full rounded-md py-1.5 pe-3 ps-9 text-start text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                          >
                            <span className="block truncate">{section.title}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              ))}
            </nav>
          </div>

          <div className="border-t border-border px-1 py-1">
            {/* Held in place while the session is checked, as the boot skeleton draws them. */}
            {(showSessionLinks || !authenticated) && (
              <div className="space-y-0.5 px-1 py-1">
                {showSessionLinks ? sessionLinks(false) : <AdminSessionLinksSkeleton mobile={false} />}
              </div>
            )}
            <AboutFooter />
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-3xl px-6 py-6">
              {readOnlyBanner}
              <div ref={pageSlot} />
            </div>
          </div>
          <div ref={setSaveBarHost} className="shrink-0" />
        </main>
      </div>
      {page}
    </AdminShellContext.Provider>
  );
}
