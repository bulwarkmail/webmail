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
} from "@/components/icons";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactPrimaryEmail } from "@/stores/contact-store";
import { exportContact } from "./contact-export";
import { printContact } from "./contact-print";
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
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddToGroup: () => void;
  onDuplicate?: () => void;
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
  onEdit,
  onDelete,
  onAddToGroup,
  onDuplicate,
  onBatchExport,
  onBatchAddToGroup,
  onBatchDelete,
}: ContactContextMenuProps) {
  const t = useTranslations("contacts");
  const email = getContactPrimaryEmail(contact);
  const phone = getContactPrimaryPhone(contact);
  const showBatchActions = isMultiSelect && selectedCount > 1;

  const handle = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const handleSendEmail = () => {
    if (!email) return;
    window.location.href = `mailto:${email}`;
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
    exportContact(contact);
    toast.success(t("export.success", { count: 1 }));
  };

  const handlePrint = () => {
    printContact(contact);
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
        <ContextMenuItem
          icon={Download}
          label={t("bulk.export")}
          onClick={handle(() => onBatchExport?.())}
          disabled={!onBatchExport}
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
      <ContextMenuItem icon={Eye} label={t("context_menu.open")} onClick={handle(onOpen)} />
      <ContextMenuItem icon={Pencil} label={t("context_menu.edit")} onClick={handle(onEdit)} />
      {(email || phone) && <ContextMenuSeparator />}
      {email && (
        <ContextMenuItem
          icon={Mail}
          label={t("context_menu.send_email")}
          onClick={handle(handleSendEmail)}
        />
      )}
      {phone && (
        <ContextMenuItem
          icon={Phone}
          label={t("context_menu.call")}
          onClick={handle(handleCall)}
        />
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
      <ContextMenuSeparator />
      <ContextMenuItem
        icon={Users}
        label={t("context_menu.add_to_group")}
        onClick={handle(onAddToGroup)}
      />
      {onDuplicate && (
        <ContextMenuItem
          icon={Copy}
          label={t("context_menu.duplicate")}
          onClick={handle(onDuplicate)}
        />
      )}
      <ContextMenuItem
        icon={Download}
        label={t("context_menu.export_vcard")}
        onClick={handle(handleExport)}
      />
      <ContextMenuItem
        icon={Printer}
        label={t("context_menu.print")}
        onClick={handle(handlePrint)}
      />
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
