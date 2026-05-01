'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  Settings,
  Palette,
  Shield,
  Scale,
  ScrollText,
  LogOut,
  KeyRound,
  Puzzle,
  SwatchBook,
  Activity,
  Mail,
  Calendar,
  BookUser,
  HardDrive,
  ArrowLeft,
  Store,
  Menu,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConfig } from '@/hooks/use-config';
import { useThemeStore } from '@/stores/theme-store';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';

import { useAuthStore } from '@/stores/auth-store';
import { apiFetch } from '@/lib/browser-navigation';

const NAV_GROUPS = [
  {
    label: 'Overview',
    items: [
      { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { href: '/admin/settings', label: 'Settings', icon: Settings },
      { href: '/admin/branding', label: 'Branding', icon: Palette },
      { href: '/admin/auth', label: 'Authentication', icon: Shield },
      { href: '/admin/policy', label: 'Policy', icon: Scale },
    ],
  },
  {
    label: 'Extensions',
    items: [
      { href: '/admin/plugins', label: 'Plugins', icon: Puzzle },
      { href: '/admin/themes', label: 'Themes', icon: SwatchBook },
      { href: '/admin/marketplace', label: 'Marketplace', icon: Store },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/admin/telemetry', label: 'Telemetry', icon: Activity },
      { href: '/admin/logs', label: 'Audit Log', icon: ScrollText },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isStalwartAdmin, setIsStalwartAdmin] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { appLogoLightUrl, appLogoDarkUrl, loginLogoLightUrl, loginLogoDarkUrl } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const logoUrl = resolvedTheme === 'dark'
    ? (appLogoDarkUrl || appLogoLightUrl || loginLogoDarkUrl)
    : (appLogoLightUrl || appLogoDarkUrl || loginLogoLightUrl);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    if (pathname === '/admin/login') return;
    let cancelled = false;

    async function checkAuth() {
      try {
        const jmapHeaders = getActiveAccountSlotHeaders();
        const res = await apiFetch('/api/admin/auth', { headers: jmapHeaders });
        const data = await res.json();
        if (cancelled) return;

        const stalwartAdmin = data.stalwartAdmin === true;
        setIsStalwartAdmin(stalwartAdmin);

        // If neither password-based admin nor Stalwart admin, redirect away
        if (!data.enabled && !stalwartAdmin) {
          router.replace('/');
          return;
        }

        if (data.authenticated) {
          setAuthenticated(true);
          return;
        }

        // If Stalwart admin but not yet authenticated, auto-login
        if (stalwartAdmin) {
          const loginRes = await apiFetch('/api/admin/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...jmapHeaders },
            body: JSON.stringify({ stalwartAuth: true }),
          });
          if (cancelled) return;
          if (loginRes.ok) {
            setAuthenticated(true);
            return;
          }
          const body = await loginRes.json().catch(() => ({}));
          setAuthError(body?.error || `Admin auto-login failed (HTTP ${loginRes.status})`);
          setAuthenticated(false);
          return;
        }

        router.replace('/admin/login');
      } catch (err) {
        if (cancelled) return;
        setAuthError(err instanceof Error ? err.message : 'Network error during admin check');
        setAuthenticated(false);
      }
    }

    checkAuth();
    return () => { cancelled = true; };
  }, [pathname, router]);

  async function handleLogout() {
    await apiFetch('/api/admin/auth', { method: 'DELETE' });
    router.replace('/admin/login');
  }

  // Don't gate the login page
  if (pathname === '/admin/login') {
    return <>{children}</>;
  }

  const navContent = (
    <>
      <div className="flex-1 overflow-y-auto py-2">
        <div className="px-2 space-y-0.5">
          {NAV_GROUPS.map((group, groupIndex) => (
            <div key={group.label}>
              {groupIndex > 0 && <div className="mx-1 my-2 border-t border-border" />}
              <div className="px-3 pt-2.5 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </span>
              </div>
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-md text-sm transition-colors duration-150 flex items-center gap-2.5',
                      active
                        ? 'bg-accent text-accent-foreground font-medium'
                        : 'hover:bg-muted text-foreground'
                    )}
                  >
                    <Icon className={cn(
                      'w-4 h-4 shrink-0',
                      active ? 'text-accent-foreground' : 'text-muted-foreground'
                    )} />
                    {label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="px-2 py-2 border-t border-border space-y-0.5 shrink-0">
        {!isStalwartAdmin && (
          <Link
            href="/admin/change-password"
            className={cn(
              'w-full text-left px-3 py-2 rounded-md text-sm transition-colors duration-150 flex items-center gap-2.5',
              pathname === '/admin/change-password'
                ? 'bg-accent text-accent-foreground font-medium'
                : 'hover:bg-muted text-foreground'
            )}
          >
            <KeyRound className={cn(
              'w-4 h-4 shrink-0',
              pathname === '/admin/change-password' ? 'text-accent-foreground' : 'text-muted-foreground'
            )} />
            Change Password
          </Link>
        )}
        <button
          onClick={handleLogout}
          className="w-full text-left px-3 py-2 rounded-md text-sm transition-colors duration-150 flex items-center gap-2.5 hover:bg-muted text-foreground"
        >
          <LogOut className="w-4 h-4 shrink-0 text-muted-foreground" />
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen flex bg-background">
      {/* Slim webmail nav rail (desktop only) */}
      <nav className="hidden md:flex w-14 bg-secondary flex-col items-center py-3 gap-2 border-r border-border sticky top-0 h-screen shrink-0">
        {logoUrl ? (
          <img src={logoUrl} alt="" className="w-7 h-7 object-contain mb-2" />
        ) : (
          <div className="w-7 h-7 mb-2" />
        )}
        <a
          href="/"
          className="flex items-center justify-center w-10 h-10 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
          title="Mail"
        >
          <Mail className="w-[18px] h-[18px]" />
        </a>
        <a
          href="/calendar"
          className="flex items-center justify-center w-10 h-10 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
          title="Calendar"
        >
          <Calendar className="w-[18px] h-[18px]" />
        </a>
        <a
          href="/contacts"
          className="flex items-center justify-center w-10 h-10 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
          title="Contacts"
        >
          <BookUser className="w-[18px] h-[18px]" />
        </a>
        <a
          href="/files"
          className="flex items-center justify-center w-10 h-10 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
          title="Files"
        >
          <HardDrive className="w-[18px] h-[18px]" />
        </a>
        <div className="mt-auto flex flex-col items-center gap-2">
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10 text-primary" title="Admin">
            <Shield className="w-[18px] h-[18px]" />
          </div>
          <a
            href="/settings"
            className="flex items-center justify-center w-10 h-10 rounded-md transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Settings"
          >
            <Settings className="w-[18px] h-[18px]" />
          </a>
        </div>
      </nav>

      {/* Admin Sidebar (desktop only) */}
      <aside className="hidden md:flex w-60 border-r border-border bg-secondary flex-col sticky top-0 h-screen">
        <div className="h-14 flex items-center px-4 border-b border-border shrink-0">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="w-5 h-5 object-contain mr-2" />
          ) : (
            <Shield className="w-5 h-5 text-primary mr-2" />
          )}
          <span className="font-semibold text-sm text-foreground">Admin Panel</span>
        </div>
        {navContent}
      </aside>

      {/* Mobile drawer overlay */}
      {mobileNavOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          'md:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-border bg-secondary flex flex-col transition-transform duration-200 ease-out',
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        )}
        aria-label="Admin navigation"
        aria-hidden={!mobileNavOpen}
      >
        <div className="h-14 flex items-center justify-between px-3 border-b border-border shrink-0">
          <div className="flex items-center min-w-0">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="w-5 h-5 object-contain mr-2" />
            ) : (
              <Shield className="w-5 h-5 text-primary mr-2" />
            )}
            <span className="font-semibold text-sm text-foreground truncate">Admin Panel</span>
          </div>
          <button
            type="button"
            onClick={() => setMobileNavOpen(false)}
            className="flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Close navigation"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {navContent}
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 overflow-x-hidden">
        {/* Mobile header */}
        <div className="md:hidden sticky top-0 z-30 h-14 flex items-center gap-2 px-3 border-b border-border bg-background">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            className="flex items-center justify-center w-9 h-9 rounded-md text-foreground hover:bg-muted transition-colors"
            aria-label="Open navigation"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center min-w-0">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="w-5 h-5 object-contain mr-2" />
            ) : (
              <Shield className="w-5 h-5 text-primary mr-2" />
            )}
            <span className="font-semibold text-sm text-foreground truncate">Admin Panel</span>
          </div>
        </div>

        <div className="max-w-4xl mx-auto p-4 md:p-6 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-6">
          {authError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              <p className="font-medium">Admin authentication failed</p>
              <p className="mt-1 text-destructive/80">{authError}</p>
            </div>
          ) : authenticated === null ? (
            <div className="py-12 text-center text-sm text-muted-foreground animate-pulse">
              Loading admin panel…
            </div>
          ) : authenticated ? (
            children
          ) : null}
        </div>
      </main>

      {/* Mobile bottom nav (main webmail nav) */}
      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-30 flex items-center bg-background border-t border-border pb-[env(safe-area-inset-bottom)]"
        aria-label="Main navigation"
      >
        <a
          href="/"
          className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150 text-muted-foreground hover:text-foreground"
          title="Mail"
        >
          <Mail className="w-5 h-5" />
          <span className="text-[10px] font-medium leading-tight truncate max-w-full">Mail</span>
        </a>
        <a
          href="/calendar"
          className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150 text-muted-foreground hover:text-foreground"
          title="Calendar"
        >
          <Calendar className="w-5 h-5" />
          <span className="text-[10px] font-medium leading-tight truncate max-w-full">Calendar</span>
        </a>
        <a
          href="/contacts"
          className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150 text-muted-foreground hover:text-foreground"
          title="Contacts"
        >
          <BookUser className="w-5 h-5" />
          <span className="text-[10px] font-medium leading-tight truncate max-w-full">Contacts</span>
        </a>
        <a
          href="/files"
          className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150 text-muted-foreground hover:text-foreground"
          title="Files"
        >
          <HardDrive className="w-5 h-5" />
          <span className="text-[10px] font-medium leading-tight truncate max-w-full">Files</span>
        </a>
        <div
          className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] text-primary"
          title="Admin"
          aria-current="page"
        >
          <div className="relative">
            <Shield className="w-5 h-5" />
            <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-0.5 rounded-full bg-primary" />
          </div>
          <span className="text-[10px] font-medium leading-tight truncate max-w-full">Admin</span>
        </div>
        <a
          href="/settings"
          className="flex flex-col items-center justify-center gap-1 py-2 px-1 min-h-[44px] grow shrink-0 basis-[64px] transition-colors duration-150 text-muted-foreground hover:text-foreground"
          title="Settings"
        >
          <Settings className="w-5 h-5" />
          <span className="text-[10px] font-medium leading-tight truncate max-w-full">Settings</span>
        </a>
      </nav>
    </div>
  );
}
