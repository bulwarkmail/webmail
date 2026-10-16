"use client";

import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { EmailViewer } from "@/components/email/email-viewer";
import { ErrorBoundary, EmailViewerErrorFallback } from "@/components/error";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useIdentityStore } from "@/stores/identity-store";
import { useProMultiAccountIdentities } from "@/hooks/use-pro-multi-account-identities";
import { findDraftIdentityId } from "@/lib/reply-identity";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import { useProTabStore, type ProComposeTabData, type ProEmailTabData, type ProReplyContext } from "@/stores/pro-tab-store";
import { emailHooks } from "@/lib/plugin-hooks";
import { composeOptionsFor, runBeforeCompose, type ComposePrefill } from "@/lib/plugin-compose-gate";
import type { Email } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { buildReplySubject, buildForwardSubject } from "@/lib/subject-prefix";
import { getQuoteBodies } from "@/lib/email-composer-utils";
import { buildForwardAsAttachmentPayload } from "@/lib/forward-as-attachment";
import { KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY } from "@/lib/thread-utils";
import { cn } from "@/lib/utils";
import { getDraftTextBody } from '@/lib/email-body-selection';
import { useArchiveActionEnabled } from '@/lib/archive-gate';

interface ProEmailTabBodyProps {
  tabId: string;
  data: ProEmailTabData;
}

interface ProEmailViewProps {
  emailId: string;
  /**
   * JMAP client to fetch/mutate through; defaults to the active account's.
   * Folder tabs of another connected account pass that account's client.
   */
  client?: IJMAPClient | null;
  /**
   * Owner JMAP accountId for messages in shared/group folders. When set, the
   * message is fetched via `getEmail(emailId, accountId)` directly -
   * `fetchEmailContent`'s fallback derives the owner from the *globally*
   * selected mailbox, which is unrelated to a folder tab's mailbox.
   */
  accountId?: string;
  /** Fires once the full message is loaded (tab retitling, sidebar highlight). */
  onLoaded?: (email: Email) => void;
  /**
   * The message left this view: deleted, archived, moved, or reopened in the
   * composer. The host decides what that means (close the tab / clear the
   * folder tab's selection).
   */
  onClose: () => void;
  className?: string;
}

function buildReplyContext(email: Email): ProReplyContext {
  return {
    from: email.from,
    replyToAddresses: email.replyTo,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    ...getQuoteBodies(email),
    receivedAt: email.receivedAt,
    accountId: email.accountId,
    attachments: email.attachments,
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
  };
}

/**
 * Self-sufficient single-message view for Pro surfaces. Fetches the email on
 * mount via `email-store.fetchEmailContent`, so it doesn't depend on what the
 * Mail tab has selected; compose actions open Pro compose tabs directly.
 * Hosted by `ProEmailTabBody` (a dedicated email tab) and by the folder tab's
 * reading pane.
 */
export function ProEmailView({ emailId, client: clientOverride, accountId, onLoaded, onClose, className }: ProEmailViewProps) {
  const t = useTranslations();
  const tNotifications = useTranslations('notifications');
  const archiveActionEnabled = useArchiveActionEnabled();

  const activeClient = useAuthStore((s) => s.client);
  const client = clientOverride ?? activeClient;
  const fetchEmailContent = useEmailStore((s) => s.fetchEmailContent);
  const deleteEmail = useEmailStore((s) => s.deleteEmail);
  const markAsRead = useEmailStore((s) => s.markAsRead);
  const toggleStar = useEmailStore((s) => s.toggleStar);
  const moveToMailbox = useEmailStore((s) => s.moveToMailbox);
  const setEmailKeywordsLocal = useEmailStore((s) => s.setEmailKeywordsLocal);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const identities = useIdentityStore((s) => s.identities);
  const multiAccountIdentities = useProMultiAccountIdentities();

  const openComposeTabNow = useProTabStore((s) => s.openComposeTab);

  const [email, setEmail] = useState<Email | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const composerSessionIdRef = useRef(0);

  // Every compose tab opened from here asks onBeforeCompose first: a plugin
  // may stop it or prefill it. Opens straight away when nobody listens.
  const openComposeTab = useCallback((
    data: Omit<ProComposeTabData, 'sessionId'>,
    fields: Omit<NonNullable<Parameters<typeof composeOptionsFor>[1]>, 'ownEmails' | 'replyPrefix' | 'forwardPrefix'>,
    onOpened?: () => void,
  ) => {
    const open = (prefill: ComposePrefill | null) => {
      composerSessionIdRef.current += 1;
      openComposeTabNow({ ...data, sessionId: composerSessionIdRef.current, prefill });
      onOpened?.();
    };
    if (emailHooks.onBeforeCompose.size === 0) {
      open(null);
      return;
    }
    void runBeforeCompose(composeOptionsFor(data.mode, {
      ...fields,
      ownEmails: identities.map((i) => i.email).filter((e): e is string => Boolean(e)),
      replyPrefix: t('email_composer.prefix.reply'),
      forwardPrefix: t('email_composer.prefix.forward'),
    })).then((prefill) => {
      if (prefill) open(Object.keys(prefill).length > 0 ? prefill : null);
    });
  }, [identities, openComposeTabNow, t]);

  // Held in a ref so a host passing an inline callback doesn't refetch the
  // message on every render.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    let cancelled = false;
    if (!client) return;
    setIsLoading(true);
    (accountId ? client.getEmail(emailId, accountId) : fetchEmailContent(client, emailId))
      .then((loaded) => {
        if (cancelled) return;
        setEmail(loaded);
        if (loaded) onLoadedRef.current?.(loaded);
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
  }, [client, emailId, accountId, fetchEmailContent]);

  const currentMailboxRole = useMemo(() => {
    if (!email) return undefined;
    const mb = email.mailboxIds
      ? Object.keys(email.mailboxIds).map((id) => mailboxes.find((m) => m.id === id)).find(Boolean)
      : undefined;
    return mb?.role;
  }, [email, mailboxes]);

  const handleReply = useCallback((draftText?: string) => {
    if (!email) return;
    openComposeTab({
      mode: 'reply',
      replyTo: buildReplyContext(email),
      sourceEmailId: email.id,
      initialDraftText: draftText,
      title: buildReplySubject(email.subject || t('email_composer.new_message'), t('email_composer.prefix.reply')),
    }, { source: email, body: draftText ?? '' });
  }, [email, openComposeTab, t]);

  const handleReplyAll = useCallback(() => {
    if (!email) return;
    openComposeTab({
      mode: 'replyAll',
      replyTo: buildReplyContext(email),
      sourceEmailId: email.id,
      title: buildReplySubject(email.subject || t('email_composer.new_message'), t('email_composer.prefix.reply')),
    }, { source: email });
  }, [email, openComposeTab, t]);

  const handleForward = useCallback(() => {
    if (!email) return;
    openComposeTab({
      mode: 'forward',
      replyTo: buildReplyContext(email),
      sourceEmailId: email.id,
      title: buildForwardSubject(email.subject || t('email_composer.new_message'), t('email_composer.prefix.forward')),
    }, { source: email });
  }, [email, openComposeTab, t]);

  // Mirrors handleForward, but attaches the original as a message/rfc822
  // file instead of quoting it inline - see lib/forward-as-attachment.ts.
  // This is a separate, self-contained render path from the main Mail
  // tab's EmailViewer (page.tsx) - Pro tabs fetch their own `email` and
  // open compose tabs directly via useProTabStore, not through
  // page.tsx's pendingDraft/selectedEmail plumbing - so it needed its own
  // wiring rather than falling out of the page.tsx fix automatically.
  const handleForwardAsAttachment = useCallback(() => {
    if (!email) return;
    const {
      emailDownloadTemplate,
      filenameSpaceReplacement,
      filenameLowercase,
      filenameStripDiacritics,
      filenameCollapseSeparators,
    } = useSettingsStore.getState();
    const payload = buildForwardAsAttachmentPayload(email, t('email_composer.prefix.forward'), {
      template: emailDownloadTemplate,
      spaceReplacement: filenameSpaceReplacement,
      lowercase: filenameLowercase,
      stripDiacritics: filenameStripDiacritics,
      collapseSeparators: filenameCollapseSeparators,
    });
    if (!payload) return;

    openComposeTab({
      mode: 'forward',
      replyTo: {
        subject: email.subject,
        attachments: [payload.attachment],
      },
      sourceEmailId: email.id,
      // payload.subject is intentionally blank for a subject-less email (to
      // match normal Forward's *composer* subject behavior - see
      // buildForwardAsAttachmentPayload). The Pro tab *title* is a separate
      // UI label that still needs a sensible fallback, same as handleForward
      // above uses - reusing payload.subject here would give the tab an
      // empty title instead of e.g. "Fwd: New message".
      title: buildForwardSubject(email.subject || t('email_composer.new_message'), t('email_composer.prefix.forward')),
    }, { subject: payload.subject });
  }, [email, openComposeTab, t]);

  const handleDelete = useCallback(async () => {
    if (!client || !email) return;
    try {
      // false: not deleted (a plugin stopped it), so the tab stays open.
      if (await deleteEmail(client, email.id)) onClose();
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error(tNotifications('error_deleting'));
    }
  }, [client, email, deleteEmail, onClose, tNotifications]);

  const handleArchive = useCallback(async () => {
    if (!client || !email) return;
    const archiveMb = mailboxes.find((m) => m.role === 'archive');
    if (!archiveMb) return;
    try {
      if (!(await moveToMailbox(client, email.id, archiveMb.id))) return;
      toast.success(tNotifications('email_archived'));
      onClose();
    } catch (err) {
      console.error('Archive failed:', err);
    }
  }, [client, email, mailboxes, moveToMailbox, onClose, tNotifications]);

  const handleToggleStar = useCallback(async () => {
    if (!client || !email) return;
    try {
      if (!(await toggleStar(client, email.id))) return;
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

  const handleMarkAsRead = useCallback(async (emailIdToMark: string, read: boolean) => {
    if (!client) return;
    try {
      if (!(await markAsRead(client, emailIdToMark, read))) return;
      setEmail((prev) => prev && prev.id === emailIdToMark ? {
        ...prev,
        keywords: { ...prev.keywords, $seen: read },
      } : prev);
    } catch (err) {
      console.error('Mark as read failed:', err);
    }
  }, [client, markAsRead]);

  const handleSetTag = useCallback((emailIdToTag: string, tagId: string | null) => {
    if (!email || email.id !== emailIdToTag) return;
    // Toggle one tag, or clear them all. Matches the mail page's local
    // optimistic update, down to reaching tags this client cannot name.
    const keywords = { ...(email.keywords ?? {}) };
    if (tagId === null) {
      for (const key of Object.keys(keywords)) {
        if (key.startsWith(KEYWORD_PREFIX) || key.startsWith(KEYWORD_PREFIX_LEGACY)) {
          keywords[key] = false;
        }
      }
    } else {
      const activeKeys = [KEYWORD_PREFIX + tagId, KEYWORD_PREFIX_LEGACY + tagId]
        .filter(key => keywords[key]);
      if (activeKeys.length > 0) {
        for (const key of activeKeys) {
          keywords[key] = false;
        }
      } else {
        keywords[KEYWORD_PREFIX + tagId] = true;
      }
    }
    setEmailKeywordsLocal(emailIdToTag, keywords);
    setEmail({ ...email, keywords });
  }, [email, setEmailKeywordsLocal]);

  const handleMoveToMailbox = useCallback(async (mailboxId: string) => {
    if (!client || !email) return;
    try {
      if (await moveToMailbox(client, email.id, mailboxId)) onClose();
    } catch (err) {
      console.error('Move failed:', err);
    }
  }, [client, email, moveToMailbox, onClose]);

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

    // Only the parts the server lists as the body: bodyValues also carries
    // every text/* ATTACHMENT, which used to be joined in as the message.
    const bodyText = getDraftTextBody(email);
    // A plain-text-only draft lists its text/plain part under htmlBody
    // (RFC 8621 § 4.1.4 fallback) - only treat it as HTML when it really is.
    const draftHtmlPart = email.htmlBody?.[0];
    const htmlBody = draftHtmlPart?.partId
      && (!draftHtmlPart.type || draftHtmlPart.type.toLowerCase() === 'text/html')
      && email.bodyValues?.[draftHtmlPart.partId]
      ? email.bodyValues[draftHtmlPart.partId].value
      : undefined;

    // Preserve the identity the draft was composed with — match name + address
    // against the same list the composer renders (see findDraftIdentityId).
    const composerIdentities = multiAccountIdentities.enabled
      ? multiAccountIdentities.allIdentities
      : identities;
    const matchedIdentityId = findDraftIdentityId(composerIdentities, email.from?.[0]);

    const draftSubject = email.subject && email.subject !== t('email_composer.no_subject') ? email.subject : '';
    const addresses = (list: Email['to']) => (list ?? []).map((a) => a.email).filter(Boolean);
    openComposeTab({
      mode: 'compose',
      title: email.subject || t('email_composer.new_message'),
      initialData: {
        to: email.to?.map((a) => a.email).filter(Boolean).join(', ') || '',
        cc: email.cc?.map((a) => a.email).filter(Boolean).join(', ') || '',
        bcc: email.bcc?.map((a) => a.email).filter(Boolean).join(', ') || '',
        // Drafts saved before #1189 stored an empty subject as the composer's
        // "(No Subject)" placeholder; reopen those with an empty field.
        subject: email.subject && email.subject !== t('email_composer.no_subject') ? email.subject : '',
        body: htmlBody || bodyText,
        showCc: (email.cc?.length || 0) > 0,
        showBcc: (email.bcc?.length || 0) > 0,
        selectedIdentityId: matchedIdentityId,
        subAddressTag: '',
        mode: 'compose',
        draftId: email.id,
        // The draft's already-uploaded parts - the classic path carries them
        // since #849; without this the Pro draft tab still opened the
        // composer without its files and the next save stripped them.
        attachments: email.attachments,
      },
    }, { to: addresses(email.to), cc: addresses(email.cc), subject: draftSubject, body: bodyText }, onClose);
  }, [email, identities, multiAccountIdentities, openComposeTab, onClose, t]);

  return (
    <div className={cn("flex h-full flex-col bg-background", className)}>
      <ErrorBoundary fallback={EmailViewerErrorFallback}>
        <EmailViewer
          email={email}
          isLoading={isLoading}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onForwardAsAttachment={handleForwardAsAttachment}
          onDelete={handleDelete}
          onArchive={archiveActionEnabled ? handleArchive : undefined}
          onToggleStar={handleToggleStar}
          onMarkAsRead={handleMarkAsRead}
          onSetTag={handleSetTag}
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

/**
 * Renders a single email in its own Pro tab: a fullscreen mail view - just
 * the message, no folder sidebar and no list pane.
 */
export function ProEmailTabBody({ tabId, data }: ProEmailTabBodyProps) {
  const closeTab = useProTabStore((s) => s.closeTab);
  const updateTabTitle = useProTabStore((s) => s.updateTabTitle);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const getClientForAccount = useAuthStore((s) => s.getClientForAccount);

  const handleLoaded = useCallback((email: Email) => {
    if (email.subject) updateTabTitle(tabId, email.subject);
  }, [tabId, updateTabTitle]);

  const handleClose = useCallback(() => closeTab(tabId), [closeTab, tabId]);

  // Messages opened out of a shared/group folder must be fetched with the
  // owner's accountId - fetchEmailContent's fallback derives it from the
  // globally selected mailbox, which is unrelated to this tab.
  const ownerAccountId = useMemo(() => {
    if (!data.mailboxId) return undefined;
    const mb = mailboxes.find((m) => m.id === data.mailboxId);
    return mb?.isShared ? mb.accountId : undefined;
  }, [mailboxes, data.mailboxId]);

  // A hit opened from another login (global search) is fetched through that
  // login's client, targeting the owner accountId stamped on the hit (#847).
  const clientOverride = data.clientAccountId ? getClientForAccount(data.clientAccountId) ?? null : null;

  return (
    <ProEmailView
      emailId={data.emailId}
      client={clientOverride ?? undefined}
      accountId={clientOverride ? data.accountId : ownerAccountId}
      onLoaded={handleLoaded}
      onClose={handleClose}
      className="w-full"
    />
  );
}
