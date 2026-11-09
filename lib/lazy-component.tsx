"use client";

import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

/**
 * A component whose code is fetched the first time it renders, in a chunk of
 * its own, instead of with the page. Until it arrives it draws `fallback`
 * (nothing by default) in place, inside its own Suspense boundary, so the rest
 * of the page stays as it is.
 *
 * For what only shows on request: a dialog drawn while it's open, a pane that
 * needs a click first. Unlike next/dynamic it renders in unit tests too.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  fallback: ReactNode = null,
): ComponentType<P> {
  const Loaded = lazy(async () => ({ default: await load() }));
  function LazyComponent(props: P) {
    return (
      <Suspense fallback={fallback}>
        <Loaded {...props} />
      </Suspense>
    );
  }
  return LazyComponent;
}
