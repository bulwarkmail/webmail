"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, MoreHorizontal, CheckSquare } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, MenuShortcut } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { cn } from "@/lib/utils";
import { TagPicker } from "./tag-picker";
import type { MessageActionEntry, MessageActionKey } from "./message-actions";
import type { TagScope } from "@/hooks/use-account-tags";

/** The narrowest a button gets, whatever its words (CSS px). */
const MIN_BUTTON_WIDTH = 120;
const GAP = 8;

/**
 * How many buttons go on each line: as few lines as the width allows, and the lines as
 * even as they can be, so no button is left alone on the last one. With room for one
 * button a line, or no way to avoid a single one, it's one column.
 */
export function selectionRows(count: number, perLine: number): number[] {
  if (count <= 0) return [];
  const most = Math.max(1, Math.min(perLine, count));
  const lines = Math.ceil(count / most);
  const base = Math.floor(count / lines);
  if (lines > 1 && base < 2) return Array.from({ length: count }, () => 1);
  const longer = count % lines;
  return Array.from({ length: lines }, (_, i) => base + (i < longer ? 1 : 0));
}

/** "pane-batch-archive": the ids the selection bar's buttons had, for the pane's copies. */
function paneTestId(entry: { key: string; testId?: string }): string {
  const id = (entry.testId ?? entry.key).replace(/^ctx-/, "").replace(/^move-to$/, "move");
  return `pane-batch-${id}`;
}

export interface SelectionViewProps {
  /** "4 conversations selected". */
  title: string;
  /** How many of them are unread; a line under the title when there are some. */
  unread: number;
  /** The selection menu's top level (useSelectionActionList), in its order. */
  entries: MessageActionEntry[];
  /** The key hint for an entry, as the menu shows it. */
  shortcutOf: (entry: Extract<MessageActionEntry, { kind: "item" }>) => string | undefined;
  /** Opens the Move list under the button. */
  onMove: (button: HTMLElement) => void;
  /** Opens what the selection menu has under "More actions", under the button. */
  onMore: (button: HTMLElement) => void;
  onClear: () => void;
  /** The tag picker for the whole selection. */
  tags: { selectedIds: string[]; partialIds: string[]; scope: TagScope | null; onToggle: (tagId: string) => void };
  disabled?: boolean;
  /** Entries the device can't run now (offline). */
  isDisabled?: (key: MessageActionKey) => boolean;
}

/**
 * The reading pane while several messages are selected, as Outlook lays it out: what's
 * selected, the selection menu's actions as buttons in even lines, More actions for the
 * rest, and a way out. The buttons and their order come from the same list as the
 * selection's right-click menu.
 */
export function SelectionView({ title, unread, entries, shortcutOf, onMove, onMore, onClear, tags, disabled, isDisabled }: SelectionViewProps) {
  const t = useTranslations("email_list");
  const tViewer = useTranslations("email_viewer");
  const tCount = useTranslations("notification_center");
  const tagMenu = useContextMenu<null>();
  const gridRef = useRef<HTMLDivElement>(null);
  const [perLine, setPerLine] = useState(4);

  // As many buttons a line as fit the pane (a container's width, not the window's), each
  // as wide as the longest words of any of them, so none has to cut its label.
  const labelsKey = entries.map((entry) => (entry.kind === "separator" ? "" : entry.label)).join("|");
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const width = grid.clientWidth;
      if (width <= 0) return;
      let need = MIN_BUTTON_WIDTH;
      for (const button of Array.from(grid.querySelectorAll<HTMLElement>("button"))) {
        // Its icons, the label's whole text, the gaps between them, padding and border:
        // what it needs whatever width it has now.
        const style = getComputedStyle(button);
        const parts = Array.from(button.children) as HTMLElement[];
        const content = parts.reduce((sum, part) => sum + (part.hasAttribute("data-selection-label") ? part.scrollWidth : part.getBoundingClientRect().width), 0);
        const gaps = (parseFloat(style.columnGap) || 0) * Math.max(0, parts.length - 1);
        const frame = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
        need = Math.max(need, Math.ceil(content + gaps + frame) + 2);
      }
      setPerLine(Math.max(1, Math.floor((width + GAP) / (need + GAP))));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [labelsKey]);

  // After an action the button that had the focus can go (Mark as read once all are
  // read): the focus stays in the view, on the button now in its place.
  const focused = useRef<{ el: HTMLElement; index: number } | null>(null);
  useEffect(() => {
    const grid = gridRef.current;
    const last = focused.current;
    if (!grid || !last || last.el.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    buttons[Math.min(last.index, buttons.length - 1)]?.focus();
  });

  const items = entries.filter((entry) => entry.kind !== "separator");
  // More actions is the last button of the grid.
  const lines = selectionRows(items.length + 1, perLine);
  const widest = Math.max(1, ...lines);
  const cell = `calc((100% - ${(widest - 1) * GAP}px) / ${widest})`;

  const button = (entry: Exclude<MessageActionEntry, { kind: "separator" }>, index: number) => {
    const Icon = entry.icon;
    const common = {
      variant: "outline" as const,
      size: "sm" as const,
      style: { width: cell },
      className: cn(
        "gap-2 min-w-0 justify-center",
        entry.kind === "item" && entry.destructive && "hover:bg-destructive/10 hover:text-destructive",
      ),
      onFocus: (e: React.FocusEvent<HTMLButtonElement>) => { focused.current = { el: e.currentTarget, index }; },
    };
    const label = <span className="truncate" data-selection-label="">{entry.label}</span>;
    if (entry.kind === "submenu") {
      const open = (el: HTMLElement) => (entry.key === "tag" ? tagMenu.openContextMenuFrom(el, null, "start") : onMove(el));
      return (
        <Button
          key={entry.key}
          {...common}
          title={entry.label}
          aria-haspopup="menu"
          aria-expanded={entry.key === "tag" ? tagMenu.contextMenu.isOpen : undefined}
          data-testid={paneTestId(entry)}
          disabled={disabled || isDisabled?.(entry.key)}
          onClick={(e) => open(e.currentTarget)}
        >
          <Icon className="size-4 shrink-0" />
          {label}
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      );
    }
    const key = shortcutOf(entry);
    return (
      <Button
        // Star keeps its button when it turns into Unstar, and with it the focus.
        key={entry.key === "read" ? `read-${entry.testId}` : entry.key}
        {...common}
        title={key ? `${entry.label} (${key})` : entry.label}
        data-testid={paneTestId(entry)}
        disabled={disabled || entry.disabled || isDisabled?.(entry.key)}
        onClick={entry.run}
      >
        <Icon className={cn("size-4 shrink-0", entry.destructive && "text-destructive")} />
        {label}
      </Button>
    );
  };

  const all = [
    ...items.map((entry, index) => button(entry, index)),
    <Button
      key="more"
      variant="outline"
      size="sm"
      style={{ width: cell }}
      className="gap-2 min-w-0 justify-center"
      aria-haspopup="menu"
      data-testid="pane-batch-more"
      disabled={disabled}
      onFocus={(e) => { focused.current = { el: e.currentTarget, index: items.length }; }}
      onClick={(e) => onMore(e.currentTarget)}
    >
      <MoreHorizontal className="size-4 shrink-0" />
      <span className="truncate" data-selection-label="">{tViewer("more_actions")}</span>
      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
    </Button>,
  ];
  let at = 0;
  const rows = lines.map((length) => {
    const row = all.slice(at, at + length);
    at += length;
    return row;
  });

  return (
    <section aria-label={title} className="mx-auto w-full max-w-3xl px-4 text-center" data-testid="selection-pane">
      <CheckSquare className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {unread > 0 && <p className="mt-0.5 text-sm text-muted-foreground" data-testid="selection-unread">{tCount("unread_count", { count: unread })}</p>}
      <div ref={gridRef} className="mt-5 flex flex-col items-center gap-2" data-testid="selection-actions">
        {rows.map((row, i) => (
          <div key={i} className="flex w-full justify-center gap-2" data-selection-line="">
            {row}
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onClear}
        disabled={disabled}
        className="mt-3 gap-2 text-muted-foreground hover:text-foreground"
        aria-keyshortcuts="Escape"
        data-testid="selection-clear"
      >
        {t("batch_actions.clear_selection")}
        <MenuShortcut keys="Esc" />
      </Button>
      <ContextMenu
        ref={tagMenu.menuRef}
        isOpen={tagMenu.contextMenu.isOpen}
        position={tagMenu.contextMenu.position}
        onClose={tagMenu.closeContextMenu}
        label={items.find((entry) => entry.key === "tag")?.label}
      >
        <div className="w-56 max-w-[18rem]">
          <TagPicker selectedIds={tags.selectedIds} partialIds={tags.partialIds} onToggle={tags.onToggle} scope={tags.scope} />
        </div>
      </ContextMenu>
    </section>
  );
}
