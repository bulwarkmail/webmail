"use client";

import { useCallback, useRef, type DragEvent } from "react";
import { useLongPress } from "@/hooks/use-long-press";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPhotoRef, getContactPrimaryEmail } from "@/stores/contact-store";
import { CheckSquare, Square } from "@/components/icons";
import type { Density } from "@/stores/settings-store";

interface ContactListItemProps {
  contact: ContactCard;
  isSelected: boolean;
  isChecked: boolean;
  hasSelection: boolean;
  density: Density;
  selectedContactIds: Set<string>;
  onClick: (e: React.MouseEvent) => void;
  onCheckboxClick: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent, contact: ContactCard) => void;
  /** The keyboard cursor: the row that takes Tab and shows a focus ring. */
  isFocused?: boolean;
  onFocus?: () => void;
  /** Long-press on touch: the row's menu, as right-click does (R7). */
  onLongPress?: (row: HTMLElement) => void;
}

export function ContactListItem({ contact, isSelected, isChecked, hasSelection, density, selectedContactIds, onClick, onCheckboxClick, onContextMenu, isFocused = false, onFocus, onLongPress }: ContactListItemProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const longPress = useLongPress(() => {
    if (rowRef.current) onLongPress?.(rowRef.current);
  }, !!onLongPress);
  const t = useTranslations("contacts");
  const name = getContactDisplayName(contact);
  const email = getContactPrimaryEmail(contact);
  const org = contact.organizations
    ? Object.values(contact.organizations)[0]?.name
    : undefined;

  const handleDragStart = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Drag all selected contacts if this one is selected, otherwise just this one
    const ids = selectedContactIds.has(contact.id)
      ? Array.from(selectedContactIds)
      : [contact.id];

    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("application/x-contact-ids", JSON.stringify(ids));
    e.dataTransfer.setData("text/plain", name || email || contact.id);

    // Custom drag preview
    const preview = document.createElement("div");
    preview.style.cssText = `
      position: fixed; top: -9999px; left: 0;
      padding: 8px 16px; background-color: var(--color-primary, #3b82f6);
      color: var(--color-primary-foreground, #ffffff); border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-size: 14px; font-weight: 500;
      z-index: 9999; white-space: nowrap; pointer-events: none;
    `;
    preview.textContent = ids.length === 1 && name ? name : t("drag_count", { count: ids.length });
    document.body.appendChild(preview);
    e.dataTransfer.setDragImage(preview, 0, 0);
    requestAnimationFrame(() => preview.remove());
  }, [contact.id, name, email, selectedContactIds, t]);

  return (
    <div
      ref={rowRef}
      {...(onLongPress ? longPress.handlers : {})}
      role="option"
      aria-selected={isSelected || isChecked}
      tabIndex={isFocused ? 0 : -1}
      data-contact-id={contact.id}
      onFocus={onFocus}
      draggable
      onDragStart={handleDragStart}
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => onContextMenu(e, contact) : undefined}
      className={cn(
        "w-full flex items-center cursor-pointer select-none transition-colors border-b border-border/60 outline-none focus-inset",
        isSelected
          ? "bg-selection"
          : "bg-background hover:bg-muted/60",
        isChecked && !isSelected && "ring-2 ring-primary/20 bg-selection/60",
      )}
      style={{ gap: 'var(--density-item-gap)', paddingInline: '16px', paddingBlock: 'var(--density-item-py)' }}
    >
      {hasSelection && (
        <button
          type="button"
          role="checkbox"
          aria-checked={isChecked}
          aria-label={t("select_contact", { name: name || email || "-" })}
          onClick={onCheckboxClick}
          className={cn(
            "p-1 rounded flex-shrink-0 transition-all duration-200",
            "hover:bg-muted/50 hover:scale-110",
            "active:scale-95",
            "animate-in fade-in zoom-in-95 duration-150",
            isChecked && "text-primary"
          )}
        >
          {isChecked ? (
            <CheckSquare className="w-4 h-4 animate-in zoom-in-50 duration-200" />
          ) : (
            <Square className="w-4 h-4 text-muted-foreground opacity-60 hover:opacity-100 transition-opacity" />
          )}
        </button>
      )}

      {density !== 'extra-compact' && (
        <Avatar name={name} email={email} contactPhoto={getContactPhotoRef(contact) ?? null} size="sm" className="flex-shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate" title={name || email || "-"}>
          {name || email || "-"}
        </div>
        {density !== 'extra-compact' && email && name && (
          <div className="text-xs text-muted-foreground truncate" title={email}>{email}</div>
        )}
        {density === 'comfortable' && org && (
          <div className="text-xs text-muted-foreground truncate" title={org}>{org}</div>
        )}
      </div>
    </div>
  );
}
