import { useEffect, useLayoutEffect, useRef } from 'react';

// The traps that are active, the one opened last at the end. Only that one
// answers Escape, so a dialog over a dialog closes alone.
const activeTraps: object[] = [];

interface UseFocusTrapOptions {
  isActive: boolean;
  onEscape?: () => void;
  restoreFocus?: boolean;
  /** Where the focus goes on open, instead of the first focusable element. */
  initialFocus?: () => HTMLElement | null | undefined;
  /**
   * The document the dialog was opened from, whose focused element gets the focus back.
   * Defaults to the page's. A dialog drawn in a window of its own has a document of its
   * own, which is not where the opener is.
   */
  openerDocument?: Document | null;
}

export function useFocusTrap({
  isActive,
  onEscape,
  restoreFocus = true,
  initialFocus,
  openerDocument,
}: UseFocusTrapOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  // Callers pass a new onEscape on every render. The trap reads the latest
  // one from here instead of starting over for it: each new start moved the
  // focus back to the opener and then to the first element, out of the field
  // the user was typing in whenever the page behind rendered again.
  // Updated during the commit, not after it: an Escape pressed once the
  // DOM has changed must reach the handler of that render, not the one
  // before (a form that just closed would ask about its input again).
  const onEscapeRef = useRef(onEscape);
  const initialFocusRef = useRef(initialFocus);
  const openerDocumentRef = useRef(openerDocument);
  useLayoutEffect(() => {
    onEscapeRef.current = onEscape;
    initialFocusRef.current = initialFocus;
    openerDocumentRef.current = openerDocument;
  });

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    // The dialog's own document: the page's, or its window's when it has one.
    const doc = container.ownerDocument;

    // Store the element that had focus before modal opened
    previousActiveElement.current = (openerDocumentRef.current ?? document).activeElement as HTMLElement;

    const token = {};
    activeTraps.push(token);
    const isTopmost = () => activeTraps[activeTraps.length - 1] === token;

    // A click on text in the dialog (a heading, a paragraph) would otherwise
    // move the focus to <body>, out of reach of the keydown listener below:
    // focusable, the container takes it instead.
    const addedTabIndex = !container.hasAttribute('tabindex');
    if (addedTabIndex) container.setAttribute('tabindex', '-1');

    // Get all focusable elements
    const getFocusableElements = () => {
      return container.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not(:disabled)'
      );
    };

    // The element in the dialog that had the focus last.
    let lastFocused: HTMLElement | null = null;
    const handleFocusIn = (e: FocusEvent) => {
      lastFocused = e.target as HTMLElement;
    };
    container.addEventListener('focusin', handleFocusIn);

    // Focus the requested element, else the first one
    const target = initialFocusRef.current?.() ?? getFocusableElements()[0];
    target?.focus();

    // Handle Tab key to trap focus
    const handleKeyDown = (e: KeyboardEvent) => {
      // Handle Escape
      if (e.key === 'Escape' && onEscapeRef.current) {
        if (!isTopmost()) return;
        // Escape closes the innermost layer only (R8): the page's own
        // handlers (Files clears its selection) must not see it too.
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }

      // Handle Tab
      if (e.key === 'Tab') {
        const focusableElements = getFocusableElements();
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey) {
          // Shift+Tab; from the container itself too, which has the focus
          // after a click on text and sits before the first element.
          if (doc.activeElement === firstElement || doc.activeElement === container) {
            lastElement?.focus();
            e.preventDefault();
          }
        } else {
          // Tab
          if (doc.activeElement === lastElement) {
            firstElement?.focus();
            e.preventDefault();
          }
        }
      }
    };

    container.addEventListener('keydown', handleKeyDown);

    // Escape with the focus outside the dialog: after a click on the
    // backdrop the focus is on <body>. The listener above has answered every
    // Escape from inside; a widget outside that already used the key (a
    // portalled dropdown closing) marks it handled.
    const handleDocumentKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !onEscapeRef.current) return;
      // Not instanceof Node: a dialog window's nodes come from that window's realm.
      const target = e.target as Node | null;
      if (target && typeof target.nodeType === 'number' && container.contains(target)) return;
      if (!isTopmost()) return;
      onEscapeRef.current();
    };
    doc.addEventListener('keydown', handleDocumentKeyDown);

    // A view change in the dialog (a list giving way to a form) can remove
    // the element that had the focus, which then drops to the page behind,
    // out of the trap. Bring it back to the first element - only then, so a
    // focus the user moved on purpose stays where it is.
    const observer = new MutationObserver(() => {
      const active = doc.activeElement;
      if (lastFocused && !lastFocused.isConnected && (!active || active === doc.body)) {
        getFocusableElements()[0]?.focus();
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    // Cleanup
    return () => {
      observer.disconnect();
      container.removeEventListener('focusin', handleFocusIn);
      container.removeEventListener('keydown', handleKeyDown);
      doc.removeEventListener('keydown', handleDocumentKeyDown);
      const index = activeTraps.indexOf(token);
      if (index !== -1) activeTraps.splice(index, 1);
      if (addedTabIndex) container.removeAttribute('tabindex');

      // Restore focus to previous element
      if (restoreFocus && previousActiveElement.current) {
        previousActiveElement.current.focus();
      }
    };
  }, [isActive, restoreFocus]);

  return containerRef;
}
