"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Folder, Loader2, Paperclip, RefreshCw, Star } from "@/components/icons";
import { cn, cleanPreview, formatDate } from "@/lib/utils";
import { emailListDate } from "@/lib/email-date";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { EmailViewer } from "@/components/email/email-viewer";
import { ProEmailView } from "@/components/pro/pro-email-tab-body";
import { RetentionNotice } from "@/components/email/retention-notice";
import { useAuthStore } from "@/stores/auth-store";
import { captureListedArchive, ensureArchiveMailbox, findArchiveMailbox, useEmailStore, type EmailRestoreBatch } from "@/stores/email-store";
import { getMessageListOrderFor, useSettingsStore } from "@/stores/settings-store";
import { useProTabStore, type ProFolderTabData } from "@/stores/pro-tab-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { usePaneId } from "@/hooks/use-pane-context";
import type { Email, Mailbox } from "@/lib/jmap/types";
import { emailHooks } from "@/lib/plugin-hooks";
import { scheduleAutoMarkAsRead } from "@/lib/mark-as-read-delay";
import { isArchiveActionEnabled } from "@/lib/archive-gate";
import { archiveInboxTarget } from "@/lib/archive-inbox";
import { allowEmailMove, emitEmailMove } from "@/lib/plugin-mail-hooks";
import { confirmMailRemoval } from "@/lib/mail-removal-confirm";
import { offerMoveUndo } from "@/lib/popout/moved-undo";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface RowReadIntent {
  email: Email;
  confirmedThroughFetch: number;
}

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
  const tRemove = useTranslations('email_list.confirm_remove');
  const { confirm, dialogProps } = useConfirmDialog();

  const activeClient = useAuthStore((s) => s.client);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
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
  // The login `client` belongs to. A message of this folder is read again
  // through it, and a draft reopened from it is saved over and removed
  // through it: the same ids name other messages on another server.
  const clientLogin = (data.accountId && getClientForAccount(data.accountId) ? data.accountId : activeAccountId) ?? undefined;

  // The folder's metadata, resolved from whichever account's mailbox list it
  // was dragged from. Shared folders are namespaced in the store, so JMAP
  // calls need originalId + the owner accountId (mirrors fetchEmails).
  const folderMailboxes = useMemo(
    () => data.accountId ? accountMailboxes[data.accountId] ?? [] : activeMailboxes,
    [data.accountId, accountMailboxes, activeMailboxes],
  );
  const mailbox: Mailbox | undefined = folderMailboxes.find((m) => m.id === data.mailboxId);
  const jmapMailboxId = mailbox?.originalId || data.mailboxId;
  const jmapAccountId = mailbox?.isShared ? mailbox.accountId : undefined;

  const [emails, setEmails] = useState<Email[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const fetchSeqRef = useRef(0);
  const cancelRowReadRef = useRef<(() => void) | null>(null);
  // Reads belong to this client/folder, even if another folder has the same ids.
  const rowReads = useMemo(() => ({
    active: false,
    pending: new Set<string>(),
    archiving: new Set<string>(),
    selected: null as RowReadIntent | null,
    // A context change starts a fresh scope even though its values are not stored here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [client, clientLogin, data.accountId, data.mailboxId, jmapMailboxId, jmapAccountId]);

  useEffect(() => {
    rowReads.active = true;
    return () => {
      rowReads.active = false;
      cancelRowReadRef.current?.();
    };
  }, [rowReads]);

  const folderLabel = mailbox
    ? localizeMailboxName(mailbox.role, mailbox.name, (k) => tSidebar(`mailboxes.${k}`))
    : data.title;

  // Keep the tab title in sync with the folder's (possibly localized) name.
  useEffect(() => {
    if (folderLabel && folderLabel !== data.title) updateTabTitle(tabId, folderLabel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderLabel, tabId, updateTabTitle]);

  // The configured list order (#718) depends on the folder's role (Inbox-only
  // by default), and every page of the tab must ask for the same order.
  const mailboxRole = mailbox?.role;
  const loadPage = useCallback(async (position: number) => {
    if (!client) return;
    const seq = ++fetchSeqRef.current;
    if (position === 0) {
      setIsLoading(true);
    } else setIsLoadingMore(true);
    try {
      const result = await client.getEmails(jmapMailboxId, jmapAccountId, emailsPerPage, position, undefined, true, undefined, getMessageListOrderFor(mailboxRole));
      if (seq !== fetchSeqRef.current || !rowReads.active) return;
      if (position === 0) {
        // Refresh keeps the selected read intent and its original timer. Let
        // that intent follow the replacement row, including when the request
        // succeeded while this (possibly older, unread) response was in flight.
        // Later refreshes remain authoritative, e.g. after an explicit Unread.
        const selected = rowReads.selected;
        setEmails(result.emails.map((email) => {
          if (!selected || email.id !== selected.email.id) return email;
          const current = selected.confirmedThroughFetch >= seq
            ? { ...email, keywords: { ...email.keywords, $seen: true } }
            : email;
          selected.email = current;
          return current;
        }));
      } else setEmails((prev) => {
        const known = new Set(prev.map((e) => e.id));
        return [...prev, ...result.emails.filter((e) => !known.has(e.id))];
      });
      setTotal(result.total);
      setHasMore(result.hasMore);
    } catch (error) {
      // Keep what is on screen: a failed page is not an empty folder.
      console.error('Failed to load folder tab:', error);
    } finally {
      if (seq === fetchSeqRef.current) {
        if (position === 0) setIsLoading(false); else setIsLoadingMore(false);
      }
    }
  }, [client, jmapMailboxId, jmapAccountId, emailsPerPage, mailboxRole, rowReads]);

  useEffect(() => {
    cancelRowReadRef.current?.();
    rowReads.selected = null;
    setSelectedEmailId(null);
    void loadPage(0);
  }, [loadPage, rowReads]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    if (!hasMore || isLoadingMore || isLoading) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      void loadPage(emails.length);
    }
  }, [hasMore, isLoadingMore, isLoading, loadPage, emails.length]);

  const markRowAsRead = useCallback(async (intent: RowReadIntent) => {
    const email = intent.email;
    if (!client || email.keywords?.$seen || !rowReads.active || rowReads.pending.has(email.id)) return;
    // Deduplicate before awaiting plugins too. A refused attempt is released in
    // finally; only a later row selection retries it, never a render/effect.
    rowReads.pending.add(email.id);
    try {
      // This tab owns its rows, so it calls the client and plugin hooks directly.
      if (emailHooks.onBeforeEmailReadStateChange.size > 0
        && !(await emailHooks.onBeforeEmailReadStateChange.intercept({ emailIds: [email.id], read: true }))) {
        return;
      }
      // Selection/context/unmount may have cancelled while a plugin was waiting.
      if (!rowReads.active || rowReads.selected !== intent) return;
      await client.markAsRead(email.id, true, jmapAccountId);
      if (rowReads.active) {
        // Only this intent can receive success. Same-context Refresh may have
        // transferred it to a new row; a different selection owns its own copy.
        intent.confirmedThroughFetch = fetchSeqRef.current;
        const current = intent.email;
        const confirmed = { ...current, keywords: { ...current.keywords, $seen: true } };
        intent.email = confirmed;
        setEmails((prev) => prev.map((e) => e === current ? confirmed : e));
      }
      void emailHooks.onEmailReadStateChange.emit({ emailIds: [email.id], read: true });
    } catch (err) {
      console.error('Mark as read failed:', err);
    } finally {
      rowReads.pending.delete(email.id);
    }
  }, [client, jmapAccountId, rowReads]);

  const openAsEmailTab = useCallback((email: Email, reuseReader: boolean) => {
    useProTabStore.getState().openEmailTab(
      {
        accountId: jmapAccountId ?? '',
        clientAccountId: clientLogin,
        emailId: email.id,
        mailboxId: data.mailboxId,
        title: email.subject?.trim() || t('email_composer.new_message'),
      },
      { pane: paneId ?? 'main', reuseReader },
    );
  }, [jmapAccountId, clientLogin, data.mailboxId, paneId, t]);

  // Opening a row marks it read on the user's markAsReadDelay, like the
  // reading pane does; a pending delayed mark is dropped when another row is
  // opened or the tab goes away.
  const handleRowClick = useCallback((email: Email) => {
    cancelRowReadRef.current?.();
    const intent = rowReads.selected?.email === email
      ? rowReads.selected
      : { email, confirmedThroughFetch: 0 };
    rowReads.selected = intent;
    cancelRowReadRef.current = scheduleAutoMarkAsRead(
      useSettingsStore.getState().markAsReadDelay,
      () => void markRowAsRead(intent),
    );
    if (isMobile) {
      // No room for a reading pane - promote to a dedicated email tab.
      openAsEmailTab(email, true);
      return;
    }
    setSelectedEmailId(email.id);
  }, [markRowAsRead, isMobile, openAsEmailTab, rowReads]);

  // The selected message left the folder (deleted / archived / moved /
  // reopened as a draft): drop its row and clear the reading pane.
  const handleViewerClose = useCallback(() => {
    setSelectedEmailId((current) => {
      if (current) setEmails((prev) => prev.filter((e) => e.id !== current));
      return null;
    });
  }, []);

  // The folder owns these rows. The list-based moveToMailbox deliberately
  // refuses a message absent from the global list, and may name another
  // login's colliding id there. Keep this Archive bound to the reader and
  // this folder's client/account, using the same move/archive plugin gates.
  const handleArchiveEmail = useCallback(async (email: Email) => {
    const intent = rowReads.selected;
    if (!client || !mailbox || !intent || intent.email.id !== email.id
      || rowReads.archiving.has(email.id) || !isArchiveActionEnabled()) return;
    const existing = findArchiveMailbox(folderMailboxes, mailbox.id, jmapAccountId);
    if (mailbox.myRights?.mayRemoveItems === false || existing?.myRights?.mayAddItems === false) return;
    const isCurrent = () => rowReads.active && rowReads.selected === intent
      && (!data.accountId || useAuthStore.getState().getClientForAccount(data.accountId) === client);
    const readFolders = () => {
      const state = useEmailStore.getState();
      return data.accountId ? state.accountMailboxes[data.accountId] ?? [] : state.mailboxes;
    };
    rowReads.archiving.add(email.id);
    try {
      if (!(await confirmMailRemoval('archive', 1, confirm, tRemove)) || !isCurrent()) return;
      // Like Mail, make the Archive when the account has none yet (#578).
      const archive = existing ?? await ensureArchiveMailbox({
        client, mailboxes: folderMailboxes, selectedMailboxId: mailbox.id, accountId: jmapAccountId,
        refresh: async () => {
          const store = useEmailStore.getState();
          if (data.accountId) await store.fetchAccountMailboxes(client, data.accountId);
          else await store.fetchMailboxes(client);
          return readFolders();
        },
      });
      if (!archive || archive.myRights?.mayAddItems === false || !isCurrent()) return;
      const mode = useSettingsStore.getState().archiveMode;
      const accountId = jmapAccountId ?? client.getAccountId();
      const prefix = `${accountId}:`;
      const restore: EmailRestoreBatch[] = [{ client, accountId, points: [{
        id: email.id,
        mailboxIds: Object.fromEntries(Object.entries(email.mailboxIds).filter(([, inIt]) => inIt)
          .map(([id]) => [id.startsWith(prefix) ? id.slice(prefix.length) : id, true])),
        seen: !!email.keywords?.$seen,
      }] }];
      const move = { emailIds: [email.id], fromMailboxId: mailbox.id, toMailboxId: archive.id };
      // A just-made Archive isn't in the folder list this render saw.
      const hookMailboxes = [...folderMailboxes.filter((m) => m.id !== archive.id), archive];
      if (!(await allowEmailMove(move, hookMailboxes)) || !isCurrent() || !isArchiveActionEnabled()) return;
      // A year or month folder isn't known yet, so only the plain Archive's
      // counter is bumped here; the folder refresh below settles the rest.
      const completeListedArchive = captureListedArchive(email.id, { client, clientAccountId: clientLogin, accountId }, mode === 'single' ? archive.id : '');
      if (mode === 'single') {
        await client.moveEmail(email.id, archive.originalId || archive.id, accountId);
      } else {
        // archiveMode files into year or year/month folders, made as needed.
        // batchArchiveEmails finds them by the server's ids, not the store's
        // namespaced ones (see archiveAggregateSelection).
        const serverFolders = readFolders().map((m) => (m.originalId && m.accountId ? {
          ...m, id: m.originalId,
          parentId: m.parentId?.startsWith(`${m.accountId}:`) ? m.parentId.slice(m.accountId.length + 1) : m.parentId,
        } : m));
        await client.batchArchiveEmails([{ id: email.id, receivedAt: email.receivedAt }], archive.originalId || archive.id, mode, serverFolders, accountId);
        const store = useEmailStore.getState();
        void (data.accountId ? store.fetchAccountMailboxes(client, data.accountId) : store.fetchMailboxes(client));
      }
      completeListedArchive();
      if (isCurrent()) {
        // Revoke the intent as well as the timer: a before-read hook may
        // already be waiting. A read sent to the server is left alone.
        cancelRowReadRef.current?.();
        rowReads.selected = null;
        // An older in-flight Refresh must not reinsert the archived row.
        ++fetchSeqRef.current;
        setIsLoading(false);
        setIsLoadingMore(false);
        setEmails((prev) => prev.filter((e) => e.id !== email.id));
        setSelectedEmailId(null);
      }
      // A confirmed server change still has its hooks and Undo if the user
      // selected another row or folder while it was in flight.
      emitEmailMove(move, hookMailboxes);
      await offerMoveUndo('archive', client, restore, t, false);
    } catch (error) {
      console.error('Archive failed:', error);
    } finally {
      rowReads.archiving.delete(email.id);
    }
  }, [client, clientLogin, mailbox, folderMailboxes, jmapAccountId, rowReads, data.accountId, confirm, tRemove, t]);

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
          <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin [animation-direction:reverse]")} />
        </button>
      </div>
      <RetentionNotice role={mailboxRole} accountId={clientLogin ?? null} />

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
                      {formatDate(emailListDate(email))}
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
                  {cleanPreview(email.preview) && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {cleanPreview(email.preview)}
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
      <ConfirmDialog {...dialogProps} />
      {selectedEmailId ? (
        <ProEmailView
          key={selectedEmailId}
          emailId={selectedEmailId}
          client={client}
          clientAccountId={clientLogin}
          accountId={jmapAccountId}
          onClose={handleViewerClose}
          onArchiveEmail={archiveInboxTarget(folderMailboxes, mailbox?.id) ? undefined : handleArchiveEmail}
          className="min-w-0 flex-1"
        />
      ) : (
        <EmailViewer email={null} isLoading={false} className="min-w-0 flex-1" />
      )}
    </div>
  );
}
