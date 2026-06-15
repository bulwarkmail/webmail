"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { ArrowLeft, Users, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ContactList } from "@/components/contacts/contact-list";
import { ContactDetail } from "@/components/contacts/contact-detail";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactGroupForm } from "@/components/contacts/contact-group-form";
import { ContactGroupDetail } from "@/components/contacts/contact-group-detail";
import { ContactsSidebar, type ContactCategory } from "@/components/contacts/contacts-sidebar";
import { ContactImportDialog } from "@/components/contacts/contact-import-dialog";
import { RenameDialog } from "@/components/files/rename-dialog";
import { exportContacts } from "@/components/contacts/contact-export";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { useContactStore, getContactDisplayName } from "@/stores/contact-store";
import { useAuthStore, redirectToLogin } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import { cn, generateUUID } from "@/lib/utils";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useProMultiAccountContacts } from "@/hooks/use-pro-multi-account-contacts";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { useIsDesktop, useIsMobile } from "@/hooks/use-media-query";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import type { ContactCard, AddressBook, AddressBookRights } from "@/lib/jmap/types";
import { ShareCollectionDialog } from "@/components/settings/share-collection-dialog";

type View =
  | "list"
  | "detail"
  | "create"
  | "edit"
  | "group-detail"
  | "group-create"
  | "group-edit"
  | "bulk-add-to-group";

export default function ContactsPage() {
  const t = useTranslations("contacts");
  const contactsEnabled = usePolicyStore((s) => s.isFeatureEnabled('contactsEnabled'));
  const { client, isAuthenticated, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const [initialCheckDone, setInitialCheckDone] = useState(() => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client);
  const { quota, isPushConnected } = useEmailStore();
  const {
    contacts,
    addressBooks,
    selectedContactId,
    searchQuery,
    supportsSync,
    selectedContactIds,
    setSelectedContact,
    setSearchQuery,
    fetchContacts,
    createContact,
    updateContact,
    deleteContact,
    addLocalContact,
    updateLocalContact,
    deleteLocalContact,
    getGroupMembers,
    createGroup,
    updateGroup,
    addMembersToGroup,
    removeMembersFromGroup,
    deleteGroup,
    toggleContactSelection,
    selectRangeContacts,
    selectAllContacts,
    clearSelection,
    bulkDeleteContacts,
    bulkAddToGroup,
    moveContactToAddressBook,
    renameAddressBook,
    removeAddressBook,
    shareAddressBook,
    renameKeyword,
    importContacts,
  } = useContactStore();

  const [view, setView] = useState<View>("list");
  const [activeCategory, setActiveCategory] = useState<ContactCategory>("all");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [renamingAddressBook, setRenamingAddressBook] = useState<AddressBook | null>(null);
  const [sharingAddressBookId, setSharingAddressBookId] = useState<string | null>(null);
  const [defaultBookIdForCreate, setDefaultBookIdForCreate] = useState<string | undefined>(undefined);
  const [createPrefill, setCreatePrefill] = useState<{ email?: string; name?: string } | undefined>(undefined);
  const [returnToEmail, setReturnToEmail] = useState(false);
  const [renamingKeyword, setRenamingKeyword] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const hasFetched = useRef(false);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const isEmbedded = useIsEmbedded();
  const router = useRouter();
  const searchParams = useSearchParams();
  // One-shot intent flag: only consume the URL params on the first render that
  // has them. After applying, we strip the query so a later refresh or
  // re-mount doesn't re-trigger the navigation.
  const intentAppliedRef = useRef(false);
  // Narrow pane (Pro split or small window): the categories sidebar collapses
  // into a burger-toggled overlay.
  const isNarrow = !isDesktop;
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  useEffect(() => { if (!isNarrow) setNarrowSidebarOpen(false); }, [isNarrow]);

  // Panel resize state - sidebar (categories)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const v = localStorage.getItem("contacts-sidebar-width"); return v ? Number(v) : 256; } catch { return 256; }
  });
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarDragStartWidth = useRef(256);

  // Panel resize state - contact list
  const [listWidth, setListWidth] = useState(() => {
    try { const v = localStorage.getItem("contacts-list-width"); return v ? Number(v) : 384; } catch { return 384; }
  });
  const [isListResizing, setIsListResizing] = useState(false);
  const listDragStartWidth = useRef(384);

  // Check auth on mount – skip when already authenticated so that navigating
  // between routes doesn't retrigger checkAuth's transient `{ client: null,
  // isLoading: true }` reset, which was flashing the spinner on every nav.
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      try { sessionStorage.setItem('redirect_after_login', window.location.pathname); } catch { /* ignore */ }
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  // Pro shell only: aggregate contacts and address books from every
  // connected account so the sidebar lists them all. The hook is a no-op
  // outside the embedded shell.
  const { enabled: multiAccountEnabled, accountClients } = useProMultiAccountContacts();

  useEffect(() => {
    if (isEmbedded) return;
    if (client && supportsSync && !hasFetched.current) {
      hasFetched.current = true;
      fetchContacts(client);
    }
  }, [client, supportsSync, fetchContacts, isEmbedded]);

  // Consume one-shot URL params (set by the mobile recipient popover when no
  // sidebar is available) and strip them so a refresh doesn't replay the
  // intent. `from=email` flips the mobile back button to `router.back()`.
  useEffect(() => {
    if (intentAppliedRef.current) return;
    const contactId = searchParams.get('contactId');
    const addEmail = searchParams.get('addEmail');
    const addName = searchParams.get('addName');
    const from = searchParams.get('from');
    const viewParam = searchParams.get('view');
    if (!contactId && !addEmail && !from) return;
    intentAppliedRef.current = true;
    if (from === 'email') setReturnToEmail(true);
    if (contactId) {
      setSelectedContact(contactId);
      setView(viewParam === 'edit' ? 'edit' : 'detail');
    } else if (addEmail) {
      setCreatePrefill({ email: addEmail, name: addName ?? undefined });
      setSelectedContact(null);
      setView('create');
    }
    router.replace('/contacts');
  }, [searchParams, router, setSelectedContact]);

  // Intercept browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh)
  // and refresh contacts via JMAP instead of reloading the page.
  useRefreshGesture({
    enabled: isAuthenticated && !!client && supportsSync,
    onRefresh: async () => {
      if (!client) return;
      if (multiAccountEnabled && accountClients.length > 0) {
        const activeId = useAuthStore.getState().activeAccountId;
        if (activeId) {
          const { fetchAllAccountsContacts, fetchAllAccountsAddressBooks } = useContactStore.getState();
          await Promise.all([
            fetchAllAccountsAddressBooks(accountClients, activeId),
            fetchAllAccountsContacts(accountClients, activeId),
          ]);
          return;
        }
      }
      await fetchContacts(client);
    },
  });

  const groups = useMemo(() => contacts.filter(c => c.kind === 'group'), [contacts]);
  const individuals = useMemo(() => contacts.filter(c => c.kind !== 'group'), [contacts]);
  const selectedContact = contacts.find((c) => c.id === selectedContactId) || null;
  const selectedGroup = selectedGroupId ? contacts.find(c => c.id === selectedGroupId) || null : null;
  const selectedGroupMembers = useMemo(() => selectedGroupId ? getGroupMembers(selectedGroupId) : [], [selectedGroupId, getGroupMembers]);

  // Collect all unique keywords across contacts
  const allKeywords = useMemo(() => {
    const kws = new Set<string>();
    for (const contact of individuals) {
      if (!contact.keywords) continue;
      for (const [kw, active] of Object.entries(contact.keywords)) {
        if (active) kws.add(kw);
      }
    }
    return Array.from(kws).sort((a, b) => a.localeCompare(b));
  }, [individuals]);

  // Contacts to display based on active category
  const displayedContacts = useMemo(() => {
    if (activeCategory === "all") return individuals;
    if (activeCategory === "uncategorized") {
      return individuals.filter(c => !c.keywords || Object.keys(c.keywords).filter(k => c.keywords![k]).length === 0);
    }
    if ("addressBookId" in activeCategory) {
      const bookId = activeCategory.addressBookId;
      return individuals.filter(c => {
        if (!c.addressBookIds) return false;
        return c.addressBookIds[bookId] === true;
      });
    }
    if ("keyword" in activeCategory) {
      return individuals.filter(c => c.keywords?.[activeCategory.keyword]);
    }
    // Show members of the selected group
    return getGroupMembers(activeCategory.groupId);
  }, [activeCategory, individuals, getGroupMembers]);

  const handleSelectCategory = useCallback((category: ContactCategory) => {
    setActiveCategory(category);
    clearSelection();
    if (typeof category === "object" && "groupId" in category) {
      setSelectedGroupId(category.groupId);
      setView("group-detail");
    } else {
      setSelectedGroupId(null);
    }
    setNarrowSidebarOpen(false);
  }, [clearSelection]);

  const handleDropContacts = useCallback(async (contactIds: string[], addressBook: AddressBook) => {
    if (!client) return;
    try {
      await moveContactToAddressBook(client, contactIds, addressBook);
      const msg = contactIds.length === 1
        ? t("address_books.moved", { name: addressBook.name })
        : t("address_books.moved_plural", { count: contactIds.length, name: addressBook.name });
      toast.success(msg);
    } catch (error) {
      console.error('Failed to move contacts:', error);
      toast.error(t("address_books.move_failed"));
    }
  }, [client, moveContactToAddressBook, t]);

  const handleDropContactsToCategory = useCallback(async (contactIds: string[], keyword: string) => {
    if (!client && supportsSync) return;
    try {
      for (const contactId of contactIds) {
        const contact = contacts.find(c => c.id === contactId);
        if (!contact) continue;
        const existingKeywords = contact.keywords || {};
        if (existingKeywords[keyword]) continue; // already has this keyword
        const updatedKeywords = { ...existingKeywords, [keyword]: true };
        if (supportsSync && client) {
          await updateContact(client, contactId, { keywords: updatedKeywords });
        } else {
          updateLocalContact(contactId, { keywords: updatedKeywords });
        }
      }
      const msg = contactIds.length === 1
        ? t("category_added", { name: keyword })
        : t("category_added_plural", { count: contactIds.length, name: keyword });
      toast.success(msg);
    } catch (error) {
      console.error('Failed to add contacts to category:', error);
      toast.error(t("toast.error_update"));
    }
  }, [client, supportsSync, contacts, updateContact, updateLocalContact, t]);

  const handleImportContacts = useCallback(async (importedContacts: ContactCard[]) => {
    return importContacts(
      supportsSync && client ? client : null,
      importedContacts
    );
  }, [supportsSync, client, importContacts]);

  const handleSelectContact = (id: string) => {
    setSelectedContact(id);
    clearSelection();
    setView("detail");
  };

  const handleCreateNew = () => {
    setSelectedContact(null);
    setView("create");
  };

  const handleEdit = () => {
    setView("edit");
  };

  const deleteContactById = useCallback(async (contactId: string) => {
    const confirmed = await confirmDialog({
      title: t("delete_confirm_title"),
      message: t("delete_confirm"),
      confirmText: t("form.delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      if (supportsSync && client) {
        await deleteContact(client, contactId);
      } else {
        deleteLocalContact(contactId);
      }
      toast.success(t("toast.deleted"));
      if (selectedContactId === contactId) setView("list");
    } catch (error) {
      console.error('Failed to delete contact:', error);
      toast.error(t("toast.error_delete"));
    }
  }, [confirmDialog, t, supportsSync, client, deleteContact, deleteLocalContact, selectedContactId]);

  const handleDelete = async () => {
    if (!selectedContact) return;
    await deleteContactById(selectedContact.id);
  };

  const handleEditContact = useCallback((id: string) => {
    setSelectedContact(id);
    setView("edit");
  }, [setSelectedContact]);

  const handleDeleteContact = useCallback((contact: ContactCard) => {
    void deleteContactById(contact.id);
  }, [deleteContactById]);

  const handleAddContactToGroup = useCallback((id: string) => {
    clearSelection();
    toggleContactSelection(id);
    if (groups.length === 0) {
      setView("group-create");
      return;
    }
    setView("bulk-add-to-group");
  }, [clearSelection, toggleContactSelection, groups.length]);

  const handleDuplicateContact = useCallback(async (source: ContactCard) => {
    const { id: _id, created: _created, updated: _updated, ...rest } = source;
    void _id; void _created; void _updated;
    const data: Partial<ContactCard> = JSON.parse(JSON.stringify(rest));
    if (supportsSync && client) {
      await createContact(client, data);
      toast.success(t("toast.created"));
    } else {
      const localContact: ContactCard = {
        id: `local-${generateUUID()}`,
        addressBookIds: data.addressBookIds || {},
        ...data,
      };
      addLocalContact(localContact);
      toast.success(t("toast.created"));
    }
  }, [supportsSync, client, createContact, addLocalContact, t]);

  const handleSaveNew = useCallback(async (data: Partial<ContactCard>) => {
    if (supportsSync && client) {
      await createContact(client, data);
      toast.success(t("toast.created"));
    } else {
      const localContact: ContactCard = {
        id: `local-${generateUUID()}`,
        addressBookIds: {},
        ...data,
      };
      addLocalContact(localContact);
      toast.success(t("toast.created"));
    }
    setDefaultBookIdForCreate(undefined);
    setCreatePrefill(undefined);
    if (returnToEmail) {
      setReturnToEmail(false);
      router.back();
      return;
    }
    setView("list");
  }, [supportsSync, client, createContact, addLocalContact, t, returnToEmail, router]);

  const handleSaveEdit = useCallback(async (data: Partial<ContactCard>) => {
    if (!selectedContact) return;

    if (supportsSync && client) {
      await updateContact(client, selectedContact.id, data);
      toast.success(t("toast.updated"));
    } else {
      updateLocalContact(selectedContact.id, data);
      toast.success(t("toast.updated"));
    }
    setView("detail");
  }, [supportsSync, client, selectedContact, updateContact, updateLocalContact, t]);

  const handleCancel = () => {
    setDefaultBookIdForCreate(undefined);
    // Came from email → cancel returns to the email instead of the contact list.
    if (returnToEmail && view === "create") {
      setCreatePrefill(undefined);
      setReturnToEmail(false);
      router.back();
      return;
    }
    if (view === "create") setCreatePrefill(undefined);
    if (view === "group-create" || view === "group-edit") {
      setView(selectedGroup ? "group-detail" : "list");
    } else if (view === "bulk-add-to-group") {
      setView("list");
    } else {
      setView(selectedContact ? "detail" : "list");
    }
  };

  const _handleSelectGroup = (id: string) => {
    setSelectedGroupId(id);
    setActiveCategory({ groupId: id });
    setView("group-detail");
  };

  const handleCreateGroup = () => {
    setSelectedGroupId(null);
    setView("group-create");
  };

  const handleEditGroup = () => {
    setView("group-edit");
  };

  const handleEditGroupFromSidebar = useCallback((groupId: string) => {
    setSelectedGroupId(groupId);
    setActiveCategory({ groupId });
    setView("group-edit");
  }, []);

  const handleDeleteGroupFromSidebar = useCallback(async (groupId: string) => {
    const confirmed = await confirmDialog({
      title: t("groups.delete_confirm_title"),
      message: t("groups.delete_confirm"),
      confirmText: t("form.delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await deleteGroup(supportsSync && client ? client : null, groupId);
      toast.success(t("toast.deleted"));
      if (selectedGroupId === groupId) {
        setSelectedGroupId(null);
        setActiveCategory("all");
        setView("list");
      }
    } catch (error) {
      console.error('Failed to delete group:', error);
      toast.error(t("toast.error_delete"));
    }
  }, [confirmDialog, deleteGroup, supportsSync, client, selectedGroupId, t]);

  const handleDeleteGroup = async () => {
    if (!selectedGroup) return;

    const confirmed = await confirmDialog({
      title: t("groups.delete_confirm_title"),
      message: t("groups.delete_confirm"),
      confirmText: t("form.delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await deleteGroup(supportsSync && client ? client : null, selectedGroup.id);
      toast.success(t("toast.deleted"));
      setSelectedGroupId(null);
      setView("list");
    } catch (error) {
      console.error('Failed to delete group:', error);
      toast.error(t("toast.error_delete"));
    }
  };

  const handleSaveGroup = useCallback(async (name: string, memberIds: string[]) => {
    const jmapClient = supportsSync && client ? client : null;
    if (view === "group-edit" && selectedGroup) {
      await updateGroup(jmapClient, selectedGroup.id, name);
      // Use resolved member contact IDs for diff, not raw urn:uuid: keys
      const currentIds = selectedGroupMembers.map(m => m.id);
      const toAdd = memberIds.filter(id => !currentIds.includes(id));
      const toRemove = currentIds.filter(id => !memberIds.includes(id));
      if (toAdd.length > 0) await addMembersToGroup(jmapClient, selectedGroup.id, toAdd);
      if (toRemove.length > 0) await removeMembersFromGroup(jmapClient, selectedGroup.id, toRemove);
      toast.success(t("toast.updated"));
      setView("group-detail");
    } else {
      await createGroup(jmapClient, name, memberIds);
      toast.success(t("toast.created"));
      setView("list");
    }
  }, [view, selectedGroup, selectedGroupMembers, supportsSync, client, createGroup, updateGroup, addMembersToGroup, removeMembersFromGroup, t]);

  const handleRemoveGroupMember = async (memberId: string) => {
    if (!selectedGroup) return;
    try {
      await removeMembersFromGroup(
        supportsSync && client ? client : null,
        selectedGroup.id,
        [memberId]
      );
      toast.success(t("toast.updated"));
    } catch (error) {
      console.error('Failed to remove group member:', error);
      toast.error(t("toast.error_update"));
    }
  };

  const handleBulkDelete = async () => {
    if (selectedContactIds.size === 0) return;

    const confirmed = await confirmDialog({
      title: t("bulk.delete_confirm_title"),
      message: t("bulk.delete_confirm", { count: selectedContactIds.size }),
      confirmText: t("bulk.delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      await bulkDeleteContacts(
        supportsSync && client ? client : null,
        Array.from(selectedContactIds)
      );
      toast.success(t("bulk.deleted", { count: selectedContactIds.size }));
      setView("list");
    } catch (error) {
      console.error('Failed to bulk delete contacts:', error);
      toast.error(t("toast.error_delete"));
    }
  };

  const handleBulkAddToGroup = () => {
    if (selectedContactIds.size === 0) return;
    if (groups.length === 0) {
      setView("group-create");
      return;
    }
    setView("bulk-add-to-group");
  };

  const handleBulkExport = () => {
    const toExport = contacts.filter(c => selectedContactIds.has(c.id));
    if (toExport.length > 0) {
      exportContacts(toExport);
      toast.success(t("export.success", { count: toExport.length }));
      clearSelection();
    }
  };

  const handleBulkAddToGroupConfirm = async (groupId: string) => {
    try {
      await bulkAddToGroup(
        supportsSync && client ? client : null,
        groupId,
        Array.from(selectedContactIds)
      );
      toast.success(t("bulk.added_to_group"));
      setView("list");
    } catch (error) {
      console.error('Failed to add contacts to group:', error);
      toast.error(t("toast.error_update"));
    }
  };

  if (!isAuthenticated) return null;

  const renderRightPanel = () => {
    switch (view) {
      case "create":
        return <ContactForm addressBooks={addressBooks} allKeywords={allKeywords} defaultAddressBookId={defaultBookIdForCreate} prefill={createPrefill} onSave={handleSaveNew} onCancel={handleCancel} />;

      case "edit":
        if (!selectedContact) return null;
        return (
          <ContactForm
            contact={selectedContact}
            addressBooks={addressBooks}
            allKeywords={allKeywords}
            onSave={handleSaveEdit}
            onCancel={handleCancel}
          />
        );

      case "group-detail":
        if (!selectedGroup) return null;
        return (
          <ContactGroupDetail
            group={selectedGroup}
            members={selectedGroupMembers}
            onEdit={handleEditGroup}
            onDelete={handleDeleteGroup}
            onRemoveMember={handleRemoveGroupMember}
            isMobile={isMobile}
            onSelectMember={(id) => {
              setSelectedContact(id);
              setView("detail");
            }}
          />
        );

      case "group-create":
        return (
          <ContactGroupForm
            individuals={individuals}
            onSave={handleSaveGroup}
            onCancel={handleCancel}
          />
        );

      case "group-edit":
        if (!selectedGroup) return null;
        return (
          <ContactGroupForm
            group={selectedGroup}
            individuals={individuals}
            currentMemberIds={selectedGroupMembers.map(m => m.id)}
            onSave={handleSaveGroup}
            onCancel={handleCancel}
          />
        );

      case "bulk-add-to-group":
        return (
          <div className="flex flex-col h-full">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold">{t("bulk.choose_group")}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                {t("bulk.adding_contacts", { count: selectedContactIds.size })}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-border">
              {groups.map((group) => {
                const gName = getContactDisplayName(group);
                const memberCount = group.members
                  ? Object.values(group.members).filter(Boolean).length
                  : 0;
                return (
                  <button
                    key={group.id}
                    onClick={() => handleBulkAddToGroupConfirm(group.id)}
                    className="w-full flex items-center gap-3 px-6 py-3 text-left hover:bg-muted transition-colors"
                  >
                    <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Users className="w-4 h-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{gName}</div>
                      <div className="text-xs text-muted-foreground">
                        {t("groups.member_count", { count: memberCount })}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="px-6 py-4 border-t border-border">
              <Button variant="outline" onClick={handleCancel} className="w-full">
                {t("form.cancel")}
              </Button>
            </div>
          </div>
        );

      default:
        return (
          <ContactDetail
            contact={selectedContact}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onAddToGroup={
              selectedContact
                ? () => handleAddContactToGroup(selectedContact.id)
                : undefined
            }
            onDuplicate={
              selectedContact
                ? () => void handleDuplicateContact(selectedContact)
                : undefined
            }
            isMobile={isMobile}
          />
        );
    }
  };

  if (!contactsEnabled) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-lg text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-yellow-500 mx-auto" />
          <p className="text-sm font-medium">Contacts feature is disabled by your administrator</p>
          <p className="text-xs text-muted-foreground">Please contact your administrator if you need access.</p>
        </div>
      </div>
    );
  }

  const showListPanel = !isMobile || view === "list";
  const showRightPanel = !isMobile || view !== "list";

  const mobileBackToList = () => {
    if (returnToEmail) {
      setReturnToEmail(false);
      setCreatePrefill(undefined);
      router.back();
      return;
    }
    setView("list");
    clearSelection();
  };

  return (
    <div className={cn("flex flex-col bg-background overflow-hidden pt-[env(safe-area-inset-top)]", isEmbedded ? "h-full" : "h-dvh")}>
      <AppTopBannerSlot />
      <div className={cn("flex flex-1 min-h-0 overflow-hidden", isMobile && "flex-col")}>
      {/* Navigation Rail - desktop only (hidden when embedded in Pro shell) */}
      {!isMobile && !isEmbedded && (
        <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}>
          <NavigationRail
            collapsed
            quota={quota}
            isPushConnected={isPushConnected}
            onLogout={logout}
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {inlineApp && (
          <InlineAppView apps={loadedApps} activeAppId={inlineApp!.id} onClose={closeInlineApp} />
        )}
        <div className={cn("relative flex flex-1 min-h-0", inlineApp && "hidden")}>
          {/* Narrow-pane backdrop for the overlay categories sidebar */}
          {isNarrow && narrowSidebarOpen && (
            <div
              className={cn(
                "inset-0 bg-black/50 z-40",
                isEmbedded ? "absolute" : "fixed"
              )}
              onClick={() => setNarrowSidebarOpen(false)}
            />
          )}
          {showListPanel && (
            <>
              {/* Panel 1: Categories sidebar (in-flow on desktop, overlay on narrow) */}
              {(!isMobile || isNarrow) && (
                <>
                  <div
                    className={cn(
                      "border-r border-border flex flex-col flex-shrink-0 bg-background",
                      !isSidebarResizing && "transition-[width] duration-300",
                      isNarrow && cn(
                        "absolute inset-y-0 left-0 z-50 w-72 pt-[env(safe-area-inset-top)]",
                        "transform transition-transform duration-300 ease-in-out",
                        !narrowSidebarOpen && "-translate-x-full"
                      )
                    )}
                    style={isNarrow ? undefined : { width: `${sidebarWidth}px` }}
                  >
                    <ContactsSidebar
                      groups={groups}
                      individuals={individuals}
                      addressBooks={addressBooks}
                      activeCategory={activeCategory}
                      onSelectCategory={handleSelectCategory}
                      onCreateGroup={handleCreateGroup}
                      onCreateContact={handleCreateNew}
                      onImport={() => setShowImportDialog(true)}
                      onEditGroup={handleEditGroupFromSidebar}
                      onDeleteGroup={handleDeleteGroupFromSidebar}
                      onDropContacts={handleDropContacts}
                      onDropContactsToCategory={handleDropContactsToCategory}
                      onRenameAddressBook={client ? (book) => setRenamingAddressBook(book) : undefined}
                      onShareAddressBook={client ? (book) => setSharingAddressBookId(book.id) : undefined}
                      onCreateContactInBook={(book) => {
                        setDefaultBookIdForCreate(book.id);
                        handleCreateNew();
                      }}
                      onDeleteAddressBook={client ? async (book) => {
                        const ok = await confirmDialog({
                          title: t("address_books.delete"),
                          message: t("address_books.confirm_delete", { name: book.name }),
                          variant: "destructive",
                          confirmText: t("address_books.delete"),
                        });
                        if (!ok) return;
                        try {
                          await removeAddressBook(client, book);
                          toast.success(t("address_books.deleted"));
                        } catch {
                          toast.error(t("address_books.delete_failed"));
                        }
                      } : undefined}
                      onRenameKeyword={(kw) => setRenamingKeyword(kw)}
                      multiAccountMode={multiAccountEnabled && accountClients.length > 1}
                    />
                  </div>
                  {!isNarrow && (
                    <ResizeHandle
                      onResizeStart={() => { sidebarDragStartWidth.current = sidebarWidth; setIsSidebarResizing(true); }}
                      onResize={(delta) => setSidebarWidth(Math.max(180, Math.min(400, sidebarDragStartWidth.current + delta)))}
                      onResizeEnd={() => {
                        setIsSidebarResizing(false);
                        localStorage.setItem("contacts-sidebar-width", String(sidebarWidth));
                      }}
                      onDoubleClick={() => { setSidebarWidth(256); localStorage.setItem("contacts-sidebar-width", "256"); }}
                    />
                  )}
                </>
              )}

              {/* Panel 2: Contact list */}
              <div
                data-tour="contacts-list"
                className={cn(
                  "border-r border-border bg-background flex flex-col flex-shrink-0",
                  isMobile ? "w-full" : "",
                  !isListResizing && !isMobile && "transition-[width] duration-300"
                )}
                style={!isMobile ? { width: `${listWidth}px` } : undefined}
              >
                <ContactList
                  contacts={displayedContacts}
                  selectedContactId={selectedContactId}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSelectContact={handleSelectContact}
                  onCreateNew={handleCreateNew}
                  className="flex-1"
                  selectedContactIds={selectedContactIds}
                  onToggleSelection={toggleContactSelection}
                  onSelectRangeContacts={selectRangeContacts}
                  onSelectAll={selectAllContacts}
                  onClearSelection={clearSelection}
                  onBulkDelete={handleBulkDelete}
                  onBulkAddToGroup={handleBulkAddToGroup}
                  onBulkExport={handleBulkExport}
                  onEditContact={handleEditContact}
                  onDeleteContact={handleDeleteContact}
                  onAddContactToGroup={handleAddContactToGroup}
                  onMenuClick={isNarrow ? () => setNarrowSidebarOpen(true) : undefined}
                />
              </div>

              {!isMobile && (
                <ResizeHandle
                  onResizeStart={() => { listDragStartWidth.current = listWidth; setIsListResizing(true); }}
                  onResize={(delta) => setListWidth(Math.max(220, Math.min(500, listDragStartWidth.current + delta)))}
                  onResizeEnd={() => {
                    setIsListResizing(false);
                    localStorage.setItem("contacts-list-width", String(listWidth));
                  }}
                  onDoubleClick={() => { setListWidth(384); localStorage.setItem("contacts-list-width", "384"); }}
                />
              )}
            </>
          )}

          {/* Panel 3: Detail / Form */}
          {showRightPanel && (
            <div className="flex-1 min-w-0 flex flex-col">
              {isMobile && (
                <div className="px-3 py-2 border-b border-border">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={mobileBackToList}
                    className="touch-manipulation"
                  >
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    {returnToEmail ? t("back_to_email") : t("back_to_contacts")}
                  </Button>
                </div>
              )}
              <div className="flex-1 min-h-0">
                {renderRightPanel()}
              </div>
            </div>
          )}
        </div>

        {isMobile && !isEmbedded && (
          <NavigationRail
            orientation="horizontal"
            onManageApps={handleManageApps}
            onInlineApp={handleInlineApp}
            onCloseInlineApp={closeInlineApp}
            activeAppId={inlineApp?.id ?? null}
          />
        )}
      </div>

      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
      <ConfirmDialog {...confirmDialogProps} />
      {renamingKeyword !== null && (
        <RenameDialog
          currentName={renamingKeyword}
          title={t("rename_category")}
          label={t("category_name_label")}
          onCancel={() => setRenamingKeyword(null)}
          onConfirm={async (newName) => {
            try {
              await renameKeyword(supportsSync && client ? client : null, renamingKeyword, newName);
              toast.success(t("category_renamed"));
              if (typeof activeCategory === "object" && "keyword" in activeCategory && activeCategory.keyword === renamingKeyword) {
                setActiveCategory({ keyword: newName.trim() });
              }
              setRenamingKeyword(null);
            } catch (err) {
              console.error("Failed to rename category:", err);
              toast.error(t("category_rename_failed"));
            }
          }}
        />
      )}
      {renamingAddressBook && (
        <RenameDialog
          currentName={renamingAddressBook.name}
          title={t("address_books.rename")}
          label={t("address_books.name_label")}
          onCancel={() => setRenamingAddressBook(null)}
          onConfirm={async (newName) => {
            if (!client) return;
            try {
              await renameAddressBook(client, renamingAddressBook, newName);
              toast.success(t("address_books.renamed"));
              setRenamingAddressBook(null);
            } catch (err) {
              console.error("Failed to rename address book:", err);
              toast.error(t("address_books.rename_failed"));
            }
          }}
        />
      )}
      {showImportDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-background rounded-lg border border-border shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
            <ContactImportDialog
              existingContacts={contacts}
              onImport={handleImportContacts}
              onClose={() => setShowImportDialog(false)}
            />
          </div>
        </div>
      )}
      {sharingAddressBookId && client && (() => {
        const book = addressBooks.find((b) => b.id === sharingAddressBookId);
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
            onClose={() => setSharingAddressBookId(null)}
          />
        );
      })()}
      </div>
    </div>
  );
}
