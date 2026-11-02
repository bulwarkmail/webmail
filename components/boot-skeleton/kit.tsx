/**
 * The page skeleton kit.
 *
 * Plain markup with no hooks, no store reads and no next-intl, so the same
 * component renders on the server (before any JS runs), during hydration and
 * inside a loaded page's own loading state, and Lite pages without a message
 * catalog can draw it too. Variants are picked by CSS from the `data-boot-*`
 * attributes the boot script sets on <html> (lib/boot-skeleton/boot-script.ts);
 * the classes behind them live in app/boot-skeleton.css.
 */
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type SkeletonSurface =
  | "mail"
  | "calendar"
  | "contacts"
  | "files"
  | "apps"
  | "settings"
  | "pro"
  | "admin"
  | "admin-login"
  | "login"
  | "setup";

interface RegionProps {
  /** Which page this is the skeleton of; tests and the probes look for it. */
  surface: SkeletonSurface;
  /**
   * The one polite "Loading" announcement for the whole page. Leave it out
   * only where no translation is at hand (Lite before its catalog loads).
   */
  label?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * The outermost element of a page skeleton: marks the page busy and carries
 * the single status message. Everything visual inside is aria-hidden.
 */
export function SkeletonRegion({ surface, label, className, style, children }: RegionProps) {
  return (
    <div data-boot-skeleton={surface} aria-busy="true" className={className} style={style}>
      {label ? <span role="status" className="sr-only">{label}</span> : null}
      {children}
    </div>
  );
}

interface ShapeProps {
  className?: string;
  /** Width as any CSS length, e.g. "60%" or "8rem". */
  w?: string;
  style?: CSSProperties;
}

/** A placeholder for a line of text: give it a height (h-3, h-4) and a width. */
export function Bar({ className, w, style }: ShapeProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("sk-shape block h-3 rounded", className)}
      style={w ? { ...style, width: w } : style}
    />
  );
}

/** A placeholder for an avatar or a round button: give it a size (w-8 h-8). */
export function Circle({ className, style }: Omit<ShapeProps, "w">) {
  return <span aria-hidden="true" className={cn("sk-shape block shrink-0 rounded-full", className)} style={style} />;
}

/** A placeholder for a box: a button, an input, a card. */
export function Block({ className, w, style }: ShapeProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("sk-shape block rounded-md", className)}
      style={w ? { ...style, width: w } : style}
    />
  );
}

/**
 * Widths for placeholder text that look like text: varied, but the same on
 * every render (no randomness, so server and client markup agree).
 */
export function textWidth(i: number, min = 40, spread = 45): string {
  return `${min + ((i * 37 + 11) % spread)}%`;
}

/** `count` items from `render`, keyed by index. */
export function repeat(count: number, render: (i: number) => ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < count; i++) out.push(<Fragment key={i}>{render(i)}</Fragment>);
  return out;
}
