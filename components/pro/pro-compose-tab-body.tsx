"use client";

import { useCallback, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { EmailComposer, type ComposerDraftData } from "@/components/email/email-composer";
import { ErrorBoundary, ComposerErrorFallback } from "@/components/error";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { useProTabStore, type ProComposeTabData } from "@/stores/pro-tab-store";
import { debug } from "@/lib/debug";

interface ProComposeTabBodyProps {
  tabId: string;
  data: ProComposeTabData;
}

/**
 * Renders a standalone `<EmailComposer />` inside its own Pro tab. Sending,
 * draft autosave, and discard all flow through the shared `email-store`, so
 * the result is identical to composing inline in the mail page - the
 * composer is just hosted in its own tab instead of in the right pane.
 */
export function ProComposeTabBody({ tabId, data }: ProComposeTabBodyProps) {
  const t = useTranslations();
  const client = useAuthStore((s) => s.client);
  const sendEmail = useEmailStore((s) => s.sendEmail);
  const fetchEmails = useEmailStore((s) => s.fetchEmails);
  const refreshCurrentMailbox = useEmailStore((s) => s.refreshCurrentMailbox);
  const fetchScheduledEmails = useEmailStore((s) => s.fetchScheduledEmails);
  const refreshScheduledMetadata = useEmailStore((s) => s.refreshScheduledMetadata);
  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const isScheduledView = useEmailStore((s) => s.isScheduledView);
  const closeTab = useProTabStore((s) => s.closeTab);
  const updateTabTitle = useProTabStore((s) => s.updateTabTitle);
  const updateComposeDraft = useProTabStore((s) => s.updateComposeDraft);

  // Keep stable references for the callbacks below so the composer's
  // `key={sessionId}` doesn't churn.
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const handleScheduledSendCreated = useCallback(async () => {
    if (client) {
      await refreshScheduledMetadata(client);
      if (isScheduledView) await fetchScheduledEmails(client);
    }
    closeTab(tabIdRef.current);
  }, [client, refreshScheduledMetadata, isScheduledView, fetchScheduledEmails, closeTab]);

  const handleSend = useCallback(async (sendData: Parameters<NonNullable<React.ComponentProps<typeof EmailComposer>['onSend']>>[0]) => {
    if (!client) return;
    try {
      const result = await sendEmail(
        client,
        sendData.to,
        sendData.subject,
        sendData.body,
        sendData.cc,
        sendData.bcc,
        sendData.identityId,
        sendData.fromEmail,
        sendData.draftId,
        sendData.fromName,
        sendData.htmlBody,
        sendData.attachments,
        sendData.inReplyTo,
        sendData.references,
        sendData.delayedUntil,
        sendData.envelopeMailFrom,
      );

      if (result.scheduled) {
        await handleScheduledSendCreated();
        return;
      }

      // Mark the original message as $answered / $forwarded so the standard
      // viewer and list reflect the action (same behaviour as inline compose).
      if (data.sourceEmailId && (data.mode === 'reply' || data.mode === 'replyAll')) {
        try {
          await client.setKeyword(data.sourceEmailId, '$answered');
        } catch (e) {
          debug.error('Failed to set $answered keyword:', e);
        }
      } else if (data.sourceEmailId && data.mode === 'forward') {
        try {
          await client.setKeyword(data.sourceEmailId, '$forwarded');
        } catch (e) {
          debug.error('Failed to set $forwarded keyword:', e);
        }
      }

      // Refresh the currently-active mail list so the new sent message /
      // updated keyword status shows up.
      await refreshCurrentMailbox(client);
      // Re-fetch the replied thread's cross-folder data so the expanded
      // view shows the newly sent reply without collapsing.
      if (data.sourceEmailId) {
        const emailState = useEmailStore.getState();
        const repliedEmail = emailState.emails.find(e => e.id === data.sourceEmailId);
        if (repliedEmail?.threadId && emailState.expandedThreadIds.has(repliedEmail.threadId)) {
          const accountId = client.getAccountId();
          const fullEmails = await client.getThreadEmails(repliedEmail.threadId, accountId);
          if (fullEmails.length > 0) {
            useEmailStore.setState((state) => {
              const c = new Map(state.threadEmailsCache);
              c.set(repliedEmail.threadId!, fullEmails);
              return { threadEmailsCache: c };
            });
          }
        }
      }
      closeTab(tabIdRef.current);
    } catch (error) {
      console.error('Failed to send email:', error);
      toast.error(t('notifications.error_sending'));
    }
  }, [client, sendEmail, fetchEmails, selectedMailbox, closeTab, data.sourceEmailId, data.mode, t, handleScheduledSendCreated]);

  const handleClose = useCallback(() => {
    closeTab(tabIdRef.current);
  }, [closeTab]);

  const handleDiscardDraft = useCallback(async (draftId: string) => {
    if (!client) return;
    try {
      await client.deleteEmail(draftId);
    } catch (error) {
      console.error('Failed to discard draft:', error);
    }
  }, [client]);

  const handleSaveState = useCallback((state: ComposerDraftData) => {
    updateComposeDraft(tabIdRef.current, state);
    // Keep the tab title in sync with the working subject.
    const subject = state.subject?.trim() || t('email_composer.new_message');
    updateTabTitle(tabIdRef.current, subject);
  }, [updateComposeDraft, updateTabTitle, t]);

  // On first mount, ensure the tab title matches whatever subject we were
  // initialised with (replies start with "Re: …", forwards with "Fwd: …").
  useEffect(() => {
    const initialSubject = data.initialData?.subject?.trim()
      ?? data.replyTo?.subject
      ?? '';
    const title = initialSubject || t('email_composer.new_message');
    updateTabTitle(tabIdRef.current, title);
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <ErrorBoundary fallback={ComposerErrorFallback}>
        <EmailComposer
          key={data.sessionId}
          mode={data.initialData?.mode ?? data.mode}
          replyTo={data.replyTo}
          initialDraftText={data.initialDraftText}
          initialData={data.initialData}
          onSend={handleSend}
          onScheduledSendCreated={handleScheduledSendCreated}
          onClose={handleClose}
          onDiscardDraft={handleDiscardDraft}
          onSaveState={handleSaveState}
          className="flex-1"
        />
      </ErrorBoundary>
    </div>
  );
}
