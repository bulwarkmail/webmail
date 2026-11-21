"use client";

// The right-click menu on an address in a message header: copy it, write to
// it, keep it as a contact, find the mail it sent. In the desktop app the
// menu shows natively (components/ui/context-menu).

import { useEffect, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, type ContextMenuPosition } from "@/components/ui/context-menu";
import { Copy, ExternalLink, Search, Send, UserPlus } from "@/components/icons";
import { useContextMenu } from "@/hooks/use-context-menu";
import { addAddressToContacts } from "@/lib/contacts/add-from-address";
import { mailSearchAvailable, requestMailSearch } from "@/lib/mail-search-request";
import { requestInternalMailto } from "@/lib/protocol-handlers/mailto";
import type { ContactCard } from "@/lib/jmap/types";
import { useContactStore } from "@/stores/contact-store";
import { toast } from "@/stores/toast-store";

export interface MenuAddress {
  name?: string;
  email: string;
}

interface AddressContextMenuProps {
  address: MenuAddress | null;
  isOpen: boolean;
  position: ContextMenuPosition;
  onClose: () => void;
  /** The menu's element, for the hook that closes it on a click outside. */
  menuRef?: RefObject<HTMLDivElement | null>;
  /** Shows a saved contact; without it a saved address offers nothing more. */
  onViewContact?: (contact: ContactCard | null, email: string) => void;
}

function contactFor(contacts: ContactCard[], email: string): ContactCard | undefined {
  const wanted = email.toLowerCase();
  return contacts.find((c) => c.emails && Object.values(c.emails).some((e) => e.address.toLowerCase() === wanted));
}

export function AddressContextMenu({ address, isOpen, position, onClose, menuRef, onViewContact }: AddressContextMenuProps) {
  const t = useTranslations();
  const contacts = useContactStore((s) => s.contacts);
  if (!address) return null;
  const { email, name } = address;
  const contact = contactFor(contacts, email);
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(email);
      toast.success(t("email_viewer.contact_sidebar.copied"));
    } catch {
      toast.error(t("email_viewer.contact_sidebar.copy_failed"));
    }
  };
  const write = () => {
    const href = `mailto:${email}`;
    // No mail page here to take it (a message window): the system's handler.
    if (!requestInternalMailto(href)) window.location.href = href;
  };
  const save = () => {
    void addAddressToContacts(email, name).then((created) => {
      if (created) toast.success(t("email_viewer.contact_added"));
    });
  };

  return (
    <ContextMenu ref={menuRef} isOpen={isOpen} position={position} onClose={onClose} label={name || email}>
      <ContextMenuItem icon={Copy} label={t("desktopUi.context.copy_address")} onClick={run(() => void copy())} testId="address-menu-copy" />
      <ContextMenuItem icon={Send} label={t("email_composer.new_message")} onClick={run(write)} testId="address-menu-write" />
      {contact ? (
        onViewContact && (
          <ContextMenuItem
            icon={ExternalLink}
            label={t("email_viewer.contact_sidebar.view_contact")}
            onClick={run(() => onViewContact(contact, email))}
            testId="address-menu-contact"
          />
        )
      ) : (
        <ContextMenuItem icon={UserPlus} label={t("email_viewer.contact_sidebar.add_to_contacts")} onClick={run(save)} testId="address-menu-contact" />
      )}
      {mailSearchAvailable() && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Search}
            label={t("context_menu.find_emails_from", { name: name || email })}
            onClick={run(() => requestMailSearch({ from: email }))}
            testId="address-menu-search"
          />
        </>
      )}
    </ContextMenu>
  );
}

/**
 * A right-click menu for one address, for the element that shows `email`.
 * The reader keeps that element when it opens another message, so the menu
 * closes when the address changes.
 */
export function useAddressContextMenu(email: string, onViewContact?: (contact: ContactCard | null, email: string) => void): {
  onContextMenu: (e: MouseEvent, address: MenuAddress) => void;
  menu: ReactNode;
} {
  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<MenuAddress>();
  useEffect(() => closeContextMenu(), [email, closeContextMenu]);
  return {
    onContextMenu: (e, address) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e, address);
    },
    menu: (
      <AddressContextMenu
        address={contextMenu.data}
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        onClose={closeContextMenu}
        menuRef={menuRef}
        onViewContact={onViewContact}
      />
    ),
  };
}

/** An address as text, with the address menu on a right-click. */
export function AddressText({ name, email, onViewContact }: MenuAddress & { onViewContact?: (contact: ContactCard | null, email: string) => void }) {
  const { onContextMenu, menu } = useAddressContextMenu(email, onViewContact);
  return (
    <>
      <span onContextMenu={(e) => onContextMenu(e, { name, email })}>{email}</span>
      {menu}
    </>
  );
}
