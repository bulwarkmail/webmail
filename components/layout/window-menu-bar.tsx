"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Archive, ArrowLeft, ArrowRight, BookOpen, Calendar, CalendarDays, CalendarPlus, Check, CheckSquare, ChevronDown,
  ChevronRight, ChevronUp, Clipboard, Copy, Download, ExternalLink, FileText, FolderInput, Forward, Inbox, Info, Keyboard,
  Lock, LogOut, Mail, MailOpen, Maximize2, Minus, Paperclip, PanelRight, Printer, RefreshCw, Reply, ReplyAll, Save, Scissors,
  Search, Send, Settings, ShieldAlert, SquarePen, Star, Trash2, Undo, Redo, Upload, UserPlus, Users, Folder, ZoomIn, ZoomOut,
  Server, RotateCcw, LayoutGrid, LayoutList, LayoutTemplate, Zap, Power,
} from "@/components/icons";
import { CONTEXT_MENU_PANEL_CLASS, MenuShortcut } from "@/components/ui/context-menu";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { MENU_BAR_ATTRIBUTE, cachedMenuBarPinned, menuKeyText, rememberMenuBarPinned } from "@/lib/desktop/menu-bar";
import type { DesktopMenuBarEntry, DesktopMenuBarItem, DesktopMenuBarMenu } from "@/lib/desktop/types";
import { watchTitlebarArea } from "@/lib/window-controls-overlay";
import { cn } from "@/lib/utils";

/**
 * The desktop app's menu bar where the window's controls sit over the page (Windows and
 * Linux), as Thunderbird has it. Alt shows it as a row at the top that moves the app down
 * under it, and the window's controls shrink into that row; "Always show the menu bar"
 * keeps it. Alt, Escape or a click elsewhere hides it again. Alt and a letter opens that
 * menu, with the letters underlined while the keys are on the bar, and the arrows go
 * between menus and lines. The menus are the shell's own (src/main/menu.ts in the desktop
 * repo), with what's enabled and ticked now, and a pick runs the very item the native
 * menu has. macOS keeps its system bar.
 *
 * A shell from before this gives only the names, and opens each menu natively.
 */

const LINE = "[data-menu-line]";

type Glyph = React.ComponentType<{ className?: string }>;

/**
 * The icon of each line of the shell's menus, by its id (src/main/menu.ts in the desktop
 * repo; a role's line comes as `role.<role>`), so the bar's menus look like every other
 * menu in the app. A shell that sends no ids gets the lines without icons.
 */
const MENU_BAR_ICONS: Record<string, Glyph> = {
  "file.newMessage": SquarePen, "file.newEvent": CalendarPlus, "file.newTask": CheckSquare, "file.newContact": UserPlus,
  "file.quickCompose": Zap, "file.newWindow": ExternalLink, "file.print": Printer, "file.savePdf": Download,
  "file.import": Upload, "file.importMenu": Upload, "file.importCalendar": Calendar, "file.importContacts": Users,
  "file.settings": Settings, "app.settings": Settings, "file.switchMode": Server, "file.lock": Lock, "file.close": Minus,
  "file.quit": Power, "role.quit": Power, "role.close": Minus,
  "role.undo": Undo, "role.redo": Redo, "role.cut": Scissors, "role.copy": Copy, "role.paste": Clipboard,
  "role.selectAll": CheckSquare, "role.selectall": CheckSquare, "edit.search": Search,
  "view.refresh": RefreshCw, "view.calendar.day": CalendarDays, "view.calendar.week": CalendarDays,
  "view.calendar.month": CalendarDays, "view.calendar.agenda": CalendarDays, "view.readingPane": PanelRight,
  "view.layout.split": PanelRight, "view.layout.horizontal": LayoutList, "view.layout.focus": LayoutTemplate,
  "view.zoomIn": ZoomIn, "view.zoomOut": ZoomOut, "view.zoomReset": RotateCcw,
  "role.togglefullscreen": Maximize2, "role.toggleFullScreen": Maximize2,
  "compose.send": Send, "compose.saveDraft": Save, "compose.attach": Paperclip,
  "message.reply": Reply, "message.replyAll": ReplyAll, "message.forward": Forward, "message.markRead": MailOpen,
  "message.markUnread": Mail, "message.star": Star, "message.move": FolderInput, "message.archive": Archive,
  "message.spam": ShieldAlert, "message.delete": Trash2, "message.openWindow": ExternalLink,
  "go.inbox": Inbox, "go.sent": Send, "go.drafts": FileText, "go.nextMessage": ChevronDown, "go.previousMessage": ChevronUp,
  "go.nextUnread": MailOpen, "go.mail": Mail, "go.calendar": Calendar, "go.contacts": Users, "go.files": Folder,
  "go.back": ArrowLeft, "go.forward": ArrowRight, "go.today": CalendarDays, "go.nextPeriod": ChevronRight,
  "go.previousPeriod": ArrowLeft,
  "window.minimize": Minus, "role.minimize": Minus, "window.cycle": LayoutGrid,
  "help.shortcuts": Keyboard, "help.docs": BookOpen, "help.updates": Download, "help.restart": RefreshCw, "help.about": Info,
  "role.about": Info, "app.lock": Lock, "file.unlock": Lock, "app.logout": LogOut,
};
const ENABLED_LINE = `${LINE}:not([aria-disabled="true"])`;

type Focus = { kind: "name"; index: number } | { kind: "line" | "panel"; sub?: boolean };

/** The label with its letter underlined, while the keys are on the bar. */
function Label({ text, at, cue }: { text: string; at: number | undefined; cue: boolean }) {
  if (!cue || at === undefined || at < 0 || at >= text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="underline underline-offset-2">{text[at]}</span>
      {text.slice(at + 1)}
    </>
  );
}

function nameLetterAt(entry: DesktopMenuBarEntry): number | undefined {
  if (!entry.mnemonic) return undefined;
  const at = entry.label.toLowerCase().indexOf(entry.mnemonic);
  return at >= 0 ? at : undefined;
}

function letterOf(item: DesktopMenuBarItem): string | undefined {
  return item.mnemonic !== undefined ? item.label[item.mnemonic]?.toLowerCase() : undefined;
}

function usable(item: DesktopMenuBarItem | undefined): item is DesktopMenuBarItem {
  return !!item && item.type !== "separator" && item.enabled;
}

const EDGE = 4;

/**
 * A menu that would leave the window moves back in. A submenu sits beside its line, on the
 * reading side, or the other side where there's no room, and never below the window.
 */
function keepInside(root: HTMLElement | null): void {
  if (!root) return;
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const panel = root.querySelector<HTMLElement>("[data-menu-panel]");
  if (panel) {
    panel.style.translate = "";
    const rect = panel.getBoundingClientRect();
    if (rect.right > width - EDGE) panel.style.translate = `${Math.round(width - EDGE - rect.right)}px 0`;
    else if (rect.left < EDGE) panel.style.translate = `${Math.round(EDGE - rect.left)}px 0`;
  }
  const subpanel = root.querySelector<HTMLElement>("[data-menu-subpanel]");
  const line = panel?.querySelector<HTMLElement>(`${LINE}[aria-expanded="true"]`);
  if (!panel || !subpanel || !line) return;
  const outer = panel.getBoundingClientRect();
  const at = line.getBoundingClientRect();
  const own = subpanel.getBoundingClientRect();
  const rtl = getComputedStyle(root).direction === "rtl";
  const after = outer.right - EDGE;
  const before = outer.left + EDGE - own.width;
  const fitsAfter = after + own.width <= width - EDGE;
  const fitsBefore = before >= EDGE;
  const left = rtl ? (fitsBefore ? before : after) : fitsAfter || !fitsBefore ? Math.min(after, width - EDGE - own.width) : before;
  subpanel.style.left = `${Math.round(Math.max(EDGE, left))}px`;
  subpanel.style.top = `${Math.round(Math.max(EDGE, Math.min(at.top - EDGE, height - EDGE - own.height)))}px`;
}

export function WindowMenuBar() {
  const t = useTranslations("desktopUi.menu");
  const [desktop, setDesktop] = useState(false);
  const [hasOverlay, setHasOverlay] = useState(false);
  const [pinned, setPinned] = useState(false);
  /** The keys are on the bar: Alt was pressed, or a menu was opened. */
  const [active, setActive] = useState(false);
  const [menus, setMenus] = useState<DesktopMenuBarMenu[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  /** The line of the open menu whose submenu is open. */
  const [sub, setSub] = useState<number | null>(null);
  /** Underlined letters: the keys brought the bar, not the mouse. */
  const [cue, setCue] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<Focus | null>(null);

  const shown = desktop && hasOverlay && (pinned || active);
  const drawsMenus = desktop && !!getDesktopBridge()?.menu?.bar?.menus;

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.menu?.bar || bridge.platform === "darwin") return;
    setDesktop(true);
    setPinned(cachedMenuBarPinned());
    return watchTitlebarArea((area) => setHasOverlay(area !== null));
  }, []);

  const refresh = useCallback(async (): Promise<DesktopMenuBarMenu[] | null> => {
    const bar = getDesktopBridge()?.menu?.bar;
    if (!bar) return null;
    const list = bar.menus
      ? await bar.menus().catch(() => null)
      : await bar.entries().then((entries) => entries.map((entry) => ({ ...entry, items: [] }))).catch(() => null);
    if (list) setMenus(list);
    return list;
  }, []);

  const rememberFocus = useCallback(() => {
    const now = document.activeElement;
    if (now instanceof HTMLElement && now !== document.body && !barRef.current?.contains(now)) previousFocus.current = now;
  }, []);

  /** Back to how it was before Alt: the menus shut, the keys back where they were. */
  const deactivate = useCallback(() => {
    setOpen(null);
    setSub(null);
    setActive(false);
    setCue(false);
    const back = previousFocus.current;
    previousFocus.current = null;
    if (barRef.current?.contains(document.activeElement)) {
      if (back?.isConnected) back.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
    }
  }, []);

  // The shell: Alt, Alt and a letter, the window losing the focus, the setting.
  useEffect(() => {
    if (!desktop) return;
    const bar = getDesktopBridge()?.menu?.bar;
    if (!bar) return;
    const stop = bar.onEvent((event) => {
      if (typeof event.pinned === "boolean") {
        setPinned(event.pinned);
        rememberMenuBarPinned(event.pinned);
      }
      if (!event.visible) {
        deactivate();
        return;
      }
      rememberFocus();
      setActive(true);
      setCue(true);
      setSub(null);
      // Set now: the names may be drawn before the menus arrive, and take it then.
      pendingFocus.current = event.open && bar.menus ? { kind: "line" } : { kind: "name", index: 0 };
      void refresh().then((list) => {
        const index = event.open ? (list ?? []).findIndex((menu) => menu.id === event.open) : -1;
        if (index >= 0 && bar.menus) setOpen(index);
        else setOpen(null);
      });
    });
    // Listening now: the shell answers with whether the bar is always there.
    bar.report?.({ height: 0, active: false });
    return stop;
  }, [desktop, refresh, deactivate, rememberFocus]);

  // An always-shown bar has its names from the start.
  useEffect(() => {
    if (shown && !menus) void refresh();
  }, [shown, menus, refresh]);

  // The row it takes: everything else moves down under it, and the controls fit into it.
  useLayoutEffect(() => {
    if (!desktop) return;
    document.documentElement.toggleAttribute(MENU_BAR_ATTRIBUTE, shown);
    const height = shown ? Math.round(barRef.current?.getBoundingClientRect().height ?? 0) : 0;
    getDesktopBridge()?.menu?.bar?.report?.({ height, active });
  }, [desktop, shown, active]);

  useEffect(() => () => document.documentElement.removeAttribute(MENU_BAR_ATTRIBUTE), []);

  // Menus stay in the window; the focus goes where the keys asked, once it's drawn.
  useLayoutEffect(() => {
    const root = barRef.current;
    keepInside(root);
    const want = pendingFocus.current;
    if (!want || !root) return;
    let target: HTMLElement | null = null;
    if (want.kind === "name") {
      target = root.querySelectorAll<HTMLElement>("[data-menu-name]")[want.index] ?? null;
    } else {
      const panel = root.querySelector<HTMLElement>(want.sub ? "[data-menu-subpanel]" : "[data-menu-panel]");
      target = want.kind === "panel" ? panel : panel?.querySelector<HTMLElement>(ENABLED_LINE) ?? panel ?? null;
    }
    if (!target) return;
    pendingFocus.current = null;
    target.focus({ preventScroll: true });
  });

  // A click anywhere else puts it all away.
  useEffect(() => {
    if (!active && open === null) return;
    const onDown = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      deactivate();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [active, open, deactivate]);

  const openMenu = useCallback((index: number, focus: "line" | "panel") => {
    if (!drawsMenus) {
      const entry = menus?.[index];
      const button = barRef.current?.querySelectorAll<HTMLElement>("[data-menu-name]")[index];
      if (!entry || !button) return;
      const rect = button.getBoundingClientRect();
      getDesktopBridge()?.menu?.bar?.open(entry.id, { x: rect.left, y: rect.bottom });
      return;
    }
    setActive(true);
    setOpen(index);
    setSub(null);
    pendingFocus.current = { kind: focus };
    // What's enabled may have changed since the bar showed.
    void refresh();
  }, [drawsMenus, menus, refresh]);

  const run = useCallback((item: DesktopMenuBarItem) => {
    if (!usable(item)) return;
    // Cut, Copy and Paste work on what had the focus, so it has it back first.
    deactivate();
    getDesktopBridge()?.menu?.bar?.run?.(item.key, item.label);
  }, [deactivate]);

  if (!shown) return null;

  const list = menus ?? [];
  const openItems = open !== null ? list[open]?.items ?? [] : [];
  const subItems = sub !== null ? openItems[sub]?.items ?? [] : [];

  const names = () => Array.from(barRef.current?.querySelectorAll<HTMLElement>("[data-menu-name]") ?? []);
  const linesIn = (selector: string) => Array.from(barRef.current?.querySelector(selector)?.querySelectorAll<HTMLElement>(ENABLED_LINE) ?? []);

  const step = (lines: HTMLElement[], delta: number) => {
    if (lines.length === 0) return;
    const at = lines.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (delta > 0 ? 0 : lines.length - 1) : (at + delta + lines.length) % lines.length;
    lines[next]?.focus({ preventScroll: true });
  };

  const openSub = (index: number) => {
    setSub(index);
    pendingFocus.current = { kind: "line", sub: true };
  };

  const closeSub = () => {
    const parent = sub;
    setSub(null);
    barRef.current?.querySelector<HTMLElement>(`[data-menu-panel] [data-menu-line="${parent}"]`)?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const rtl = getComputedStyle(barRef.current ?? document.documentElement).direction === "rtl";
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const backward = rtl ? "ArrowRight" : "ArrowLeft";
    const inSub = !!target.closest("[data-menu-subpanel]");
    const inMenu = inSub || !!target.closest("[data-menu-panel]");
    const key = event.key;
    const plainLetter = key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    setCue(true);

    if (key === "Tab") {
      take();
      deactivate();
      return;
    }

    if (!inMenu) {
      const at = names().indexOf(target);
      if (key === forward || key === backward) {
        take();
        step(names(), key === forward ? 1 : -1);
      } else if (key === "ArrowDown" || key === "Enter" || key === " ") {
        take();
        if (at >= 0) openMenu(at, "line");
      } else if (key === "Escape") {
        take();
        deactivate();
      } else if (plainLetter) {
        const index = list.findIndex((menu) => menu.mnemonic === key.toLowerCase());
        if (index >= 0) {
          take();
          openMenu(index, "line");
        }
      }
      return;
    }

    const items = inSub ? subItems : openItems;
    const lineIndex = Number(target.closest<HTMLElement>(LINE)?.dataset.menuLine);
    const current = Number.isInteger(lineIndex) ? items[lineIndex] : undefined;
    const neighbour = (delta: number) => {
      if (open !== null && list.length) openMenu((open + delta + list.length) % list.length, "line");
    };

    if (key === "ArrowDown" || key === "ArrowUp") {
      take();
      step(linesIn(inSub ? "[data-menu-subpanel]" : "[data-menu-panel]"), key === "ArrowDown" ? 1 : -1);
    } else if (key === "Home" || key === "End") {
      take();
      const lines = linesIn(inSub ? "[data-menu-subpanel]" : "[data-menu-panel]");
      lines[key === "Home" ? 0 : lines.length - 1]?.focus({ preventScroll: true });
    } else if (key === forward) {
      take();
      if (!inSub && usable(current) && current.type === "submenu") openSub(lineIndex);
      else neighbour(1);
    } else if (key === backward) {
      take();
      if (inSub) closeSub();
      else neighbour(-1);
    } else if (key === "Enter" || key === " ") {
      take();
      if (!usable(current)) return;
      if (current.type === "submenu") openSub(lineIndex);
      else run(current);
    } else if (key === "Escape") {
      take();
      if (inSub) {
        closeSub();
      } else {
        const index = open ?? 0;
        setOpen(null);
        names()[index]?.focus({ preventScroll: true });
      }
    } else if (plainLetter) {
      const index = items.findIndex((item) => usable(item) && letterOf(item) === key.toLowerCase());
      if (index < 0) return;
      take();
      const item = items[index];
      if (item.type === "submenu" && !inSub) openSub(index);
      else run(item);
    }
  };

  const renderLines = (items: DesktopMenuBarItem[], level: "panel" | "subpanel") =>
    items.map((item, index) => {
      if (item.type === "separator") return <div key={item.key} role="separator" className="my-1 h-px bg-border" />;
      const isSub = item.type === "submenu";
      const checkable = item.type === "checkbox" || item.type === "radio";
      const opened = level === "panel" && isSub && sub === index;
      const LineIcon = item.id ? MENU_BAR_ICONS[item.id] : undefined;
      return (
        <div key={item.key} className="relative">
          <button
            type="button"
            role={item.type === "checkbox" ? "menuitemcheckbox" : item.type === "radio" ? "menuitemradio" : "menuitem"}
            aria-checked={checkable ? !!item.checked : undefined}
            aria-haspopup={isSub ? "menu" : undefined}
            aria-expanded={isSub ? opened : undefined}
            aria-disabled={item.enabled ? undefined : true}
            aria-keyshortcuts={item.accelerator ? menuKeyText(item.accelerator, getDesktopBridge()?.platform, 'en') : undefined}
            data-menu-line={index}
            tabIndex={-1}
            onMouseEnter={(event) => {
              if (level === "panel") setSub(isSub && item.enabled ? index : null);
              if (item.enabled) event.currentTarget.focus({ preventScroll: true });
            }}
            onClick={() => {
              if (!item.enabled) return;
              if (isSub) openSub(index);
              else run(item);
            }}
            // The shared menu's row (components/ui/context-menu.tsx): icon column, label,
            // the key as a keycap, the submenu's chevron.
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm outline-none",
              item.enabled ? "focus:bg-muted" : "cursor-default opacity-50",
              opened && "bg-muted",
            )}
          >
            <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">
              {checkable && item.checked ? <Check className="h-4 w-4" /> : LineIcon ? <LineIcon className="h-4 w-4" /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate" data-menu-label="">
              <Label text={item.label} at={item.mnemonic} cue={cue} />
            </span>
            {item.accelerator && (
              <MenuShortcut
                keys={menuKeyText(item.accelerator, getDesktopBridge()?.platform)}
                className="ms-6"
                data-menu-keys=""
              />
            )}
            {isSub && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          </button>
        </div>
      );
    });

  return (
    <div
      ref={barRef}
      role="menubar"
      aria-label={t("bar_label")}
      data-window-menu-bar=""
      data-window-top-row=""
      onKeyDown={onKeyDown}
      className="fixed inset-x-0 top-0 z-[100002] flex h-8 items-center gap-0.5 border-b border-border bg-background px-1 text-sm text-foreground select-none"
    >
      {list.map((menu, index) => (
        <div key={menu.id} className="relative">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            data-menu-name=""
            data-menu-id={menu.id}
            tabIndex={-1}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              // The focus stays put until a menu takes it: Cut and Paste need to know where it was.
              event.preventDefault();
              rememberFocus();
              setCue(false);
              if (open === index) deactivate();
              else openMenu(index, "panel");
            }}
            onClick={(event) => {
              // Enter and Space; the pointer was handled on the way down.
              if (event.detail === 0) openMenu(index, "line");
            }}
            onMouseEnter={() => {
              if (open !== null && open !== index) openMenu(index, "panel");
            }}
            className={cn(
              "flex h-7 items-center rounded px-2.5 outline-none hover:bg-muted focus-visible:bg-muted",
              open === index && "bg-muted",
            )}
          >
            <Label text={menu.label} at={nameLetterAt(menu)} cue={cue} />
          </button>
          {open === index && drawsMenus && (
            <div
              role="menu"
              aria-label={menu.label}
              data-menu-panel=""
              tabIndex={-1}
              className={cn("absolute start-0 top-full mt-0.5 min-w-56 max-w-[min(22rem,90vw)] max-h-[calc(100dvh-2.75rem)] overflow-y-auto py-1 text-foreground outline-none", CONTEXT_MENU_PANEL_CLASS)}
            >
              {renderLines(openItems, "panel")}
            </div>
          )}
          {open === index && drawsMenus && sub !== null && (
            <div
              role="menu"
              aria-label={openItems[sub]?.label}
              data-menu-subpanel=""
              className={cn("fixed z-10 min-w-44 max-w-[min(22rem,90vw)] max-h-[calc(100dvh-0.5rem)] overflow-y-auto py-1 text-foreground", CONTEXT_MENU_PANEL_CLASS)}
              style={{ top: -9999, left: -9999 }}
            >
              {renderLines(subItems, "subpanel")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
