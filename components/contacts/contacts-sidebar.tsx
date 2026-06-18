"use client";

import { useMemo, useState, useCallback, useEffect, useRef, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { BookUser, User, Users, Plus, Share2, Book, ChevronRight, ChevronDown, UserPlus, UsersRound, Upload, Tag, Pencil, Trash2, Settings, Mail } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { cn } from "@/lib/utils";
import type { ContactCard, AddressBook } from "@/lib/jmap/types";
import { getContactDisplayName } from "@/stores/contact-store";
import { useAccountStore } from "@/stores/account-store";

export type ContactCategory = "all" | { groupId: string } | { addressBookId: string } | { keyword: string } | "uncategorized";

interface ContactsSidebarProps {
  groups: ContactCard[];
  individuals: ContactCard[];
  addressBooks: AddressBook[];
  activeCategory: ContactCategory;
  onSelectCategory: (category: ContactCategory) => void;
  onCreateGroup: () => void;
  onCreateContact: () => void;
  onImport?: () => void;
  onEditGroup?: (groupId: string) => void;
  onDeleteGroup?: (groupId: string) => void;
  onComposeGroup?: (groupId: string, field: "to" | "cc" | "bcc") => void;
  onDropContacts?: (contactIds: string[], addressBook: AddressBook) => void;
  onDropContactsToCategory?: (contactIds: string[], keyword: string) => void;
  onRenameAddressBook?: (addressBook: AddressBook) => void;
  onShareAddressBook?: (addressBook: AddressBook) => void;
  onCreateContactInBook?: (addressBook: AddressBook) => void;
  onDeleteAddressBook?: (addressBook: AddressBook) => void;
  onRenameKeyword?: (keyword: string) => void;
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

export function ContactsSidebar({
  groups,
  individuals,
  addressBooks,
  activeCategory,
  onSelectCategory,
  onCreateGroup,
  onCreateContact,
  onImport,
  onEditGroup,
  onDeleteGroup,
  onComposeGroup,
  onDropContacts,
  onDropContactsToCategory,
  onRenameAddressBook,
  onShareAddressBook,
  onCreateContactInBook,
  onDeleteAddressBook,
  onRenameKeyword,
  className,
  multiAccountMode,
}: ContactsSidebarProps) {
  const t = useTranslations("contacts");
  const router = useRouter();
  const { contextMenu: groupContextMenu, openContextMenu: openGroupContextMenu, closeContextMenu: closeGroupContextMenu, menuRef: groupMenuRef } = useContextMenu<ContactCard>();
  const { contextMenu: bookContextMenu, openContextMenu: openBookContextMenu, closeContextMenu: closeBookContextMenu, menuRef: bookMenuRef } = useContextMenu<AddressBook>();
  const { contextMenu: keywordContextMenu, openContextMenu: openKeywordContextMenu, closeContextMenu: closeKeywordContextMenu, menuRef: keywordMenuRef } = useContextMenu<string>();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const toggleSection = useCallback((key: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMenu]);

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
      <div className="px-3 border-b border-border flex items-center justify-between" style={{ paddingBlock: 'var(--density-header-py)' }}>
        <span className="text-sm font-semibold truncate">{t("title")}</span>
        <div className="relative flex-shrink-0">
          <Button
            ref={menuBtnRef}
            size="icon"
            variant="ghost"
            onClick={() => setShowMenu(v => !v)}
            className="h-7 w-7"
          >
            <Plus className="w-4 h-4" />
          </Button>
          {showMenu && (
            <div
              ref={menuRef}
              className="absolute right-0 top-full mt-1 w-44 rounded-md border border-border bg-background text-foreground shadow-md z-50 py-1"
            >
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left"
                onClick={() => { setShowMenu(false); onCreateContact(); }}
              >
                <UserPlus className="w-4 h-4" />
                {t("create_new")}
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left"
                onClick={() => { setShowMenu(false); onCreateGroup(); }}
              >
                <UsersRound className="w-4 h-4" />
                {t("groups.create")}
              </button>
              {onImport && (
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left"
                  onClick={() => { setShowMenu(false); onImport(); }}
                >
                  <Upload className="w-4 h-4" />
                  {t("import.title")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-1">
        {/* All contacts */}
        <button
          onClick={() => onSelectCategory("all")}
          className={cn(
            "w-full flex items-center gap-2 px-3 text-sm transition-colors",
            isAllActive
              ? "bg-accent text-accent-foreground font-medium"
              : "text-foreground/80 hover:bg-muted"
          )}
          style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
        >
          <BookUser className="w-4 h-4 flex-shrink-0" />
          <span className="truncate">{t("tabs.all")}</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {individuals.length}
          </span>
        </button>

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
                    className="flex items-center gap-1 flex-1 min-w-0 text-left"
                  >
                    {expanded ? (
                      <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                    )}
                    <User className="w-3 h-3 text-muted-foreground" />
                    <span className="text-xs font-semibold text-foreground/90 uppercase tracking-wider truncate">
                      {group.label}
                    </span>
                  </button>
                </div>
                {expanded && (
                  <div className="pl-2">
                    {owned.length > 0 && (
                      <div className="mt-1">
                        <div className="px-3 py-0.5 text-[10px] font-medium text-muted-foreground/80 uppercase tracking-wider">
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
                            onContextMenu={(onRenameAddressBook || onShareAddressBook || onCreateContactInBook || onDeleteAddressBook) ? (e) => openBookContextMenu(e, book) : undefined}
                          />
                        ))}
                      </div>
                    )}
                    {sharedGroups.map((sg) => (
                      <div key={`${group.key}-shared-${sg.label}`} className="mt-1">
                        <div className="px-3 py-0.5 text-[10px] font-medium text-muted-foreground/80 uppercase tracking-wider flex items-center gap-1">
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
                            onContextMenu={(onRenameAddressBook || onShareAddressBook || onCreateContactInBook || onDeleteAddressBook) ? (e) => openBookContextMenu(e, book) : undefined}
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
                  className="flex items-center gap-1 flex-1 text-left"
                >
                  {collapsed.addressBooks ? (
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {t("address_books.title")}
                  </span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    try { localStorage.setItem('settings-active-tab', 'contacts'); } catch { /* ignore */ }
                    router.push('/settings');
                  }}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-150 hover:bg-muted"
                  title={t("address_books.manage")}
                >
                  <Settings className="w-3 h-3 text-muted-foreground" />
                </button>
              </div>
              {!collapsed.addressBooks && personalBooks.map((book) => (
                <AddressBookItem
                  key={book.id}
                  book={book}
                  isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                  contactCount={contactCountByBook[book.id] || 0}
                  onSelect={() => onSelectCategory({ addressBookId: book.id })}
                  onDropContacts={onDropContacts}
                  onContextMenu={(onRenameAddressBook || onShareAddressBook || onCreateContactInBook || onDeleteAddressBook) ? (e) => openBookContextMenu(e, book) : undefined}
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
              className="flex items-center gap-1 px-3 py-1 w-full text-left group"
            >
              {collapsed.groups ? (
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              )}
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t("tabs.groups")}
              </span>
            </button>

            {!collapsed.groups && sortedGroups.map((group) => {
              const isActive = typeof activeCategory === "object" && "groupId" in activeCategory && activeCategory.groupId === group.id;
              const memberCount = memberCountByGroup[group.id] || 0;

              return (
                <button
                  key={group.id}
                  onClick={() => onSelectCategory({ groupId: group.id })}
                  onContextMenu={(e) => openGroupContextMenu(e, group)}
                  className={cn(
                    "w-full flex items-center gap-2 pl-5 pr-3 text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-foreground/80 hover:bg-muted"
                  )}
                  style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
                >
                  <Users className="w-4 h-4 flex-shrink-0" />
                  <span className="truncate">{getContactDisplayName(group)}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {memberCount}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Categories section (from contact keywords) */}
        <div className="mt-2">
          <button
            onClick={() => toggleSection("categories")}
            className="flex items-center gap-1 px-3 py-1 w-full text-left group"
          >
            {collapsed.categories ? (
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            )}
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t("detail.categories")}
            </span>
          </button>

          {!collapsed.categories && (
            <>
              {/* No Category item */}
              <button
                onClick={() => onSelectCategory("uncategorized")}
                className={cn(
                  "w-full flex items-center gap-2 pl-5 pr-3 text-sm transition-colors",
                  activeCategory === "uncategorized"
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-foreground/80 hover:bg-muted"
                )}
                style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
              >
                <Tag className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
                <span className="truncate italic">{t("no_category")}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
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
                    onContextMenu={onRenameKeyword ? (e) => openKeywordContextMenu(e, keyword) : undefined}
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
                className="flex items-center gap-1 flex-1 min-w-0 text-left"
              >
                {collapsed[`shared-${group.accountId}`] ? (
                  <ChevronRight className="w-3 h-3 text-muted-foreground" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-muted-foreground" />
                )}
                <Share2 className="w-3 h-3 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider truncate">
                  {t("address_books.shared_prefix", { name: group.accountName })}
                </span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  try { localStorage.setItem('settings-active-tab', 'contacts'); } catch { /* ignore */ }
                  router.push('/settings');
                }}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-150 hover:bg-muted"
                title={t("address_books.manage")}
              >
                <Settings className="w-3 h-3 text-muted-foreground" />
              </button>
            </div>
            {!collapsed[`shared-${group.accountId}`] && group.books.map((book) => (
              <AddressBookItem
                key={book.id}
                book={book}
                isActive={typeof activeCategory === "object" && "addressBookId" in activeCategory && activeCategory.addressBookId === book.id}
                contactCount={contactCountByBook[book.id] || 0}
                onSelect={() => onSelectCategory({ addressBookId: book.id })}
                onDropContacts={onDropContacts}
                onContextMenu={(onRenameAddressBook || onShareAddressBook || onCreateContactInBook || onDeleteAddressBook) ? (e) => openBookContextMenu(e, book) : undefined}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Address book context menu */}
      {bookContextMenu.data && (onRenameAddressBook || onShareAddressBook || onCreateContactInBook || onDeleteAddressBook) && (() => {
        const book = bookContextMenu.data;
        const canCreate = onCreateContactInBook && book.myRights?.mayWrite !== false;
        const canRename = onRenameAddressBook && book.myRights?.mayWrite !== false;
        const canShare = onShareAddressBook && book.myRights?.mayShare && !book.isShared;
        const canDelete = onDeleteAddressBook && !book.isDefault && !book.isShared && book.myRights?.mayDelete !== false;
        const showSeparator = (canCreate || canRename || canShare) && canDelete;
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
      {keywordContextMenu.data && onRenameKeyword && (
        <ContextMenu
          ref={keywordMenuRef}
          isOpen={keywordContextMenu.isOpen}
          position={keywordContextMenu.position}
          onClose={closeKeywordContextMenu}
        >
          <ContextMenuItem
            icon={Pencil}
            label={t("rename_category")}
            onClick={() => {
              const kw = keywordContextMenu.data!;
              closeKeywordContextMenu();
              onRenameKeyword(kw);
            }}
          />
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
            label={t("form.delete")}
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

function CategoryItem({
  keyword,
  count,
  isActive,
  onSelect,
  onDropContacts,
  onContextMenu,
}: {
  keyword: string;
  count: number;
  isActive: boolean;
  onSelect: () => void;
  onDropContacts?: (contactIds: string[], keyword: string) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<HTMLButtonElement>) => {
    if (!e.dataTransfer.types.includes("application/x-contact-ids")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLButtonElement>) => {
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
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "w-full flex items-center gap-2 pl-5 pr-3 text-sm transition-colors",
        isActive
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/80 hover:bg-muted",
        isDragOver && "bg-primary/20 ring-2 ring-primary/50"
      )}
      style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
    >
      <Tag className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="truncate">{keyword}</span>
      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
        {count}
      </span>
    </button>
  );
}

function AddressBookItem({
  book,
  isActive,
  contactCount,
  onSelect,
  onDropContacts,
  onContextMenu,
}: {
  book: AddressBook;
  isActive: boolean;
  contactCount: number;
  onSelect: () => void;
  onDropContacts?: (contactIds: string[], addressBook: AddressBook) => void;
  onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: DragEvent<HTMLButtonElement>) => {
    if (!e.dataTransfer.types.includes("application/x-contact-ids")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent<HTMLButtonElement>) => {
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

  return (
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "w-full flex items-center gap-2 pl-5 pr-3 text-sm transition-colors",
        isActive
          ? "bg-accent text-accent-foreground font-medium"
          : "text-foreground/80 hover:bg-muted",
        isDragOver && "bg-primary/20 ring-2 ring-primary/50"
      )}
      style={{ paddingBlock: 'var(--density-sidebar-py, 4px)', minHeight: '32px' }}
    >
      <Book className="w-4 h-4 flex-shrink-0" />
      <span className="truncate">{book.name}</span>
      {!book.isShared && Object.keys(book.shareWith || {}).length > 0 && (
        <Users className="w-3 h-3 text-muted-foreground flex-shrink-0 ml-auto" />
      )}
      <span className={cn(
        "text-xs text-muted-foreground tabular-nums",
        !(!book.isShared && Object.keys(book.shareWith || {}).length > 0) && "ml-auto"
      )}>
        {contactCount}
      </span>
    </button>
  );
}
