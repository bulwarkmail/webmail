"use client";

import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { EmailViewer } from "@/components/email/email-viewer";
import { ErrorBoundary, EmailViewerErrorFallback } from "@/components/error";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { useProTabStore, type ProEmailTabData, type ProReplyContext } from "@/stores/pro-tab-store";
import type { Email } from "@/lib/jmap/types";
import { buildReplySubject, buildForwardSubject } from "@/lib/subject-prefix";

interface ProEmailTabBodyProps {
  tabId: string;
  data: ProEmailTabData;
}

function buildReplyContext(email: Email): ProReplyContext {
  const textPartId = email.textBody?.[0]?.partId ?? '';
  const htmlPartId = email.htmlBody?.[0]?.partId ?? '';
  return {
    from: email.from,
    replyToAddresses: email.replyTo,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    body: email.bodyValues?.[textPartId]?.value || email.preview || '',
    htmlBody: email.bodyValues?.[htmlPartId]?.value || undefined,
    receivedAt: email.receivedAt,
    accountId: email.accountId,
    attachments: email.attachments,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
  };
}

/**
 * Renders a single email in its own Pro tab. Fetches the email content on
 * mount via `email-store.fetchEmailContent` so the tab is self-sufficient -
 * it doesn't depend on what the Mail tab has selected.
 */
export function ProEmailTabBody({ tabId, data }: ProEmailTabBodyProps) {
  const t = useTranslations();
  const tNotifications = useTranslations('notifications');

  const client = useAuthStore((s) => s.client);
  const fetchEmailContent = useEmailStore((s) => s.fetchEmailContent);
  const deleteEmail = useEmailStore((s) => s.deleteEmail);
  const markAsRead = useEmailStore((s) => s.markAsRead);
  const toggleStar = useEmailStore((s) => s.toggleStar);
  const moveToMailbox = useEmailStore((s) => s.moveToMailbox);
  const setEmailKeywordsLocal = useEmailStore((s) => s.setEmailKeywordsLocal);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const settingsKeywords = useSettingsStore((s) => s.emailKeywords);
  const identities = useIdentityStore((s) => s.identities);

  const closeTab = useProTabStore((s) => s.closeTab);
  const openComposeTab = useProTabStore((s) => s.openComposeTab);
  const updateTabTitle = useProTabStore((s) => s.updateTabTitle);

  const [email, setEmail] = useState<Email | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const composerSessionIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    if (!client) return;
    setIsLoading(true);
    fetchEmailContent(client, data.emailId)
      .then((loaded) => {
        if (cancelled) return;
        setEmail(loaded);
        if (loaded?.subject) {
          updateTabTitle(tabId, loaded.subject);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch email for Pro tab:', err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, data.emailId, fetchEmailContent, tabId, updateTabTitle]);

  const currentMailboxRole = useMemo(() => {
    if (!email) return undefined;
    const mb = email.mailboxIds
      ? Object.keys(email.mailboxIds).map((id) => mailboxes.find((m) => m.id === id)).find(Boolean)
      : undefined;
    return mb?.role;
  }, [email, mailboxes]);

  const handleReply = useCallback((draftText?: string) => {
    if (!email) return;
    composerSessionIdRef.current += 1;
    openComposeTab({
      sessionId: composerSessionIdRef.current,
      mode: 'reply',
      replyTo: buildReplyContext(email),
      sourceEmailId: email.id,
      initialDraftText: draftText,
      title: buildReplySubject(email.subject || t('email_composer.new_message'), t('email_composer.prefix.reply')),
    });
  }, [email, openComposeTab, t]);

  const handleReplyAll = useCallback(() => {
    if (!email) return;
    composerSessionIdRef.current += 1;
    openComposeTab({
      sessionId: composerSessionIdRef.current,
      mode: 'replyAll',
      replyTo: buildReplyContext(email),
      sourceEmailId: email.id,
      title: buildReplySubject(email.subject || t('email_composer.new_message'), t('email_composer.prefix.reply')),
    });
  }, [email, openComposeTab, t]);

  const handleForward = useCallback(() => {
    if (!email) return;
    composerSessionIdRef.current += 1;
    openComposeTab({
      sessionId: composerSessionIdRef.current,
      mode: 'forward',
      replyTo: buildReplyContext(email),
      sourceEmailId: email.id,
      title: buildForwardSubject(email.subject || t('email_composer.new_message'), t('email_composer.prefix.forward')),
    });
  }, [email, openComposeTab, t]);

  const handleDelete = useCallback(async () => {
    if (!client || !email) return;
    try {
      await deleteEmail(client, email.id);
      closeTab(tabId);
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error(tNotifications('error_deleting'));
    }
  }, [client, email, deleteEmail, closeTab, tabId, tNotifications]);

  const handleArchive = useCallback(async () => {
    if (!client || !email) return;
    const archiveMb = mailboxes.find((m) => m.role === 'archive');
    if (!archiveMb) return;
    try {
      await moveToMailbox(client, email.id, archiveMb.id);
      toast.success(tNotifications('email_archived'));
      closeTab(tabId);
    } catch (err) {
      console.error('Archive failed:', err);
    }
  }, [client, email, mailboxes, moveToMailbox, closeTab, tabId, tNotifications]);

  const handleToggleStar = useCallback(async () => {
    if (!client || !email) return;
    try {
      await toggleStar(client, email.id);
      // Reflect locally - the viewer re-reads from email-store's selectedEmail
      // shape only for the mail tab; here we update our local copy too.
      setEmail((prev) => prev ? {
        ...prev,
        keywords: {
          ...prev.keywords,
          $flagged: !prev.keywords?.$flagged,
        },
      } : prev);
    } catch (err) {
      console.error('Toggle star failed:', err);
    }
  }, [client, email, toggleStar]);

  const handleMarkAsRead = useCallback(async (emailId: string, read: boolean) => {
    if (!client) return;
    try {
      await markAsRead(client, emailId, read);
      setEmail((prev) => prev && prev.id === emailId ? {
        ...prev,
        keywords: { ...prev.keywords, $seen: read },
      } : prev);
    } catch (err) {
      console.error('Mark as read failed:', err);
    }
  }, [client, markAsRead]);

  const handleSetColorTag = useCallback((emailId: string, color: string | null) => {
    if (!email || email.id !== emailId) return;
    // Drop existing color keywords, optionally add the new one. Matches the
    // mail page's local optimistic update.
    const keywords = { ...(email.keywords ?? {}) };
    for (const kw of settingsKeywords) {
      delete keywords[`$label:${kw.id}`];
    }
    if (color) {
      const def = settingsKeywords.find((k) => k.color === color);
      if (def) keywords[`$label:${def.id}`] = true;
    }
    setEmailKeywordsLocal(emailId, keywords);
    setEmail({ ...email, keywords });
  }, [email, settingsKeywords, setEmailKeywordsLocal]);

  const handleMoveToMailbox = useCallback(async (mailboxId: string) => {
    if (!client || !email) return;
    try {
      await moveToMailbox(client, email.id, mailboxId);
      closeTab(tabId);
    } catch (err) {
      console.error('Move failed:', err);
    }
  }, [client, email, moveToMailbox, closeTab, tabId]);

  const handleDownloadAttachment = useCallback(async (blobId: string, name: string, type?: string) => {
    if (!client) return;
    try {
      await client.downloadBlob(blobId, name, type);
    } catch (err) {
      console.error('Download failed:', err);
    }
  }, [client]);

  const handleQuickReply = useCallback(async (body: string) => {
    handleReply(body);
  }, [handleReply]);

  const handleEditDraft = useCallback(() => {
    if (!email) return;

    const bodyText = email.bodyValues
      ? Object.values(email.bodyValues).map((v) => v.value).join('\n')
      : '';
    const htmlBody = email.htmlBody?.[0]?.partId && email.bodyValues?.[email.htmlBody[0].partId]
      ? email.bodyValues[email.htmlBody[0].partId].value
      : undefined;

    // Preserve the identity that matches the draft's From address.
    const draftFromEmail = email.from?.[0]?.email;
    const matchedIdentity = draftFromEmail
      ? identities.find((id) => id.email === draftFromEmail)
      : null;

    composerSessionIdRef.current += 1;
    openComposeTab({
      sessionId: composerSessionIdRef.current,
      mode: 'compose',
      title: email.subject || t('email_composer.new_message'),
      initialData: {
        to: email.to?.map((a) => a.email).filter(Boolean).join(', ') || '',
        cc: email.cc?.map((a) => a.email).filter(Boolean).join(', ') || '',
        bcc: email.bcc?.map((a) => a.email).filter(Boolean).join(', ') || '',
        subject: email.subject || '',
        body: htmlBody || bodyText,
        showCc: (email.cc?.length || 0) > 0,
        showBcc: (email.bcc?.length || 0) > 0,
        selectedIdentityId: matchedIdentity?.id ?? null,
        subAddressTag: '',
        mode: 'compose',
        draftId: email.id,
      },
    });
    closeTab(tabId);
  }, [email, identities, openComposeTab, closeTab, tabId, t]);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <ErrorBoundary fallback={EmailViewerErrorFallback}>
        <EmailViewer
          email={email}
          isLoading={isLoading}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onDelete={handleDelete}
          onArchive={handleArchive}
          onToggleStar={handleToggleStar}
          onMarkAsRead={handleMarkAsRead}
          onSetColorTag={handleSetColorTag}
          onDownloadAttachment={handleDownloadAttachment}
          onQuickReply={handleQuickReply}
          onEditDraft={handleEditDraft}
          onMoveToMailbox={handleMoveToMailbox}
          currentUserEmail={client?.getUsername()}
          currentUserName={client?.getUsername()?.split('@')[0]}
          currentMailboxRole={currentMailboxRole}
          mailboxes={mailboxes}
          className="flex-1"
        />
      </ErrorBoundary>
    </div>
  );
}
