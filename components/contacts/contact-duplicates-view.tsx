"use client";

import { useTranslations } from "next-intl";
import { Merge, Users } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { AddressBook, ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";

interface ContactDuplicatesViewProps {
  groups: ContactCard[][];
  addressBooks: AddressBook[];
  onMerge: (cards: ContactCard[]) => void;
  onOpen: (id: string) => void;
}

/** "Possible duplicates": cards with the same name, address or phone, each set with its own Merge. */
export function ContactDuplicatesView({ groups, addressBooks, onMerge, onOpen }: ContactDuplicatesViewProps) {
  const t = useTranslations("ux_pim_cimport");
  const bookNames = (card: ContactCard) => Object.keys(card.addressBookIds ?? {})
    .filter((id) => card.addressBookIds[id])
    .map((id) => addressBooks.find((b) => b.id === id)?.name)
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex flex-col h-full" data-testid="contact-duplicates">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-lg font-semibold">{t("duplicates_title")}</h2>
        <p className="text-sm text-muted-foreground mt-1">{t("duplicates_hint")}</p>
      </div>
      {groups.length === 0 ? (
        <EmptyState compact icon={Users} title={t("duplicates_none")} />
      ) : (
        <ul className="flex-1 overflow-y-auto p-4 space-y-3">
          {groups.map((group) => (
            <li key={group.map((c) => c.id).join("|")} className="border border-border rounded-md">
              <ul className="divide-y divide-border">
                {group.map((card) => {
                  const name = getContactDisplayName(card);
                  const email = getContactPrimaryEmail(card);
                  const phone = Object.values(card.phones ?? {})[0]?.number;
                  const book = bookNames(card);
                  return (
                    <li key={card.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(card.id)}
                        className="w-full text-start px-3 py-2 hover:bg-muted transition-colors"
                      >
                        <div className="text-sm font-medium truncate">{name || email || "-"}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {[name ? email : "", phone, book].filter(Boolean).join(" · ")}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex justify-end px-3 py-2 border-t border-border">
                <Button size="sm" variant="outline" onClick={() => onMerge(group)}>
                  <Merge className="w-4 h-4 me-1.5" />
                  {t("merge_selected")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
