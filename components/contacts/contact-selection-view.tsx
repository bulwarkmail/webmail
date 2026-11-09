"use client";

import { useTranslations } from "next-intl";
import { CheckSquare, Download, FolderInput, Mail, Merge, Trash2, Users } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { MenuShortcut } from "@/components/ui/context-menu";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { formatRecipient } from "@/lib/email-composer-utils";

/** The most names the pane lists; the rest is "and N more". */
const NAMES_SHOWN = 8;

/**
 * One new message to the selected contacts, in To as Outlook does: their first address
 * each, without the same address twice; contacts without one are left out.
 */
export function selectionRecipients(contacts: readonly ContactCard[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const contact of contacts) {
    const email = getContactPrimaryEmail(contact).trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    const name = getContactDisplayName(contact);
    out.push(formatRecipient(name && name !== email ? name : "", email));
  }
  return out;
}

interface ContactSelectionViewProps {
  contacts: ContactCard[];
  onSendEmail: () => void;
  onAddToGroup?: () => void;
  onMoveTo?: () => void;
  onMerge?: () => void;
  onExport: () => void;
  onDelete?: () => void;
  onClear: () => void;
  exporting?: boolean;
}

/**
 * The right side while contacts are ticked (pim-p3-7), as Mail's selection pane: how many,
 * who, and what can be done with all of them. The open contact's card goes, so nothing on
 * screen acts on one contact while several are chosen.
 */
export function ContactSelectionView({ contacts, onSendEmail, onAddToGroup, onMoveTo, onMerge, onExport, onDelete, onClear, exporting }: ContactSelectionViewProps) {
  const t = useTranslations("ux_p3_pim_pc");
  const tContacts = useTranslations("contacts");
  const tMerge = useTranslations("ux_pim_cimport");
  const tMenu = useTranslations("menuAudit");
  const title = t("selection_title", { count: contacts.length });
  const names = contacts.slice(0, NAMES_SHOWN).map((c) => getContactDisplayName(c) || getContactPrimaryEmail(c));
  const rest = contacts.length - names.length;
  const anyEmail = contacts.some((c) => !!getContactPrimaryEmail(c).trim());

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto py-8">
      <section aria-label={title} className="mx-auto w-full max-w-md px-4 text-center" data-testid="contact-selection-pane">
        <CheckSquare className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="mt-1 break-words text-sm text-muted-foreground" dir="auto" data-testid="contact-selection-names">
          {names.join(", ")}
          {rest > 0 && <> {t("selection_more", { count: rest })}</>}
        </p>
        <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="contact-selection-actions">
          <Button variant="outline" size="sm" className="gap-2" onClick={onSendEmail} disabled={!anyEmail} data-testid="contact-selection-send">
            <Mail className="size-4 shrink-0" />
            <span className="truncate">{tContacts("context_menu.send_email")}</span>
          </Button>
          {onAddToGroup && (
            <Button variant="outline" size="sm" className="gap-2" onClick={onAddToGroup}>
              <Users className="size-4 shrink-0" />
              <span className="truncate">{tMenu("contacts_bulk_add_to_group")}</span>
            </Button>
          )}
          {onMoveTo && (
            <Button variant="outline" size="sm" className="gap-2" onClick={onMoveTo}>
              <FolderInput className="size-4 shrink-0" />
              <span className="truncate">{tContacts("address_books.move_to")}</span>
            </Button>
          )}
          {onMerge && contacts.length > 1 && (
            <Button variant="outline" size="sm" className="gap-2" onClick={onMerge}>
              <Merge className="size-4 shrink-0" />
              <span className="truncate">{tMerge("merge_selected")}</span>
            </Button>
          )}
          <Button variant="outline" size="sm" className="gap-2" onClick={onExport} disabled={exporting} aria-busy={exporting}>
            <Download className="size-4 shrink-0" />
            <span className="truncate">{tContacts("context_menu.export_vcard")}</span>
          </Button>
          {onDelete && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
              title={`${tContacts("context_menu.delete")} (Del)`}
              aria-keyshortcuts="Delete"
            >
              <Trash2 className="size-4 shrink-0 text-destructive" />
              <span className="truncate">{tContacts("context_menu.delete")}</span>
            </Button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="mt-3 gap-2 text-muted-foreground hover:text-foreground"
          aria-keyshortcuts="Escape"
          data-testid="contact-selection-clear"
        >
          {tContacts("bulk.clear")}
          <MenuShortcut keys="Esc" />
        </Button>
      </section>
    </div>
  );
}
