'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';
import { apiFetch } from '@/lib/browser-navigation';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';
import { AdminShell } from '@/components/admin/admin-shell';
import { AdminContentSkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { useAdminLocation } from '@/hooks/use-admin-navigation';
import { UnsavedChangesGuard } from './_unsaved-changes-guard';
import { ToastContainer } from '@/components/ui/toast';
import { useToastStore } from '@/stores/toast-store';

/** The app's toasts, which the admin reports its results in (R9). */
function AdminToasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

/**
 * Gates the admin panel behind the admin session and draws its shell. The
 * pages themselves are one route (./[[...segments]]) and switch through
 * history.pushState, so this layout stays mounted across them.
 */
export function AdminLayoutClient({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const location = useAdminLocation();
  const requestLeave = useAdminUnsavedStore((s) => s.requestLeave);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isStalwartAutoLogin, setIsStalwartAutoLogin] = useState(false);
  const [configReadOnly, setConfigReadOnly] = useState(false);

  useEffect(() => {
    if (pathname === '/admin/login') return;
    // One check per visit, not one per page: the pages switch without a
    // route change, and the session does not change with them.
    if (authenticated === true) return;
    let cancelled = false;

    async function checkAuth() {
      try {
        const jmapHeaders = getActiveAccountSlotHeaders();
        const res = await apiFetch('/api/admin/auth', { headers: jmapHeaders });
        const data = await res.json();
        if (cancelled) return;

        // `stalwartAutoLogin` is only true in "auto" mode; in "password" mode
        // a Stalwart admin still lands on the password form (#870).
        const stalwartAutoLogin = data.stalwartAutoLogin === true;
        setIsStalwartAutoLogin(stalwartAutoLogin);

        // If neither password-based admin nor Stalwart auto-login, redirect away
        if (!data.enabled && !stalwartAutoLogin) {
          router.replace('/');
          return;
        }

        if (data.authenticated) {
          setAuthenticated(true);
          return;
        }

        // If Stalwart admin (auto mode) but not yet authenticated, auto-login
        if (stalwartAutoLogin) {
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

        // Carry the page that was asked for through the login, so a connector
        // link to a panel (/connector/admin_extension?slug=x) does not dump
        // the admin on the overview after signing in.
        const next = encodeURIComponent(`${pathname}${window.location.search}`);
        router.replace(`/admin/login?next=${next}`);
      } catch (err) {
        if (cancelled) return;
        setAuthError(err instanceof Error ? err.message : 'Network error during admin check');
        setAuthenticated(false);
      }
    }

    checkAuth();
    return () => { cancelled = true; };
  }, [pathname, router, authenticated]);

  // With ADMIN_CONFIG_READONLY the panel still shows every setting, but
  // nothing can be saved; say so up front instead of after a failed save (#1249).
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    apiFetch('/api/setup/status')
      .then(res => (res.ok ? res.json() : null))
      .then(data => { if (!cancelled) setConfigReadOnly(data?.readOnly === true); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [authenticated]);

  function handleLogout() {
    requestLeave(async () => {
      await apiFetch('/api/admin/auth', { method: 'DELETE' });
      router.replace('/admin/login');
    });
  }

  // Don't gate the login page
  if (pathname === '/admin/login') {
    return <>{children}<AdminToasts /></>;
  }

  return (
    <>
      <UnsavedChangesGuard />
      <AdminToasts />
      <AdminShell
        authenticated={authenticated === true}
        isStalwartAutoLogin={isStalwartAutoLogin}
        configReadOnly={configReadOnly}
        onLogout={handleLogout}
      >
        {authError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            <p className="font-medium">Admin authentication failed</p>
            <p className="mt-1 text-destructive/80">{authError}</p>
          </div>
        ) : authenticated === null ? (
          // The page's header and section placeholders, where the boot
          // skeleton drew them.
          <AdminContentSkeleton page={location.page} status="Loading admin panel…" />
        ) : authenticated ? children : null}
      </AdminShell>
    </>
  );
}
