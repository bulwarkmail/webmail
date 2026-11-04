"use client";

import { IconButton } from "@/components/ui/icon-button";
import { ContextMenu } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { Tag } from "@/components/icons";
import { TagPicker } from "./tag-picker";
import type { TagScope } from "@/hooks/use-account-tags";

/**
 * The tag entry of the selection toolbar: opens the shared tag picker for
 * every selected message at once (#1077), in the app's menu under the button.
 */
export function BatchTagButton({
  title,
  selectedIds,
  partialIds,
  onToggle,
  active,
  disabled,
  scope = null,
  testId = "batch-tag",
  showLabel = false,
}: {
  title: string;
  /** Tags every selected message carries. */
  selectedIds: string[];
  /** Tags only some of them carry. */
  partialIds: string[];
  onToggle: (tagId: string) => void;
  /** Whether there is a selection to tag; the picker shuts without one. */
  active: boolean;
  disabled?: boolean;
  /** The account of the whole selection (commonTagScope); null: the user's own tags. */
  scope?: TagScope | null;
  /** The reading pane's copy has its own (mail-10). */
  testId?: string;
  /** Name the button in words beside the icon, as the reading pane does (mail-p2-15). */
  showLabel?: boolean;
}) {
  const menu = useContextMenu<null>();
  const isOpen = menu.contextMenu.isOpen && active;

  return (
    <>
      <IconButton
        label={title}
        data-testid={testId}
        onClick={(event) => (isOpen ? menu.closeContextMenu() : menu.openContextMenuFrom(event.currentTarget, null, "start"))}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={disabled}
        {...(showLabel ? { size: "sm" as const, title: "", className: "gap-1.5" } : {})}
      >
        <Tag />
        {showLabel && <span data-selection-label="">{title}</span>}
      </IconButton>
      <ContextMenu ref={menu.menuRef} isOpen={isOpen} position={menu.contextMenu.position} onClose={menu.closeContextMenu} label={title}>
        <div data-testid="batch-tag-picker" className="w-56 max-w-[18rem]">
          <TagPicker selectedIds={selectedIds} partialIds={partialIds} onToggle={onToggle} scope={scope} />
        </div>
      </ContextMenu>
    </>
  );
}
