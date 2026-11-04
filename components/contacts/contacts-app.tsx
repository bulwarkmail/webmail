"use client";

import { isAppLockedNow } from "@/lib/app-lock/state";
import { AppMain, SkipLink } from "@/components/layout/app-landmarks";
import { Suspense, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { ArrowLeft, Users, UsersRound, AlertTriangle, Plus, UserPlus, Upload, BookPlus, Printer } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ContactList } from "@/components/contacts/contact-list";
import { ContactDetail } from "@/components/contacts/contact-detail";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactGroupForm } from "@/components/contacts/contact-group-form";
import { ContactGroupDetail } from "@/components/contacts/contact-group-detail";
import { ContactsSidebar, type ContactCategory } from "@/components/contacts/contacts-sidebar";
import { ContactImportDialog } from "@/components/contacts/contact-import-dialog";
import { AddressBookPickerDialog } from "@/components/contacts/address-book-picker-dialog";
import { DirectoryBrowser, directoryKey, filterDirectory } from "@/components/contacts/directory-browser";
import { DirectoryEntryDetail } from "@/components/contacts/directory-entry-detail";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { exportContacts } from "@/components/contacts/contact-export";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { AppSidePanelPhoneButton, useAppSidePanel } from "@/components/plugins/app-side-panel";
import { contactToView } from "@/lib/plugin-projection";
import { useStrictestDevices } from "@/hooks/use-device-policy";
import { useContactStore, getContactDisplayName, getContactPrimaryEmail, type DirectoryEntry } from "@/stores/contact-store";
import { useSettingsStore } from "@/stores/settings-store";
import { inlineContactMedia, type ContactSaveOptions } from "@/lib/contact-media";
import { getContactPhotoClient } from "@/hooks/use-contact-photo";
import { savePendingMailto } from "@/lib/protocol-handlers/session";
import { formatRecipient, formatRecipientEntry, type Recipient } from "@/lib/email-composer-utils";
import { useAuthStore, redirectToLogin, saveRedirectAfterLogin } from '@/stores/auth-store';
import { useEmailStore } from "@/stores/email-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import { cn, generateUUID } from "@/lib/utils";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useIsFocusedProTab } from "@/hooks/use-pane-context";
import { useProMultiAccountContacts } from "@/hooks/use-pro-multi-account-contacts";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { useIsDesktop, useIsMobile } from "@/hooks/use-media-query";
import { useRefreshGesture } from "@/hooks/use-refresh-gesture";
import type { ContactCard, AddressBook, AddressBookRights } from "@/lib/jmap/types";
import { ShareCollectionDialog } from "@/components/settings/share-collection-dialog";
import { appPath, buildContactsPath, parseContactsPath, type ContactDeepLink } from "@/lib/deep-links";
import { consumePendingDeepLinkEntry, subscribePendingDeepLink } from "@/lib/deep-link-handoff";
import { useHandoffFiles } from "@/hooks/use-handoff-files";
import { useDeepLinkUrl } from "@/hooks/use-deep-link-url";
import { useProInterfaceActive } from "@/components/pro/pro-interface-redirect";
import { useLiteLinkSegments } from "@/hooks/use-lite-link-segments";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ContactsSkeleton, ContactsSkeletonBody } from "@/components/boot-skeleton/contacts-skeleton";
import { useSkeletonLabels } from "@/components/boot-skeleton/use-skeleton-labels";
import { useRegisterCommands } from "@/lib/command-registry";
import { useCloseOnBack } from "@/hooks/use-close-on-back";
import { useLeaveGuard } from "@/lib/leave-guard";
import { useDeleteCategory } from "@/hooks/use-delete-category";
import { MvTopBar } from "@/components/layout/mv-top-bar";
import { useMountainViewShell } from "@/hooks/use-mountain-view-shell";
import { usePrintListener, usePrinting } from "@/components/print/print-root";
import { requestPrint, usePrintStore } from "@/stores/print-store";
import { printContact, resolveContactsPrint } from "@/components/contacts/contact-print";
import {
  ContactGroupPrintSheet,
  ContactListPrint,
  ContactPrintSheet,
  DirectoryEntryPrintSheet,
  DirectoryListPrint,
} from "@/components/contacts/contact-print-views";

type View =
  | "list"
  | "detail"
  | "create"
  | "edit"
  | "group-detail"
  | "group-create"
  | "group-edit"
  | "bulk-add-to-group"
  | "directory-detail";

export interface ContactsAppProps {
  /** Path segments after `/contacts` (`['<contactId>', 'edit']`). */
  linkSegments?: string[];
}

function ContactsAppContent({ linkSegments: routeSegments }: ContactsAppProps = {}) {
  // Static Lite build: the route params are empty, read the link from the URL.
  const linkSegments = useLiteLinkSegments('contacts', routeSegments);
  const t = useTranslations("contacts");
  const skeleton = useSkeletonLabels();
  // Organisation > Devices > No printing: no Print buttons (Ctrl+P prints a note).
  const printOff = useStrictestDevices().noPrint;
  const tSidebar = useTranslations("sidebar");
  const tCommon = useTranslations("common");
  const tShell = useTranslations("shell");
  useDocumentTitle(tSidebar("contacts"));
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
    contactsLoaded,
    selectedContactIds,
    setSelectedContact,
    setSearchQuery,
    fetchContacts,
    createContact,
    updateContact,
    fetchContactFromServer,
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
    createAddressBook,
    renameAddressBook,
    removeAddressBook,
    shareAddressBook,
    setDefaultAddressBook,
    renameKeyword,
    importContacts,
  } = useContactStore();

  const [view, setView] = useState<View>("list");
  const [activeCategory, setActiveCategory] = useState<ContactCategory>("all");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [renamingAddressBook, setRenamingAddressBook] = useState<AddressBook | null>(null);
  const [creatingAddressBook, setCreatingAddressBook] = useState(false);
  const [sharingAddressBookId, setSharingAddressBookId] = useState<string | null>(null);
  const [defaultBookIdForCreate, setDefaultBookIdForCreate] = useState<string | undefined>(undefined);
  const [createPrefill, setCreatePrefill] = useState<{ email?: string; name?: string } | undefined>(undefined);
  const [returnToEmail, setReturnToEmail] = useState(false);
  const [renamingKeyword, setRenamingKeyword] = useState<string | null>(null);
  // "Move to…": the contacts waiting for an address book to be picked.
  const [movingContactIds, setMovingContactIds] = useState<string[] | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // Who a new group starts with: the selection when it came from "Add to group".
  const [newGroupMemberIds, setNewGroupMemberIds] = useState<string[]>([]);
  const [directorySelection, setDirectorySelection] = useState<Set<string>>(() => new Set());
  const [openDirectoryKey, setOpenDirectoryKey] = useState<string | null>(null);
  const directoryPrincipals = useContactStore((s) => s.directoryPrincipals);
  const directoryStatus = useContactStore((s) => s.directoryStatus);
  const showContactsDirectory = useSettingsStore((s) => s.showContactsDirectory);
  // Hidden when the user turned it off, and when the server refuses to list
  // its directory (Stalwart 1.0 for normal users): there's nothing to browse.
  const showDirectory = !!client?.supportsPrincipals() && showContactsDirectory && directoryStatus !== "forbidden";
  const hasFetched = useRef(false);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const locale = useLocale();
  usePrintListener();
  const printing = usePrinting();
  const printTarget = usePrintStore((s) => s.target);
  const isEmbedded = useIsEmbedded();
  // Mountain View's desktop chrome: its top bar in place of the left rail.
  const mvShell = useMountainViewShell(isEmbedded);
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
  // A new view (a form, a group, a contact) replaces whatever the drawer was for.
  useEffect(() => { setNarrowSidebarOpen(false); }, [view]);
  // R5: an editor with unsaved changes asks before anything replaces it.
  const [editorDirty, setEditorDirtyState] = useState(false);
  const editorDirtyRef = useRef(false);
  const setEditorDirty = useCallback((dirty: boolean) => {
    editorDirtyRef.current = dirty;
    setEditorDirtyState(dirty);
  }, []);
  useEffect(() => {
    if (view !== "create" && view !== "edit" && view !== "group-create" && view !== "group-edit") setEditorDirty(false);
  }, [view, setEditorDirty]);
  const askDiscard = useCallback(() => confirmDialog({
    title: t("form.discard_title"),
    message: t("form.discard_message"),
    confirmText: t("form.discard"),
    cancelText: t("form.keep_editing"),
    variant: "destructive",
  }), [confirmDialog, t]);
  const confirmDiscard = useCallback(async () => {
    if (!editorDirtyRef.current) return true;
    const discard = await askDiscard();
    if (discard) setEditorDirty(false);
    return discard;
  }, [askDiscard, setEditorDirty]);
  // The rail and the phone tab bar ask too, before they leave Contacts. Only
  // ask there: leaving unmounts the form, and clearing it first would let the
  // Back guard below take its history step back over the navigation.
  useLeaveGuard(() => editorDirtyRef.current, askDiscard);
  const guard = <A extends unknown[]>(action: (...args: A) => unknown) => (...args: A): void => {
    if (!editorDirtyRef.current) {
      action(...args);
      return;
    }
    void confirmDiscard().then((discard) => { if (discard) action(...args); });
  };
  // Leaving the page or going Back asks too.
  useEffect(() => {
    if (!editorDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // The app lock asks nobody: the page is going to the lock screen.
      if (!isAppLockedNow()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editorDirty]);
  const handleCancelRef = useRef<() => void>(() => {});
  // Set when the app itself goes Back (to the email it came from): the
  // guard's history entry is in the way then, and is stepped over.
  const leavingRef = useRef(false);
  const backGuard = useCloseOnBack({ active: editorDirty, onBack: () => {
    if (leavingRef.current) {
      leavingRef.current = false;
      window.history.back();
      return;
    }
    void confirmDiscard().then((discard) => {
      if (discard) handleCancelRef.current();
      else backGuard.rearm();
    });
  } });
  const routerBack = useCallback(() => {
    if (backGuard.armed()) leavingRef.current = true;
    router.back();
  }, [backGuard, router]);
  // Anything picked in the drawer closes it (R7).
  const fromDrawer = <A extends unknown[], R>(action: (...args: A) => R) => (...args: A): R => {
    setNarrowSidebarOpen(false);
    return action(...args);
  };

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
      saveRedirectAfterLogin();
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

  // Apply the deep link once (#733): `/contacts/<id>[/edit]` and `/contacts/new`,
  // plus the older one-shot query form the mobile recipient popover emits
  // (`?contactId=`, `?addEmail=`). `from=email` flips the mobile back button to
  // `router.back()`. After this the URL is an output of the view, not an input.
  // The applier is held in a ref so the live-delivery subscription below (Pro
  // shell) always calls the copy closing over the current setters.
  const applyContactsDeepLink = (link: ContactDeepLink) => {
    if (link.fromEmail) setReturnToEmail(true);
    if (link.kind === 'contact') {
      setSelectedContact(link.id);
      setView(link.edit ? 'edit' : 'detail');
    } else {
      setCreatePrefill({ email: link.email, name: link.name });
      setSelectedContact(null);
      setView('create');
    }
  };
  const applyContactsDeepLinkRef = useRef(applyContactsDeepLink);
  applyContactsDeepLinkRef.current = applyContactsDeepLink;

  useEffect(() => {
    if (intentAppliedRef.current) return;
    const entry = linkSegments ? { segments: linkSegments } : consumePendingDeepLinkEntry('contacts');
    const segments = entry?.segments ?? [];
    const link = parseContactsPath(
      segments,
      new URLSearchParams(entry?.search ?? searchParams.toString()),
    );
    intentAppliedRef.current = true;
    if (!link) return;
    applyContactsDeepLinkRef.current(link);
  }, [searchParams, linkSegments, setSelectedContact]);

  // Pro shell only: this surface stays mounted for the whole session, so links
  // arriving after mount are delivered live instead of being parked forever.
  // Embedded-only: during a cold-load redirect the standard instance renders
  // briefly and must not steal the link parked for the Pro one.
  useEffect(() => {
    if (!isEmbedded) return;
    return subscribePendingDeepLink('contacts', (segments, search) => {
      const link = parseContactsPath(segments, new URLSearchParams(search ?? window.location.search));
      if (link) applyContactsDeepLinkRef.current(link);
    });
  }, [isEmbedded]);

  // The permalink for the contact on screen. In the Pro shell only the
  // focused tab writes the address bar; the standard instance that renders
  // while Pro takes over a route stays silent.
  const proInterfaceActive = useProInterfaceActive();
  // A .vcf opened from the OS (lib/launch-handoff.ts). It waits for the
  // contacts, or everything would look new to the duplicate check. The
  // standard page that renders while the Pro shell takes over leaves it for
  // the Pro one.
  const launchedFile = useHandoffFiles(
    "contacts",
    isAuthenticated && !!client && (contactsLoaded || !supportsSync) && (isEmbedded || !proInterfaceActive),
  );
  const isFocusedProTab = useIsFocusedProTab();
  const contactsLinkPath = appPath(buildContactsPath({
    contactId: view === 'detail' || view === 'edit' ? selectedContactId : null,
    editing: view === 'edit',
  }));
  useDeepLinkUrl(
    isEmbedded
      ? (isFocusedProTab ? contactsLinkPath : null)
      : proInterfaceActive ? null : contactsLinkPath,
  );

  // Intercept browser refresh gestures (F5, Ctrl/Cmd+R, pull-to-refresh)
  // and refresh contacts via JMAP instead of reloading the page.
  const { indicator: refreshIndicator } = useRefreshGesture({
    enabled: isAuthenticated && !!client && supportsSync,
    onRefresh: async () => {
      if (!client) return;
      if (multiAccountEnabled && accountClients.length > 0) {
        const activeId = useAuthStore.getState().activeAccountId;
        if (activeId) {
          const { fetchAllAccountsContacts, fetchAllAccountsAddressBooks } = useContactStore.getState();
          await Promise.all([
            fetchAllAccountsAddressBooks(accountClients),
            fetchAllAccountsContacts(accountClients),
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

  // The plugin side panel (app-side-panel), with the contact the user opened
  // and how many are ticked. On desktop it sits under a row of its own with
  // the open contact's name and the panel's button.
  const openContact = (view === "detail" || view === "edit") && activeCategory !== "directory" && selectedContact?.kind !== "group" ? selectedContact : null;
  const selectedCount = selectedContactIds.size;
  const sidePanelContext = useMemo(() => ({
    ...(openContact ? { contact: contactToView(openContact) } : {}),
    selectedCount,
  }), [openContact, selectedCount]);
  const sidePanel = useAppSidePanel({ view: "contacts", context: sidePanelContext });
  const sidePanelTitle = openContact
    ? getContactDisplayName(openContact)
    : view === "group-detail" && selectedGroup ? getContactDisplayName(selectedGroup) : "";

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
    if (activeCategory === "all" || activeCategory === "directory") return individuals;
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
    setDirectorySelection(new Set());
    if (typeof category === "object" && "groupId" in category) {
      setSelectedGroupId(category.groupId);
      setView("group-detail");
    } else if (category === "directory") {
      setSelectedGroupId(null);
      setOpenDirectoryKey(null);
      setView("list");
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

  // Address books contacts can be moved to; "Move to…" needs a second one.
  const writableBooks = useMemo(() => addressBooks.filter((b) => b.myRights?.mayWrite !== false), [addressBooks]);
  const canMoveContacts = !!client && supportsSync && writableBooks.length > 1;
  // A contact in an address book shared read-only can't be changed: its menus leave out Edit, Move and Delete.
  const isContactReadOnly = useCallback((contact: ContactCard) => Object.entries(contact.addressBookIds ?? {})
    .some(([id, inBook]) => inBook && addressBooks.find((b) => b.id === id)?.myRights?.mayWrite === false), [addressBooks]);
  const handleMoveContacts = useCallback((ids: string[]) => {
    if (ids.length > 0) setMovingContactIds(ids);
  }, []);
  // The book the contacts are in, when they share one, so the picker can leave it out.
  const movingFromBookId = useMemo(() => {
    if (!movingContactIds) return null;
    const books = new Set(movingContactIds.flatMap((id) => {
      const c = contacts.find((x) => x.id === id);
      return c?.addressBookIds ? Object.keys(c.addressBookIds).filter((k) => c.addressBookIds[k]) : [];
    }));
    return books.size === 1 ? [...books][0] : null;
  }, [movingContactIds, contacts]);

  // The directory went away while open (turned off, or the server refused
  // to list it): back to all contacts.
  useEffect(() => {
    if (!showDirectory && activeCategory === "directory") {
      setActiveCategory("all");
      setDirectorySelection(new Set());
      setOpenDirectoryKey(null);
      setView("list");
    }
  }, [showDirectory, activeCategory]);

  // Deleting a category only takes a label off contacts: no question, an Undo (R3).
  const deleteCategory = useDeleteCategory();
  const handleDeleteKeyword = useCallback(async (keyword: string) => {
    if (!(await deleteCategory(keyword))) return;
    if (typeof activeCategory === "object" && "keyword" in activeCategory && activeCategory.keyword === keyword) {
      setActiveCategory("all");
    }
  }, [deleteCategory, activeCategory]);

  const handleDropContactsToCategory = useCallback(async (contactIds: string[], keyword: string) => {
    if (!client && supportsSync) return;
    try {
      // Contacts in the category afterwards; a plugin may stop some updates.
      let added = 0;
      for (const contactId of contactIds) {
        const contact = contacts.find(c => c.id === contactId);
        if (!contact) continue;
        const existingKeywords = contact.keywords || {};
        if (existingKeywords[keyword]) { added++; continue; } // already has this keyword
        const updatedKeywords = { ...existingKeywords, [keyword]: true };
        const updated = supportsSync && client
          ? await updateContact(client, contactId, { keywords: updatedKeywords })
          : await updateLocalContact(contactId, { keywords: updatedKeywords });
        if (updated !== false) added++;
      }
      if (added === 0) return;
      const msg = added === 1
        ? t("category_added", { name: keyword })
        : t("category_added_plural", { count: added, name: keyword });
      toast.success(msg);
    } catch (error) {
      console.error('Failed to add contacts to category:', error);
      toast.error(t("toast.error_update"));
    }
  }, [client, supportsSync, contacts, updateContact, updateLocalContact, t]);

  // Refresh address books (and contacts) after a structural change, staying
  // multi-account aware so a freshly created book lands in the sidebar.
  const refreshAddressBooks = useCallback(async () => {
    if (!client) return;
    if (multiAccountEnabled && accountClients.length > 0) {
      const activeId = useAuthStore.getState().activeAccountId;
      if (activeId) {
        const { fetchAllAccountsAddressBooks } = useContactStore.getState();
        await fetchAllAccountsAddressBooks(accountClients);
        return;
      }
    }
    await useContactStore.getState().fetchAddressBooks(client);
  }, [client, multiAccountEnabled, accountClients]);

  const handleCreateAddressBook = useCallback(async (name: string) => {
    if (!client) return;
    try {
      await createAddressBook(client, name);
      await refreshAddressBooks();
      toast.success(t("address_books.created"));
    } catch (error) {
      console.error('Failed to create address book:', error);
      toast.error(t("address_books.create_failed"));
    }
  }, [client, createAddressBook, refreshAddressBooks, t]);

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
    // When a specific address book is being viewed, create the new contact in
    // that book instead of falling back to the account's default book.
    if (typeof activeCategory === "object" && "addressBookId" in activeCategory) {
      setDefaultBookIdForCreate(activeCategory.addressBookId);
    } else {
      setDefaultBookIdForCreate(undefined);
    }
    setView("create");
  };

  const handleEdit = () => {
    setView("edit");
  };

  // R3: the confirm names what goes ("Delete Alice Smith?", "Delete 3
  // contacts?") and says what is lost with it.
  const confirmDeleteContacts = useCallback((ids: string[]) => {
    const only = ids.length === 1 ? contacts.find((c) => c.id === ids[0]) : undefined;
    const name = only ? getContactDisplayName(only).trim() : "";
    return confirmDialog({
      title: name ? t("delete_named_title", { name }) : t("bulk.delete_confirm", { count: ids.length }),
      message: t("delete_details_message"),
      confirmText: t("form.delete"),
      variant: "destructive",
    });
  }, [contacts, confirmDialog, t]);
  const confirmDeleteGroup = useCallback((groupId: string) => {
    const group = contacts.find((c) => c.id === groupId);
    const name = group ? getContactDisplayName(group).trim() : "";
    return confirmDialog({
      title: name ? t("delete_named_title", { name }) : t("groups.delete_confirm_title"),
      message: t("groups.delete_message"),
      confirmText: t("form.delete"),
      variant: "destructive",
    });
  }, [contacts, confirmDialog, t]);

  const deleteContactById = useCallback(async (contactId: string) => {
    if (!(await confirmDeleteContacts([contactId]))) return;

    try {
      const deleted = supportsSync && client
        ? await deleteContact(client, contactId)
        : await deleteLocalContact(contactId);
      // A plugin stopped it and has told the user why.
      if (!deleted) return;
      toast.success(t("toast.deleted"));
      if (selectedContactId === contactId) setView("list");
    } catch (error) {
      console.error('Failed to delete contact:', error);
      toast.error(t("toast.error_delete"));
    }
  }, [confirmDeleteContacts, t, supportsSync, client, deleteContact, deleteLocalContact, selectedContactId]);

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
      // No group to add to yet: a new one, with the contact already in it.
      setNewGroupMemberIds([id]);
      setView("group-create");
      return;
    }
    setView("bulk-add-to-group");
  }, [clearSelection, toggleContactSelection, groups.length]);

  // After a save or a duplicate the new card is on screen, not "Select a contact".
  const showNewestContact = useCallback(() => {
    const newest = useContactStore.getState().contacts.at(-1);
    if (!newest) {
      setView("list");
      return;
    }
    setSelectedContact(newest.id);
    setView("detail");
  }, [setSelectedContact]);

  const handleDuplicateContact = useCallback(async (source: ContactCard) => {
    const { id: _id, uid: _uid, created: _created, updated: _updated, ...rest } = source;
    void _id; void _uid; void _created; void _updated;
    const data: Partial<ContactCard> = JSON.parse(JSON.stringify(rest));
    if (supportsSync && client && source.media) {
      // A blobId names the bytes embedded in the source card; the copy gets
      // the bytes themselves.
      data.media = await inlineContactMedia(source.media, {
        client: getContactPhotoClient(source.localAccountId),
        accountId: source.accountId,
        localAccountId: source.localAccountId,
      }, "keep");
    }
    let created: boolean;
    try {
      created = supportsSync && client
        ? await createContact(client, data)
        : await addLocalContact({
          id: `local-${generateUUID()}`,
          addressBookIds: data.addressBookIds || {},
          ...data,
        });
    } catch (error) {
      console.error("Failed to duplicate contact:", error);
      toast.error(t("toast.error_create"));
      return;
    }
    if (!created) return;
    toast.success(t("toast.created"));
    showNewestContact();
  }, [supportsSync, client, createContact, addLocalContact, t, showNewestContact]);

  const handleSaveNew = useCallback(async (data: Partial<ContactCard>, options?: ContactSaveOptions) => {
    const created = supportsSync && client
      ? await createContact(client, data, options)
      : await addLocalContact({
        id: `local-${generateUUID()}`,
        addressBookIds: {},
        ...data,
      });
    // A plugin stopped it: keep the form open with what was typed.
    if (!created) return;
    toast.success(t("toast.created"));
    setEditorDirty(false);
    setDefaultBookIdForCreate(undefined);
    setCreatePrefill(undefined);
    if (returnToEmail) {
      setReturnToEmail(false);
      routerBack();
      return;
    }
    showNewestContact();
  }, [supportsSync, client, createContact, addLocalContact, t, returnToEmail, routerBack, setEditorDirty, showNewestContact]);

  const handleSaveEdit = useCallback(async (data: Partial<ContactCard>, options?: ContactSaveOptions) => {
    if (!selectedContact) return;

    const updated = supportsSync && client
      ? await updateContact(client, selectedContact.id, data, options)
      : await updateLocalContact(selectedContact.id, data);
    if (!updated) return;
    toast.success(t("toast.updated"));
    setView("detail");
  }, [supportsSync, client, selectedContact, updateContact, updateLocalContact, t]);

  const handleCancel = () => {
    setEditorDirty(false);
    setDefaultBookIdForCreate(undefined);
    // Came from email → cancel returns to the email instead of the contact list.
    if (returnToEmail && view === "create") {
      setCreatePrefill(undefined);
      setReturnToEmail(false);
      routerBack();
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

  handleCancelRef.current = handleCancel;

  const _handleSelectGroup = (id: string) => {
    setSelectedGroupId(id);
    setActiveCategory({ groupId: id });
    setView("group-detail");
  };

  const handleCreateGroup = () => {
    setSelectedGroupId(null);
    setNewGroupMemberIds([]);
    setView("group-create");
  };

  // "Add to group": a new group starting with the selected contacts.
  const handleCreateGroupFromSelection = () => {
    setSelectedGroupId(null);
    setNewGroupMemberIds(Array.from(selectedContactIds));
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

  // Open the in-app composer in the current session rather than routing through
  // a mailto: URL. `window.location='mailto:'` hands off to the OS handler
  // (which may open a different mail app), and the mailto protocol round-trip
  // reloads the app - dropping the in-memory per-account JMAP clients of a
  // multi-account session, which reads as a logout. Stashing the recipients and
  // doing a client-side router.push keeps the session and the active account
  // intact; the main route consumes the pending compose and opens the composer
  // (see consumePendingMailto in page.tsx).
  const openComposeInApp = useCallback((recipients: string[], field: "to" | "cc" | "bcc") => {
    savePendingMailto({
      to: field === "to" ? recipients : [],
      cc: field === "cc" ? recipients : [],
      bcc: field === "bcc" ? recipients : [],
      subject: "",
      body: "",
      inApp: true,
    });
    router.push("/");
  }, [router]);

  const handleComposeGroupFromSidebar = useCallback((groupId: string, field: "to" | "cc" | "bcc") => {
    // Hand the composer a single group chip (RFC 5322 group syntax survives
    // the string hand-off) instead of one entry per member - the chip expands
    // into the members when the message is sent. Dedupe by email,
    // case-insensitively; members without an email are skipped.
    const seen = new Set<string>();
    const members: Array<{ name?: string; email: string }> = [];
    for (const member of getGroupMembers(groupId)) {
      const email = getContactPrimaryEmail(member).trim();
      const key = email.toLowerCase();
      if (!email || seen.has(key)) continue;
      seen.add(key);
      const name = getContactDisplayName(member);
      members.push({ name: name && name !== email ? name : undefined, email });
    }
    if (members.length === 0) {
      toast.error(t("groups.no_member_emails"));
      return;
    }
    const group = useContactStore.getState().contacts.find((c) => c.id === groupId);
    const chip: Recipient = {
      name: (group && getContactDisplayName(group)) || "Group",
      email: "",
      group: { members },
    };
    openComposeInApp([formatRecipientEntry(chip)], field);
  }, [getGroupMembers, t, openComposeInApp]);

  const handleComposeDirectory = useCallback((entries: DirectoryEntry[]) => {
    if (entries.length === 0) return;
    openComposeInApp(entries.map((e) => formatRecipient(e.name !== e.email ? e.name : "", e.email)), "to");
  }, [openComposeInApp]);

  const handleAddDirectoryEntryToContacts = useCallback((entry: DirectoryEntry) => {
    setCreatePrefill({ email: entry.email, name: entry.name !== entry.email ? entry.name : undefined });
    setSelectedContact(null);
    setDefaultBookIdForCreate(undefined);
    setActiveCategory("all");
    setView("create");
  }, [setSelectedContact]);

  const handleComposeContact = useCallback((contact: ContactCard) => {
    const email = getContactPrimaryEmail(contact).trim();
    if (!email) return;
    openComposeInApp([formatRecipient(getContactDisplayName(contact), email)], "to");
  }, [openComposeInApp]);

  const handleDeleteGroupFromSidebar = useCallback(async (groupId: string) => {
    if (!(await confirmDeleteGroup(groupId))) return;

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
  }, [confirmDeleteGroup, deleteGroup, supportsSync, client, selectedGroupId, t]);

  const handleDeleteGroup = async () => {
    if (!selectedGroup) return;
    if (!(await confirmDeleteGroup(selectedGroup.id))) return;

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
      clearSelection();
      setView("list");
    }
  }, [view, selectedGroup, selectedGroupMembers, supportsSync, client, createGroup, updateGroup, addMembersToGroup, removeMembersFromGroup, clearSelection, t]);

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

    if (!(await confirmDeleteContacts(Array.from(selectedContactIds)))) return;

    try {
      if (!(await bulkDeleteContacts(
        supportsSync && client ? client : null,
        Array.from(selectedContactIds)
      ))) return;
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
      handleCreateGroupFromSelection();
      return;
    }
    setView("bulk-add-to-group");
  };

  const handleBulkExport = async () => {
    const toExport = contacts.filter(c => selectedContactIds.has(c.id));
    if (toExport.length > 0 && await exportContacts(toExport)) {
      toast.success(t("export.success", { count: toExport.length }));
      clearSelection();
    }
  };

  // The command palette's Contacts group (Ctrl/⌘+K).
  useRegisterCommands(tSidebar("contacts"), [
    { id: "new-contact", label: t("create_new"), icon: UserPlus, run: () => guard(handleCreateNew)() },
    { id: "import", label: t("import.title"), icon: Upload, run: () => setShowImportDialog(true) },
    { id: "new-group", label: t("groups.create"), icon: UsersRound, run: () => guard(handleCreateGroup)() },
    { id: "new-address-book", label: t("address_books.create"), icon: BookPlus, run: () => setCreatingAddressBook(true), when: () => !!client },
  ], contactsEnabled);

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

  // Until the session is restored: the page skeleton the server drew.
  if (!isAuthenticated) {
    return isEmbedded
      ? <ContactsSkeletonBody embedded />
      : <ContactsSkeleton label={skeleton.label} labels={skeleton.labels} />;
  }

  const renderRightPanel = () => {
    // The directory is read-only: its panel shows the open entry whatever the view.
    if (activeCategory === "directory") {
      return (
        <DirectoryEntryDetail
          entry={directoryPrincipals.find((e) => directoryKey(e) === openDirectoryKey) ?? null}
          onPrint={printOff ? undefined : (entry) => { void requestPrint({ kind: "directory-entry", entry }); }}
          onCompose={(entry) => handleComposeDirectory([entry])}
          onAddToContacts={guard(handleAddDirectoryEntryToContacts)}
        />
      );
    }
    switch (view) {
      case "create":
        return <ContactForm addressBooks={addressBooks} allKeywords={allKeywords} defaultAddressBookId={defaultBookIdForCreate} prefill={createPrefill} onSave={handleSaveNew} onCancel={guard(handleCancel)} onDirtyChange={setEditorDirty} />;

      case "edit":
        if (!selectedContact) return null;
        return (
          <ContactForm
            contact={selectedContact}
            addressBooks={addressBooks}
            allKeywords={allKeywords}
            onSave={handleSaveEdit}
            onCancel={guard(handleCancel)}
            onDirtyChange={setEditorDirty}
            loadCurrentMedia={supportsSync && client ? () => fetchContactFromServer(client, selectedContact.id) : undefined}
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
            onComposeGroup={(field) => handleComposeGroupFromSidebar(selectedGroup.id, field)}
            onPrint={printOff ? undefined : () => { void requestPrint({ kind: "contact-group", group: selectedGroup }); }}
            isMobile={isMobile}
            onSelectMember={guard((id: string) => {
              setSelectedContact(id);
              setView("detail");
            })}
          />
        );

      case "group-create":
        return (
          <ContactGroupForm
            individuals={individuals}
            currentMemberIds={newGroupMemberIds}
            onSave={handleSaveGroup}
            onCancel={guard(handleCancel)}
            onDirtyChange={setEditorDirty}
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
            onCancel={guard(handleCancel)}
            onDirtyChange={setEditorDirty}
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
              <button
                type="button"
                onClick={handleCreateGroupFromSelection}
                className="w-full flex items-center gap-3 px-6 py-3 text-start hover:bg-muted transition-colors"
              >
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <UsersRound className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0 text-sm font-medium">{t("bulk.new_group")}</div>
              </button>
              {groups.map((group) => {
                const gName = getContactDisplayName(group);
                const memberCount = group.members
                  ? Object.values(group.members).filter(Boolean).length
                  : 0;
                return (
                  <button
                    key={group.id}
                    onClick={() => handleBulkAddToGroupConfirm(group.id)}
                    className="w-full flex items-center gap-3 px-6 py-3 text-start hover:bg-muted transition-colors"
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
            onCompose={
              selectedContact
                ? () => handleComposeContact(selectedContact)
                : undefined
            }
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
            onMoveTo={selectedContact && canMoveContacts ? () => handleMoveContacts([selectedContact.id]) : undefined}
            onPrint={selectedContact && !printOff ? () => { void printContact(selectedContact); } : undefined}
            isMobile={isMobile}
            readOnly={selectedContact ? isContactReadOnly(selectedContact) : false}
          />
        );
    }
  };

  if (!contactsEnabled) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-lg text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-amber-600 dark:text-amber-400 mx-auto" />
          <p className="text-sm font-medium">{t("disabled_title")}</p>
          <p className="text-xs text-muted-foreground">{t("disabled_description")}</p>
        </div>
      </div>
    );
  }

  const showListPanel = !isMobile || view === "list";
  const showRightPanel = !isMobile || view !== "list";

  // The print copy (Ctrl+P or Print): the contact, group or directory entry
  // that is open, else the list as it is on screen.
  const printContent = printing ? resolveContactsPrint(printTarget, {
    directory: activeCategory === "directory",
    detailShown: showRightPanel,
    view,
    selectedContact,
    selectedGroup,
    openDirectoryEntry: directoryPrincipals.find((e) => directoryKey(e) === openDirectoryKey) ?? null,
  }) : null;
  const listTitle = activeCategory === "all" ? t("tabs.all")
    : activeCategory === "uncategorized" ? t("no_category")
      : activeCategory === "directory" ? t("directory.title")
        : "addressBookId" in activeCategory ? addressBooks.find((b) => b.id === activeCategory.addressBookId)?.name ?? t("title")
          : "keyword" in activeCategory ? activeCategory.keyword
            : getContactDisplayName(groups.find((g) => g.id === activeCategory.groupId) ?? ({} as ContactCard)) || t("title");
  // The list prints itself, with its filters and letter groups; a phone
  // showing something else prints what the list would hold.
  const printCopy = (() => {
    switch (printContent?.kind) {
      case "contact": return <ContactPrintSheet contact={printContent.contact} photoUri={printContent.photoUri} />;
      case "group": return <ContactGroupPrintSheet group={printContent.group} members={getGroupMembers(printContent.group.id)} />;
      case "directory-entry": return <DirectoryEntryPrintSheet entry={printContent.entry} />;
      case "directory-list":
        return showListPanel ? null : <DirectoryListPrint entries={filterDirectory(directoryPrincipals, "", locale)} />;
      case "list":
        return showListPanel ? null : (
          <ContactListPrint
            title={listTitle}
            contacts={[...displayedContacts].sort((a, b) => getContactDisplayName(a).localeCompare(getContactDisplayName(b), locale))}
            searchQuery={searchQuery}
          />
        );
      default: return null;
    }
  })();

  const mobileBackToList = () => {
    if (returnToEmail) {
      setReturnToEmail(false);
      setCreatePrefill(undefined);
      routerBack();
      return;
    }
    setView("list");
    clearSelection();
  };

  return (
    <div className={cn("flex flex-col overflow-hidden pt-[var(--app-top-inset)]", mvShell ? "bg-[var(--mv-canvas)]" : "bg-background", isEmbedded ? "h-full" : "h-dvh")}>
      {!isEmbedded && <SkipLink>{tShell("skip_to_content")}</SkipLink>}
      <AppTopBannerSlot />
      {refreshIndicator}
      {mvShell && (
        <MvTopBar
          showMenuButton={false}
          onManageApps={handleManageApps}
          onInlineApp={handleInlineApp}
          onCloseInlineApp={closeInlineApp}
          activeAppId={inlineApp?.id ?? null}
        />
      )}
      <div data-mv-card={mvShell ? "" : undefined} className={cn("flex flex-1 min-h-0 overflow-hidden", isMobile && "flex-col", mvShell && "mb-4 mx-4")}>
      {/* Navigation Rail - desktop only (hidden when embedded in Pro shell) */}
      {!isMobile && !isEmbedded && !mvShell && (
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
        {/* Clips the closed drawer, so it never sits over the nav rail. */}
        <div className={cn("relative flex flex-1 min-h-0 overflow-hidden", inlineApp && "hidden")}>
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
          {/* Panel 1: Categories sidebar (in-flow on desktop, overlay on narrow) */}
          {showListPanel && (!isMobile || isNarrow) && (
                <>
                  <div
                    data-testid={isNarrow ? "contacts-sidebar-drawer" : undefined}
                    data-pane="sidebar"
                    className={cn(
                      "border-e border-border flex flex-col flex-shrink-0 bg-background",
                      !isSidebarResizing && "transition-[width] duration-300",
                      isNarrow && cn(
                        "absolute inset-y-0 start-0 z-50 w-72 pt-[var(--app-top-inset)]",
                        "transform transition-[transform,visibility] duration-300 ease-in-out",
                        !narrowSidebarOpen && "invisible -translate-x-full rtl:translate-x-full"
                      )
                    )}
                    // Closed, the drawer is out of reach: no clicks, no Tab stops.
                    inert={isNarrow && !narrowSidebarOpen}
                    style={isNarrow ? undefined : { width: `${sidebarWidth}px` }}
                  >
                    <ContactsSidebar
                      groups={groups}
                      individuals={individuals}
                      addressBooks={addressBooks}
                      activeCategory={activeCategory}
                      onSelectCategory={guard(handleSelectCategory)}
                      onCreateGroup={fromDrawer(guard(handleCreateGroup))}
                      onCreateContact={fromDrawer(guard(handleCreateNew))}
                      onCreateAddressBook={client ? fromDrawer(() => setCreatingAddressBook(true)) : undefined}
                      onImport={fromDrawer(() => setShowImportDialog(true))}
                      onEditGroup={fromDrawer(guard(handleEditGroupFromSidebar))}
                      onDeleteGroup={fromDrawer(handleDeleteGroupFromSidebar)}
                      onComposeGroup={fromDrawer(handleComposeGroupFromSidebar)}
                      onDropContacts={handleDropContacts}
                      onDropContactsToCategory={handleDropContactsToCategory}
                      onRenameAddressBook={client ? fromDrawer((book: AddressBook) => setRenamingAddressBook(book)) : undefined}
                      onShareAddressBook={client ? fromDrawer((book: AddressBook) => setSharingAddressBookId(book.id)) : undefined}
                      onSetDefaultAddressBook={client ? fromDrawer(async (book: AddressBook) => {
                        try {
                          await setDefaultAddressBook(client, book);
                          toast.success(t("address_books.default_updated"));
                        } catch {
                          toast.error(t("address_books.set_default_failed"));
                        }
                      }) : undefined}
                      onCreateContactInBook={fromDrawer(guard((book: AddressBook) => {
                        setDefaultBookIdForCreate(book.id);
                        setSelectedContact(null);
                        setView("create");
                      }))}
                      onDeleteAddressBook={client ? fromDrawer(async (book: AddressBook) => {
                        const ok = await confirmDialog({
                          title: t("address_books.delete_title"),
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
                      }) : undefined}
                      onRenameKeyword={fromDrawer((kw: string) => setRenamingKeyword(kw))}
                      onDeleteKeyword={fromDrawer((kw: string) => void handleDeleteKeyword(kw))}
                      directoryCount={showDirectory ? directoryPrincipals.length : undefined}
                      multiAccountMode={multiAccountEnabled && accountClients.length > 1}
                    />
                  </div>
                  {!isNarrow && (
                    <ResizeHandle
                      pane="sidebar"
                      value={sidebarWidth}
                      min={180}
                      max={400}
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

          {/* The list and the contact: the main content, after the sidebar. */}
          <AppMain
            embedded={isEmbedded}
            heading={tShell("heading", { place: listTitle, app: tSidebar("contacts") })}
            className="relative flex flex-1 min-w-0 min-h-0"
          >
          {showListPanel && (
            <>
              {/* Panel 2: Contact list */}
              <div
                data-tour="contacts-list"
                className={cn(
                  "relative border-e border-border bg-background flex flex-col flex-shrink-0",
                  isMobile ? "w-full" : "",
                  !isListResizing && !isMobile && "transition-[width] duration-300"
                )}
                style={!isMobile ? { width: `${listWidth}px` } : undefined}
              >
                {activeCategory === "directory" ? (
                  <>
                    <DirectoryBrowser
                      client={client}
                      selected={directorySelection}
                      onSelectedChange={setDirectorySelection}
                      onOpen={(entry) => { setOpenDirectoryKey(directoryKey(entry)); setView("directory-detail"); }}
                      activeKey={openDirectoryKey}
                      onPrint={printOff ? undefined : () => { void requestPrint({ kind: "directory-list" }); }}
                      printing={printContent?.kind === "directory-list"}
                      onMenuClick={isNarrow ? () => setNarrowSidebarOpen(true) : undefined}
                      className="flex-1"
                    />
                    {directorySelection.size > 0 && (
                      <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
                        <span className="text-xs text-muted-foreground me-auto tabular-nums">
                          {t("directory.selected_count", { count: directorySelection.size })}
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => setDirectorySelection(new Set())}>
                          {t("bulk.clear")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleComposeDirectory(directoryPrincipals.filter((e) => directorySelection.has(directoryKey(e))))}
                        >
                          {t("directory.write_email")}
                        </Button>
                      </div>
                    )}
                  </>
                ) : (
                <ContactList
                  contacts={displayedContacts}
                  isContactReadOnly={isContactReadOnly}
                  selectedContactId={selectedContactId}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSelectContact={guard(handleSelectContact)}
                  onCreateNew={guard(handleCreateNew)}
                  className="flex-1"
                  selectedContactIds={selectedContactIds}
                  onToggleSelection={toggleContactSelection}
                  onSelectRangeContacts={selectRangeContacts}
                  onSelectAll={selectAllContacts}
                  onClearSelection={clearSelection}
                  onBulkDelete={handleBulkDelete}
                  onBulkAddToGroup={guard(handleBulkAddToGroup)}
                  onBulkExport={handleBulkExport}
                  onEditContact={guard(handleEditContact)}
                  onDeleteContact={handleDeleteContact}
                  onAddContactToGroup={guard(handleAddContactToGroup)}
                  onComposeContact={handleComposeContact}
                  onDuplicateContact={(contact) => void handleDuplicateContact(contact)}
                  onMoveContacts={canMoveContacts ? handleMoveContacts : undefined}
                  onMenuClick={isNarrow ? () => setNarrowSidebarOpen(true) : undefined}
                  emptyView={activeCategory !== "all"}
                  onImport={() => setShowImportDialog(true)}
                  phoneMenuItems={(close) => (
                    // On the phone these are otherwise only in the drawer's "+".
                    <>
                      <ContextMenuItem icon={UsersRound} label={t("groups.create")} onClick={() => { close(); guard(handleCreateGroup)(); }} />
                      <ContextMenuItem icon={Upload} label={t("import.title")} onClick={() => { close(); setShowImportDialog(true); }} />
                      {!printOff && <ContextMenuItem icon={Printer} label={tCommon("print")} onClick={() => { close(); void requestPrint({ kind: "contact-list" }); }} />}
                    </>
                  )}
                  // Until the session is back, nobody knows yet whether the server
                  // keeps contacts: show the rows loading, not an empty book.
                  isLoading={!contactsLoaded && (supportsSync || !client)}
                  onPrint={printOff ? undefined : () => { void requestPrint({ kind: "contact-list" }); }}
                  printTitle={printContent?.kind === "list" ? listTitle : null}
                />
                )}
                {/* The phone's create button, as in Mail and Files (R7). */}
                {isMobile && activeCategory !== "directory" && selectedContactIds.size === 0 && (
                  <Button
                    size="icon-lg"
                    className="absolute bottom-4 end-4 z-20 rounded-full shadow-lg"
                    aria-label={t("create_new")}
                    title={t("create_new")}
                    onClick={guard(handleCreateNew)}
                  >
                    <Plus className="w-5 h-5" />
                  </Button>
                )}
              </div>

              {!isMobile && (
                <ResizeHandle
                  pane="contactList"
                  value={listWidth}
                  min={220}
                  max={500}
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

          {/* Panel 3: Detail / Form. With a plugin side panel, a row with the
              contact's name and the panel's button sits over it, like the
              reader's toolbar. The same element either way, so a form keeps
              what was typed when the panel starts or stops docking. */}
          {showRightPanel && (
            <div className="flex-1 min-w-0 flex flex-col" data-contacts-side-panel-column="">
              {sidePanel.docks && (
                <div className="flex items-center gap-2 h-14 box-content border-b border-border px-2 sm:px-4 lg:px-6 shrink-0" data-contacts-panel-row="">
                  <div className="flex-1 min-w-0 truncate text-sm font-semibold" title={sidePanelTitle || undefined}>{sidePanelTitle}</div>
                  {sidePanel.toggle}
                </div>
              )}
              {isMobile && (
                <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={guard(mobileBackToList)}
                    className="touch-manipulation"
                  >
                    <ArrowLeft className="w-4 h-4 me-2" />
                    {returnToEmail ? t("back_to_email") : t("back_to_contacts")}
                  </Button>
                  {/* The list's header with its button is hidden while a contact is open. */}
                  <AppSidePanelPhoneButton className="ms-auto" />
                </div>
              )}
              <div ref={sidePanel.rowRef} className="relative flex flex-1 min-h-0">
                <div className="flex-1 min-w-0 min-h-0">
                  {renderRightPanel()}
                </div>
                {sidePanel.panel}
              </div>
            </div>
          )}
          </AppMain>
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
      <PromptDialog
        isOpen={renamingKeyword !== null}
        onClose={() => setRenamingKeyword(null)}
        title={t("rename_category")}
        placeholder={t("category_name_label")}
        defaultValue={renamingKeyword ?? ""}
        confirmText={t("form.save")}
        cancelText={t("form.cancel")}
        onSubmit={(newName) => {
          const keyword = renamingKeyword;
          if (keyword === null || newName === keyword) return;
          void (async () => {
            try {
              await renameKeyword(supportsSync && client ? client : null, keyword, newName);
              toast.success(t("category_renamed"));
              if (typeof activeCategory === "object" && "keyword" in activeCategory && activeCategory.keyword === keyword) {
                setActiveCategory({ keyword: newName });
              }
            } catch (err) {
              console.error("Failed to rename category:", err);
              toast.error(t("category_rename_failed"));
            }
          })();
        }}
      />
      <PromptDialog
        isOpen={creatingAddressBook}
        onClose={() => setCreatingAddressBook(false)}
        title={t("address_books.create")}
        placeholder={t("address_books.name_label")}
        confirmText={t("address_books.create_confirm")}
        cancelText={t("form.cancel")}
        onSubmit={(name) => void handleCreateAddressBook(name)}
      />
      <PromptDialog
        isOpen={renamingAddressBook !== null}
        onClose={() => setRenamingAddressBook(null)}
        title={t("address_books.rename")}
        placeholder={t("address_books.name_label")}
        defaultValue={renamingAddressBook?.name ?? ""}
        confirmText={t("form.save")}
        cancelText={t("form.cancel")}
        onSubmit={(newName) => {
          const book = renamingAddressBook;
          if (!client || !book || newName === book.name) return;
          void (async () => {
            try {
              await renameAddressBook(client, book, newName);
              toast.success(t("address_books.renamed"));
            } catch (err) {
              console.error("Failed to rename address book:", err);
              toast.error(t("address_books.rename_failed"));
            }
          })();
        }}
      />
      <AddressBookPickerDialog
        isOpen={movingContactIds !== null}
        onClose={() => setMovingContactIds(null)}
        addressBooks={writableBooks}
        currentId={movingFromBookId}
        count={movingContactIds?.length ?? 0}
        onPick={(book) => {
          if (movingContactIds) void handleDropContacts(movingContactIds, book);
        }}
      />
      {launchedFile.file && (
        <ContactImportDialog
          key={`${launchedFile.file.name}:${launchedFile.file.lastModified}`}
          existingContacts={contacts}
          onImport={handleImportContacts}
          initialFile={launchedFile.file}
          onClose={launchedFile.done}
        />
      )}
      {showImportDialog && (
        <ContactImportDialog
          existingContacts={contacts}
          onImport={handleImportContacts}
          onClose={() => setShowImportDialog(false)}
        />
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
      {printCopy}
    </div>
  );
}

// useSearchParams() above needs a Suspense boundary for the surface to
// prerender (static Lite build); at runtime it never suspends.
export function ContactsApp(props: ContactsAppProps = {}) {
  return (
    // The static Lite export writes this fallback into the page's HTML.
    <Suspense fallback={<ContactsFallback />}>
      <ContactsAppContent {...props} />
    </Suspense>
  );
}

function ContactsFallback() {
  const { label, labels } = useSkeletonLabels();
  return <ContactsSkeleton label={label} labels={labels} />;
}
