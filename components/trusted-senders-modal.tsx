"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslations } from "next-intl";
import { ShieldCheck, Search, Trash2, Plus } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { PaneSpinner, Spinner } from "@/components/ui/spinner";
import { useSettingsStore } from "@/stores/settings-store";
import { useContactStore } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import { UNDO_TOAST_DURATION } from "@/lib/email-action-toast";
import { cn } from "@/lib/utils";
import { OrgLockedNote } from "@/components/settings/org-locked-note";

interface TrustedSendersModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The organisation blocks remote content: the list can be read and
   * cleaned up, but adding senders is pointless and offered nowhere.
   */
  readOnly?: boolean;
}

export function TrustedSendersModal({ isOpen, onClose, readOnly = false }: TrustedSendersModalProps) {
  const t = useTranslations("settings.email_behavior.trusted_senders");
  const tLock = useTranslations("remote_content_lock");
  const tNotifications = useTranslations("notifications");
  const inputRef = useRef<HTMLInputElement>(null);

  const { trustedSenders, addTrustedSender, removeTrustedSender, trustedSendersAddressBook } = useSettingsStore();
  const {
    trustedSenderEmails,
    trustedSendersLoaded,
    trustedSendersLoading,
    loadTrustedSendersBook,
    addToTrustedSendersBook,
    removeFromTrustedSendersBook,
  } = useContactStore();
  const { client } = useAuthStore();

  const [searchQuery, setSearchQuery] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailError, setEmailError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // When address book mode is on, load the book on first open
  useEffect(() => {
    if (isOpen && trustedSendersAddressBook && client && !trustedSendersLoaded) {
      loadTrustedSendersBook(client);
    }
  }, [isOpen, trustedSendersAddressBook, client, trustedSendersLoaded, loadTrustedSendersBook]);

  // The active list depends on mode
  const activeSenders = trustedSendersAddressBook ? trustedSenderEmails : trustedSenders;
  const isLoading = trustedSendersAddressBook && (!trustedSendersLoaded || trustedSendersLoading);

  // Filter senders based on search query
  const filteredSenders = useMemo(() => {
    if (!searchQuery.trim()) return activeSenders;
    const query = searchQuery.toLowerCase();
    return activeSenders.filter((email) => email.toLowerCase().includes(query));
  }, [activeSenders, searchQuery]);

  // Show search only when 5+ senders
  const showSearch = activeSenders.length >= 5;

  // Focus input when adding mode is enabled
  useEffect(() => {
    if (isAdding && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isAdding]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery("");
      setIsAdding(false);
      setNewEmail("");
      setEmailError("");
    }
  }, [isOpen]);

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const addSender = async (email: string) => {
    if (trustedSendersAddressBook && client) {
      await addToTrustedSendersBook(client, email);
    } else {
      addTrustedSender(email);
    }
  };

  const handleAddSender = async () => {
    const trimmedEmail = newEmail.trim().toLowerCase();

    if (!trimmedEmail) {
      setEmailError(t("invalid_email"));
      return;
    }

    if (!validateEmail(trimmedEmail)) {
      setEmailError(t("invalid_email"));
      return;
    }

    if (activeSenders.includes(trimmedEmail)) {
      setEmailError(t("already_added"));
      return;
    }

    setIsSubmitting(true);
    try {
      await addSender(trimmedEmail);
      setNewEmail("");
      setIsAdding(false);
      setEmailError("");
    } catch {
      setEmailError(t("save_error"));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Taking a sender off the list is reversible (R3): no question, a toast
  // with Undo that adds the address back.
  const handleRemoveSender = async (email: string) => {
    try {
      if (trustedSendersAddressBook && client) {
        await removeFromTrustedSendersBook(client, email);
      } else {
        removeTrustedSender(email);
      }
    } catch {
      toast.error(t("remove_error"));
      return;
    }
    toast.success(t("removed"), {
      message: email,
      duration: UNDO_TOAST_DURATION,
      action: {
        label: tNotifications("undo"),
        onClick: () => {
          void addSender(email).catch(() => toast.error(t("save_error")));
        },
      },
    });
  };

  const addRow = isAdding ? (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="email"
          placeholder={t("add_placeholder")}
          aria-label={t("add_placeholder")}
          aria-invalid={!!emailError}
          value={newEmail}
          onChange={(e) => {
            setNewEmail(e.target.value);
            setEmailError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleAddSender();
            }
          }}
          className={cn(
            "flex-1 min-w-0 px-3 py-2 text-sm bg-background border rounded-md focus:outline-hidden",
            emailError ? "border-destructive" : "border-border"
          )}
        />
        <Button size="sm" onClick={() => void handleAddSender()} disabled={isSubmitting}>
          {isSubmitting ? <Spinner size="sm" /> : t("add_button")}
        </Button>
      </div>
      {emailError && (
        <p className="text-xs text-destructive">{emailError}</p>
      )}
    </div>
  ) : (
    <Button variant="ghost" size="sm" className="-ms-3" onClick={() => setIsAdding(true)}>
      <Plus className="w-4 h-4" />
      {t("add_manually")}
    </Button>
  );

  const isEmpty = !isLoading && activeSenders.length === 0;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("modal_title")}
      dirty={isAdding && newEmail.trim() !== ""}
      className="max-h-[60vh]"
      bodyClassName="px-0 pb-0 mt-4 border-y border-border"
      footer={readOnly
        ? <div className="w-full pt-4"><OrgLockedNote /><p className="mt-1 text-xs text-muted-foreground">{tLock("trusted_senders_note")}</p></div>
        : !isLoading && (!isEmpty || isAdding) ? <div className="w-full pt-4">{addRow}</div> : undefined}
    >
      {/* Search (only when 5+ senders) */}
      {showSearch && (
        <div className="px-6 py-3 border-b border-border">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={t("search_placeholder")}
              aria-label={t("search_placeholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full ps-9 pe-3 py-2 text-sm bg-muted border border-border rounded-md focus:outline-hidden"
            />
          </div>
        </div>
      )}

      {isLoading ? (
        <PaneSpinner />
      ) : isEmpty ? (
        // The add row sits in the footer once "Add sender manually" is picked,
        // empty list or not.
        <EmptyState
          compact
          icon={ShieldCheck}
          title={t("empty_title")}
          description={t("empty_description")}
          actions={!isAdding && !readOnly ? (
            <Button size="sm" onClick={() => setIsAdding(true)}>
              <Plus className="w-4 h-4" />
              {t("add_manually")}
            </Button>
          ) : undefined}
        />
      ) : filteredSenders.length === 0 ? (
        <EmptyState compact icon={Search} title={t("no_results")} />
      ) : (
        <ul className="divide-y divide-border">
          {filteredSenders.map((email) => (
            <li
              key={email}
              className="flex items-center gap-3 px-6 py-3 hover:bg-muted/50 transition-colors group"
            >
              <Avatar email={email} size="sm" />
              <span className="flex-1 text-sm text-foreground truncate" title={email}>
                {email}
              </span>
              <IconButton
                label={`${t("remove")} ${email}`}
                title={t("remove")}
                onClick={() => void handleRemoveSender(email)}
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              >
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
