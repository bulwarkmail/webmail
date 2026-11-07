"use client";

import { memo, type ComponentType } from "react";
import { useStableEach } from "@/hooks/use-stable-each";

type Handler = (...args: never[]) => unknown;

/**
 * The component, drawn again only when a prop other than a handler changes.
 * The mail page re-renders for every open, search and folder switch and
 * hands its children new inline handlers each time; the wrapper gives the
 * memoised component handlers that keep their identity and forward to the
 * latest ones. Every other prop must keep its identity while unchanged.
 */
export function withStableHandlers<P extends object>(Component: ComponentType<P>): ComponentType<P> {
  const Inner = memo(Component) as unknown as ComponentType<P>;
  function Stable(props: P) {
    const handlers: Record<string, Handler> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "function") handlers[key] = value as Handler;
    }
    const stable = useStableEach(handlers);
    return <Inner {...props} {...(stable as Partial<P>)} />;
  }
  Stable.displayName = `Stable(${Component.displayName || Component.name || "Component"})`;
  return Stable;
}
