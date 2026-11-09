"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Book, BookPlus, MoreVertical, Pencil, Share2, Star, Tag, Trash2, Users } from "@/components/icons";
import { useContactStore } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { useManagedAccountStore } from "@/stores/managed-account-store";
import { toast } from "@/stores/toast-store";
import { SettingsSection } from "./settings-section";
import { cn } from "@/lib/utils";
import { collectionDisplayName } from "@/lib/default-collection-name";
import { IconButton } from "@/components/ui/icon-button";
import type { AddressBook, AddressBookRights } from "@/lib/jmap/types";
import { ShareCollectionDialog } from "./share-collection-dialog";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { useDeleteCategory } from "@/hooks/use-delete-category";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";

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
          aria-label={t("name_label")}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isValid) onSave(name.trim());
            if (e.key === "Escape") onCancel();
          }}
          className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground focus:outline-hidden"
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
  const tWording = useTranslations("uxs_wording");
  const bookName = (book: AddressBook) => collectionDisplayName(book.name, "addressBook", tWording("default_address_book"));
  const { client } = useAuthStore();
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);
  const { addressBooks, contacts, supportsSync, fetchAddressBooks, createAddressBook, renameAddressBook, shareAddressBook, setDefaultAddressBook, removeAddressBook, renameKeyword } = useContactStore();
  const deleteCategory = useDeleteCategory();
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingKeyword, setEditingKeyword] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { contextMenu, openContextMenu, openContextMenuFrom, closeContextMenu, menuRef } = useContextMenu<AddressBook>();

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

  const handleSetDefault = async (book: AddressBook) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await setDefaultAddressBook(client, book);
      toast.success(t("default_updated"));
    } catch {
      toast.error(t("set_default_failed"));
    } finally {
      setIsLoading(false);
    }
  };

  // An address book takes its contacts with it, so it asks first (R3), as
  // the Contacts sidebar does.
  const handleDelete = async (book: AddressBook) => {
    if (!client) return;
    const ok = await confirm({
      title: t("delete_title"),
      message: t("confirm_delete", { name: bookName(book) }),
      confirmText: t("delete"),
      variant: "destructive",
    });
    if (!ok) return;
    setIsLoading(true);
    try {
      await removeAddressBook(client, book);
      toast.success(t("deleted"));
    } catch {
      toast.error(t("delete_failed"));
    } finally {
      setIsLoading(false);
    }
  };

  // Deleting a category works as in the Contacts sidebar: no confirm, and
  // Undo puts it back on the same contacts (R3).
  const handleDeleteCategory = async (keyword: string) => {
    setIsLoading(true);
    try {
      await deleteCategory(keyword);
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

  // One action list per address book (R6), as for calendars: the row's icons
  // on wider screens, the ⋮ and right-click menu everywhere.
  const bookActions = (book: AddressBook) => {
    const canRename = !book.isShared || book.myRights?.mayWrite !== false;
    // The default only applies to books the account owns, and re-setting the
    // current default is a no-op, so hide it in both cases.
    const canSetDefault = !!client && !book.isShared && !book.isDefault;
    // The default book is where new contacts go, so it stays; a shared one
    // only when its owner lets this account delete it.
    const canDelete = !!client && !book.isDefault && book.myRights?.mayDelete !== false;
    const actions: Array<{ id: string; label: string; icon: typeof Pencil; run: () => void; disabled?: boolean; destructive?: boolean }> = [];
    if (canRename) actions.push({ id: "rename", label: t("rename"), icon: Pencil, run: () => setEditingId(book.id) });
    if (canSetDefault) actions.push({ id: "default", label: t("set_default"), icon: Star, run: () => void handleSetDefault(book), disabled: isLoading });
    if (!book.isShared && book.myRights?.mayShare) actions.push({ id: "share", label: t("share"), icon: Users, run: () => setSharingId(book.id) });
    if (canDelete) actions.push({ id: "delete", label: t("delete"), icon: Trash2, run: () => void handleDelete(book), disabled: isLoading, destructive: true });
    return actions;
  };

  const renderBookMenu = () => {
    const book = contextMenu.data;
    if (!book) return null;
    const run = (fn: () => void) => () => { closeContextMenu(); fn(); };
    const actions = bookActions(book);
    const plain = actions.filter((a) => !a.destructive);
    const destructive = actions.filter((a) => a.destructive);
    return (
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        {plain.map((a) => (
          <ContextMenuItem key={a.id} icon={a.icon} label={a.label} disabled={a.disabled} onClick={run(a.run)} />
        ))}
        {plain.length > 0 && destructive.length > 0 && <ContextMenuSeparator />}
        {destructive.map((a) => (
          <ContextMenuItem key={a.id} icon={a.icon} label={a.label} disabled={a.disabled} destructive onClick={run(a.run)} />
        ))}
      </ContextMenu>
    );
  };

  const renderBook = (book: AddressBook) => {
    if (editingId === book.id) {
      return (
        <AddressBookEditRow
          key={book.id}
          initial={bookName(book)}
          // Saved unchanged, the shown name keeps the server's own.
          onSave={(name) => handleUpdate(book, name === bookName(book) ? book.name : name)}
          onCancel={() => setEditingId(null)}
          isLoading={isLoading}
        />
      );
    }

    const actions = bookActions(book);

    return (
      <div
        key={book.id}
        onContextMenu={actions.length > 0 ? (e) => openContextMenu(e, book) : undefined}
        className={cn(
          "flex items-center gap-3 py-2.5 px-3 rounded-md border border-border bg-background group"
        )}
      >
        <Book className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium truncate block" title={bookName(book)} dir="auto">{bookName(book)}</span>
        </div>
        {book.isDefault && (
          <span className="flex-shrink-0 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
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
        {/* Phone: four icons next to the name left it a few letters, so the
            actions sit behind a ⋮ there, as for calendars. */}
        {actions.length > 0 && (
          <IconButton
            label={tContacts("row_actions", { name: bookName(book) })}
            className="sm:hidden flex-shrink-0 text-muted-foreground"
            onClick={(e) => openContextMenuFrom(e.currentTarget, book, "end")}
          >
            <MoreVertical />
          </IconButton>
        )}
        <div className="hidden sm:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
          {actions.map((action) => (
            <IconButton
              key={action.id}
              label={action.label}
              onClick={action.run}
              disabled={action.disabled}
              className={cn(
                "text-muted-foreground",
                action.destructive && "hover:text-destructive hover:bg-destructive/10",
              )}
            >
              <action.icon />
            </IconButton>
          ))}
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
    <SettingsSection id="address-books" title={tSettings("manage_title")} description={tSettings("manage_description")}>
      {renderBookMenu()}
      <div className="space-y-2">
        {/* In scoped mode (managing a shared account) hide the user's own
            address books and show only the managed account's group. */}
        {(managedAccountId ? [] : personal).map(renderBook)}

        {Array.from(sharedGroups.entries())
          .filter(([accountId]) => !managedAccountId || accountId === managedAccountId)
          .map(([accountId, group]) => (
          <div key={accountId} className="mt-4 space-y-2">
            <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
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
      <SettingsSection id="categories" title={tSettings("categories_title")} description={tSettings("categories_description")}>
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
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => setEditingKeyword(keyword)}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    title={tContacts("rename_category")}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteCategory(keyword)}
                    disabled={isLoading}
                    className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                    title={tContacts("delete_category")}
                    aria-label={tContacts("delete_category")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
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

    <PromptDialog
      isOpen={creating}
      onClose={() => setCreating(false)}
      title={t("create")}
      placeholder={t("name_label")}
      confirmText={t("create_confirm")}
      onSubmit={(name) => void handleCreate(name)}
    />

    <ConfirmDialog {...confirmProps} />

    {sharingId && client && (() => {
      const book = addressBooks.find((b) => b.id === sharingId);
      if (!book) return null;
      return (
        <ShareCollectionDialog
          client={client}
          kind="addressBook"
          collectionName={bookName(book)}
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
