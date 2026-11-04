"use client";

import { useMemo, useState, useCallback, useRef, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { BookUser, Building2, User, Users, Plus, Share2, Book, BookPlus, ChevronRight, ChevronDown, UserPlus, UsersRound, Upload, Tag, Pencil, Trash2, Settings, Mail, Star, MoreVertical } from "@/components/icons";
import { useRouter } from "@/i18n/navigation";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu } from "@/components/ui/context-menu";
import { isContextMenuKey, useContextMenu } from "@/hooks/use-context-menu";
import { useLongPress } from "@/hooks/use-long-press";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import type { ContactCard, AddressBook } from "@/lib/jmap/types";
import { getContactDisplayName, TRUSTED_SENDERS_BOOK_NAME } from "@/stores/contact-store";
import { useAccountStore } from "@/stores/account-store";
import { useCollectionNames } from "@/hooks/use-collection-names";
import { AccountScopeLabel } from "@/components/layout/account-scope-label";

export type ContactCategory = "all" | "directory" | { groupId: string } | { addressBookId: string } | { keyword: string } | "uncategorized";

interface ContactsSidebarProps {
  groups: ContactCard[];
  individuals: ContactCard[];
  addressBooks: AddressBook[];
  activeCategory: ContactCategory;
  onSelectCategory: (category: ContactCategory) => void;
  onCreateGroup: () => void;
  onCreateContact: () => void;
  onCreateAddressBook?: () => void;
  onImport?: () => void;
  onEditGroup?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onComposeGroup?: (groupId: string, field: "to" | "cc" | "bcc") => void;
  onDropContacts?: (contactIds: string[], addressBook: AddressBook) => void;
  onDropContactsToCategory?: (contactIds: string[], keyword: string) => void;
  onRenameAddressBook?: (addressBook: AddressBook) => void;
  onShareAddressBook?: (addressBook: AddressBook) => void;
  onSetDefaultAddressBook?: (addressBook: AddressBook) => void;
  onCreateContactInBook?: (addressBook: AddressBook) => void;
  onDeleteAddressBook?: (addressBook: AddressBook) => void;
  onRenameKeyword?: (keyword: string) => void;
  /** Take the category off every contact. */
  onDeleteKeyword?: (keyword: string) => void;
  /** Entries in the company directory; the Directory entry shows only when set. */
  directoryCount?: number;
  className?: string;
  /**
   * Pro shell: render one collapsible section per connected local account
   * (active first), each with "My Address Books" / "Shared from X"
   * subsections. Mirrors the calendar sidebar's Pro layout.
   */
  multiAccountMode?: boolean;
}

type AddressBookAccountSplit = {
  owned: AddressBook[];
  sharedGroups: { label: string; books: AddressBook[] }[];
};

function splitAccountBooks(list: AddressBook[]): AddressBookAccountSplit {
  const owned: AddressBook[] = [];
  const sharedBuckets = new Map<string, { label: string; books: AddressBook[] }>();
  for (const book of list) {
    if (book.isShared) {
      const key = book.accountId || book.accountName || book.id;
      const bucket = sharedBuckets.get(key);
      if (bucket) {
        bucket.books.push(book);
      } else {
        sharedBuckets.set(key, { label: book.accountName || key, books: [book] });
      }
    } else {
      owned.push(book);
    }
  }
  return { owned, sharedGroups: Array.from(sharedBuckets.values()) };
}

const COLLAPSED_KEY = "contacts-sidebar-collapsed";

function loadCollapsed(): Record<string, boolean> {
  try {
    const v = localStorage.getItem(COLLAPSED_KEY);
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
}

function saveCollapsed(state: Record<string, boolean>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

/**
 * The app's own "Trusted Senders" book: the senders whose images load, kept
 * and managed in Settings, not a list of people. The sidebar leaves it out.
 */
export function isTrustedSendersBook(book: AddressBook): boolean {
  return !book.isShared && book.name === TRUSTED_SENDERS_BOOK_NAME;
}

export function ContactsSidebar({
  groups,
  individuals,
  addressBooks: allAddressBooks,
  activeCategory,
  onSelectCategory,
  onCreateGroup,
  onCreateContact,
  onCreateAddressBook,
  onImport,
  onEditGroup,
  onDeleteGroup,
  onComposeGroup,
  onDropContacts,
  onDropContactsToCategory,
  onRenameAddressBook,
  onShareAddressBook,
  onSetDefaultAddressBook,
  onCreateContactInBook,
  onDeleteAddressBook,
  onRenameKeyword,
  onDeleteKeyword,
  directoryCount,
  className,
  multiAccountMode,
}: ContactsSidebarProps) {
  const shownName = useCollectionNames();
  const t = useTranslations("contacts");
  const tx = useTranslations("ux_pim_contact");
  const router = useRouter();
  const addressBooks = useMemo(() => allAddressBooks.filter(b => !isTrustedSendersBook(b)), [allAddressBooks]);
  const { contextMenu: groupContextMenu, openContextMenu: openGroupContextMenu, openContextMenuFrom: openGroupMenuFrom, closeContextMenu: closeGroupContextMenu, menuRef: groupMenuRef } = useContextMenu<ContactCard>();
  const { contextMenu: bookContextMenu, openContextMenu: openBookContextMenu, openContextMenuFrom: openBookMenuFrom, closeContextMenu: closeBookContextMenu, menuRef: bookMenuRef } = useContextMenu<AddressBook>();
  const hasBookMenu = !!(onRenameAddressBook || onShareAddressBook || onSetDefaultAddressBook || onCreateContactInBook || onDeleteAddressBook);
  const { contextMenu: keywordContextMenu, openContextMenu: openKeywordContextMenu, openContextMenuFrom: openKeywordMenuFrom, closeContextMenu: closeKeywordContextMenu, menuRef: keywordMenuRef } = useContextMenu<string>();
  const hasKeywordMenu = !!(onRenameKeyword || onDeleteKeyword);
  // Every row with a menu opens it by right-click, its ⋮, long-press and the menu key.
  const bookMenu = (book: AddressBook) => hasBookMenu ? {
    onContextMenu: (e: React.MouseEvent) => openBookContextMenu(e, book),
    onOpenMenu: (anchor: HTMLElement) => openBookMenuFrom(anchor, book, "end"),
    menuLabel: t("row_actions", { name: shownName.addressBook(book) }),
  } : {};

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const newMenu = useContextMenu<null>();

  const toggleSection = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) =>
      getContactDisplayName(a).localeCompare(getContactDisplayName(b))
    );
  }, [groups]);

  const isAllActive = activeCategory === "all";

  // Group address books: personal vs shared accounts
  const personalBooks = useMemo(() =>
    addressBooks.filter(b => !b.isShared),
  [addressBooks]);

  const sharedBookGroups = useMemo(() => {
    const map = new Map<string, { accountId: string; accountName: string; books: AddressBook[] }>();
    for (const book of addressBooks) {
      if (!book.isShared || !book.accountId) continue;
      const existing = map.get(book.accountId);
      if (existing) {
        existing.books.push(book);
      } else {
        map.set(book.accountId, {
          accountId: book.accountId,
          accountName: book.accountName || book.accountId,
          books: [book],
        });
      }
    }
    return Array.from(map.values());
  }, [addressBooks]);

  // Pro / multi-account grouping: each local account is its own collapsible
  // section with owned / shared sub-buckets.
  const localAccounts = useAccountStore((s) => s.accounts);
  const activeLocalAccountId = useAccountStore((s) => s.activeAccountId);
  const localAccountGroups = useMemo(() => {
    if (!multiAccountMode) return [];
    const byAccount = new Map<string, AddressBook[]>();
    for (const book of addressBooks) {
      const key = book.localAccountId || '__other__';
      const list = byAccount.get(key) ?? [];
      list.push(book);
      byAccount.set(key, list);
    }
    const ordered: { key: string; label: string; split: AddressBookAccountSplit }[] = [];
    if (activeLocalAccountId && byAccount.has(activeLocalAccountId)) {
      const acct = localAccounts.find(a => a.id === activeLocalAccountId);
      ordered.push({
        key: activeLocalAccountId,
        label: acct?.label || acct?.email || acct?.username || activeLocalAccountId,
        split: splitAccountBooks(byAccount.get(activeLocalAccountId)!),
      });
      byAccount.delete(activeLocalAccountId);
    }
    for (const acct of localAccounts) {
      if (!byAccount.has(acct.id)) continue;
      ordered.push({
        key: acct.id,
        label: acct.label || acct.email || acct.username,
        split: splitAccountBooks(byAccount.get(acct.id)!),
      });
      byAccount.delete(acct.id);
    }
    for (const [key, list] of byAccount.entries()) {
      const fallback = key === '__other__'
        ? t('address_books.title')
        : list[0]?.accountName || key;
      ordered.push({ key, label: fallback, split: splitAccountBooks(list) });
    }
    return ordered;
  }, [multiAccountMode, addressBooks, localAccounts, activeLocalAccountId, t]);

  // Count contacts per address book
  const contactCountByBook = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const contact of individuals) {
      if (!contact.addressBookIds) continue;
      for (const bookId of Object.keys(contact.addressBookIds)) {
        if (!contact.addressBookIds[bookId]) continue;
        counts[bookId] = (counts[bookId] || 0) + 1;
      }
    }
    return counts;
  }, [individuals]);

  // Auto-collect keywords from all contacts
  const allKeywords = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const contact of individuals) {
      if (!contact.keywords) continue;
      for (const [kw, active] of Object.entries(contact.keywords)) {
        if (!active) continue;
        counts[kw] = (counts[kw] || 0) + 1;
      }
    }
    return Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  }, [individuals]);

  // Count of contacts without any keywords
  const uncategorizedCount = useMemo(() => {
    return individuals.filter(c => !c.keywords || Object.keys(c.keywords).filter(k => c.keywords![k]).length === 0).length;
  }, [individuals]);

  // Resolve actual group member counts against living contacts
  const memberCountByGroup = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of groups) {
      if (!group.members) {
        counts[group.id] = 0;
        continue;
      }
      const memberKeys = Object.keys(group.members).filter(k => group.members![k]);
      const normalizedKeys = memberKeys.map(k => k.startsWith('urn:uuid:') ? k.slice(9) : k);
      counts[group.id] = individuals.filter(c => {
        if (memberKeys.includes(c.id) || normalizedKeys.includes(c.id)) return true;
        if (c.uid) {
          const bareUid = c.uid.startsWith('urn:uuid:') ? c.uid.slice(9) : c.uid;
          return memberKeys.includes(c.uid) || normalizedKeys.includes(bareUid);
        }
        return false;
      }).length;
    }
    return counts;
  }, [groups, individuals]);

  return (
    <div className={cn("flex flex-col h-full bg-secondary", className)}>
      {/* Header */}
      {/* Same h-14 box as the mail sidebar's account switcher, so the apps line up. */}
      <div className="px-3 h-14 box-content border-b border-border flex items-center justify-between flex-shrink-0">
        {/* Which account it shows, when there are several: the address, which switches. */}
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-semibold truncate">{t("title")}</span>
          <AccountScopeLabel />
        </div>
        <div className="relative flex-shrink-0">
          <IconButton
            label={t("new")}
            aria-haspopup="menu"
            aria-expanded={newMenu.contextMenu.isOpen}
            onMouseDown={(e) => { if (newMenu.contextMenu.isOpen) e.stopPropagation(); }}
            onClick={(e) => {
              if (newMenu.contextMenu.isOpen) newMenu.closeContextMenu();
              else newMenu.openContextMenuFrom(e.currentTarget, null, "end");
            }}
          >
            <Plus />
          </IconButton>
          <ContextMenu ref={newMenu.menuRef} isOpen={newMenu.contextMenu.isOpen} position={newMenu.contextMenu.position} onClose={newMenu.closeContextMenu}>
            <ContextMenuItem icon={UserPlus} label={t("create_new")} onClick={() => { newMenu.closeContextMenu(); onCreateContact(); }} />
            <ContextMenuItem icon={UsersRound} label={t("groups.create")} onClick={() => { newMenu.closeContextMenu(); onCreateGroup(); }} />
            {onCreateAddressBook && (
              <ContextMenuItem icon={BookPlus} label={tx("new_address_book_menu")} onClick={() => { newMenu.closeContextMenu(); onCreateAddressBook(); }} />
            )}
            {onImport && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem icon={Upload} label={tx("import_menu")} onClick={() => { newMenu.closeContextMenu(); onImport(); }} />
              </>
            )}
          </ContextMenu>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-1">
        {/* All contacts */}
        <button
          onClick={() => onSelectCategory("all")}
          // Marked as the other categories are: the drawer opens on it.
          aria-current={isAllActive ? "true" : undefined}
          className={cn(
            "w-full flex items-center gap-2 px-3 text-sm transition-colors min-h-8 pointer-coarse:min-h-11",
            isAllActive
              ? "bg-accent text-accent-foreground font-medium"
              : "text-foreground hover:bg-muted"
          )}
          style={{ paddingBlock: 'var(--density-sidebar-py, 4px)' }}
        >
          <BookUser className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">{t("tabs.all")}</span>
          <span className="ms-auto text-xs text-muted-foreground tabular-nums">
            {individuals.length}
          </span>
        </button>

        {/* Company directory (server principals), read-only */}
        {directoryCount !== undefined && (
          <button
            onClick={() => onSelectCategory("directory")}
            aria-current={activeCategory === "directory" ? "true" : undefined}
            className={cn(
              "w-full flex items-center gap-2 px-3 text-sm transition-colors min-h-8 pointer-coarse:min-h-11",
              activeCategory === "directory"
                ? "bg-accent text-accent-foreground font-medium"
                : "text-foreground hover:bg-muted"
            )}
            style={{ paddingBlock: 'var(--density-sidebar-py, 4px)' }}
            data-testid="contacts-directory-entry"
          >
            <Building2 className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{t("directory.title")}</span>
            {directoryCount > 0 && (
              <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                {directoryCount}
              </span>
            )}
          </button>
        )}

        {/* Address Books: per-account groups in multi-account Pro mode, else the
            classic "My Address Books" section. */}
        {multiAccountMode && localAccountGroups.length > 0 ? (
          localAccountGroups.map((group) => {
            const sectionKey = `account-${group.key}`;
            const expanded = !collapsed[sectionKey];
            const { owned, sharedGroups } = group.split;
            return (
              <div key={group.key} className="mt-2">
                <div className="flex items-center px-3 py-1 group">
                  <button
                    onClick={() => toggleSection(sectionKey)}
                    className="flex items-center gap-1 flex-1 min-w-0 text-start"
                  >
                    {expanded ? (
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    )}
                    <User className="w-3 h-3 text-muted-foreground" />
                    <span className="text-xs font-semibold text-foreground/90 truncate">
                      {group.label}
                    </span>
                  </button>
                </div>
                {expanded && (
                  <div className="ps-2">
                    {owned.length > 0 && (
                      <div className="mt-1">
                        <div className="px-3 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">
                          {t("address_books.title")}
                        </div>
                        {owned.map((book) => (
                          <AddressBookItem
                            key={book.id}
                            book={book}
                            isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                            contactCount={contactCountByBook[book.id] || 0}
                            onSelect={() => onSelectCategory({ addressBookId: book.id })}
                            onDropContacts={onDropContacts}
                            {...bookMenu(book)}
                          />
                        ))}
                      </div>
                    )}
                    {sharedGroups.map((sg) => (
                      <div key={`${group.key}-shared-${sg.label}`} className="mt-1">
                        <div className="px-3 py-0.5 text-[0.6875rem] font-medium text-muted-foreground flex items-center gap-1">
                          <Share2 className="w-3 h-3" />
                          {sg.label}
                        </div>
                        {sg.books.map((book) => (
                          <AddressBookItem
                            key={book.id}
                            book={book}
                            isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                            contactCount={contactCountByBook[book.id] || 0}
                            onSelect={() => onSelectCategory({ addressBookId: book.id })}
                            onDropContacts={onDropContacts}
                            {...bookMenu(book)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          personalBooks.length > 0 && (
            <div className="mt-2">
              <div className="flex items-center px-3 py-1 group">
                <button
                  onClick={() => toggleSection("addressBooks")}
                  className="flex items-center gap-1 flex-1 text-start"
                >
                  {collapsed.addressBooks ? (
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("address_books.title")}
                  </span>
                </button>
                <IconButton
                  label={t("address_books.manage")}
                  onClick={(e) => {
                    e.stopPropagation();
                    router.push('/settings/contacts');
                  }}
                  className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 transition-opacity duration-150"
                >
                  <Settings className="text-muted-foreground" />
                </IconButton>
              </div>
              {!collapsed.addressBooks && personalBooks.map((book) => (
                <AddressBookItem
                  key={book.id}
                  book={book}
                  isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                  contactCount={contactCountByBook[book.id] || 0}
                  onSelect={() => onSelectCategory({ addressBookId: book.id })}
                  onDropContacts={onDropContacts}
                  {...bookMenu(book)}
                />
              ))}
            </div>
          )
        )}

        {/* Groups section */}
        {sortedGroups.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => toggleSection("groups")}
              className="flex items-center gap-1 px-3 py-1 w-full text-start group"
            >
              {collapsed.groups ? (
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              )}
              <span className="text-xs font-medium text-muted-foreground">
                {t("tabs.groups")}
              </span>
            </button>

            {!collapsed.groups && sortedGroups.map((group) => {
              const isActive = typeof activeCategory === "object" && "groupId" in activeCategory && activeCategory.groupId === group.id;
              const memberCount = memberCountByGroup[group.id] || 0;

              const groupName = getContactDisplayName(group);
              return (
                <SidebarRow
                  key={group.id}
                  isActive={isActive}
                  icon={<Users className="w-4 h-4 flex-shrink-0" />}
                  label={groupName}
                  count={memberCount}
                  onSelect={() => onSelectCategory({ groupId: group.id })}
                  onContextMenu={(e) => openGroupContextMenu(e, group)}
                  onOpenMenu={(anchor) => openGroupMenuFrom(anchor, group, "end")}
                  menuLabel={t("row_actions", { name: groupName })}
                />
              );
            })}
          </div>
        )}

        {/* Categories section (from contact keywords) */}
        <div className="mt-2">
          <button
            onClick={() => toggleSection("categories")}
            className="flex items-center gap-1 px-3 py-1 w-full text-start group"
          >
            {collapsed.categories ? (
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            )}
            <span className="text-xs font-medium text-muted-foreground">
              {t("detail.categories")}
            </span>
          </button>

          {!collapsed.categories && (
            <>
              {/* No Category item */}
              <button
                onClick={() => onSelectCategory("uncategorized")}
                className={cn(
                  "w-full flex items-center gap-2 ps-5 pe-3 text-sm transition-colors min-h-8 pointer-coarse:min-h-11",
                  activeCategory === "uncategorized"
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-foreground hover:bg-muted"
                )}
                style={{ paddingBlock: 'var(--density-sidebar-py, 4px)' }}
              >
                <Tag className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
                <span className="truncate italic">{t("no_category")}</span>
                <span className="ms-auto text-xs text-muted-foreground tabular-nums">
                  {uncategorizedCount}
                </span>
              </button>
              {allKeywords.map(([keyword, count]) => {
                const isActive = typeof activeCategory === "object" && "keyword" in activeCategory && activeCategory.keyword === keyword;
                return (
                  <CategoryItem
                    key={keyword}
                    keyword={keyword}
                    count={count}
                    isActive={isActive}
                    onSelect={() => onSelectCategory({ keyword })}
                    onDropContacts={onDropContactsToCategory}
                    onContextMenu={hasKeywordMenu ? (e) => openKeywordContextMenu(e, keyword) : undefined}
                    onOpenMenu={hasKeywordMenu ? (anchor) => openKeywordMenuFrom(anchor, keyword, "end") : undefined}
                    menuLabel={t("row_actions", { name: keyword })}
                  />
                );
              })}
            </>
          )}
        </div>

        {/* Shared accounts with address books - only when not already split
            into per-account groups above (multi-account Pro mode). */}
        {!multiAccountMode && sharedBookGroups.map((group) => (
          <div key={group.accountId} className="mt-2">
            <div className="flex items-center px-3 py-1 group">
              <button
                onClick={() => toggleSection(`shared-${group.accountId}`)}
                className="flex items-center gap-1 flex-1 min-w-0 text-start"
              >
                {collapsed[`shared-${group.accountId}`] ? (
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                )}
                <Share2 className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground truncate">
                  {t("address_books.shared_prefix", { name: group.accountName })}
                </span>
              </button>
              <IconButton
                label={t("address_books.manage")}
                onClick={(e) => {
                  e.stopPropagation();
                  router.push('/settings/contacts');
                }}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 transition-opacity duration-150"
              >
                <Settings className="text-muted-foreground" />
              </IconButton>
            </div>
            {!collapsed[`shared-${group.accountId}`] && group.books.map((book) => (
              <AddressBookItem
                key={book.id}
                book={book}
                isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                contactCount={contactCountByBook[book.id] || 0}
                onSelect={() => onSelectCategory({ addressBookId: book.id })}
                onDropContacts={onDropContacts}
                {...bookMenu(book)}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Address book context menu */}
      {bookContextMenu.data && hasBookMenu && (() => {
        const book = bookContextMenu.data;
        const canCreate = onCreateContactInBook && book.myRights?.mayWrite !== false;
        const canRename = onRenameAddressBook && book.myRights?.mayWrite !== false;
        const canShare = onShareAddressBook && book.myRights?.mayShare && !book.isShared;
        // The default only applies to books the account owns, and re-setting the
        // current default is a no-op, so hide it in both cases.
        const canSetDefault = onSetDefaultAddressBook && !book.isShared && !book.isDefault;
        const canDelete = onDeleteAddressBook && !book.isDefault && !book.isShared && book.myRights?.mayDelete !== false;
        const showSeparator = (canCreate || canRename || canShare || canSetDefault) && canDelete;
        return (
          <ContextMenu
            ref={bookMenuRef}
            isOpen={bookContextMenu.isOpen}
            position={bookContextMenu.position}
            onClose={closeBookContextMenu}
          >
            {canCreate && (
              <ContextMenuItem
                icon={UserPlus}
                label={t("address_books.new_contact_in_book")}
                onClick={() => {
                  closeBookContextMenu();
                  onCreateContactInBook(book);
                }}
              />
            )}
            {canRename && (
              <ContextMenuItem
                icon={Pencil}
                label={t("address_books.rename")}
                onClick={() => {
                  closeBookContextMenu();
                  onRenameAddressBook(book);
                }}
              />
            )}
            {canShare && (
              <ContextMenuItem
                icon={Users}
                label={t("address_books.share")}
                onClick={() => {
                  closeBookContextMenu();
                  onShareAddressBook(book);
                }}
              />
            )}
            {canSetDefault && (
              <ContextMenuItem
                icon={Star}
                label={t("address_books.set_default")}
                onClick={() => {
                  closeBookContextMenu();
                  onSetDefaultAddressBook(book);
                }}
              />
            )}
            {showSeparator && <ContextMenuSeparator />}
            {canDelete && (
              <ContextMenuItem
                icon={Trash2}
                label={t("address_books.delete")}
                onClick={() => {
                  closeBookContextMenu();
                  onDeleteAddressBook(book);
                }}
                destructive
              />
            )}
          </ContextMenu>
        );
      })()}

      {/* Keyword (category) context menu */}
      {keywordContextMenu.data && hasKeywordMenu && (
        <ContextMenu
          ref={keywordMenuRef}
          isOpen={keywordContextMenu.isOpen}
          position={keywordContextMenu.position}
          onClose={closeKeywordContextMenu}
        >
          {onRenameKeyword && (
            <ContextMenuItem
              icon={Pencil}
              label={t("rename_category")}
              onClick={() => {
                const kw = keywordContextMenu.data!;
                closeKeywordContextMenu();
                onRenameKeyword(kw);
              }}
            />
          )}
          {onRenameKeyword && onDeleteKeyword && <ContextMenuSeparator />}
          {onDeleteKeyword && (
            <ContextMenuItem
              icon={Trash2}
              label={t("delete_category")}
              destructive
              onClick={() => {
                const kw = keywordContextMenu.data!;
                closeKeywordContextMenu();
                onDeleteKeyword(kw);
              }}
            />
          )}
        </ContextMenu>
      )}

      {/* Group context menu */}
      {groupContextMenu.data && (
        <ContextMenu
          ref={groupMenuRef}
          isOpen={groupContextMenu.isOpen}
          position={groupContextMenu.position}
          onClose={closeGroupContextMenu}
        >
          <ContextMenuItem
            icon={Pencil}
            label={t("groups.edit")}
            onClick={() => {
              closeGroupContextMenu();
              onEditGroup?.(groupContextMenu.data!.id);
            }}
          />
          {onComposeGroup && (
            <ContextMenuSubMenu icon={Mail} label={t("groups.send_email")}>
              {(["to", "cc", "bcc"] as const).map((field) => (
                <ContextMenuItem
                  key={field}
                  icon={Mail}
                  label={t(`groups.send_email_${field}`)}
                  onClick={() => {
                    const groupId = groupContextMenu.data!.id;
                    closeGroupContextMenu();
                    onComposeGroup(groupId, field);
                  }}
                />
              ))}
            </ContextMenuSubMenu>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Trash2}
            label={t("groups.delete")}
            onClick={() => {
              closeGroupContextMenu();
              onDeleteGroup?.(groupContextMenu.data!.id);
            }}
            destructive
          />
        </ContextMenu>
      )}
    </div>
  );
}

const ROW_STYLE = { paddingBlock: "var(--density-sidebar-py, 4px)" } as const;

interface RowMenuProps {
  /** Right-click: the menu at the pointer. */
  onContextMenu?: (e: React.MouseEvent) => void;
  /** The ⋮, long-press and the menu key: the menu under the element. */
  onOpenMenu?: (anchor: HTMLElement) => void;
  menuLabel?: string;
}

/**
 * A sidebar row: the row itself selects, a ⋮ at its end (shown on hover and
 * focus, always on touch) opens its menu, as do right-click, long-press and
 * Shift+F10 or the Menu key (R6, R7).
 */
function SidebarRow({
  isActive, isDragOver, icon, label, count, extra, onSelect, onContextMenu, onOpenMenu, menuLabel, dropProps, rowProps,
}: RowMenuProps & {
  isActive: boolean;
  isDragOver?: boolean;
  icon: React.ReactNode;
  label: string;
  count: number;
  extra?: React.ReactNode;
  onSelect: () => void;
  dropProps?: React.HTMLAttributes<HTMLDivElement>;
  rowProps?: Record<string, string>;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const longPress = useLongPress(() => {
    if (rowRef.current && onOpenMenu) onOpenMenu(rowRef.current);
  }, !!onOpenMenu);
  return (
    <div
      ref={rowRef}
      {...rowProps}
      {...dropProps}
      {...(onOpenMenu ? longPress.handlers : {})}
      onContextMenu={onContextMenu}
      className={cn(
        // 32px rows, 44px on touch (R1).
        "group w-full flex items-center ps-5 pe-1 text-sm transition-colors select-none min-h-8 pointer-coarse:min-h-11",
        isActive ? "bg-accent text-accent-foreground font-medium" : "text-foreground hover:bg-muted",
        isDragOver && "bg-primary/20 ring-2 ring-primary/50",
      )}
      style={ROW_STYLE}
    >
      <button
        type="button"
        onClick={onSelect}
        onKeyDown={(e) => {
          if (onOpenMenu && isContextMenuKey(e)) {
            e.preventDefault();
            onOpenMenu(e.currentTarget);
          }
        }}
        aria-current={isActive ? "true" : undefined}
        className="flex flex-1 min-w-0 items-center gap-2 self-stretch text-start rounded-sm outline-none focus-inset"
      >
        {icon}
        <span className="truncate" title={label}>{label}</span>
        {extra}
        <span className={cn("pe-2 text-xs text-muted-foreground tabular-nums", !extra && "ms-auto")}>{count}</span>
      </button>
      {onOpenMenu && menuLabel && (
        <IconButton
          label={menuLabel}
          aria-haspopup="menu"
          onClick={(e) => onOpenMenu(e.currentTarget)}
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <MoreVertical />
        </IconButton>
      )}
    </div>
  );
}

function CategoryItem({
  keyword,
  count,
  isActive,
  onSelect,
  onDropContacts,
  onContextMenu,
  onOpenMenu,
  menuLabel,
}: RowMenuProps & {
  keyword: string;
  count: number;
  isActive: boolean;
  onSelect: () => void;
  onDropContacts?: (contactIds: string[], keyword: string) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("application/x-contact-ids")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const data = e.dataTransfer.getData("application/x-contact-ids");
    if (!data || !onDropContacts) return;
    try {
      const contactIds = JSON.parse(data) as string[];
      if (contactIds.length > 0) {
        onDropContacts(contactIds, keyword);
      }
    } catch {
      // ignore invalid data
    }
  }, [keyword, onDropContacts]);

  return (
    <SidebarRow
      isActive={isActive}
      isDragOver={isDragOver}
      icon={<Tag className="w-3.5 h-3.5 flex-shrink-0" />}
      label={keyword}
      count={count}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      onOpenMenu={onOpenMenu}
      menuLabel={menuLabel}
      dropProps={{ onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop }}
    />
  );
}

function AddressBookItem({
  book,
  isActive,
  contactCount,
  onSelect,
  onDropContacts,
  onContextMenu,
  onOpenMenu,
  menuLabel,
}: RowMenuProps & {
  book: AddressBook;
  isActive: boolean;
  contactCount: number;
  onSelect: () => void;
  onDropContacts?: (contactIds: string[], addressBook: AddressBook) => void;
}) {
  const shownName = useCollectionNames();
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("application/x-contact-ids")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const data = e.dataTransfer.getData("application/x-contact-ids");
    if (!data || !onDropContacts) return;
    try {
      const contactIds = JSON.parse(data) as string[];
      if (contactIds.length > 0) {
        onDropContacts(contactIds, book);
      }
    } catch {
      // ignore invalid data
    }
  }, [book, onDropContacts]);

  const sharedOut = !book.isShared && Object.keys(book.shareWith || {}).length > 0;
  return (
    <SidebarRow
      isActive={isActive}
      isDragOver={isDragOver}
      icon={<Book className="w-4 h-4 flex-shrink-0" />}
      label={shownName.addressBook(book)}
      count={contactCount}
      extra={sharedOut ? <Users className="w-3 h-3 text-muted-foreground flex-shrink-0 ms-auto" /> : undefined}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      onOpenMenu={onOpenMenu}
      menuLabel={menuLabel}
      dropProps={{ onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop }}
      rowProps={{ "data-testid": "address-book-item", "data-book-name": book.name, "data-account": book.accountName ?? "" }}
    />
  );
}
