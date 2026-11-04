"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useEdgeDrawer } from "@/hooks/use-edge-drawer";

interface DrawerScrimProps {
  onClose: () => void;
  /** In a Pro pane: dims the pane only, not the other one beside it. */
  contained?: boolean;
  className?: string;
  "data-testid"?: string;
}

/**
 * The dimmed page behind a drawer. A click on it closes the drawer; the
 * click, not the press, so it can't go through to what is under it.
 */
export function DrawerScrim({ onClose, contained, className, "data-testid": testId = "drawer-scrim" }: DrawerScrimProps) {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      data-drawer-scrim=""
      className={cn("inset-0 bg-black/50 z-40", contained ? "absolute" : "fixed", className)}
      onClick={() => onClose()}
    />
  );
}

interface EdgeDrawerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  onClose: () => void;
  /**
   * In a Pro pane or Mountain View's card: at the start edge of the nearest
   * positioned box instead of the window's.
   */
  contained?: boolean;
  /** Where the focus goes back to when the opener is gone by then. */
  returnFocus?: () => HTMLElement | null | undefined;
  children: ReactNode;
}

/**
 * A sidebar opened over the page below the full desktop, as Mail's folders
 * do: from the window's start edge (the right in RTL), over the app rail,
 * from under the top bar and the window's controls (--drawer-top) to the
 * bottom, with the page dimmed behind it. Keyboard and focus: useEdgeDrawer.
 * Closed, it is off-screen and out of reach: no clicks, no Tab stops.
 */
export function EdgeDrawer({ open, onClose, contained, returnFocus, className, children, ...rest }: EdgeDrawerProps) {
  const ref = useEdgeDrawer({ open, onClose, returnFocus });
  return (
    <>
      {open && <DrawerScrim onClose={onClose} contained={contained} />}
      <div
        {...rest}
        ref={ref}
        data-edge-drawer=""
        inert={!open}
        className={cn(
          "z-50 w-72 max-w-[85%] flex flex-col",
          contained ? "absolute inset-y-0 start-0" : "fixed start-0 top-[var(--drawer-top)] bottom-0",
          "transform duration-300 ease-in-out",
          // Visible at once on opening, so the focus can go in straight away
          // (a visibility transition keeps it hidden for that first frame);
          // hidden only once it has slid out on closing.
          open ? "shadow-xl transition-transform" : "invisible -translate-x-full rtl:translate-x-full transition-[transform,visibility]",
          className
        )}
      >
        {children}
      </div>
    </>
  );
}
