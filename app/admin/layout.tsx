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
  Mail,
  Calendar,
  BookUser,
  HardDrive,
  ArrowLeft,
  Store,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConfig } from '@/hooks/use-config';
import { useThemeStore } from '@/stores/theme-store';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';

import { useAuthStore } from '@/stores/auth-store';
import { apiPath } from "@/lib/api-path";

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
      { href: '/admin/logs', label: 'Audit Log', icon: ScrollText },
    ],
  },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [isStalwartAdmin, setIsStalwartAdmin] = useState(false);
  const { appLogoLightUrl, appLogoDarkUrl, loginLogoLightUrl, loginLogoDarkUrl } = useConfig();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const logoUrl = resolvedTheme === 'dark'
    ? (appLogoDarkUrl || appLogoLightUrl || loginLogoDarkUrl)
    : (appLogoLightUrl || appLogoDarkUrl || loginLogoLightUrl);

  useEffect(() => {
    if (pathname !== '/admin/login') {
      checkAuth();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function getJmapHeaders(): Record<string, string> {
    return getActiveAccountSlotHeaders();
  }

  async function checkAuth() {
    try {
      const jmapHeaders = getJmapHeaders();
      const res = await fetch(apiPath('/api/admin/auth'), { headers: jmapHeaders });
      const data = await res.json();

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
        const loginRes = await fetch(apiPath('/api/admin/auth'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...jmapHeaders },
          body: JSON.stringify({ stalwartAuth: true }),
        });
        if (loginRes.ok) {
          setAuthenticated(true);
          return;
        }
      }

      router.replace('/admin/login');
    } catch {
      router.replace('/admin/login');
    }
  }

  async function handleLogout() {
    await fetch(apiPath('/api/admin/auth'), { method: 'DELETE' });
    router.replace('/admin/login');
  }

  // Don't gate the login page
  if (pathname === '/admin/login') {
    return <>{children}</>;
  }

  if (authenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-background">
      {/* Slim webmail nav rail */}
      <nav className="w-14 bg-secondary flex flex-col items-center py-3 gap-2 border-r border-border sticky top-0 h-screen shrink-0">
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

      {/* Admin Sidebar */}
      <aside className="w-60 border-r border-border bg-secondary flex flex-col sticky top-0 h-screen">
        <div className="h-14 flex items-center px-4 border-b border-border shrink-0">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="w-5 h-5 object-contain mr-2" />
          ) : (
            <Shield className="w-5 h-5 text-primary mr-2" />
          )}
          <span className="font-semibold text-sm text-foreground">Admin Panel</span>
        </div>

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
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
