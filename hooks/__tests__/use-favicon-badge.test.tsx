import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, renderHook, waitFor } from '@testing-library/react';
import { useFaviconBadge } from '@/hooks/use-favicon-badge';
import { renderBadgedFavicon } from '@/lib/favicon-badge';

vi.mock('@/lib/favicon-badge', () => ({
  renderBadgedFavicon: vi.fn((_source: string, count: number) =>
    count > 0 ? `data:image/svg+xml,BADGED-${count}` : null,
  ),
}));

const renderBadgedFaviconMock = vi.mocked(renderBadgedFavicon);

const ORIGINAL_HREF = '/branding/Bulwark_Favicon.svg';

/** The link the hook owns: the only one it may ever touch. */
function badgeLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[data-favicon-badge]');
}

/** The base icon link the page (or React) rendered: must survive untouched. */
function baseLinks(): HTMLLinkElement[] {
  return Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]:not([data-favicon-badge])'),
  );
}

/** Every icon link in <head>, in document order. The browser honours the last. */
function iconLinks(): HTMLLinkElement[] {
  return Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

function lastIconLink(): HTMLLinkElement | null {
  return iconLinks().at(-1) ?? null;
}

/**
 * What Next/React does on a client-side navigation: it re-hoists its metadata
 * icon link into <head>, appending a *fresh* node after everything already
 * there — including our badge link.
 */
function rehoistBaseIcon(href = ORIGINAL_HREF): HTMLLinkElement {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = href;
  document.head.appendChild(link);
  return link;
}

/** Drains microtasks (MutationObserver callbacks) and one macrotask. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function svgResponse(body = '<svg viewBox="0 0 1000 1000"/>') {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/svg+xml' } });
}

function Badger({ count }: { count: number }) {
  useFaviconBadge(count);
  return null;
}

beforeEach(() => {
  document.head.innerHTML = `<link rel="icon" href="${ORIGINAL_HREF}">`;
  vi.stubGlobal('fetch', vi.fn(async () => svgResponse()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // document.head outlives every test, so a spy on it that a failing assertion
  // never got to restore would leak into the next test's counts.
  vi.restoreAllMocks();
});

describe('useFaviconBadge', () => {
  it('appends its own badged icon link when the count is positive', async () => {
    renderHook(() => useFaviconBadge(3));
    await waitFor(() => {
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
    });
    expect(badgeLink()!.getAttribute('type')).toBe('image/svg+xml');
    // Last-declared icon wins, so ours must be last in <head>.
    expect(document.head.lastElementChild).toBe(badgeLink());
  });

  it('never removes or mutates an icon link it did not create', async () => {
    const before = baseLinks()[0];
    renderHook(() => useFaviconBadge(3));
    await waitFor(() => expect(badgeLink()).not.toBeNull());

    expect(before.isConnected).toBe(true);
    expect(before.getAttribute('href')).toBe(ORIGINAL_HREF);
    expect(baseLinks()).toHaveLength(1);
  });

  it('leaves every icon link it did not create intact, including non-SVG fallbacks', async () => {
    document.head.innerHTML =
      `<link rel="icon" type="image/svg+xml" href="/a.svg">` +
      `<link rel="icon" type="image/png" sizes="32x32" href="/a.png">`;

    renderHook(() => useFaviconBadge(3));
    await waitFor(() => expect(badgeLink()).not.toBeNull());

    const survivors = baseLinks();
    expect(survivors).toHaveLength(2);
    expect(survivors[0].getAttribute('href')).toBe('/a.svg');
    expect(survivors[0].getAttribute('type')).toBe('image/svg+xml');
    expect(survivors[1].getAttribute('href')).toBe('/a.png');
    expect(survivors[1].getAttribute('type')).toBe('image/png');
    expect(survivors[1].getAttribute('sizes')).toBe('32x32');
  });

  it('does not throw when React owns the icon link and its subtree is deleted', async () => {
    // React 19 hoists <link rel="icon"> into <head> and keeps a fiber pointing at
    // that DOM node. Removing it out from under React makes the commit phase throw
    // "Cannot read properties of null (reading 'removeChild')" when the fiber is
    // later deleted. The hook must therefore never touch a node it did not create.
    document.head.innerHTML = '';

    const { unmount } = render(
      <>
        <link rel="icon" type="image/svg+xml" href={ORIGINAL_HREF} />
        <Badger count={3} />
      </>,
    );

    await waitFor(() => expect(badgeLink()).not.toBeNull());

    // The React-owned node is still there, untouched.
    const reactOwned = baseLinks();
    expect(reactOwned).toHaveLength(1);
    expect(reactOwned[0].getAttribute('href')).toBe(ORIGINAL_HREF);

    expect(() => unmount()).not.toThrow();
    expect(badgeLink()).toBeNull();
  });

  it('replaces its own link rather than mutating its href', async () => {
    const { rerender } = renderHook(({ n }) => useFaviconBadge(n), { initialProps: { n: 3 } });
    await waitFor(() => {
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
    });
    const first = badgeLink();

    rerender({ n: 4 });
    await waitFor(() => {
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-4');
    });

    // Firefox ignores an in-place href change on the favicon link.
    expect(badgeLink()).not.toBe(first);
    expect(first!.isConnected).toBe(false);
  });

  it('clears the badge by inserting a fresh link carrying the base href, not by removing its own', async () => {
    // The field bug: Firefox does not re-evaluate the favicon when an icon link
    // is *removed* — a removal is not an insertion, so it keeps painting the
    // last icon it was handed and the stale "99+" badge sticks until a hard
    // reload. Clearing must therefore be an insertion: our own link is replaced
    // by a brand-new node carrying the original base href.
    const { rerender } = renderHook(({ n }) => useFaviconBadge(n), { initialProps: { n: 3 } });
    await waitFor(() => {
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
    });
    const badged = badgeLink()!;

    rerender({ n: 0 });
    await waitFor(() => expect(badgeLink()!.getAttribute('href')).toBe(ORIGINAL_HREF));

    const restored = badgeLink()!;
    expect(restored).not.toBe(badged); // a NEW node: an insertion, not an href swap
    expect(badged.isConnected).toBe(false);
    expect(restored.getAttribute('type')).toBe('image/svg+xml');
    expect(lastIconLink()).toBe(restored);

    // And the base link the page rendered is still untouched.
    const survivors = baseLinks();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].getAttribute('href')).toBe(ORIGINAL_HREF);
  });

  it('inserts the base-href link exactly once while the count stays at zero', async () => {
    const { rerender } = renderHook(({ n }) => useFaviconBadge(n), { initialProps: { n: 3 } });
    await waitFor(() => expect(badgeLink()).not.toBeNull());

    const appendSpy = vi.spyOn(document.head, 'appendChild');
    const ownAppends = () =>
      appendSpy.mock.calls.filter(
        ([node]) => node instanceof Element && node.matches('link[data-favicon-badge]'),
      ).length;

    rerender({ n: 0 });
    await waitFor(() => expect(badgeLink()!.getAttribute('href')).toBe(ORIGINAL_HREF));
    const restored = badgeLink()!;
    expect(ownAppends()).toBe(1);

    // Neither further renders at the same count nor unrelated <head> churn (an
    // observer tick) may re-insert it: no remove/append thrash on every tick.
    rerender({ n: 0 });
    rerender({ n: 0 });
    document.head.appendChild(document.createElement('meta'));
    await settle();

    expect(ownAppends()).toBe(1);
    expect(badgeLink()).toBe(restored);
    expect(document.querySelectorAll('link[data-favicon-badge]')).toHaveLength(1);
    appendSpy.mockRestore();
  });

  it('keeps its own link last even while it is only carrying the base href', async () => {
    const { rerender } = renderHook(({ n }) => useFaviconBadge(n), { initialProps: { n: 3 } });
    await waitFor(() => expect(badgeLink()).not.toBeNull());

    rerender({ n: 0 });
    await waitFor(() => expect(badgeLink()!.getAttribute('href')).toBe(ORIGINAL_HREF));
    const own = badgeLink()!;

    rehoistBaseIcon();
    await waitFor(() => expect(lastIconLink()).toBe(own));
    expect(badgeLink()).toBe(own); // moved, not recreated
  });

  it('badges again with a fresh insertion when the count leaves zero', async () => {
    const { rerender } = renderHook(({ n }) => useFaviconBadge(n), { initialProps: { n: 3 } });
    await waitFor(() => expect(badgeLink()).not.toBeNull());

    rerender({ n: 0 });
    await waitFor(() => expect(badgeLink()!.getAttribute('href')).toBe(ORIGINAL_HREF));
    const cleared = badgeLink()!;

    rerender({ n: 7 });
    await waitFor(() => {
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-7');
    });
    expect(badgeLink()).not.toBe(cleared);
    expect(cleared.isConnected).toBe(false);
    expect(lastIconLink()).toBe(badgeLink());
    expect(fetch).toHaveBeenCalledTimes(1); // the base is still fetched only once
    expect(baseLinks()).toHaveLength(1);
  });

  it('removes only its own link on unmount', async () => {
    const { unmount } = renderHook(() => useFaviconBadge(3));
    await waitFor(() => expect(badgeLink()).not.toBeNull());

    unmount();
    expect(badgeLink()).toBeNull();
    expect(baseLinks()).toHaveLength(1);
    expect(baseLinks()[0].getAttribute('href')).toBe(ORIGINAL_HREF);
  });

  it('does not fetch, and adds no link, while the count is zero', async () => {
    renderHook(() => useFaviconBadge(0));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).not.toHaveBeenCalled();
    expect(renderBadgedFaviconMock).not.toHaveBeenCalled();
    expect(badgeLink()).toBeNull();
    expect(baseLinks()).toHaveLength(1);
  });

  it('leaves the icon alone when the base is not SVG', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('binary', { headers: { 'content-type': 'image/png' } })),
    );
    renderHook(() => useFaviconBadge(3));
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    // Assert on the observable end state, not merely on the href being
    // unchanged: the href is also unchanged *before* the catch block runs,
    // so a href-only assertion would pass even if the code went on to swap
    // the icon a tick later. The renderer must never be reached.
    await waitFor(() => expect(renderBadgedFaviconMock).not.toHaveBeenCalled());
    expect(badgeLink()).toBeNull();
    expect(baseLinks()[0].getAttribute('href')).toBe(ORIGINAL_HREF);
  });

  it('leaves the icon alone when the base fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    renderHook(() => useFaviconBadge(3));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(renderBadgedFaviconMock).not.toHaveBeenCalled();
    expect(badgeLink()).toBeNull();
    expect(baseLinks()[0].getAttribute('href')).toBe(ORIGINAL_HREF);
  });

  it('does nothing when there is no icon link to read', async () => {
    document.head.innerHTML = '';
    renderHook(() => useFaviconBadge(3));
    await Promise.resolve(); // let any deferred async work start
    expect(fetch).not.toHaveBeenCalled();
    expect(renderBadgedFaviconMock).not.toHaveBeenCalled();
    expect(badgeLink()).toBeNull();
  });

  it('fetches the base icon exactly once under StrictMode and rapid count changes', async () => {
    // StrictMode double-invokes effects, and a count change while the fetch is in
    // flight re-runs the effect: neither may issue a second request.
    let resolveFetch: (response: Response) => void = () => {};
    const inFlight = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => inFlight),
    );

    const { rerender } = renderHook(({ n }) => useFaviconBadge(n), {
      initialProps: { n: 1 },
      wrapper: StrictMode,
    });

    rerender({ n: 2 });
    rerender({ n: 5 });
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFetch(svgResponse());
    await waitFor(() => {
      // The badge lands on the latest count, not the one in flight at fetch time.
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-5');
    });

    rerender({ n: 6 });
    await waitFor(() => {
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-6');
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-render the badge when the count is unchanged', async () => {
    const { rerender } = renderHook(({ n }) => useFaviconBadge(n), {
      initialProps: { n: 3 },
    });
    await waitFor(() => {
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
    });

    const settled = badgeLink();
    renderBadgedFaviconMock.mockClear();
    rerender({ n: 3 });

    // The element identity alone is not evidence: `count` is the effect's only
    // dependency, so React would skip the effect regardless. Assert the
    // renderer was not invoked again — that is the behaviour under test.
    expect(renderBadgedFaviconMock).not.toHaveBeenCalled();
    expect(badgeLink()).toBe(settled);
  });

  describe('when the setting is off', () => {
    it('adds no link and does not fetch, however high the count', async () => {
      renderHook(() => useFaviconBadge(3, false));
      await settle();

      expect(fetch).not.toHaveBeenCalled();
      expect(renderBadgedFaviconMock).not.toHaveBeenCalled();
      expect(badgeLink()).toBeNull();
      expect(baseLinks()).toHaveLength(1);
      expect(baseLinks()[0].getAttribute('href')).toBe(ORIGINAL_HREF);
    });

    it('clears a showing badge by inserting a fresh link carrying the base href', async () => {
      // Same guarantee as the count-back-to-zero clear, and for the same reason:
      // Firefox re-evaluates the favicon on an *insertion* and on nothing else.
      // Turning the setting off by *removing* our link would leave the stale
      // badge painted on the tab until a hard reload.
      const { rerender } = renderHook(({ on }) => useFaviconBadge(3, on), {
        initialProps: { on: true },
      });
      await waitFor(() => {
        expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
      });
      const badged = badgeLink()!;

      rerender({ on: false });
      await waitFor(() => expect(badgeLink()!.getAttribute('href')).toBe(ORIGINAL_HREF));

      const restored = badgeLink()!;
      expect(restored).not.toBe(badged); // a NEW node: an insertion, not an href swap
      expect(badged.isConnected).toBe(false);
      expect(restored.getAttribute('type')).toBe('image/svg+xml');
      expect(lastIconLink()).toBe(restored);

      // And the base link the page rendered is still untouched.
      const survivors = baseLinks();
      expect(survivors).toHaveLength(1);
      expect(survivors[0].getAttribute('href')).toBe(ORIGINAL_HREF);
    });

    it('re-badges with a fresh insertion when the setting is turned back on', async () => {
      const { rerender } = renderHook(({ on }) => useFaviconBadge(3, on), {
        initialProps: { on: true },
      });
      await waitFor(() => expect(badgeLink()).not.toBeNull());

      rerender({ on: false });
      await waitFor(() => expect(badgeLink()!.getAttribute('href')).toBe(ORIGINAL_HREF));
      const cleared = badgeLink()!;

      rerender({ on: true });
      await waitFor(() => {
        expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
      });
      expect(badgeLink()).not.toBe(cleared);
      expect(cleared.isConnected).toBe(false);
      expect(lastIconLink()).toBe(badgeLink());
      expect(fetch).toHaveBeenCalledTimes(1); // the base is still fetched only once
      expect(baseLinks()).toHaveLength(1);
    });

    it('keeps its base-href link last when React re-hoists its icon', async () => {
      const { rerender } = renderHook(({ on }) => useFaviconBadge(3, on), {
        initialProps: { on: true },
      });
      await waitFor(() => expect(badgeLink()).not.toBeNull());

      rerender({ on: false });
      await waitFor(() => expect(badgeLink()!.getAttribute('href')).toBe(ORIGINAL_HREF));
      const own = badgeLink()!;

      rehoistBaseIcon();
      await waitFor(() => expect(lastIconLink()).toBe(own));
      expect(badgeLink()).toBe(own); // moved, not recreated
    });
  });

  describe('when React re-hoists its icon link on a client-side navigation', () => {
    it('moves its own link back to the end so the badge keeps winning', async () => {
      // The field bug: Inbox badges the tab, a hop to /calendar makes React
      // re-insert its metadata <link rel="icon"> *after* ours, the base icon
      // wins again and the badge vanishes.
      renderHook(() => useFaviconBadge(3));
      await waitFor(() => expect(badgeLink()).not.toBeNull());
      expect(lastIconLink()).toBe(badgeLink());

      const own = badgeLink()!;
      const rehoisted = rehoistBaseIcon();
      expect(lastIconLink()).toBe(rehoisted); // the badge is now outranked

      await waitFor(() => expect(lastIconLink()).toBe(own));
      expect(document.head.lastElementChild).toBe(own);
      expect(badgeLink()).toBe(own); // moved, not recreated
      expect(rehoisted.isConnected).toBe(true); // and React's node is untouched
    });

    it('restores the badge without the count changing', async () => {
      // The "never comes back" half of the bug. Navigating back to the inbox
      // does not change the unread count, so nothing re-runs the count effect:
      // the observer alone must put the badge back on top.
      const { rerender } = renderHook(({ n }) => useFaviconBadge(n), { initialProps: { n: 3 } });
      await waitFor(() => {
        expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
      });

      renderBadgedFaviconMock.mockClear();
      rehoistBaseIcon();
      await waitFor(() => expect(lastIconLink()).toBe(badgeLink()));

      rerender({ n: 3 }); // same count: no effect re-run to lean on
      await settle();

      expect(lastIconLink()).toBe(badgeLink());
      expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
      expect(renderBadgedFaviconMock).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('re-applies the badge if its own link is removed entirely', async () => {
      renderHook(() => useFaviconBadge(3));
      await waitFor(() => expect(badgeLink()).not.toBeNull());

      badgeLink()!.remove(); // React blows away part of <head>

      await waitFor(() => {
        expect(badgeLink()!.getAttribute('href')).toBe('data:image/svg+xml,BADGED-3');
      });
      expect(lastIconLink()).toBe(badgeLink());
      expect(fetch).toHaveBeenCalledTimes(1); // the base is still fetched only once
    });

    it('settles: re-appending its own link does not feed the observer a loop', async () => {
      // Moving our link fires the observer again. If the move is not guarded by
      // "am I already last?", that second run moves it again, for ever. Count
      // the appends of *our* node: exactly one, and it must stop growing.
      renderHook(() => useFaviconBadge(3));
      await waitFor(() => expect(badgeLink()).not.toBeNull());
      const own = badgeLink()!;

      const appendSpy = vi.spyOn(document.head, 'appendChild');
      const ownAppends = () => appendSpy.mock.calls.filter(([node]) => node === own).length;

      rehoistBaseIcon();
      await waitFor(() => expect(lastIconLink()).toBe(own));
      expect(ownAppends()).toBe(1);

      await settle();
      expect(ownAppends()).toBe(1); // the observer's own mutation is a no-op
      expect(lastIconLink()).toBe(own);
      // Base + re-hoisted base + exactly one badge: nothing was duplicated.
      expect(iconLinks()).toHaveLength(3);
      expect(document.querySelectorAll('link[data-favicon-badge]')).toHaveLength(1);
      appendSpy.mockRestore();
    });

    it('still never removes or mutates a link it did not create', async () => {
      document.head.innerHTML =
        `<link rel="icon" type="image/svg+xml" href="/a.svg">` +
        `<link rel="icon" type="image/png" sizes="32x32" href="/a.png">`;

      const { unmount } = render(
        <>
          <link rel="icon" type="image/svg+xml" href={ORIGINAL_HREF} />
          <Badger count={3} />
        </>,
      );
      await waitFor(() => expect(badgeLink()).not.toBeNull());

      const rehoisted = rehoistBaseIcon();
      await waitFor(() => expect(lastIconLink()).toBe(badgeLink()));

      const survivors = baseLinks();
      expect(survivors).toHaveLength(4);
      expect(survivors.map((l) => l.getAttribute('href'))).toEqual([
        '/a.svg',
        '/a.png',
        ORIGINAL_HREF,
        ORIGINAL_HREF,
      ]);
      expect(survivors[1].getAttribute('type')).toBe('image/png');
      expect(survivors[1].getAttribute('sizes')).toBe('32x32');
      expect(rehoisted.isConnected).toBe(true);

      // The React-owned node is still React's to delete.
      expect(() => unmount()).not.toThrow();
    });

    it('disconnects the observer on unmount and leaves nothing of its own behind', async () => {
      const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
      const { unmount } = renderHook(() => useFaviconBadge(3));
      await waitFor(() => expect(badgeLink()).not.toBeNull());

      unmount();
      expect(disconnect).toHaveBeenCalled();
      expect(badgeLink()).toBeNull();

      // A post-unmount re-hoist must not resurrect the badge.
      rehoistBaseIcon();
      await settle();
      expect(badgeLink()).toBeNull();
      expect(baseLinks()).toHaveLength(2);
      disconnect.mockRestore();
    });
  });
});
