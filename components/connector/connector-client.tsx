'use client';

import { useEffect, useMemo, useState } from 'react';
import { resolveTarget, type ResolveResult } from '@/lib/connector/registry';
import { appPath } from '@/lib/deep-links';
import { replaceWindowLocation } from '@/lib/browser-navigation';
import { useAdminTabStore } from '@/stores/admin-tab-store';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '';

/**
 * Resolves a connector link and sends the browser to the real surface.
 *
 * Everything past the target name is read from `window.location` rather than
 * handed down as a route prop: the Lite build is a static export with no
 * server to read a query string, and on a server build it keeps the target out
 * of the request the origin sees.
 *
 * It replaces rather than pushes, so Back returns to wherever the link was
 * clicked instead of bouncing through here again.
 *
 * Authentication needs nothing special. The surface the user lands on does its
 * own `saveRedirectAfterLogin()` + `redirectToLogin()`, and by then the
 * address bar already holds the resolved path, so the login round-trip returns
 * to the deep link. The admin area is the exception - see `?next=` below.
 */
export function ConnectorClient({ target }: { target: string }) {
  const [result, setResult] = useState<ResolveResult | null>(null);
  const setAdminTab = useAdminTabStore((s) => s.setActiveTab);

  useEffect(() => {
    setResult(resolveTarget(target, new URLSearchParams(window.location.search)));
  }, [target]);

  const destination = useMemo(() => {
    if (result?.kind !== 'ok') return null;
    const { path, adminTab } = result.resolution;
    // The admin shell keeps its active tab in a store rather than in the URL,
    // so a link to a specific panel selects it here. The store is persisted,
    // so the choice survives an admin login in between.
    return { url: appPath(path), adminTab: adminTab ?? null };
  }, [result]);

  useEffect(() => {
    if (!destination) return;
    if (destination.adminTab) setAdminTab(destination.adminTab);
    // Nothing is appended to the URL. An admin who is not signed in gets
    // bounced by the admin layout, which parks this destination in its own
    // `?next=` - adding one here would nest inside that one and be refused.
    replaceWindowLocation(destination.url);
  }, [destination, setAdminTab]);

  if (result === null || result.kind === 'ok') {
    return <Shell>Opening…</Shell>;
  }

  // Neither case 404s. A link that this version cannot honour should say so
  // and offer the app, not look like a broken server.
  if (result.kind === 'unknown-target') {
    return (
      <Shell>
        <h1 className="text-xl font-medium text-foreground">This link is newer than this Bulwark</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          It opens something {APP_VERSION ? `version ${APP_VERSION} ` : 'this version '}
          does not know about. Updating Bulwark should teach it.
        </p>
        <Actions />
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-medium text-foreground">That link is not quite right</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        It asks for {result.target.label}, but its{' '}
        {/* The parameter is named, never echoed: its value is attacker-controlled. */}
        <code className="rounded bg-muted px-1 py-0.5">{result.param}</code> is missing or
        malformed. Nothing was opened.
      </p>
      <Actions />
    </Shell>
  );
}

function Actions() {
  return (
    <p className="mt-6">
      <a
        href={appPath('/mail')}
        className="inline-flex h-9 items-center rounded-sm border border-border px-4 text-sm hover:bg-muted"
      >
        Open Bulwark
      </a>
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md text-center text-muted-foreground">{children}</div>
    </div>
  );
}
