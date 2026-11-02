import { create } from "zustand";
import { flushSync } from "react-dom";
import type { CalendarEvent, ContactCard } from "@/lib/jmap/types";
import type { DirectoryEntry } from "@/stores/contact-store";
import { canPrintAnywhere } from "@/lib/device-policy";

/**
 * What a Print action asked for. Ctrl+P asks for nothing in particular: the
 * page then prints what it shows (its default).
 */
export type PrintTarget =
  | { kind: "contact-list" }
  | { kind: "contact"; contact: ContactCard; photoUri?: string }
  | { kind: "contact-group"; group: ContactCard }
  | { kind: "directory-list" }
  | { kind: "directory-entry"; entry: DirectoryEntry }
  | { kind: "calendar-view" }
  | { kind: "calendar-event"; event: CalendarEvent };

interface PrintStore {
  /** True from the moment printing starts until the browser is done with it. */
  printing: boolean;
  /** The explicit request, or null while printing what the page shows. */
  target: PrintTarget | null;
}

export const usePrintStore = create<PrintStore>(() => ({
  printing: false,
  target: null,
}));

/**
 * Puts the print copy into the page right away: the browser lays the page
 * out for printing as soon as the handler that started it returns, so the
 * copy must be in the DOM by then.
 */
function startPrinting(target: PrintTarget | null): void {
  saveScrollOffsets();
  flushSync(() => usePrintStore.setState({ printing: true, target }));
}

function stopPrinting(): void {
  if (!usePrintStore.getState().printing) return;
  usePrintStore.setState({ printing: false, target: null });
  restoreScrollOffsets();
}

/*
 * While the copy prints, the app is display: none, which drops the scroll
 * offsets of its panes, and the views that measure themselves (the week
 * strip) recompute from a zero size. Their offsets are put back once the
 * page is laid out for the screen again.
 */
let savedOffsets: Array<[Element, number, number]> = [];

function saveScrollOffsets(): void {
  savedOffsets = [];
  document.querySelectorAll("body *").forEach((el) => {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) savedOffsets.push([el, el.scrollTop, el.scrollLeft]);
  });
}

function restoreScrollOffsets(): void {
  const offsets = savedOffsets;
  savedOffsets = [];
  if (offsets.length === 0) return;
  // After the frame in which resize observers and their effects ran.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const [el, top, left] of offsets) {
      if (!el.isConnected) continue;
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }));
}

const IMAGE_WAIT_MS = 3000;

/** Waits for the print copy's images (a contact photo) so they are not printed blank. */
async function waitForPrintImages(): Promise<void> {
  const images = Array.from(document.querySelectorAll<HTMLImageElement>("[data-print-root] img"));
  if (images.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(images.map((img) => img.decode().catch(() => undefined))),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, IMAGE_WAIT_MS); }),
  ]);
  clearTimeout(timer);
}

/**
 * A Print button: renders the copy of `target` and opens the browser's print
 * dialog, which gives the same page Ctrl+P would for that view.
 */
export async function requestPrint(target: PrintTarget): Promise<void> {
  if (usePrintStore.getState().printing) return;
  // Organisation > Devices > No printing (the buttons are hidden then).
  if (!canPrintAnywhere()) return;
  startPrinting(target);
  await waitForPrintImages();
  if (!usePrintStore.getState().printing) return;
  window.print();
  // Browsers whose print() returns before the dialog closes reset on afterprint.
}

let listeners = 0;
let printQuery: MediaQueryList | null = null;

const handleBeforePrint = () => {
  if (!usePrintStore.getState().printing) startPrinting(null);
};
const handleAfterPrint = () => stopPrinting();
// Safari has fired beforeprint late or not at all; the print media query
// changes in every browser.
const handlePrintQuery = (e: MediaQueryListEvent) => {
  if (e.matches) handleBeforePrint();
  else handleAfterPrint();
};

/**
 * Listens for the browser's own printing (Ctrl+P, the menu) while a page with
 * a print copy is mounted. Returns the cleanup.
 */
export function listenForPrinting(): () => void {
  if (typeof window === "undefined") return () => {};
  if (listeners++ === 0) {
    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);
    printQuery = typeof window.matchMedia === "function" ? window.matchMedia("print") : null;
    printQuery?.addEventListener?.("change", handlePrintQuery);
  }
  return () => {
    if (--listeners > 0) return;
    window.removeEventListener("beforeprint", handleBeforePrint);
    window.removeEventListener("afterprint", handleAfterPrint);
    printQuery?.removeEventListener?.("change", handlePrintQuery);
    printQuery = null;
    stopPrinting();
  };
}
