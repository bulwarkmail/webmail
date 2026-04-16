"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Mail, Phone, Building, ExternalLink, Copy, Send, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useContactStore, getContactDisplayName } from "@/stores/contact-store";
import { toast } from "@/stores/toast-store";
import type { ContactCard } from "@/lib/jmap/types";

interface RecipientPopoverProps {
  name?: string;
  email: string;
  /** Display label override (e.g. "me") */
  displayLabel?: string;
  /** Called when user clicks "View contact" - receives the contact and email */
  onViewContact?: (contact: ContactCard | null, email: string) => void;
  className?: string;
}

export function RecipientPopover({ name, email, displayLabel, onViewContact, className }: RecipientPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const contacts = useContactStore((s) => s.contacts);

  // Find matching contact by email
  const contact = contacts.find((c) => {
    if (!c.emails) return false;
    return Object.values(c.emails).some(
      (e) => e.address.toLowerCase() === email.toLowerCase()
    );
  });

  const contactName = contact ? getContactDisplayName(contact) : name;
  const emails = contact?.emails ? Object.values(contact.emails) : [];
  const phones = contact?.phones ? Object.values(contact.phones) : [];
  const orgs = contact?.organizations ? Object.values(contact.organizations) : [];

  const handleOpen = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = 300;
    const popoverHeight = 250;

    let top = rect.bottom + 4;
    let left = rect.left;

    // Keep within viewport
    if (left + popoverWidth > window.innerWidth - 8) {
      left = window.innerWidth - popoverWidth - 8;
    }
    if (left < 8) left = 8;
    if (top + popoverHeight > window.innerHeight - 8) {
      top = rect.top - popoverHeight - 4;
    }

    setPosition({ top, left });
    setIsOpen(true);
  };

  const handleClose = () => {
    setIsOpen(false);
    setPosition(null);
  };

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        handleClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen]);

  // Close on scroll so the popover does not float while content moves.
  useEffect(() => {
    if (!isOpen) return;
    const handler = () => handleClose();
    document.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      document.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [isOpen]);

  const handleViewContact = () => {
    if (onViewContact) {
      onViewContact(contact ?? null, email);
    }
    handleClose();
  };

  const handleCopyEmail = async (addr: string) => {
    try {
      await navigator.clipboard.writeText(addr);
      toast.success("Copied!");
    } catch {
      toast.error("Failed to copy");
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleOpen}
        className={cn(
          "text-foreground hover:text-primary hover:underline cursor-pointer transition-colors",
          className
        )}
      >
        {displayLabel || name || email}
      </button>

      {isOpen &&
        position &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-50 w-[300px] bg-background rounded-lg shadow-lg border border-border animate-in fade-in-0 zoom-in-95 duration-100"
            style={{ top: position.top, left: position.left }}
          >
            {/* Header with avatar and name */}
            <div className="px-4 pt-4 pb-3 flex items-center gap-3">
              <Avatar
                name={contactName || email}
                email={email}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-sm truncate">
                  {contactName || email}
                </div>
                {contactName && contactName !== email && (
                  <div className="text-xs text-muted-foreground truncate">
                    {email}
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
            </div>

            {/* Actions */}
            <div className="border-t border-border px-2 py-2 flex items-center gap-1">
              <button
                onClick={() => handleCopyEmail(email)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded hover:bg-muted transition-colors"
                title="Copy email"
              >
                <Copy className="w-3.5 h-3.5" />
                Copy
              </button>
              <a
                href={`mailto:${email}`}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded hover:bg-muted transition-colors"
                title="Send email"
              >
                <Send className="w-3.5 h-3.5" />
                Email
              </a>
              {onViewContact && (
                <button
                  onClick={handleViewContact}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded hover:bg-muted transition-colors ml-auto"
                  title={contact ? "View contact" : "View details"}
                >
                  {contact ? <ExternalLink className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
                  {contact ? "View contact" : "View details"}
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
