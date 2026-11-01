'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useConfig } from '@/hooks/use-config';
import { resolveTarget, type ResolveResult } from '@/lib/connector/registry';
import { appPath } from '@/lib/deep-links';
import { replaceWindowLocation } from '@/lib/browser-navigation';
import { productName } from '@/lib/product-name';
import { CONNECTOR_SURFACES } from '@/lib/boot-skeleton/surfaces';
import { RouteSkeleton } from '@/components/boot-skeleton/route-skeleton';

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
  const t = useTranslations('connector_link');
  const [result, setResult] = useState<ResolveResult | null>(null);
  const name = productName(useConfig().appName);

  useEffect(() => {
    setResult(resolveTarget(target, new URLSearchParams(window.location.search)));
  }, [target]);

  const destination = useMemo(() => {
    if (result?.kind !== 'ok') return null;
    return { url: appPath(result.resolution.path) };
  }, [result]);

  useEffect(() => {
    if (!destination) return;
    // Nothing is appended to the URL. An admin who is not signed in gets
    // bounced by the admin layout, which parks this destination in its own
    // `?next=` - adding one here would nest inside that one and be refused.
    replaceWindowLocation(destination.url);
  }, [destination]);

  if (result === null || result.kind === 'ok') {
    // The page the link opens, as its skeleton: the boot script has already
    // set that page's variant attributes from the link's parameters, so the
    // hard redirect lands on the same shapes. No bottom bar labels: this page
    // is English only and the destination may not be.
    const surface = Object.hasOwn(CONNECTOR_SURFACES, target) ? CONNECTOR_SURFACES[target] : null;
    if (surface) return <RouteSkeleton surface={surface} label={t('opening')} />;
    return <Shell>{t('opening')}</Shell>;
  }

  // Neither case 404s. A link that this version cannot honour should say so
  // and offer the app, not look like a broken server.
  if (result.kind === 'unknown-target') {
    return (
      <Shell>
        <h1 className="text-xl font-medium text-foreground">{t('unknown_title', { name })}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {t('unknown_body', { name, version: APP_VERSION || '?' })}
        </p>
        <Actions name={name} />
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-xl font-medium text-foreground">{t('malformed_title')}</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {/* The parameter is named, never echoed: its value is attacker-controlled. */}
        {t('malformed_body', { label: result.target.label, param: result.param })}
      </p>
      <Actions name={name} />
    </Shell>
  );
}

function Actions({ name }: { name: string }) {
  const t = useTranslations('connector_link');
  return (
    <p className="mt-6">
      <a
        href={appPath('/mail')}
        className="inline-flex h-9 items-center rounded-sm border border-border px-4 text-sm hover:bg-muted"
      >
        {t('open_app', { name })}
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
