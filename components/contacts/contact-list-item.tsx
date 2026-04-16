"use client";

import { useCallback, type DragEvent } from "react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { CheckSquare, Square } from "lucide-react";
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
}

export function ContactListItem({ contact, isSelected, isChecked, hasSelection, density, selectedContactIds, onClick, onCheckboxClick }: ContactListItemProps) {
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
    preview.textContent = ids.length === 1 ? (name || "1 contact") : `${ids.length} contacts`;
    document.body.appendChild(preview);
    e.dataTransfer.setDragImage(preview, 0, 0);
    requestAnimationFrame(() => preview.remove());
  }, [contact.id, name, email, selectedContactIds]);

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={onClick}
      className={cn(
        "w-full flex items-center cursor-pointer select-none transition-all duration-200 border-b border-border",
        isSelected
          ? "bg-selection shadow-sm"
          : "bg-background hover:bg-muted hover:shadow-sm",
        isChecked && !isSelected && "ring-2 ring-primary/20 bg-selection/60",
      )}
      style={{ gap: 'var(--density-item-gap)', paddingInline: '16px', paddingBlock: 'var(--density-item-py)' }}
    >
      {hasSelection && (
        <button
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
        <Avatar name={name} email={email} size="sm" className="flex-shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {name || email || "-"}
        </div>
        {density !== 'extra-compact' && email && name && (
          <div className="text-xs text-muted-foreground truncate">{email}</div>
        )}
        {density === 'comfortable' && org && (
          <div className="text-xs text-muted-foreground truncate">{org}</div>
        )}
      </div>
    </div>
  );
}
