"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { openPopoutChannel, type PopoutChannel, type PopoutSentNotice, type RescuedDraft, type SharedAccountSession } from "@/lib/popout/channel";
import { changesAnyType, subscribePushStateChanges } from "@/lib/push-events";

/** At most this often: a pop-out's autosave reports every few seconds. */
const REFRESH_THROTTLE_MS = 1500;
/** What the list changing in this window waits for, so a burst tells pop-outs once. */
const LIST_CHANGE_DEBOUNCE_MS = 400;

/** Held by one main window at a time, for what must happen once: a draft saved twice is two drafts. */
export const POPOUT_LEADER_LOCK = "bulwark-popout-leader";

/** The sessions this window can lend to a pop-out. Empty until it is signed in, and in the demo. */
function shareableSessions(): SharedAccountSession[] {
  const auth = useAuthStore.getState();
  if (!auth.isAuthenticated || auth.isDemoMode) return [];
  const sessions: SharedAccountSession[] = [];
  for (const [accountId, client] of auth.getAllConnectedClients()) {
    const account = useAccountStore.getState().getAccountById(accountId);
    if (!account) continue;
    sessions.push({
      accountId,
      serverUrl: account.serverUrl,
      username: account.username,
      authMode: account.authMode,
      authHeader: client.getAuthHeader(),
      ...(client.isOfflineOnly() ? { offlineOnly: true } : {}),
    });
  }
  return sessions;
}

/**
 * The main window's side of pop-outs: lends them its session and renews it
 * for them, passes on that mail changed, and takes over what a pop-out can't
 * say any more once it has closed. Every main window runs one; a pop-out takes
 * the first answer.
 */
export function PopoutHost() {
  const t = useTranslations();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let channel: PopoutChannel | null = null;
    let closing = false;

    // The browser gives the lock to the next window when this one goes away.
    let leader = false;
    const stopLeading = new AbortController();
    void navigator.locks?.request(POPOUT_LEADER_LOCK, { signal: stopLeading.signal }, () => {
      leader = true;
      return new Promise<void>((resolve) => stopLeading.signal.addEventListener("abort", () => resolve()));
    }).catch(() => {});

    const answerSessionRequest = async (requestId: string, accountId?: string, rejectedAuthHeader?: string) => {
      const auth = useAuthStore.getState();
      // The server refused what the pop-out holds. If that is what this window
      // holds too, renew it here, where the timers and the sign-out live.
      if (accountId && rejectedAuthHeader && auth.getClientForAccount(accountId)?.getAuthHeader() === rejectedAuthHeader) {
        await auth.refreshAccessToken({ accountId });
      }
      const sessions = shareableSessions().filter((session) => !accountId || session.accountId === accountId);
      if (sessions.length === 0) return;
      channel?.post({
        type: "session-answer",
        requestId,
        answer: { activeAccountId: useAuthStore.getState().activeAccountId, sessions },
      });
    };

    // List and counts, so read state and Drafts follow what a pop-out did.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshList = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        const client = useAuthStore.getState().client;
        if (!client) return;
        const emails = useEmailStore.getState();
        void emails.refreshCurrentMailbox(client);
        void emails.fetchMailboxes(client);
      }, REFRESH_THROTTLE_MS);
    };

    const takeOverSent = (notice: PopoutSentNotice) => {
      const translate = tRef.current;
      if (notice.filingError) toast.warning(translate("email_composer.send_filing_warning"));
      if (notice.rejectedRecipients) {
        toast.warning(translate("email_composer.send_some_recipients_rejected"), { message: notice.rejectedRecipients, duration: 15000 });
      }
      // Undo lives here now: the window that sent it is closing.
      if (notice.pendingUndoSend) useEmailStore.setState({ pendingUndoSend: notice.pendingUndoSend });
      else if (!notice.queued && !notice.scheduled && !notice.filingError && !notice.rejectedRecipients) toast.success(translate("notifications.email_sent"));
      refreshList();
    };

    const saveRescuedDraft = async (draft: RescuedDraft) => {
      const auth = useAuthStore.getState();
      const client = draft.localAccountId ? auth.getClientForAccount(draft.localAccountId) : auth.client;
      try {
        if (!client) throw new Error("No login to save through");
        await client.createDraft(
          draft.to, draft.subject, draft.body, draft.cc, draft.bcc, draft.identityId, draft.fromEmail, draft.draftId,
          draft.attachments, draft.fromName, draft.htmlBody, draft.inReplyTo, draft.references, draft.options,
        );
        refreshList();
      } catch (error) {
        console.error("Failed to save a closing window's draft:", error);
        toast.error(tRef.current("email_composer.save_failed"));
      }
    };

    channel = openPopoutChannel((message) => {
      switch (message.type) {
        case "session-request":
          void answerSessionRequest(message.requestId, message.accountId, message.rejectedAuthHeader);
          break;
        case "sent":
          if (!leader) break;
          channel?.post({ type: "sent-ack", requestId: message.requestId });
          takeOverSent(message.notice);
          break;
        case "draft-rescue":
          if (leader) void saveRescuedDraft(message.draft);
          break;
        case "main-ping":
          if (leader && !closing) channel?.post({ type: "main-pong" });
          break;
        case "mail-changed":
          refreshList();
          break;
      }
    });
    if (!channel) return;

    const stopPush = subscribePushStateChanges((change) => {
      if (changesAnyType(change, ["Email", "Mailbox"])) channel?.post({ type: "state-change" });
    });
    // This window's own changes reach no push stream on the way to a pop-out.
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    const stopList = useEmailStore.subscribe((state, prev) => {
      if (state.emails === prev.emails && state.selectedEmail === prev.selectedEmail) return;
      if (listTimer) clearTimeout(listTimer);
      listTimer = setTimeout(() => channel?.post({ type: "state-change" }), LIST_CHANGE_DEBOUNCE_MS);
    });
    const stopAccounts = useAccountStore.subscribe((state, prev) => {
      if (state.accounts === prev.accounts) return;
      const ids = new Set(state.accounts.map((account) => account.id));
      for (const account of prev.accounts) {
        if (!ids.has(account.id)) channel?.post({ type: "account-removed", accountId: account.id });
      }
    });
    // Hearing "gone", a pop-out asks who else is there. This window may still
    // run long enough to hear that, and must not answer: a draft handed to it
    // now would be lost.
    const onPageHide = () => {
      closing = true;
      if (leader) channel?.post({ type: "main-gone" });
    };
    const onPageShow = () => {
      closing = false;
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      stopLeading.abort();
      stopPush();
      stopList();
      stopAccounts();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (listTimer) clearTimeout(listTimer);
      channel?.close();
    };
  }, []);

  return null;
}
