"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from "react";

/**
 * The message list as one widget for keyboards and screen readers (SR-01,
 * SR-02): a treegrid with one Tab stop, whose rows are named in one sentence
 * (unread, sender, subject, date, flags); a conversation row expands into
 * its messages (aria-expanded, aria-level). A treegrid rather than a
 * listbox because rows hold controls (checkbox, star, hover actions), which
 * an option may not. j/k and the arrows move
 * the selection; the focus follows it, so a screen reader reads each row as
 * it gets there. The controls inside a row (checkbox, star, hover actions)
 * stay for the mouse but leave the Tab order: Space ticks the row, Enter
 * opens it, Shift+F10 or the menu key opens its actions.
 */

export const ROW_KEY_ATTR = "data-row-key";

/** One sentence that names a row, from the parts that apply, in reading order. */
export function rowLabel(parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join(", ");
}

interface RowA11yOptions {
  rowKey: string;
  label: string;
  /** The open message's row. */
  selected: boolean;
  /** A conversation row: whether it shows its messages. */
  expanded?: boolean;
  /** 2 for a message inside an expanded conversation. */
  level?: number;
  /** Ticked for a batch action; only set while something is ticked. */
  checked?: boolean;
  selectionMode: boolean;
  onToggleCheck: () => void;
  /** Opens the row's actions menu, as a right-click would. */
  onOpenMenu?: (e: ReactMouseEvent) => void;
}

/** Props for a row's outer element. */
export function rowA11yProps({ rowKey, label, selected, expanded, level = 1, checked, selectionMode, onToggleCheck, onOpenMenu }: RowA11yOptions) {
  return {
    role: "row" as const,
    // The list moves the single Tab stop (useListboxFocus); React leaves an
    // attribute it didn't change alone, so -1 here doesn't undo that.
    tabIndex: -1,
    [ROW_KEY_ATTR]: rowKey,
    "aria-label": label,
    // Ticked rows are the selection while something is ticked; otherwise the
    // open message is. aria-current marks the open message either way.
    "aria-selected": selectionMode ? !!checked : selected ? true : undefined,
    "aria-current": selected ? ("true" as const) : undefined,
    "aria-expanded": expanded,
    "aria-level": level,
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      // Keys from a control inside the row are that control's.
      if (e.target !== e.currentTarget) return;
      if (e.key === " ") {
        e.preventDefault();
        onToggleCheck();
      } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.currentTarget.click();
      } else if (onOpenMenu && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onOpenMenu({
          clientX: rect.left + Math.min(48, rect.width / 2),
          clientY: rect.top + rect.height / 2,
          preventDefault: () => {},
          stopPropagation: () => {},
          currentTarget: e.currentTarget,
          target: e.currentTarget,
        } as unknown as ReactMouseEvent);
      }
    },
  };
}

const FOCUSABLE_IN_ROW = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function rowFor(list: HTMLElement, key: string | undefined): HTMLElement | null {
  if (!key) return null;
  const k = CSS.escape(key);
  // A message's own row, else the collapsed conversation that holds it.
  return list.querySelector<HTMLElement>(`[role="row"][${ROW_KEY_ATTR}="${k}"]`)
    ?? list.querySelector<HTMLElement>(`[role="row"][data-thread-keys~="${k}"]`);
}

/** Whether the row's top edge shows in the list's scrolled view. */
function startsInView(list: HTMLElement, row: HTMLElement): boolean {
  const view = list.getBoundingClientRect();
  const top = row.getBoundingClientRect().top;
  return top >= view.top - 1 && top < view.bottom;
}

/**
 * The first row the user can see. The first row drawn is not it: the list
 * draws a few rows above the view, and focusing one scrolls up to it.
 */
function firstRowInView(list: HTMLElement): HTMLElement | null {
  for (const row of Array.from(list.querySelectorAll<HTMLElement>('[role="row"]'))) {
    if (startsInView(list, row)) return row;
  }
  return null;
}

/** Writes each rendered row's place in the whole list onto it. */
function applyPositions(list: HTMLElement): void {
  list.querySelectorAll<HTMLElement>("[data-pos]").forEach((wrapper) => {
    const row = wrapper.querySelector<HTMLElement>('[role="row"]');
    const setSize = wrapper.closest<HTMLElement>("[data-setsize]")?.dataset.setsize;
    if (!row || !setSize) return;
    if (row.getAttribute("aria-posinset") !== wrapper.dataset.pos) row.setAttribute("aria-posinset", wrapper.dataset.pos ?? "");
    if (row.getAttribute("aria-setsize") !== setSize) row.setAttribute("aria-setsize", setSize);
  });
}

/**
 * Keeps one Tab stop in the list (the open message's row, else the first
 * row in view), moves the focus with the selection while the focus is in
 * the list, and takes the controls inside rows out of the Tab order, also
 * the ones that mount later (hover actions appear on pointer-over).
 */
export function useListboxFocus(listRef: RefObject<HTMLElement | null>, activeKey: string | undefined, renderVersion: unknown): void {
  // Inner controls out of the Tab order.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const demote = (root: ParentNode) => {
      root.querySelectorAll<HTMLElement>('[role="row"] ' + FOCUSABLE_IN_ROW.split(", ").join(', [role="row"] ')).forEach((el) => {
        if (el.getAttribute("tabindex") !== "-1") el.setAttribute("tabindex", "-1");
      });
    };
    demote(list);
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "childList" && r.addedNodes.length) { demote(list); return; }
        if (r.type === "attributes" && r.target instanceof HTMLElement && r.target.closest('[role="row"]') && r.target.getAttribute("role") !== "row") {
          // Only change what isn't -1 yet: writing the same value again is a
          // mutation too, and would call this observer forever.
          if (r.target.matches(FOCUSABLE_IN_ROW) && r.target.getAttribute("tabindex") !== "-1") r.target.setAttribute("tabindex", "-1");
        }
      }
    });
    observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["tabindex"] });
    // The list itself takes the focus from the skip link and from the focus
    // rescue after a delete; hand it on to the row that holds the Tab stop,
    // or to the first row in view when that one is scrolled out of it. The
    // rescue also lands here when the focused row scrolled out and was
    // unmounted, so this must never scroll the list.
    const onFocus = (e: FocusEvent) => {
      if (e.target !== list) return;
      const stop = list.querySelector<HTMLElement>('[role="row"][tabindex="0"]');
      const row = stop && startsInView(list, stop) ? stop : firstRowInView(list) ?? stop;
      row?.focus({ preventScroll: true });
    };
    list.addEventListener("focus", onFocus);
    return () => {
      observer.disconnect();
      list.removeEventListener("focus", onFocus);
    };
  }, [listRef]);

  // The selection the focus last went along with, and whether it still has
  // to go to that selection's row once the list draws it.
  const followedKey = useRef(activeKey);
  const follow = useRef(false);
  // The row that had the focus, and the message it showed then.
  const focusedRow = useRef<{ row: HTMLElement; key: string | null } | null>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onFocusIn = (e: FocusEvent) => {
      const row = e.target instanceof HTMLElement && e.target.getAttribute("role") === "row" ? e.target : null;
      focusedRow.current = row ? { row, key: row.getAttribute(ROW_KEY_ATTR) } : null;
    };
    list.addEventListener("focusin", onFocusIn);
    return () => list.removeEventListener("focusin", onFocusIn);
  }, [listRef]);

  // The single Tab stop, and the focus following the selection.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    applyPositions(list);
    // Only when the selection moves (j/k, the next row after a delete) and
    // the focus is in the list: never pull it out of the reader, the
    // composer or a dialog. Rows scrolling in or out don't move it, or
    // scrolling away from the open message would jump back to it.
    if (followedKey.current !== activeKey) {
      followedKey.current = activeKey;
      follow.current = list.contains(document.activeElement);
    }
    const row = rowFor(list, activeKey);
    const target = row ?? firstRowInView(list) ?? list.querySelector<HTMLElement>('[role="row"]');
    list.querySelectorAll<HTMLElement>('[role="row"][tabindex="0"]').forEach((el) => {
      if (el !== target) el.setAttribute("tabindex", "-1");
    });
    if (!target) return;
    target.setAttribute("tabindex", "0");
    // The list keeps a row on screen for the next message at its place (a
    // folder switch, a search; see useRowSlots). A focused row that now shows
    // another message hands the focus on through the list to its Tab stop,
    // as a row taken down and built new did, so the move is announced
    // instead of the focus sitting on a row that changed under it.
    const held = focusedRow.current;
    if (held && document.activeElement === held.row && held.row.getAttribute(ROW_KEY_ATTR) !== held.key) {
      focusedRow.current = null;
      list.focus({ preventScroll: true });
      return;
    }
    if (!follow.current || !row) return;
    follow.current = false;
    const active = document.activeElement;
    if (active && active !== row && list.contains(active)) {
      row.focus({ preventScroll: false });
    }
  }, [listRef, activeKey, renderVersion]);
}
