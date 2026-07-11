"use client";

import { useCallback, useEffect, useRef } from 'react';
import { renderBadgedFavicon } from '@/lib/favicon-badge';
import { debug } from '@/lib/debug';

// Our own link, and only ever our own. Next's metadata `icons` (app/(main)/
// layout.tsx) renders <link rel="icon"> through React, which hoists it into
// <head> and keeps a fiber pointing at that DOM node. Removing it out from
// under React leaves the fiber holding a detached node, and the next commit
// that deletes that fiber throws "Cannot read properties of null (reading
// 'removeChild')". So we never remove or mutate a node we did not create:
// instead we append an *extra* icon link, marked as ours. The last-declared
// icon wins in browsers, so ours overrides the base without deleting it.
//
// Ours is never removed to clear the badge, though — only on unmount. Firefox
// re-evaluates the favicon on an *insertion* and on nothing else: a removal
// leaves it painting the last icon it was handed, which is how a read inbox
// kept a stale "99+" in the tab. Clearing therefore re-inserts our link with
// the original base href in place of the badge (see `apply`).
const MARKER = 'data-favicon-badge';
const OWN_SELECTOR = `link[${MARKER}]`;
const ICON_SELECTOR = 'link[rel~="icon"]';
const BASE_SELECTOR = `${ICON_SELECTOR}:not([${MARKER}])`;

// Both the badged icon and the untouched base we fall back to are SVG: the hook
// disables itself unless the fetched base is served as image/svg+xml, so by the
// time either link exists that content type is a proven fact, not a guess.
const ICON_TYPE = 'image/svg+xml';

function removeOwnLink(): void {
  document.querySelectorAll(OWN_SELECTOR).forEach((el) => el.remove());
}

function ownLink(): HTMLLinkElement | null {
  return document.head.querySelector<HTMLLinkElement>(OWN_SELECTOR);
}

/** True when ours is the last icon link in <head>, i.e. the one the browser uses. */
function isLastIconLink(link: HTMLLinkElement): boolean {
  const icons = document.head.querySelectorAll<HTMLLinkElement>(ICON_SELECTOR);
  return icons[icons.length - 1] === link;
}

/**
 * Appends a fresh icon link of ours, replacing any previous one of ours.
 *
 * Always a remove-then-append of a *new* node, never an href mutation: Firefox
 * only re-evaluates the favicon when an icon link is inserted. It ignores an
 * in-place href change, and — the count-back-to-zero bug — it equally ignores a
 * removal, happily painting the last icon it was handed. So even *clearing* the
 * badge is done by inserting: see `apply`, which re-inserts our link carrying
 * the original base href rather than deleting it.
 */
function setOwnLink(href: string): void {
  removeOwnLink();
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = ICON_TYPE;
  link.href = href;
  link.setAttribute(MARKER, '');
  document.head.appendChild(link);
}

/**
 * Draws `count` as a badge on the browser-tab favicon, unless `enabled` is
 * false (the `faviconUnreadBadge` setting).
 *
 * The base icon is read from the rendered <link rel="icon">, so admin and
 * per-domain branding overrides (configManager `faviconUrl`) are respected
 * without plumbing config to the client.
 *
 * Every failure — no icon link, a fetch error, a non-SVG base, unparseable
 * source — leaves the existing favicon untouched.
 */
export function useFaviconBadge(count: number, enabled = true): void {
  // Disabled is just "nothing to show", i.e. exactly a count of zero, so it
  // rides the same paths: no fetch while we have never badged, and — the part
  // that matters — clearing an *existing* badge by inserting a fresh link
  // carrying the base href rather than removing ours, which Firefox would
  // ignore (see `apply`). Switching the setting off therefore restores the
  // plain icon immediately, with no reload.
  const effectiveCount = enabled ? count : 0;
  const baseSource = useRef<string | null>(null);
  const baseHref = useRef<string | null>(null);
  // The href our own link currently carries, and the hook's whole state machine:
  //   null            -> nothing of ours is in <head> (we have never badged)
  //   baseHref        -> ours is in <head>, showing the unbadged base icon
  //   a data: URL     -> ours is in <head>, showing the badge
  const appliedHref = useRef<string | null>(null);
  const disabled = useRef(false);
  const fetchStarted = useRef(false);
  const unmounted = useRef(false);
  const latestCount = useRef(effectiveCount);
  latestCount.current = effectiveCount;

  // Declared before the badge effect so that on a StrictMode remount it runs
  // first and clears `unmounted` before the badge effect reads it.
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      // Restore the server-rendered favicon by removing our override. Nothing
      // else in <head> is ours to touch.
      removeOwnLink();
      appliedHref.current = null;
    };
  }, []);

  // Reads the refs rather than a closure over `count`, so that the reply to an
  // in-flight fetch — and the MutationObserver below, which outlives any single
  // render — lands on the newest count, not the one that started it.
  const apply = useCallback(() => {
    if (unmounted.current || disabled.current) return;

    const current = latestCount.current;
    if (current <= 0) {
      // Clearing the badge is an *insertion*, not a removal.
      //
      // The field bug: with 133 unread the tab showed "99+", the user read
      // everything, the store went to 0 — and Firefox kept painting "99+" until
      // a hard reload. Removing our link is not an insertion, and Firefox only
      // re-evaluates the favicon on an insertion; a removal leaves it painting
      // the last icon it was handed. So instead of deleting our link we replace
      // it with a fresh one carrying the *original* base href: same pixels as
      // the untouched base link below it, but handed to the browser as a new
      // icon, which it does repaint.
      //
      // Never badged (`appliedHref` still null)? Then nothing of ours is in
      // <head> and nothing should be: a fully-read inbox adds no link at all.
      const base = baseHref.current;
      if (appliedHref.current === null || base === null) return;
      if (appliedHref.current === base && ownLink()) return; // already showing the base: no thrash

      setOwnLink(base);
      appliedHref.current = base;
      return;
    }

    const source = baseSource.current;
    if (source === null) return; // still fetching; the fetch will call back

    const next = renderBadgedFavicon(source, current);
    if (!next) return;
    if (next === appliedHref.current && ownLink()) return;

    setOwnLink(next);
    appliedHref.current = next;
  }, []);

  useEffect(() => {
    if (disabled.current) return;

    // Nothing to show and nothing applied: do not even fetch. A fully-read
    // inbox — or the setting switched off before we ever badged — should cost
    // no request.
    if (effectiveCount <= 0 && baseSource.current === null && !fetchStarted.current) return;

    // The base is fetched at most once, ever. Without this guard a StrictMode
    // double-invoke issues two requests, and any count change while the fetch
    // is in flight issues another.
    if (baseSource.current !== null || fetchStarted.current) {
      apply();
      return;
    }

    // The one and only read of the base link. Its href is both what we fetch the
    // source from and what we hand back to the browser when the badge clears.
    const link = document.querySelector<HTMLLinkElement>(BASE_SELECTOR);
    const href = link?.getAttribute('href');
    if (!href) {
      disabled.current = true;
      return;
    }
    baseHref.current = href;
    fetchStarted.current = true;

    void (async () => {
      try {
        const response = await fetch(href);
        if (!response.ok) throw new Error(`favicon fetch failed: ${response.status}`);

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('image/svg+xml')) {
          throw new Error(`favicon is not SVG: ${contentType || 'unknown'}`);
        }

        baseSource.current = await response.text();
        apply();
      } catch (error) {
        disabled.current = true;
        debug.log('[favicon-badge] disabled:', error);
      }
    })();
  }, [effectiveCount, apply]);

  // Keep ours the last icon link in <head>.
  //
  // On a client-side navigation (Inbox -> Calendar) Next re-hoists the metadata
  // <link rel="icon"> from app/(main)/layout.tsx into <head>. The re-inserted
  // node lands *after* our badge link, the last-declared icon wins, and the
  // badge vanishes. Coming back to the inbox did not bring it back either: the
  // count is unchanged, so the effect above never re-ran and our link just sat
  // there outranked. Watching <head> fixes both halves at once.
  //
  // Termination: moving our own link is itself a <head> mutation, so it feeds
  // the observer a fresh record. The guard is `isLastIconLink` — on that second
  // run ours *is* last, so we do nothing and the cascade stops. One move per
  // foreign insertion, never two.
  const keepOwnLinkLast = useCallback(() => {
    if (unmounted.current || disabled.current) return;
    // Ours must stay last in *both* states — badged, and showing the base href
    // after a clear (`appliedHref` is only null when we have never badged, and
    // then nothing of ours is in <head> to keep last). Gating this on the count
    // instead would strand our base-href link behind a re-hoisted React icon,
    // and the next badge would have to fight its way back on top.
    if (appliedHref.current === null) return;

    const own = ownLink();
    if (!own) {
      // React blew our link away with the rest of the head: re-apply from scratch.
      apply();
      return;
    }
    if (isLastIconLink(own)) return;

    // Re-appending *our own* element is the only mutation we ever make; a node
    // we did not create is never removed, moved or touched (see above).
    document.head.appendChild(own);
  }, [apply]);

  useEffect(() => {
    const observer = new MutationObserver(keepOwnLinkLast);
    observer.observe(document.head, { childList: true });
    return () => observer.disconnect();
  }, [keepOwnLinkLast]);
}
