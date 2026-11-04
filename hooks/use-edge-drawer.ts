import { useEffect, useLayoutEffect, useRef } from 'react';
import { useFocusTrap } from '@/hooks/use-focus-trap';

interface UseEdgeDrawerOptions {
  /** Whether the drawer is open over the page. */
  open: boolean;
  /** Closes it: Escape, and whatever else the caller wires (scrim, X, a pick). */
  onClose: () => void;
  /**
   * Where the focus goes back to when the button that opened the drawer is
   * gone by then (a header that rendered again).
   */
  returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * The keyboard side of a sidebar opened over the page as a drawer (Mail's
 * folders on a phone, Calendar, Contacts and Files below the full desktop):
 * the focus goes to the current item in it, else the first, Tab stays inside
 * until it closes, Escape closes it, and however it closes (Escape, the scrim,
 * a close button, a pick) the focus goes back to the button that opened it,
 * unless the pick moved it somewhere else on purpose.
 *
 * Returns the ref for the drawer's element.
 */
export function useEdgeDrawer({ open, onClose, returnFocus }: UseEdgeDrawerOptions) {
  const ref = useFocusTrap({
    isActive: open,
    onEscape: onClose,
    restoreFocus: false,
    initialFocus: () => ref.current?.querySelector<HTMLElement>(
      '[aria-current]:not(:disabled):not([tabindex="-1"])'
    ),
  });

  // The opener, read before the trap moves the focus into the drawer.
  const openerRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef(returnFocus);
  useLayoutEffect(() => {
    returnFocusRef.current = returnFocus;
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !ref.current?.contains(active)) {
      openerRef.current = active;
    }
  });

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      // The current item can sit in a folded group: then the first one.
      const root = ref.current;
      if (root && !root.contains(document.activeElement)) {
        root.querySelector<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )?.focus();
      }
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const active = document.activeElement;
    // A pick that moved the focus on (a dialog, a form) keeps it there.
    if (active && active !== document.body && !ref.current?.contains(active)) return;
    const opener = openerRef.current;
    openerRef.current = null;
    (opener?.isConnected ? opener : returnFocusRef.current?.())?.focus();
  }, [open, ref]);

  return ref;
}
