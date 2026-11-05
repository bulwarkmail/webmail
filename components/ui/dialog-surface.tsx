"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dialogSurfacesAvailable, openDialogSurface, type DialogSurface } from "@/lib/desktop/dialog-surface";

/**
 * The dialog window the tree below is drawn in, or null over the page. Menus and popovers
 * inside a dialog portal into its window (usePortalRoot), and a dialog opened from a
 * dialog hangs its window on that one.
 */
export const DialogSurfaceContext = createContext<DialogSurface | null>(null);

export function useDialogSurfaceContext(): DialogSurface | null {
  return useContext(DialogSurfaceContext);
}

/** Where a portal goes: the body of the dialog window it is drawn in, else the page's. */
export function usePortalRoot(): HTMLElement | null {
  const surface = useContext(DialogSurfaceContext);
  if (surface) return surface.doc.body;
  return typeof document === "undefined" ? null : document.body;
}

/** The window and document a component is drawn in: the dialog window's inside one. */
export function useOwnerWindow(): Window | null {
  const surface = useContext(DialogSurfaceContext);
  if (surface) return surface.win;
  return typeof window === "undefined" ? null : window;
}

const noChanges = () => () => {};

export type DialogSurfaceState =
  | { mode: "page" }
  /** The window is being made: draw nothing yet. */
  | { mode: "pending" }
  | { mode: "window"; surface: DialogSurface };

/**
 * A modal dialog's place while `isOpen`: a window of its own in the desktop app, the page
 * elsewhere. `onClose` runs when the user closes the window itself (Alt+F4, Cmd+W). If
 * the shell won't take the window, the dialog falls back to the page for this time.
 */
export function useDialogSurface(isOpen: boolean, { title, onClose, inPage = false }: { title: string; onClose: () => void; inPage?: boolean }): DialogSurfaceState {
  const parent = useContext(DialogSurfaceContext);
  const available = useSyncExternalStore(noChanges, dialogSurfacesAvailable, () => false);
  const [surface, setSurface] = useState<DialogSurface | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef({ title, onClose });
  useLayoutEffect(() => {
    latest.current = { title, onClose };
  });
  const wanted = isOpen && available && !failed && !inPage;

  useLayoutEffect(() => {
    if (!wanted) return;
    const opener = parent?.win ?? window;
    const opened = openDialogSurface(opener, {
      title: latest.current.title,
      onUserClose: () => latest.current.onClose(),
      onFailed: () => {
        setSurface(null);
        setFailed(true);
      },
    });
    if (!opened) {
      setFailed(true);
      return;
    }
    setSurface(opened);
    return () => {
      opened.close();
      setSurface(null);
    };
  }, [wanted, parent]);

  useEffect(() => {
    if (surface) surface.doc.title = title || "Bulwark";
  }, [surface, title]);

  // The next time it opens, try the window again.
  useEffect(() => {
    if (!isOpen) setFailed(false);
  }, [isOpen]);

  if (!wanted) return { mode: "page" };
  return surface ? { mode: "window", surface } : { mode: "pending" };
}

/** Draws `children` into the dialog window, with the context for what's inside. */
export function DialogSurfacePortal({ surface, children }: { surface: DialogSurface; children: ReactNode }) {
  return createPortal(<DialogSurfaceContext.Provider value={surface}>{children}</DialogSurfaceContext.Provider>, surface.root);
}
