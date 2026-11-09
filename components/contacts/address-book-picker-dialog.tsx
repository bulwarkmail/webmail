"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import { Book, Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { AddressBook } from "@/lib/jmap/types";
import { useCollectionNames } from "@/hooks/use-collection-names";
import { groupCalendarsByAccount } from "@/lib/calendar-targets";
import { useAccountStore } from "@/stores/account-store";

interface AddressBookPickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The books contacts can be moved to (writable ones). */
  addressBooks: AddressBook[];
  /** The book the contacts are in now, when they are all in one. */
  currentId?: string | null;
  count: number;
  onPick: (book: AddressBook) => void;
}

/** "Move to…" for contacts: pick the address book they go to. */
export function AddressBookPickerDialog({ isOpen, onClose, addressBooks, currentId, count, onPick }: AddressBookPickerDialogProps) {
  const shownName = useCollectionNames();
  const t = useTranslations("contacts");
  const [selected, setSelected] = useState<string | null>(null);
  const choice = addressBooks.find((b) => b.id === selected && b.id !== currentId) ?? null;
  // Under each account's address with several signed in (pim-p2-3).
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const groups = groupCalendarsByAccount(addressBooks, accounts, activeAccountId);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("address_books.move_title")}
      description={t("bulk.moving_contacts", { count })}
      onSubmit={(e) => {
        e.preventDefault();
        if (!choice) return;
        onPick(choice);
        onClose();
      }}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>{t("form.cancel")}</Button>
          <Button type="submit" disabled={!choice}>{t("address_books.move_here")}</Button>
        </>
      }
    >
      <div role="radiogroup" aria-label={t("address_books.title")} className="mt-4 max-h-80 overflow-y-auto rounded-md border border-border py-1">
        {groups.map((group) => (
          <Fragment key={group.key || "own"}>
            {group.label && (
              <div className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground truncate" data-testid="address-book-account" title={group.label}>{group.label}</div>
            )}
        {group.calendars.map((book) => {
          const isCurrent = book.id === currentId;
          const isSelected = selected === book.id;
          return (
            <button
              key={book.id}
              type="button"
              role="radio"
              aria-checked={isSelected}
              disabled={isCurrent}
              onClick={() => setSelected(book.id)}
              onDoubleClick={() => { if (!isCurrent) { onPick(book); onClose(); } }}
              className={cn(
                "w-full flex items-center gap-2 px-3 h-9 text-sm text-start outline-none focus-inset",
                isSelected ? "bg-selection" : "hover:bg-muted",
                isCurrent && "text-muted-foreground",
              )}
            >
              <Book className="w-4 h-4 shrink-0 text-muted-foreground" />
              <span className="truncate flex-1" title={shownName.addressBook(book)}>{shownName.addressBook(book)}</span>
              {book.isShared && book.accountName && (
                <span className="text-xs text-muted-foreground truncate max-w-[40%]" title={book.accountName}>{book.accountName}</span>
              )}
              {isSelected && <Check className="w-4 h-4 shrink-0 text-primary" />}
            </button>
          );
        })}
          </Fragment>
        ))}
      </div>
    </Dialog>
  );
}
