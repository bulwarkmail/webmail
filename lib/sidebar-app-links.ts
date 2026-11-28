import { sanitizeDefaultSidebarApps } from '@/lib/sidebar-apps';
import type { AdminSidebarApp } from '@/lib/admin/types';
import { gateLinkClick, linkCheckActive, linkText, normaliseLinkHref, resolveExternalLink } from '@/lib/plugin-hook-result';
import type { ExternalLinkContext } from '@/lib/plugin-types';
import { usePolicyStore } from '@/stores/policy-store';
import { useSidebarAppFramesStore } from '@/stores/sidebar-app-frames-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

/**
 * A web address as the browser parses it, or null for anything else, nothing
 * parseable, or one with a user name or password (never an app's link).
 */
function webUrl(href: string): URL | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

/** Whether a path lies at or below an app's path, by whole segments. */
function pathCovers(appPath: string, path: string): boolean {
  const base = appPath.endsWith('/') ? appPath : `${appPath}/`;
  return path === appPath || path.startsWith(base);
}

/**
 * The admin app a link belongs to: an inline app of the policy's
 * `defaultSidebarApps` whose URL has the link's origin (scheme, host and port,
 * as the browser parses them; never a prefix of the address). Of several apps
 * on that origin, the one whose path is the longest prefix of the link's (by
 * whole segments), else the first. A user's own sidebar apps never take
 * links: the operator vouches for an admin app's origin, and only those are
 * in the document's `frame-src` from the start.
 */
export function sidebarAppForLink(href: string, apps: readonly AdminSidebarApp[]): AdminSidebarApp | null {
  const link = webUrl(href);
  if (!link) return null;
  const candidates = apps.flatMap((app) => {
    const url = app.openMode === 'inline' ? webUrl(app.url) : null;
    return url && url.origin === link.origin ? [{ app, path: url.pathname }] : [];
  });
  let best: { app: AdminSidebarApp; path: string } | undefined;
  for (const candidate of candidates) {
    if (pathCovers(candidate.path, link.pathname) && (!best || candidate.path.length > best.path.length)) best = candidate;
  }
  return (best ?? candidates[0])?.app ?? null;
}

/**
 * A plain click: the main button with no modifier key. Ctrl / Cmd / Shift /
 * Alt and the middle button ask for a tab or a window, and keep getting one.
 */
export function isPlainLinkClick(event: Pick<MouseEvent, 'type' | 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
  return event.type === 'click' && event.button === 0
    && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

/** Where a link would open in the sidebar: its admin app and the page to show it, or null. */
function sidebarTarget(href: string) {
  const apps = sanitizeDefaultSidebarApps(usePolicyStore.getState().policy.defaultSidebarApps);
  const app = sidebarAppForLink(href, apps);
  if (!app) return null;
  const host = useSidebarAppFramesStore.getState().hosts.at(-1);
  // On a phone only an app the rail offers there.
  if (host === undefined || (useUIStore.getState().isMobile && !app.showOnMobile)) return null;
  return { app, host };
}

/**
 * Open a link in the sidebar app it belongs to, in the newest page that can
 * show apps (the app's pane, as its rail button opens it), with the app's
 * frame going to that address. Bulwark sends the app nothing; the address is
 * all it gets. False - nothing done, the caller opens the link as before -
 * for a link of no admin inline app, or when no such page is mounted (a
 * popped-out message, an app not shown on a phone).
 */
export function openLinkInSidebarApp(href: string): boolean {
  const target = sidebarTarget(href);
  if (!target) return false;
  const { app, host } = target;
  const frame = useSidebarAppFramesStore
    .getState()
    .openAt({ id: app.id, url: app.url, name: app.name }, href, useSettingsStore.getState().keepAppsLoaded);
  host.show(frame);
  return true;
}

/**
 * Open a link the link check let through (resolveExternalLink's address): in
 * its admin app's pane when `inPane` (a plain click) and an app takes it,
 * else in a new tab.
 */
export function openCheckedLink(target: string, inPane: boolean): void {
  if (inPane && openLinkInSidebarApp(target)) return;
  window.open(target, '_blank', 'noopener,noreferrer');
}

/**
 * gateLinkClick for a body rendered in the page (a plain-text message): a
 * plain click on a web link goes through the link check, then opens in an
 * admin app's pane when the checked address is one of its links, else in a
 * new tab; everything else as gateLinkClick has it. Without a link check
 * listening, a link that no app takes stays the browser's.
 */
export function gateAppLinkClick(
  event: Parameters<typeof gateLinkClick>[0] & Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
  extra: Partial<ExternalLinkContext> = {},
): void {
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  const href = link?.getAttribute('href')?.trim() ?? '';
  if (!link || !isPlainLinkClick(event) || !/^https?:/i.test(href)
    || (!linkCheckActive() && !sidebarTarget(normaliseLinkHref(href)))) {
    gateLinkClick(event, extra);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  void resolveExternalLink({ href, target: link.getAttribute('target') ?? '_blank', text: linkText(link), ...extra })
    .then((target) => { if (target) openCheckedLink(target, true); });
}
