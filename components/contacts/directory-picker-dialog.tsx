"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { cn } from "@/lib/utils";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { ContactCard } from "@/lib/jmap/types";
import { useContactStore, getContactDisplayName, type DirectoryEntry } from "@/stores/contact-store";
import { DirectoryBrowser, directoryKey } from "./directory-browser";
import { ModalWindow } from "@/components/ui/dialog-surface";

export type RecipientField = "to" | "cc" | "bcc";

type PickerTab = "contacts" | "directory";

interface DirectoryPickerDialogProps {
  client: IJMAPClient | null;
  onClose: () => void;
  /** Called with the checked entries in list order; the dialog closes afterwards. */
  onAdd: (field: RecipientField, entries: DirectoryEntry[]) => void;
}

/** Every address of the user's own contacts, one row each; groups are left out. */
export function contactEntries(contacts: ContactCard[]): DirectoryEntry[] {
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];
  for (const contact of contacts) {
    if (contact.kind === "group") continue;
    const name = getContactDisplayName(contact);
    for (const email of Object.values(contact.emails ?? {})) {
      const address = email?.address?.trim();
      if (!address) continue;
      const entry = { id: `${contact.id}:${address}`, name: name || address, email: address };
      if (seen.has(directoryKey(entry))) continue;
      seen.add(directoryKey(entry));
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * The composer's recipient picker: the user's own contacts, and the server's
 * directory (other accounts) on a tab of its own where the server has one.
 * It used to list only the directory, without the contacts autocomplete offers.
 */
export function DirectoryPickerDialog({ client, onClose, onAdd }: DirectoryPickerDialogProps) {
  const t = useTranslations("contacts.directory");
  const tSend = useTranslations("compose_send");
  const modalRef = useFocusTrap({ isActive: true, onEscape: onClose, restoreFocus: true });
  const contacts = useContactStore((s) => s.contacts);
  const ownEntries = useMemo(() => contactEntries(contacts ?? []), [contacts]);
  const hasDirectory = !!client?.supportsPrincipals?.();
  // Contacts first; straight to the directory for someone who has none.
  const [tab, setTab] = useState<PickerTab>(() => (ownEntries.length === 0 && hasDirectory ? "directory" : "contacts"));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const add = (field: RecipientField) => {
    // Checked on either tab, each address once.
    const pool = [...ownEntries, ...useContactStore.getState().directoryPrincipals];
    const seen = new Set<string>();
    const entries = pool.filter((e) => {
      const key = directoryKey(e);
      if (!selected.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (entries.length === 0) return;
    onAdd(field, entries);
    onClose();
  };

  const tabButton = (value: PickerTab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`recipient-picker-tab-${value}`}
      aria-selected={tab === value}
      aria-controls="recipient-picker-panel"
      onClick={() => setTab(value)}
      className={cn(
        "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
        tab === value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <ModalWindow title={tSend("picker_title")} onClose={onClose}>
      <div data-modal-backdrop="" className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="directory-picker-title"
          className="bg-background border border-border rounded-lg shadow-xl w-full max-w-lg h-[80vh] max-h-[640px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
          data-testid="directory-picker-dialog"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 id="directory-picker-title" className="text-sm font-semibold text-foreground">
              {tSend("picker_title")}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("cancel")}
              className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {hasDirectory && (
            <div role="tablist" className="flex gap-1 px-3 border-b border-border">
              {tabButton("contacts", tSend("tab_contacts"))}
              {tabButton("directory", tSend("tab_directory"))}
            </div>
          )}

          <div
            id="recipient-picker-panel"
            role={hasDirectory ? "tabpanel" : undefined}
            aria-labelledby={hasDirectory ? `recipient-picker-tab-${tab}` : undefined}
            className="flex-1 min-h-0 flex flex-col"
          >
            <DirectoryBrowser
              // A fresh search and first page on each tab.
              key={tab}
              client={client}
              selected={selected}
              onSelectedChange={setSelected}
              autoFocusSearch
              className="flex-1"
              {...(tab === "contacts"
                ? {
                    entries: ownEntries,
                    labels: {
                      list: tSend("tab_contacts"),
                      emptyTitle: tSend("contacts_empty_title"),
                      emptyHint: tSend("contacts_empty_hint"),
                      noMatch: tSend("contacts_no_match"),
                    },
                  }
                : {})}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-t border-border">
            <span className="text-xs text-muted-foreground me-auto tabular-nums">
              {t("selected_count", { count: selected.size })}
            </span>
            <Button size="sm" variant="ghost" onClick={onClose}>{t("cancel")}</Button>
            <Button size="sm" variant="outline" disabled={selected.size === 0} onClick={() => add("bcc")}>{t("add_bcc")}</Button>
            <Button size="sm" variant="outline" disabled={selected.size === 0} onClick={() => add("cc")}>{t("add_cc")}</Button>
            <Button size="sm" disabled={selected.size === 0} onClick={() => add("to")}>{t("add_to")}</Button>
          </div>
        </div>
      </div>
    </ModalWindow>
  );
}
