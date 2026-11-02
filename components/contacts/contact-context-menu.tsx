"use client";

import { useTranslations } from "next-intl";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuHeader,
} from "@/components/ui/context-menu";
import {
  Eye,
  Pencil,
  Mail,
  Phone,
  ClipboardCopy,
  Download,
  Users,
  Trash2,
  Copy,
  Printer,
  FolderInput,
  CheckSquare,
} from "@/components/icons";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactPrimaryEmail } from "@/stores/contact-store";
import { exportContact, useContactExportBusy } from "./contact-export";
import { printContact } from "./contact-print";
import { useStrictestDevices } from "@/hooks/use-device-policy";
import { toast } from "@/stores/toast-store";

function getContactPrimaryPhone(contact: ContactCard): string {
  if (!contact.phones) return "";
  return Object.values(contact.phones)[0]?.number || "";
}

interface Position {
  x: number;
  y: number;
}

interface ContactContextMenuProps {
  contact: ContactCard;
  position: Position;
  isOpen: boolean;
  onClose: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
  isMultiSelect?: boolean;
  selectedCount?: number;
  /** Left out where the contact is already open (the detail's ⋮). */
  onOpen?: () => void;
  /** Touch: start selecting with this contact (there is no Ctrl+click). */
  onSelect?: () => void;
  /** Left out where Edit is a button next to the menu. */
  onEdit?: () => void;
  onDelete: () => void;
  onAddToGroup?: () => void;
  /** Leave out what the detail shows as buttons of its own. */
  inDetail?: boolean;
  /** Writes to the contact in the app's composer. */
  onCompose?: () => void;
  onDuplicate?: () => void;
  /** Move to another address book; undefined where there is none to move to. */
  onMoveTo?: () => void;
  onBatchMoveTo?: () => void;
  onBatchExport?: () => void;
  onBatchAddToGroup?: () => void;
  onBatchDelete?: () => void;
}

export function ContactContextMenu({
  contact,
  position,
  isOpen,
  onClose,
  menuRef,
  isMultiSelect = false,
  selectedCount = 1,
  onOpen,
  onSelect,
  onEdit,
  onDelete,
  onAddToGroup,
  onCompose,
  onDuplicate,
  onMoveTo,
  onBatchMoveTo,
  inDetail = false,
  onBatchExport,
  onBatchAddToGroup,
  onBatchDelete,
}: ContactContextMenuProps) {
  const t = useTranslations("contacts");
  const printOff = useStrictestDevices().noPrint;
  const email = getContactPrimaryEmail(contact);
  const phone = getContactPrimaryPhone(contact);
  const showBatchActions = isMultiSelect && selectedCount > 1;
  const exporting = useContactExportBusy();

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const handleCall = () => {
    if (!phone) return;
    window.location.href = `tel:${phone}`;
  };

  const handleCopy = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("detail.copied"));
    } catch {
      toast.error(t("detail.copy_failed"));
    }
  };

  const handleExport = () => {
    void exportContact(contact).then((exported) => {
      if (exported) toast.success(t("export.success", { count: 1 }));
    });
  };

  const handlePrint = () => {
    void printContact(contact);
  };

  if (showBatchActions) {
    return (
      <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
        <ContextMenuHeader>
          {t("bulk.selected", { count: selectedCount })}
        </ContextMenuHeader>
        <ContextMenuItem
          icon={Users}
          label={t("bulk.add_to_group")}
          onClick={handle(() => onBatchAddToGroup?.())}
          disabled={!onBatchAddToGroup}
        />
        {onBatchMoveTo && (
          <ContextMenuItem icon={FolderInput} label={t("address_books.move_to")} onClick={handle(onBatchMoveTo)} />
        )}
        <ContextMenuItem
          icon={Download}
          label={t("bulk.export")}
          onClick={handle(() => onBatchExport?.())}
          disabled={!onBatchExport || exporting}
        />
        <ContextMenuSeparator />
        <ContextMenuItem
          icon={Trash2}
          label={t("bulk.delete")}
          onClick={handle(() => onBatchDelete?.())}
          disabled={!onBatchDelete}
          destructive
        />
      </ContextMenu>
    );
  }

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose}>
      {/* R6 order: Open, write, Edit, then the rest; the detail's ⋮ leaves
          out what it has as buttons (Edit, Send email, Call). */}
      {onOpen && <ContextMenuItem icon={Eye} label={t("context_menu.open")} onClick={handle(onOpen)} />}
      {onSelect && <ContextMenuItem icon={CheckSquare} label={t("filters.select")} onClick={handle(onSelect)} />}
      {email && onCompose && !inDetail && (
        <ContextMenuItem
          icon={Mail}
          label={t("context_menu.send_email")}
          onClick={handle(onCompose)}
        />
      )}
      {phone && !inDetail && (
        <ContextMenuItem
          icon={Phone}
          label={t("context_menu.call")}
          onClick={handle(handleCall)}
        />
      )}
      {onEdit && <ContextMenuItem icon={Pencil} label={t("context_menu.edit")} onClick={handle(onEdit)} />}
      {!inDetail && <ContextMenuSeparator />}
      {onAddToGroup && (
        <ContextMenuItem
          icon={Users}
          label={t("context_menu.add_to_group")}
          onClick={handle(onAddToGroup)}
        />
      )}
      {onDuplicate && (
        <ContextMenuItem
          icon={Copy}
          label={t("context_menu.duplicate")}
          onClick={handle(onDuplicate)}
        />
      )}
      {onMoveTo && (
        <ContextMenuItem icon={FolderInput} label={t("address_books.move_to")} onClick={handle(onMoveTo)} />
      )}
      {email && (
        <ContextMenuItem
          icon={ClipboardCopy}
          label={t("detail.copy_email")}
          onClick={handle(() => handleCopy(email))}
        />
      )}
      {phone && (
        <ContextMenuItem
          icon={ClipboardCopy}
          label={t("detail.copy_phone")}
          onClick={handle(() => handleCopy(phone))}
        />
      )}
      <ContextMenuItem
        icon={Download}
        label={t("context_menu.export_vcard")}
        onClick={handle(handleExport)}
        disabled={exporting}
      />
      {!printOff && (
        <ContextMenuItem
          icon={Printer}
          label={t("context_menu.print")}
          onClick={handle(handlePrint)}
        />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Trash2}
        label={t("context_menu.delete")}
        onClick={handle(onDelete)}
        destructive
      />
    </ContextMenu>
  );
}
