'use client';

import { forwardRef, useMemo, useSyncExternalStore, type ComponentProps } from 'react';
import NextLink from 'next/link';
import { useRouter as useNextRouter, usePathname as useNextPathname } from 'next/navigation';
import { useLocale } from 'next-intl';
import { getPathPrefix } from '@/lib/browser-navigation';
import { mountedHref, stripMountedPathname, type MountedHref } from '@/lib/lite-mounted-href';

/**
 * `@/i18n/navigation` for a Lite bundle whose mount prefix is only known at
 * runtime (the Stalwart build, see lib/lite-mounted-href.ts). Same call
 * signatures as next-intl's helpers; only the hrefs differ.
 */

type NavigateOptions = { locale?: string; scroll?: boolean };

const noopSubscribe = () => () => {};

/**
 * The mount prefix, hydration-safe: '' while prerendering and during the
 * hydration pass, the real prefix right after.
 */
function useMountPrefix(): string {
  return useSyncExternalStore(noopSubscribe, getPathPrefix, () => '');
}

export function useMountedRouter() {
  const router = useNextRouter();
  const locale = useLocale();
  return useMemo(() => {
    const to = (href: MountedHref, options?: NavigateOptions) =>
      mountedHref(href, options?.locale ?? locale, getPathPrefix());
    return {
      ...router,
      push: (href: MountedHref, options?: NavigateOptions) => router.push(to(href, options), { scroll: options?.scroll }),
      replace: (href: MountedHref, options?: NavigateOptions) => router.replace(to(href, options), { scroll: options?.scroll }),
      prefetch: (href: MountedHref, options?: NavigateOptions) => router.prefetch(to(href, options)),
    };
  }, [router, locale]);
}

export function useMountedPathname(): string {
  const pathname = useNextPathname();
  const prefix = useMountPrefix();
  return stripMountedPathname(pathname ?? '/', prefix);
}

type MountedLinkProps = Omit<ComponentProps<typeof NextLink>, 'href'> & { href: MountedHref; locale?: string };

export const MountedLink = forwardRef<HTMLAnchorElement, MountedLinkProps>(function MountedLink(
  { href, locale, ...rest },
  ref,
) {
  const current = useLocale();
  const prefix = useMountPrefix();
  return <NextLink ref={ref} href={mountedHref(href, locale ?? current, prefix)} {...rest} />;
});
