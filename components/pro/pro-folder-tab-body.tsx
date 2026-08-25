"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Folder, Loader2, Paperclip, RefreshCw, Star } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { EmailViewer } from "@/components/email/email-viewer";
import { ProEmailView } from "@/components/pro/pro-email-tab-body";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProTabStore, type ProFolderTabData } from "@/stores/pro-tab-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { usePaneId } from "@/hooks/use-pane-context";
import type { Email, Mailbox } from "@/lib/jmap/types";

interface ProFolderTabBodyProps {
  tabId: string;
  data: ProFolderTabData;
}

/**
 * A mailbox opened in its own Pro tab (sidebar folder dragged onto the tab
 * strip). Self-sufficient like `ProEmailTabBody`: it queries its folder
 * directly through the owning account's JMAP client instead of touching the
 * email-store's single global list, so it never fights the Mail tab (or
 * another folder tab) over `selectedMailbox`.
 *
 * Wide panes render list + reading pane; a phone-narrow pane renders just the
 * list and opens messages as dedicated email tabs.
 */
export function ProFolderTabBody({ tabId, data }: ProFolderTabBodyProps) {
  const t = useTranslations();
  const tList = useTranslations('email_list');
  const tSidebar = useTranslations('sidebar');

  const activeClient = useAuthStore((s) => s.client);
  const getClientForAccount = useAuthStore((s) => s.getClientForAccount);
  const activeMailboxes = useEmailStore((s) => s.mailboxes);
  const accountMailboxes = useEmailStore((s) => s.accountMailboxes);
  const emailsPerPage = useSettingsStore((s) => s.emailsPerPage);
  const updateTabTitle = useProTabStore((s) => s.updateTabTitle);
  const paneId = usePaneId();
  // Pane-scoped: in a phone-narrow pane there is no room for a reading pane.
  const { isMobile } = useDeviceDetection();

  const client = useMemo(
    () => (data.accountId ? getClientForAccount(data.accountId) ?? activeClient : activeClient),
    [data.accountId, getClientForAccount, activeClient],
  );

  // The folder's metadata, resolved from whichever account's mailbox list it
  // was dragged from. Shared folders are namespaced in the store, so JMAP
  // calls need originalId + the owner accountId (mirrors fetchEmails).
  const mailbox: Mailbox | undefined = useMemo(() => {
    const list = data.accountId ? accountMailboxes[data.accountId] ?? [] : activeMailboxes;
    return list.find((m) => m.id === data.mailboxId);
  }, [data.accountId, data.mailboxId, accountMailboxes, activeMailboxes]);
  const jmapMailboxId = mailbox?.originalId || data.mailboxId;
  const jmapAccountId = mailbox?.isShared ? mailbox.accountId : undefined;

  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);

  const folderLabel = mailbox
    ? localizeMailboxName(mailbox.role, mailbox.name, (k) => tSidebar(`mailboxes.${k}`))
    : data.title;

  // Keep the tab title in sync with the folder's (possibly localized) name.
  useEffect(() => {
    if (folderLabel && folderLabel !== data.title) updateTabTitle(tabId, folderLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderLabel, tabId, updateTabTitle]);

  const loadPage = useCallback(async (position: number) => {
    if (!client) return;
    const seq = ++fetchSeqRef.current;
    if (position === 0) setIsLoading(true); else setIsLoadingMore(true);
    // getEmails never throws - it reports failures as an empty page.
    const result = await client.getEmails(jmapMailboxId, jmapAccountId, emailsPerPage, position, undefined, true);
    if (seq !== fetchSeqRef.current) return;
    setEmails((prev) => {
      if (position === 0) return result.emails;
      const known = new Set(prev.map((e) => e.id));
      return [...prev, ...result.emails.filter((e) => !known.has(e.id))];
    });
    setTotal(result.total);
    setHasMore(result.hasMore);
    if (position === 0) setIsLoading(false); else setIsLoadingMore(false);
  }, [client, jmapMailboxId, jmapAccountId, emailsPerPage]);

  useEffect(() => {
    setSelectedEmailId(null);
    void loadPage(0);
  }, [loadPage]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || isLoadingMore || isLoading) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      void loadPage(emails.length);
    }
  }, [hasMore, isLoadingMore, isLoading, loadPage, emails.length]);

  const markRowAsRead = useCallback((email: Email) => {
    if (!client || email.keywords?.$seen) return;
    setEmails((prev) => prev.map((e) => e.id === email.id
      ? { ...e, keywords: { ...e.keywords, $seen: true } }
      : e));
    // Straight to the client: the store's markAsRead only serves emails in
    // its own (global) list, which this tab's rows are not part of.
    void client.markAsRead(email.id, true, jmapAccountId).catch((err) => {
      console.error('Mark as read failed:', err);
    });
  }, [client, jmapAccountId]);

  const openAsEmailTab = useCallback((email: Email, reuseReader: boolean) => {
    useProTabStore.getState().openEmailTab(
      {
        accountId: email.accountId ?? '',
        emailId: email.id,
        mailboxId: data.mailboxId,
        title: email.subject?.trim() || t('email_composer.new_message'),
      },
      { pane: paneId ?? 'main', reuseReader },
    );
  }, [data.mailboxId, paneId, t]);

  const handleRowClick = useCallback((email: Email) => {
    markRowAsRead(email);
    if (isMobile) {
      // No room for a reading pane - promote to a dedicated email tab.
      openAsEmailTab(email, true);
      return;
    }
    setSelectedEmailId(email.id);
  }, [markRowAsRead, isMobile, openAsEmailTab]);

  // The selected message left the folder (deleted / archived / moved /
  // reopened as a draft): drop its row and clear the reading pane.
  const handleViewerClose = useCallback(() => {
    setSelectedEmailId((current) => {
      if (current) setEmails((prev) => prev.filter((e) => e.id !== current));
      return null;
    });
  }, []);

  // Sent/Drafts show the recipient - the sender is always "me" there.
  const showRecipient = mailbox?.role === 'sent' || mailbox?.role === 'drafts';

  const list = (
    <div className={cn("flex h-full flex-col bg-background", isMobile ? "w-full" : "w-96 flex-shrink-0 border-e border-border")}>
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border px-3">
        <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">{folderLabel}</span>
        {total > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">{total}</span>
        )}
        <button
          onClick={() => void loadPage(0)}
          className="ms-auto flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title={t('common.refresh')}
          aria-label={t('common.refresh')}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {isLoading && emails.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : emails.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {tList('no_emails')}
          </div>
        ) : (
          <>
            {emails.map((email) => {
              const isUnread = !email.keywords?.$seen;
              const isStarred = email.keywords?.$flagged === true;
              const counterpart = showRecipient ? (email.to?.[0] ?? email.from?.[0]) : email.from?.[0];
              const who = counterpart?.name || counterpart?.email || '';
              return (
                <div
                  key={email.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleRowClick(email)}
                  onDoubleClick={() => openAsEmailTab(email, false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleRowClick(email);
                    }
                  }}
                  className={cn(
                    "cursor-pointer border-b border-border/50 px-3 py-2 transition-colors",
                    email.id === selectedEmailId
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/50",
                  )}
                >
                  <div className="flex items-center gap-2">
                    {isUnread && (
                      <span className="h-2 w-2 flex-shrink-0 rounded-full bg-primary" aria-hidden="true" />
                    )}
                    <span className={cn("min-w-0 flex-1 truncate text-sm", isUnread ? "font-semibold" : "text-foreground/90")}>
                      {who}
                    </span>
                    <span className="flex-shrink-0 text-xs text-muted-foreground">
                      {formatDate(email.receivedAt)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5">
                    <span className={cn("min-w-0 flex-1 truncate text-sm", isUnread ? "font-medium" : "text-muted-foreground")}>
                      {email.subject || '—'}
                    </span>
                    {email.hasAttachment && (
                      <Paperclip className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                    )}
                    {isStarred && (
                      <Star className="h-3.5 w-3.5 flex-shrink-0 fill-yellow-400 text-yellow-400" aria-hidden="true" />
                    )}
                  </div>
                  {email.preview && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {email.preview}
                    </div>
                  )}
                </div>
              );
            })}
            {isLoadingMore && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {tList('loading_more')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  if (isMobile) {
    return list;
  }

  return (
    <div className="flex h-full w-full bg-background">
      {list}
      {selectedEmailId ? (
        <ProEmailView
          key={selectedEmailId}
          emailId={selectedEmailId}
          client={client}
          accountId={jmapAccountId}
          onClose={handleViewerClose}
          className="min-w-0 flex-1"
        />
      ) : (
        <EmailViewer email={null} isLoading={false} className="min-w-0 flex-1" />
      )}
    </div>
  );
}
