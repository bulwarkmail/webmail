"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { cn } from "@/lib/utils";
import { MvComposeWindowContext, type MvComposeWindowState } from "@/components/email/mv-compose-context";

/**
 * Mountain View's compose window: a panel docked at the bottom-right corner
 * over the mail list, which can be folded down to its title bar or opened up
 * to a large centred dialog. The composer inside stays mounted throughout, so
 * folding it keeps the draft exactly as it was. The composer draws the title
 * bar and its buttons itself, from MvComposeWindowContext.
 */
export function MvComposeWindow({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MvComposeWindowState>("normal");
  const minimized = state === "minimized";
  const maximized = state === "maximized";
  const controls = useMemo(() => ({ variant: "window" as const, state, setState }), [state]);
  // Opened up, the window covers the page behind a backdrop: a modal dialog
  // then, named by the composer's title bar, with Tab kept inside. Escape is
  // left to the composer.
  const windowRef = useFocusTrap({ isActive: maximized, restoreFocus: true, initialFocus: () => document.activeElement as HTMLElement | null });
  const fallbackTitleId = useId();
  const [titleId, setTitleId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!maximized) return;
    const heading = windowRef.current?.querySelector<HTMLElement>("[data-mv-compose-titlebar] h1, [data-mv-compose-titlebar] h2, [data-mv-compose-titlebar] h3");
    if (!heading) return;
    if (!heading.id) heading.id = fallbackTitleId;
    setTitleId(heading.id);
  }, [maximized, fallbackTitleId, windowRef]);

  return (
    <MvComposeWindowContext.Provider value={controls}>
      {maximized && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          aria-hidden
          onClick={() => setState("normal")}
        />
      )}
      <div
        ref={windowRef}
        role={maximized ? "dialog" : undefined}
        aria-modal={maximized ? true : undefined}
        aria-labelledby={maximized ? titleId : undefined}
        data-mv-compose-window=""
        data-state={state}
        className={cn(
          "fixed z-40 flex flex-col overflow-hidden bg-background shadow-[0_8px_10px_1px_rgb(0_0_0/0.14),0_3px_14px_2px_rgb(0_0_0/0.12),0_5px_5px_-3px_rgb(0_0_0/0.2)]",
          maximized
            ? "inset-x-[8vw] inset-y-[6vh] rounded-lg"
            : "bottom-0 end-[var(--mv-compose-end,1rem)] w-[min(560px,calc(100vw-var(--mv-compose-end,1rem)-1rem))] rounded-t-lg",
          minimized && "h-10 w-[min(280px,calc(100vw-var(--mv-compose-end,1rem)-1rem))]",
          state === "normal" && "h-[min(600px,calc(100dvh-5rem))]",
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </MvComposeWindowContext.Provider>
  );
}

const NOOP = () => {};

/**
 * Mountain View's inline reply: the composer as a card under the open
 * conversation, as Gmail writes replies, with a button that pops it out into
 * the docked window.
 */
export function MvComposeInline({ children, onPopOut }: { children: ReactNode; onPopOut: () => void }) {
  const controls = useMemo(
    () => ({ variant: "inline" as const, state: "normal" as const, setState: NOOP, popOut: onPopOut }),
    [onPopOut],
  );
  return (
    <MvComposeWindowContext.Provider value={controls}>
      <div
        data-mv-compose-inline=""
        className="flex h-[min(480px,70dvh)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-[0_1px_2px_0_rgb(60_64_67/0.3),0_2px_6px_2px_rgb(60_64_67/0.15)]"
      >
        {children}
      </div>
    </MvComposeWindowContext.Provider>
  );
}
