"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import { ArrowLeft, Upload, Download, Users, BookUser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ContactList } from "@/components/contacts/contact-list";
import { ContactDetail } from "@/components/contacts/contact-detail";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactGroupList } from "@/components/contacts/contact-group-list";
import { ContactGroupForm } from "@/components/contacts/contact-group-form";
import { ContactGroupDetail } from "@/components/contacts/contact-group-detail";
import { ContactImportDialog } from "@/components/contacts/contact-import-dialog";
import { exportContacts } from "@/components/contacts/contact-export";
import { useContactStore, getContactDisplayName } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { useIsMobile } from "@/hooks/use-media-query";
import type { ContactCard } from "@/lib/jmap/types";

type View =
  | "list"
  | "detail"
  | "create"
  | "edit"
  | "group-detail"
  | "group-create"
  | "group-edit"
  | "import"
  | "bulk-add-to-group";

export default function ContactsPage() {
  const router = useRouter();
  const t = useTranslations("contacts");
  const { client, isAuthenticated } = useAuthStore();
  const {
    contacts,
    selectedContactId,
    searchQuery,
    supportsSync,
    activeTab,
    selectedContactIds,
    setSelectedContact,
    setSearchQuery,
    setActiveTab,
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
    selectAllContacts,
    clearSelection,
    bulkDeleteContacts,
    bulkAddToGroup,
    importContacts,
  } = useContactStore();

  const [view, setView] = useState<View>("list");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const hasFetched = useRef(false);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!isAuthenticated) {
      router.push("/login");
    }
  }, [isAuthenticated, router]);

  useEffect(() => {
    if (client && supportsSync && !hasFetched.current) {
      hasFetched.current = true;
      fetchContacts(client);
    }
  }, [client, supportsSync, fetchContacts]);

  const groups = useMemo(() => contacts.filter(c => c.kind === 'group'), [contacts]);
  const individuals = useMemo(() => contacts.filter(c => c.kind !== 'group'), [contacts]);
  const selectedContact = contacts.find((c) => c.id === selectedContactId) || null;
  const selectedGroup = selectedGroupId ? contacts.find(c => c.id === selectedGroupId) || null : null;
  const selectedGroupMembers = selectedGroupId ? getGroupMembers(selectedGroupId) : [];

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

  const handleDelete = async () => {
    if (!selectedContact) return;

    const confirmed = await confirmDialog({
      title: t("delete_confirm_title"),
      message: t("delete_confirm"),
      confirmText: t("form.delete"),
      variant: "destructive",
    });
    if (!confirmed) return;

    try {
      if (supportsSync && client) {
        await deleteContact(client, selectedContact.id);
      } else {
        deleteLocalContact(selectedContact.id);
      }
      toast.success(t("toast.deleted"));
      setView("list");
    } catch (error) {
      console.error('Failed to delete contact:', error);
      toast.error(t("toast.error_delete"));
    }
  };

  const handleSaveNew = useCallback(async (data: Partial<ContactCard>) => {
    if (supportsSync && client) {
      await createContact(client, data);
      toast.success(t("toast.created"));
    } else {
      const localContact: ContactCard = {
        id: `local-${crypto.randomUUID()}`,
        addressBookIds: {},
        ...data,
      };
      addLocalContact(localContact);
      toast.success(t("toast.created"));
    }
    setView("list");
  }, [supportsSync, client, createContact, addLocalContact, t]);

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
    if (view === "group-create" || view === "group-edit") {
      setView(selectedGroup ? "group-detail" : "list");
    } else if (view === "import") {
      setView("list");
    } else if (view === "bulk-add-to-group") {
      setView("list");
    } else {
      setView(selectedContact ? "detail" : "list");
    }
  };

  const handleSelectGroup = (id: string) => {
    setSelectedGroupId(id);
    setView("group-detail");
  };

  const handleCreateGroup = () => {
    setSelectedGroupId(null);
    setView("group-create");
  };

  const handleEditGroup = () => {
    setView("group-edit");
  };

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
      const currentMemberIds = selectedGroup.members
        ? Object.keys(selectedGroup.members).filter(k => selectedGroup.members![k])
        : [];
      const toAdd = memberIds.filter(id => !currentMemberIds.includes(id));
      const toRemove = currentMemberIds.filter(id => !memberIds.includes(id));
      if (toAdd.length > 0) await addMembersToGroup(jmapClient, selectedGroup.id, toAdd);
      if (toRemove.length > 0) await removeMembersFromGroup(jmapClient, selectedGroup.id, toRemove);
      toast.success(t("toast.updated"));
      setView("group-detail");
    } else {
      await createGroup(jmapClient, name, memberIds);
      toast.success(t("toast.created"));
      setView("list");
    }
  }, [view, selectedGroup, supportsSync, client, createGroup, updateGroup, addMembersToGroup, removeMembersFromGroup, t]);

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

  const handleImport = useCallback(async (importedContacts: ContactCard[]) => {
    return importContacts(
      supportsSync && client ? client : null,
      importedContacts
    );
  }, [supportsSync, client, importContacts]);

  if (!isAuthenticated) return null;

  const renderRightPanel = () => {
    switch (view) {
      case "create":
        return <ContactForm onSave={handleSaveNew} onCancel={handleCancel} />;

      case "edit":
        if (!selectedContact) return null;
        return (
          <ContactForm
            contact={selectedContact}
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
              setActiveTab("all");
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

      case "import":
        return (
          <ContactImportDialog
            existingContacts={contacts}
            onImport={handleImport}
            onClose={handleCancel}
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
            isMobile={isMobile}
          />
        );
    }
  };

  const showListPanel = !isMobile || view === "list";
  const showRightPanel = !isMobile || view !== "list";

  const mobileBackToList = () => {
    setView("list");
    clearSelection();
  };

  return (
    <div className="flex h-screen bg-background">
      {!isMobile && (
        <div className="w-14 border-r border-border bg-secondary flex flex-col items-center flex-shrink-0">
          <NavigationRail collapsed />
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex flex-1 min-h-0">
          {showListPanel && (
            <div className={cn(
              "border-r border-border flex flex-col flex-shrink-0",
              isMobile ? "w-full" : "w-80"
            )}>
              <div className={cn("p-4 border-b border-border", isMobile && "px-3 py-3")}>
                <div className="flex items-center justify-between">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => router.push("/")}
                    className="justify-start"
                  >
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    {t("back_to_mail")}
                  </Button>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setView("import")}
                      title={t("import.title")}
                    >
                      <Upload className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        if (contacts.length > 0) {
                          exportContacts(contacts.filter(c => c.kind !== "group"));
                          toast.success(t("export.success", { count: contacts.filter(c => c.kind !== "group").length }));
                        }
                      }}
                      title={t("export.title")}
                    >
                      <Download className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex border-b border-border">
                <button
                  onClick={() => setActiveTab("all")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors touch-manipulation",
                    activeTab === "all"
                      ? "border-b-2 border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <BookUser className="w-4 h-4" />
                  {t("tabs.all")}
                </button>
                <button
                  onClick={() => setActiveTab("groups")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-colors touch-manipulation",
                    activeTab === "groups"
                      ? "border-b-2 border-primary text-primary"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Users className="w-4 h-4" />
                  {t("tabs.groups")}
                  {groups.length > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-muted">
                      {groups.length}
                    </span>
                  )}
                </button>
              </div>

              {activeTab === "all" ? (
                <ContactList
                  contacts={contacts}
                  selectedContactId={selectedContactId}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onSelectContact={handleSelectContact}
                  onCreateNew={handleCreateNew}
                  onImport={() => setView("import")}
                  supportsSync={supportsSync}
                  className="flex-1"
                  selectedContactIds={selectedContactIds}
                  onToggleSelection={toggleContactSelection}
                  onSelectAll={selectAllContacts}
                  onClearSelection={clearSelection}
                  onBulkDelete={handleBulkDelete}
                  onBulkAddToGroup={handleBulkAddToGroup}
                  onBulkExport={handleBulkExport}
                />
              ) : (
                <ContactGroupList
                  groups={groups}
                  selectedGroupId={selectedGroupId}
                  onSelectGroup={handleSelectGroup}
                  onCreateGroup={handleCreateGroup}
                  searchQuery={searchQuery}
                  className="flex-1"
                />
              )}
            </div>
          )}

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
                    {t("back_to_mail")}
                  </Button>
                </div>
              )}
              <div className="flex-1 min-h-0">
                {renderRightPanel()}
              </div>
            </div>
          )}
        </div>

        {isMobile && (
          <NavigationRail orientation="horizontal" />
        )}
      </div>

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
