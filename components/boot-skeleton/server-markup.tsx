"use client";

import { useRef, useSyncExternalStore, type ReactNode } from "react";

const noSubscription = () => () => {};

/**
 * A page skeleton the browser keeps as the server drew it, without React
 * hydrating it. A skeleton is a few thousand elements of shapes that only
 * stand there until the page is ready, and hydrating them was work the first
 * screen waited for. Where React hydrates the server's markup, this renders an
 * element whose content it leaves alone; React takes the element away with
 * everything in it when the page stops drawing the skeleton. Drawn by the
 * client on its own (a page opened from another), the skeleton is React's as
 * any other markup. `display: contents`, so the wrapper adds no box.
 */
export function ServerMarkup({ children }: { children: ReactNode }) {
  // The server's snapshot is what React reads while hydrating.
  const hydrating = useSyncExternalStore(noSubscription, () => false, () => true);
  const fromServer = useRef<boolean | null>(null);
  if (fromServer.current === null) fromServer.current = hydrating;
  const onServer = typeof window === "undefined" || (globalThis as { __bulwarkServerRender?: boolean }).__bulwarkServerRender === true;
  if (!onServer && fromServer.current) {
    return <div data-server-markup="" style={{ display: "contents" }} suppressHydrationWarning dangerouslySetInnerHTML={KEEP} />;
  }
  return <div data-server-markup="" style={{ display: "contents" }}>{children}</div>;
}

// The same string on every render, so React never rewrites the server's content.
const KEEP = { __html: "" };
