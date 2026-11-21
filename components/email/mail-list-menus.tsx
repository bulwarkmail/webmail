"use client";

import { memo } from "react";
import { useTranslations } from "next-intl";
import { ArrowUpDown, CheckCheck, FolderX, MailOpen, MoreVertical, RefreshCw } from "@/components/icons";
import { ToolbarButton } from "@/components/ui/toolbar";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu, ContextMenuCheckItem } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useSettingsStore, getMessageListOrderFor } from "@/stores/settings-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { isDefaultOrder, sanitizeSortLevels, type SortLevel } from "@/lib/message-list-order";
import { emptyFolderLabelKey } from "@/lib/empty-folder-text";

/** The orders the list header offers; Settings has the full editor. */
export const SORT_CHOICES = [
  { key: "newest", levels: [] },
  { key: "oldest", levels: [{ criterion: "receivedAt", direction: "asc" }] },
  { key: "unread", levels: [{ criterion: "unread", direction: "desc" }], keyword: true },
  { key: "starred", levels: [{ criterion: "starred", direction: "desc" }], keyword: true },
  { key: "sender", levels: [{ criterion: "from", direction: "asc" }] },
  { key: "subject", levels: [{ criterion: "subject", direction: "asc" }] },
  { key: "largest", levels: [{ criterion: "size", direction: "desc" }] },
] as const satisfies ReadonlyArray<{ key: string; levels: readonly SortLevel[]; keyword?: boolean }>;

export type SortChoiceKey = (typeof SORT_CHOICES)[number]["key"];

/** The choice `levels` is, or null for an order only Settings can make. */
export function sortChoiceFor(levels: SortLevel[]): SortChoiceKey | null {
  // A trailing newest-first level is implicit (see detectPreset).
  const last = levels[levels.length - 1];
  const core = levels.length > 1 && last.criterion === "receivedAt" && last.direction === "desc"
    ? levels.slice(0, -1)
    : levels;
  if (isDefaultOrder(core)) return "newest";
  if (core.length !== 1) return null;
  const match = SORT_CHOICES.find((choice) =>
    choice.levels.length === 1
    && choice.levels[0].criterion === core[0].criterion
    && choice.levels[0].direction === core[0].direction);
  return match?.key ?? null;
}

/**
 * Picks an order for the list. It writes the "Message list order" setting, so
 * Settings and every device agree. That setting applies to the Inbox only
 * unless "Apply to all folders" is on; picked in another folder, it turns
 * that on, or the pick would do nothing there.
 */
export function applySortChoice(key: SortChoiceKey, folderRole: string | null | undefined): void {
  const choice = SORT_CHOICES.find((c) => c.key === key);
  if (!choice) return;
  const { updateSetting, messageListOrderScope } = useSettingsStore.getState();
  updateSetting("messageListOrder", sanitizeSortLevels(choice.levels.map((level) => ({ ...level }))));
  if (messageListOrderScope === "inbox" && folderRole !== "inbox" && choice.levels.length > 0) {
    updateSetting("messageListOrderScope", "all");
  }
  const client = useAuthStore.getState().client;
  const store = useEmailStore.getState();
  if (client && store.selectedMailbox) void store.fetchEmails(client, store.selectedMailbox, { background: true });
}

/**
 * The Sort entries (MAIL-30), as a submenu of the list header's ⋮. Nothing
 * when policy hides the order setting.
 */
export function MailSortSubMenu({ folderRole, onPicked }: { folderRole: string | null | undefined; onPicked: () => void }) {
  const t = useTranslations("email_list.sort");
  const hidden = usePolicyStore((s) => s.isSettingHidden("messageListOrder"));
  const locked = usePolicyStore((s) => s.isSettingLocked("messageListOrder"));
  // Re-render when the order changes elsewhere (Settings, another device).
  useSettingsStore((s) => s.messageListOrder);
  useSettingsStore((s) => s.messageListOrderScope);
  const client = useAuthStore((s) => s.client);
  if (hidden) return null;

  const current = sortChoiceFor(getMessageListOrderFor(folderRole));
  // A server without hasKeyword can't order by read state or stars.
  const sortOptions = client?.getEmailQuerySortOptions?.() ?? null;
  const keywordSort = sortOptions === null || sortOptions.includes("hasKeyword");

  return (
    <ContextMenuSubMenu icon={ArrowUpDown} label={t("title")} disabled={locked} testId="mail-sort">
      {SORT_CHOICES.filter((choice) => keywordSort || !("keyword" in choice)).map((choice) => (
        <SortItem
          key={choice.key}
          label={t(choice.key)}
          checked={current === choice.key}
          testId={`mail-sort-${choice.key}`}
          onClick={() => {
            onPicked();
            applySortChoice(choice.key, folderRole);
          }}
        />
      ))}
      {current === null && (
        <>
          <ContextMenuSeparator />
          <SortItem label={t("custom")} checked onClick={onPicked} />
        </>
      )}
    </ContextMenuSubMenu>
  );
}

/**
 * "Group by date" for the list's ⋮: date headers while the list runs by
 * date. Nothing when policy hides the setting.
 */
export function MailGroupByDateItem({ onPicked }: { onPicked: () => void }) {
  const t = useTranslations("email_list");
  const checked = useSettingsStore((s) => s.groupListByDate);
  const hidden = usePolicyStore((s) => s.isSettingHidden("groupListByDate"));
  const locked = usePolicyStore((s) => s.isSettingLocked("groupListByDate"));
  if (hidden) return null;
  return (
    <ContextMenuCheckItem
      label={t("group_by_date")}
      checked={checked}
      disabled={locked}
      testId="mail-group-by-date"
      onClick={() => {
        onPicked();
        useSettingsStore.getState().updateSetting("groupListByDate", !checked);
      }}
    />
  );
}

/** A checkable entry of the Sort menu, as in Files'. */
function SortItem({ label, checked, onClick, testId }: { label: string; checked: boolean; onClick: () => void; testId?: string }) {
  return <ContextMenuCheckItem kind="radio" label={label} checked={checked} onClick={onClick} testId={testId} />;
}

/**
 * The list header's ⋮: Refresh, Sort, Group by date and what the Mountain View list ⋮
 * offers for the folder (MAIL-29). On the phone the folder entries sit in
 * the header's ⋮.
 */
export const MailFolderMenu = memo(function MailFolderMenu({
  folderRole,
  onRefresh,
  refreshDisabled,
  onMarkFolderRead,
  onMarkAllFoldersRead,
  onEmptyFolder,
  disabled,
  className,
}: {
  /** The open folder's role, for the order the Sort submenu checks. */
  folderRole?: string | null;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  onMarkFolderRead?: () => void;
  onMarkAllFoldersRead?: () => void;
  /** Only where emptying is the usual thing to do: Spam and Trash. */
  onEmptyFolder?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations("email_list");
  const tCommon = useTranslations("common");
  const menu = useContextMenu<null>();
  return (
    <>
      <ToolbarButton
        label={t("folder_actions")}
        aria-haspopup="menu"
        aria-expanded={menu.contextMenu.isOpen}
        disabled={disabled}
        active={menu.contextMenu.isOpen}
        className={className}
        data-testid="mail-folder-menu"
        onMouseDown={(e) => { if (menu.contextMenu.isOpen) e.stopPropagation(); }}
        onClick={(e) => {
          if (menu.contextMenu.isOpen) menu.closeContextMenu();
          else menu.openContextMenuFrom(e.currentTarget, null, "end");
        }}
      >
        <MoreVertical />
      </ToolbarButton>
      <ContextMenu ref={menu.menuRef} isOpen={menu.contextMenu.isOpen} position={menu.contextMenu.position} onClose={menu.closeContextMenu}>
        {onRefresh && (
          <ContextMenuItem
            icon={RefreshCw}
            label={tCommon("refresh")}
            disabled={refreshDisabled}
            testId="mail-refresh"
            onClick={() => { menu.closeContextMenu(); onRefresh(); }}
          />
        )}
        <MailSortSubMenu folderRole={folderRole} onPicked={menu.closeContextMenu} />
        <MailGroupByDateItem onPicked={menu.closeContextMenu} />
        <ContextMenuSeparator />
        <MailFolderMenuItems
          onMarkFolderRead={onMarkFolderRead}
          onMarkAllFoldersRead={onMarkAllFoldersRead}
          onEmptyFolder={onEmptyFolder}
          folderRole={folderRole}
          onPicked={menu.closeContextMenu}
        />
      </ContextMenu>
    </>
  );
});

/** The folder entries, for the list ⋮ and the phone header's ⋮. */
export function MailFolderMenuItems({
  onMarkFolderRead,
  onMarkAllFoldersRead,
  onEmptyFolder,
  folderRole,
  onPicked,
}: {
  onMarkFolderRead?: () => void;
  onMarkAllFoldersRead?: () => void;
  onEmptyFolder?: () => void;
  /** Names the entry "Empty Trash" or "Empty Spam". */
  folderRole?: string | null;
  onPicked: () => void;
}) {
  const tFolder = useTranslations("mailbox_context_menu");
  const tRoot = useTranslations();
  return (
    <>
      <ContextMenuItem
        icon={MailOpen}
        label={tFolder("mark_folder_read")}
        disabled={!onMarkFolderRead}
        onClick={() => { onPicked(); onMarkFolderRead?.(); }}
      />
      {onMarkAllFoldersRead && (
        <ContextMenuItem
          icon={CheckCheck}
          label={tFolder("mark_all_folders_read")}
          onClick={() => { onPicked(); onMarkAllFoldersRead(); }}
        />
      )}
      {onEmptyFolder && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={FolderX}
            label={tRoot(emptyFolderLabelKey(folderRole) ?? "mailbox_context_menu.empty_folder")}
            destructive
            testId="mail-empty-folder"
            onClick={() => { onPicked(); onEmptyFolder(); }}
          />
        </>
      )}
    </>
  );
}
