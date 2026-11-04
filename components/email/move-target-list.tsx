"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Archive, Ban, Clock, File, Folder, FolderSearch, Inbox, Search, Send, Trash2, Users, type AppIcon } from "@/components/icons";
import { ContextMenuHeader, ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu } from "@/components/ui/context-menu";
import { localizeMailboxName } from "@/lib/mailbox-label";
import type { Email, Mailbox } from "@/lib/jmap/types";
import {
  buildMoveMenu,
  countTargets,
  filterMoveNodes,
  firstEnabled,
  MOVE_FILTER_THRESHOLD,
  type MoveMenuModel,
  type MoveMenuNode,
} from "@/lib/move-menu";
import { noteMoveTarget, readRecentMoveTargets } from "@/lib/move-recent";
import { cn } from "@/lib/utils";

/** A folder's icon in a Move list, the sidebar's for the folders with a role. */
export function moveMailboxIcon(role?: string | null): AppIcon {
  switch (role) {
    case "inbox": return Inbox;
    case "sent": return Send;
    case "drafts": return File;
    case "trash": return Trash2;
    case "junk": return Ban;
    case "archive": return Archive;
    default: return Folder;
  }
}

type MoveMenuEmails = Array<Pick<Email, "mailboxIds" | "sourceAccountId">>;

/** The Move list for these messages, with this device's recent folders. */
export function useMoveMenu(
  mailboxes: Mailbox[],
  opts: { currentMailboxId?: string | null; ownerAccountId?: string; emails?: MoveMenuEmails },
): MoveMenuModel {
  const locale = useLocale();
  const { currentMailboxId, ownerAccountId, emails } = opts;
  return useMemo(
    () => buildMoveMenu(mailboxes, { currentMailboxId, ownerAccountId, emails, locale, recentIds: readRecentMoveTargets }),
    [mailboxes, currentMailboxId, ownerAccountId, emails, locale],
  );
}

/** Whether the list is long enough for a filter field and "Choose folder…". */
export function moveMenuIsLong(model: MoveMenuModel): boolean {
  return model.targetCount > MOVE_FILTER_THRESHOLD;
}

export function moveMenuIsEmpty(model: MoveMenuModel): boolean {
  return model.targetCount === 0 && model.others.length === 0;
}

interface MoveFolderListProps {
  model: MoveMenuModel;
  onPick: (mailboxId: string) => void;
  /**
   * `menu`: inside a ContextMenu; other accounts are submenus.
   * `dialog`: a list in a dialog; other accounts follow under their names.
   * `panel`: the phone's full-width panel (44px rows).
   */
  variant?: "menu" | "dialog" | "panel";
  /** Opens the Move dialog. Offered at the end of a long list, since a native menu has no filter field. */
  onChooseFolder?: () => void;
  /** Always show the filter field (the dialog). */
  alwaysFilter?: boolean;
  /** Stable hook for integration tests: each row is `<prefix><mailbox id>`. */
  testIdPrefix?: string;
  /** Don't keep the pick as a recent folder (a copy, not a move). */
  noRecent?: boolean;
}

/**
 * The folders messages can be moved to (lib/move-menu.ts): recent ones, the
 * account's own folders nested and in mail-client order, the open folder
 * greyed, other reachable accounts under their names, and a filter field
 * once the list is long.
 *
 * Each folder with subfolders is wrapped in `data-native-submenu`: the
 * desktop app's native copy of the menu makes it a submenu there, the folder
 * itself first (lib/desktop/native-menu.ts).
 */
export function MoveFolderList({
  model,
  onPick,
  variant = "menu",
  onChooseFolder,
  alwaysFilter = false,
  testIdPrefix = "move-to:",
  noRecent = false,
}: MoveFolderListProps) {
  const t = useTranslations("menuMove");
  const tSidebar = useTranslations("sidebar");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const panel = variant === "panel";
  const showFilter = alwaysFilter || moveMenuIsLong(model);

  const labelOf = (node: Pick<MoveMenuNode, "role" | "name">) =>
    localizeMailboxName(node.role, node.name, (key) => tSidebar(`mailboxes.${key}`));

  const nodes = filterMoveNodes(model.nodes, query, labelOf, locale);
  const others = model.others
    .map((account) => ({ ...account, nodes: filterMoveNodes(account.nodes, query, labelOf, locale) }))
    .filter((account) => countTargets(account.nodes) > 0);
  const filtering = query.trim().length > 0;

  const pick = (id: string) => {
    if (!noRecent) noteMoveTarget(model.accountId, id);
    onPick(id);
  };

  // The filter takes the focus as the list shows, so typing narrows it at
  // once. It can be hidden for a frame while its panel is placed.
  useEffect(() => {
    if (!showFilter || panel) return;
    let tries = 0;
    let frame = 0;
    const attempt = () => {
      const input = inputRef.current;
      if (!input) return;
      const visible = input.getClientRects().length > 0 && getComputedStyle(input).visibility !== "hidden";
      if (visible) {
        input.focus({ preventScroll: true });
        return;
      }
      if (++tries < 20) frame = requestAnimationFrame(attempt);
    };
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [showFilter, panel]);

  const row = (node: MoveMenuNode, label: string, key: string, title?: string) => {
    const Icon = moveMailboxIcon(node.role);
    const rowTitle = title ?? (node.current ? t("current_folder", { folder: label }) : label);
    if (panel) {
      return (
        <button
          key={key}
          type="button"
          role="menuitem"
          data-mailbox-id={node.id}
          data-testid={`${testIdPrefix}${node.id}`}
          disabled={!node.enabled}
          onClick={() => pick(node.id)}
          className="w-full px-4 py-2.5 min-h-[44px] text-sm text-start flex items-center gap-3 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:text-muted-foreground disabled:hover:bg-transparent"
          title={rowTitle}
        >
          <Icon className="w-5 h-5 flex-shrink-0" />
          <span className="truncate" dir="auto" data-menu-label="">{label}</span>
        </button>
      );
    }
    return (
      <ContextMenuItem
        key={key}
        icon={Icon}
        label={label}
        title={rowTitle}
        disabled={!node.enabled}
        testId={`${testIdPrefix}${node.id}`}
        onClick={() => pick(node.id)}
      />
    );
  };

  const tree = (list: MoveMenuNode[]): React.ReactNode =>
    list.map((node) => {
      const label = labelOf(node);
      if (node.children.length === 0) return row(node, label, node.id);
      return (
        <div key={node.id} data-native-submenu="">
          {row(node, label, node.id)}
          <div className={panel ? "ps-6" : "ps-4"}>{tree(node.children)}</div>
        </div>
      );
    });

  const recent = !filtering && !noRecent ? model.recent : [];
  const nothing = nodes.length === 0 && others.length === 0;
  const separator = panel ? <div className="h-px bg-border my-1" role="separator" /> : <ContextMenuSeparator />;

  return (
    <div data-move-folder-list="">
      {showFilter && (
        <div className={cn("sticky top-0 z-10 bg-background", panel ? "px-4 py-2" : "px-2 pt-1 pb-1")}>
          <label className="flex items-center gap-2 rounded-md border border-border px-2 focus-within:ring-2 focus-within:ring-ring">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                e.stopPropagation();
                const first = firstEnabled(nodes) ?? others.map((a) => firstEnabled(a.nodes)).find(Boolean);
                if (first) pick(first.id);
              }}
              placeholder={t("filter_placeholder")}
              aria-label={t("filter_placeholder")}
              className={cn("min-w-0 flex-1 bg-transparent text-sm focus:outline-none", panel ? "h-10" : "h-8")}
              data-testid="move-filter"
            />
          </label>
        </div>
      )}

      {recent.length > 0 && (
        <div data-move-recent="">
          {panel ? (
            <div className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {t("recent")}
            </div>
          ) : (
            <ContextMenuHeader>{t("recent")}</ContextMenuHeader>
          )}
          {recent.map((node) => {
            const label = [...node.path, labelOf(node)].join(" / ");
            return row({ ...node, children: [] }, label, `recent-${node.id}`, label);
          })}
          {separator}
        </div>
      )}

      {tree(nodes)}

      {nothing && (
        <div className={cn("text-sm text-muted-foreground", panel ? "px-4 py-3" : "px-3 py-2")}>{t("no_match")}</div>
      )}

      {others.length > 0 && (variant === "menu" ? (
        <>
          {nodes.length > 0 && <ContextMenuSeparator />}
          {others.map((account) => (
            <ContextMenuSubMenu
              key={account.accountId}
              icon={Users}
              label={account.name}
              testId={`move-account:${account.accountId}`}
            >
              {tree(account.nodes)}
            </ContextMenuSubMenu>
          ))}
        </>
      ) : (
        others.map((account) => (
          <div key={account.accountId} data-move-account={account.accountId}>
            {panel ? (
              <div className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground truncate" title={account.name}>{account.name}</div>
            ) : (
              <ContextMenuHeader>{account.name}</ContextMenuHeader>
            )}
            {tree(account.nodes)}
          </div>
        ))
      ))}

      {onChooseFolder && moveMenuIsLong(model) && !filtering && (
        <>
          {separator}
          {panel ? (
            <button
              type="button"
              role="menuitem"
              onClick={onChooseFolder}
              className="w-full px-4 py-2.5 min-h-[44px] text-sm text-start flex items-center gap-3 hover:bg-muted"
              data-testid="move-choose-folder"
            >
              <FolderSearch className="w-5 h-5 flex-shrink-0" />
              <span data-menu-label="">{t("choose_folder")}</span>
            </button>
          ) : (
            <ContextMenuItem icon={FolderSearch} label={t("choose_folder")} onClick={onChooseFolder} testId="move-choose-folder" />
          )}
        </>
      )}
    </div>
  );
}
