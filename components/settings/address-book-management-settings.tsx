"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Book, BookPlus, Pencil, Share2, Tag, Users } from "lucide-react";
import { useContactStore } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { useManagedAccountStore } from "@/stores/managed-account-store";
import { toast } from "@/stores/toast-store";
import { SettingsSection } from "./settings-section";
import { cn } from "@/lib/utils";
import type { AddressBook, AddressBookRights } from "@/lib/jmap/types";
import { ShareCollectionDialog } from "./share-collection-dialog";
import { RenameDialog } from "@/components/files/rename-dialog";

function AddressBookEditRow({
  initial,
  onSave,
  onCancel,
  isLoading,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const t = useTranslations("contacts.address_books");
  const tCal = useTranslations("calendar.management");
  const [name, setName] = useState(initial);
  const isValid = name.trim().length > 0;

  return (
    <div className="space-y-3 p-3 rounded-md border border-primary/30 bg-accent/30">
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          {t("name_label")}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isValid) onSave(name.trim());
            if (e.key === "Escape") onCancel();
          }}
          className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          autoFocus
          disabled={isLoading}
        />
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => isValid && onSave(name.trim())}
          disabled={isLoading || !isValid}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          {tCal("save")}
        </button>
        <button
          onClick={onCancel}
          disabled={isLoading}
          className="px-3 py-1.5 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
        >
          {tCal("cancel")}
        </button>
      </div>
    </div>
  );
}

export function AddressBookManagementSettings() {
  const t = useTranslations("contacts.address_books");
  const tContacts = useTranslations("contacts");
  const tSettings = useTranslations("settings.contacts");
  const { client } = useAuthStore();
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);
  const { addressBooks, contacts, supportsSync, fetchAddressBooks, createAddressBook, renameAddressBook, shareAddressBook, renameKeyword } = useContactStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKeyword, setEditingKeyword] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (client && addressBooks.length === 0) {
      fetchAddressBooks(client);
    }
  }, [client, addressBooks.length, fetchAddressBooks]);

  const handleCreate = async (name: string) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await createAddressBook(client, name);
      await fetchAddressBooks(client);
      setCreating(false);
      toast.success(t("created"));
    } catch {
      toast.error(t("create_failed"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async (book: AddressBook, newName: string) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await renameAddressBook(client, book, newName);
      setEditingId(null);
      toast.success(t("renamed"));
    } catch {
      toast.error(t("rename_failed"));
    } finally {
      setIsLoading(false);
    }
  };

  // Group: personal first, then by shared account
  const personal = addressBooks.filter((b) => !b.isShared);
  const sharedGroups = new Map<string, { accountName: string; books: AddressBook[] }>();
  for (const book of addressBooks) {
    if (!book.isShared || !book.accountId) continue;
    const key = book.accountId;
    const existing = sharedGroups.get(key);
    if (existing) existing.books.push(book);
    else sharedGroups.set(key, { accountName: book.accountName || book.accountId, books: [book] });
  }

  const renderBook = (book: AddressBook) => {
    if (editingId === book.id) {
      return (
        <AddressBookEditRow
          key={book.id}
          initial={book.name}
          onSave={(name) => handleUpdate(book, name)}
          onCancel={() => setEditingId(null)}
          isLoading={isLoading}
        />
      );
    }

    const canRename = !book.isShared || book.myRights?.mayWrite !== false;

    return (
      <div
        key={book.id}
        className={cn(
          "flex items-center gap-3 py-2.5 px-3 rounded-md border border-border bg-background group"
        )}
      >
        <Book className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium truncate block">{book.name}</span>
        </div>
        {book.isDefault && (
          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            {t("default")}
          </span>
        )}
        {(() => {
          const shareCount = Object.keys(book.shareWith || {}).length;
          if (shareCount === 0 || book.isShared) return null;
          return (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full"
              title={t("share")}
            >
              <Users className="w-3 h-3" />
              {shareCount}
            </span>
          );
        })()}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {canRename && (
            <button
              type="button"
              onClick={() => setEditingId(book.id)}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={t("rename")}
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
          {!book.isShared && book.myRights?.mayShare && (
            <button
              type="button"
              onClick={() => setSharingId(book.id)}
              className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={t("share")}
            >
              <Users className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  };

  // Collect keywords with counts
  const keywordCounts: Record<string, number> = {};
  for (const c of contacts) {
    if (c.kind === "group" || !c.keywords) continue;
    for (const [kw, active] of Object.entries(c.keywords)) {
      if (active) keywordCounts[kw] = (keywordCounts[kw] || 0) + 1;
    }
  }
  const sortedKeywords = Object.entries(keywordCounts).sort(([a], [b]) => a.localeCompare(b));

  const handleRenameKeyword = async (oldKw: string, newKw: string) => {
    setIsLoading(true);
    try {
      await renameKeyword(supportsSync && client ? client : null, oldKw, newKw);
      setEditingKeyword(null);
      toast.success(tContacts("category_renamed"));
    } catch {
      toast.error(tContacts("category_rename_failed"));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
    <SettingsSection title={tSettings("manage_title")} description={tSettings("manage_description")}>
      <div className="space-y-2">
        {/* In scoped mode (managing a shared account) hide the user's own
            address books and show only the managed account's group. */}
        {(managedAccountId ? [] : personal).map(renderBook)}

        {Array.from(sharedGroups.entries())
          .filter(([accountId]) => !managedAccountId || accountId === managedAccountId)
          .map(([accountId, group]) => (
          <div key={accountId} className="mt-4 space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Share2 className="w-3 h-3" />
              {t("shared_prefix", { name: group.accountName })}
            </h4>
            {group.books.map(renderBook)}
          </div>
        ))}

        {addressBooks.length === 0 && (
          <p className="text-sm text-muted-foreground py-2">{tSettings("no_address_books")}</p>
        )}

        {/* Creating targets the user's own account, so hide it while scoped to a
            managed (shared) account. */}
        {!managedAccountId && client && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 py-2.5 px-3 w-full rounded-md border border-dashed border-border text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <BookPlus className="w-4 h-4 flex-shrink-0" />
            {t("create")}
          </button>
        )}
      </div>
    </SettingsSection>

    {/* Contact categories come from the active account's contacts, not the
        shared account, so hide them while scoped to a shared account. */}
    {!managedAccountId && (
    <div className="mt-8">
      <SettingsSection title={tSettings("categories_title")} description={tSettings("categories_description")}>
        <div className="space-y-2">
          {sortedKeywords.map(([keyword, count]) => {
            if (editingKeyword === keyword) {
              return (
                <AddressBookEditRow
                  key={keyword}
                  initial={keyword}
                  onSave={(name) => handleRenameKeyword(keyword, name)}
                  onCancel={() => setEditingKeyword(null)}
                  isLoading={isLoading}
                />
              );
            }
            return (
              <div
                key={keyword}
                className="flex items-center gap-3 py-2.5 px-3 rounded-md border border-border bg-background group"
              >
                <Tag className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium truncate block">{keyword}</span>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => setEditingKeyword(keyword)}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    title={tContacts("rename_category")}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
          {sortedKeywords.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">{tSettings("no_categories")}</p>
          )}
        </div>
      </SettingsSection>
    </div>
    )}

    {creating && (
      <RenameDialog
        currentName=""
        title={t("create")}
        label={t("name_label")}
        onCancel={() => setCreating(false)}
        onConfirm={handleCreate}
      />
    )}

    {sharingId && client && (() => {
      const book = addressBooks.find((b) => b.id === sharingId);
      if (!book) return null;
      return (
        <ShareCollectionDialog
          client={client}
          kind="addressBook"
          collectionName={book.name}
          shareWith={book.shareWith}
          ownAccountId={client.getAccountId()}
          onShare={async (principalId, rights) => {
            await shareAddressBook(client, book, principalId, rights as AddressBookRights | null);
          }}
          onClose={() => setSharingId(null)}
        />
      );
    })()}
    </>
  );
}
