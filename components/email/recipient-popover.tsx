"use client";

import { useState, useRef, useEffect, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Mail, Phone, Building, ExternalLink, Copy, Send, UserPlus } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { MailtoLink } from "@/components/ui/mailto-link";
import { useContactStore, getContactDisplayName } from "@/stores/contact-store";
import { toast } from "@/stores/toast-store";
import { useOwnDomainAddress } from "@/hooks/use-own-domain-address";
import type { ContactCard } from "@/lib/jmap/types";
import { useAddressContextMenu } from "./address-context-menu";

const CARD_WIDTH = 300;

const actionClass =
  "flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded hover:bg-muted transition-colors";

export interface RecipientCardProps {
  name?: string;
  email: string;
  /** Called when user clicks "View contact" - receives the contact and email */
  onViewContact?: (contact: ContactCard | null, email: string) => void;
  /** Called after an action that is done with the card ("View contact"). */
  onClose?: () => void;
  /** Shown under the contact details, above the actions. */
  children?: ReactNode;
  /** Extra buttons at the end of the action row. */
  actions?: ReactNode;
}

/**
 * Who an address belongs to: the saved contact's name, other addresses,
 * phones and company, with Copy, Email and View contact. Shared by the
 * names in a message header and by @mentions.
 */
export function RecipientCard({ name, email, onViewContact, onClose, children, actions }: RecipientCardProps) {
  const t = useTranslations("email_viewer.contact_sidebar");
  const contacts = useContactStore((s) => s.contacts);
  const shownEmail = useOwnDomainAddress()(email);

  // Find matching contact by email
  const contact = contacts.find((c) => {
    if (!c.emails) return false;
    return Object.values(c.emails).some(
      (e) => e.address.toLowerCase() === email.toLowerCase()
    );
  });

  const emails = contact?.emails ? Object.values(contact.emails) : [];
  // A contact without a name falls back to its address; prefer the name from
  // the message header in that case.
  const contactDisplayName = contact ? getContactDisplayName(contact) : '';
  const contactHasName = !!contactDisplayName &&
    !emails.some((e) => e.address.toLowerCase() === contactDisplayName.toLowerCase());
  const contactName = (contactHasName ? contactDisplayName : name) || contactDisplayName;
  const phones = contact?.phones ? Object.values(contact.phones) : [];
  const orgs = contact?.organizations ? Object.values(contact.organizations) : [];

  const handleViewContact = () => {
    onViewContact?.(contact ?? null, email);
    onClose?.();
  };

  const handleCopyEmail = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copy_failed"));
    }
  };

  return (
    <>
      {/* Header with avatar and name */}
      <div className="px-4 pt-4 pb-3 flex items-center gap-3">
        <Avatar
          name={contactName || shownEmail}
          email={email}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm truncate">
            {contactName || shownEmail}
          </div>
          {contactName && contactName.toLowerCase() !== email.toLowerCase() && (
            <div className="text-xs text-muted-foreground truncate">
              {shownEmail}
            </div>
          )}
          {orgs.length > 0 && orgs[0].name && (
            <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
              <Building className="w-3 h-3 shrink-0" />
              {orgs[0].name}
            </div>
          )}
        </div>
      </div>

      {/* Contact details */}
      <div className="px-4 pb-3 space-y-1.5">
        {/* Show additional emails if contact has them */}
        {emails.length > 1 && (
          <div className="space-y-1">
            {emails.slice(1).map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Mail className="w-3 h-3 shrink-0" />
                <span className="truncate">{e.address}</span>
              </div>
            ))}
          </div>
        )}

        {/* Phone numbers */}
        {phones.length > 0 && (
          <div className="space-y-1">
            {phones.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                <Phone className="w-3 h-3 shrink-0" />
                <a href={`tel:${p.number}`} className="hover:text-foreground hover:underline truncate">
                  {p.number}
                </a>
              </div>
            ))}
          </div>
        )}

        {children}
      </div>

      {/* Actions */}
      <div className="border-t border-border px-2 py-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => handleCopyEmail(email)}
          className={actionClass}
          title={t("action_copy_title")}
        >
          <Copy className="w-3.5 h-3.5" />
          {t("action_copy")}
        </button>
        <MailtoLink
          to={email}
          className={actionClass}
          title={t("action_email_title")}
        >
          <Send className="w-3.5 h-3.5" />
          {t("action_email")}
        </MailtoLink>
        {onViewContact && (
          <button
            type="button"
            onClick={handleViewContact}
            className={cn(actionClass, "ms-auto")}
            title={contact ? t("view_contact") : t("view_details")}
          >
            {contact ? <ExternalLink className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
            {contact ? t("view_contact") : t("view_details")}
          </button>
        )}
        {actions}
      </div>
    </>
  );
}

/** Where a card opens: under the element that opened it, in viewport pixels. */
export interface CardAnchor {
  top: number;
  bottom: number;
  left: number;
}

/** Under the anchor, or above it when there is no room below; always on screen. */
export function placeCard(anchor: CardAnchor, height: number): { top: number; left: number } {
  let top = anchor.bottom + 4;
  let left = anchor.left;
  if (left + CARD_WIDTH > window.innerWidth - 8) left = window.innerWidth - CARD_WIDTH - 8;
  if (left < 8) left = 8;
  if (top + height > window.innerHeight - 8 && anchor.top - height - 4 > 8) top = anchor.top - height - 4;
  return { top, left };
}

export const recipientCardClass =
  "fixed z-50 w-[300px] max-w-[calc(100vw-16px)] bg-background rounded-lg shadow-lg border border-border animate-in fade-in-0 zoom-in-95 animation-duration-100";

interface RecipientCardPopoverProps extends RecipientCardProps {
  anchor: CardAnchor;
  onClose: () => void;
  /** A press here doesn't count as outside (the trigger, which toggles). */
  ignoreRef?: RefObject<HTMLElement | null>;
}

/**
 * A RecipientCard floating at an anchor. Closes on a press outside it,
 * Escape, scrolling, resizing, and the window losing focus - which is what
 * a click into a message body's iframe looks like from here.
 */
export function RecipientCardPopover({ anchor, onClose, ignoreRef, ...card }: RecipientCardPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    setPosition(placeCard(anchor, popoverRef.current?.offsetHeight ?? 250));
  }, [anchor]);

  useEffect(() => {
    const close = () => onCloseRef.current();
    const onPress = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || ignoreRef?.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPress);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", onPress);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [ignoreRef]);

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={card.name || card.email}
      className={recipientCardClass}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? undefined : "hidden" }}
    >
      <RecipientCard {...card} onClose={onClose} />
    </div>,
    document.body
  );
}

interface RecipientPopoverProps {
  name?: string;
  email: string;
  /** Display label override (e.g. "me") */
  displayLabel?: string;
  /** Rich content in place of the text label, such as a name over its address. */
  label?: React.ReactNode;
  /** Called when user clicks "View contact" - receives the contact and email */
  onViewContact?: (contact: ContactCard | null, email: string) => void;
  className?: string;
}

export function RecipientPopover({ name, email, displayLabel, label, onViewContact, className }: RecipientPopoverProps) {
  const [anchor, setAnchor] = useState<CardAnchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const shownEmail = useOwnDomainAddress()(email);
  const addressMenu = useAddressContextMenu(email, onViewContact);

  const handleToggle = () => {
    if (anchor) {
      setAnchor(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.top, bottom: rect.bottom, left: rect.left });
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        onContextMenu={(e) => {
          setAnchor(null);
          addressMenu.onContextMenu(e, { name, email });
        }}
        className={cn(
          "text-foreground hover:text-primary hover:underline cursor-pointer transition-colors min-w-0 break-words text-start",
          className
        )}
      >
        {label ?? <bdi>{displayLabel || name || shownEmail}</bdi>}
      </button>

      {anchor && (
        <RecipientCardPopover
          anchor={anchor}
          name={name}
          email={email}
          onViewContact={onViewContact}
          onClose={() => setAnchor(null)}
          ignoreRef={triggerRef}
        />
      )}
      {addressMenu.menu}
    </>
  );
}
