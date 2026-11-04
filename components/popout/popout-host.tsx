"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { isAppLockedNow } from "@/lib/app-lock/state";
import { usePopoutsAvailable } from "@/hooks/use-popouts-available";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { newPopoutId, openPopoutChannel, type PopoutChannel, type PopoutMessage, type PopoutSentNotice, type RescuedDraft, type SharedAccountSession } from "@/lib/popout/channel";
import { takeOverMoved } from "@/lib/popout/moved-undo";
import { keepRescuedDraft } from "@/lib/popout/rescued-drafts";
import { commitReturnedComposer, dropReturnedComposer, offerReturnedComposer } from "@/lib/popout/return-to-main";
import { credentialFingerprint, sealFor } from "@/lib/popout/sealed";
import { changesAnyType, subscribePushStateChanges } from "@/lib/push-events";

/** At most this often: a pop-out's autosave reports every few seconds. */
const REFRESH_THROTTLE_MS = 1500;
/** What the list changing in this window waits for, so a burst tells pop-outs once. */
const LIST_CHANGE_DEBOUNCE_MS = 400;
/** How long the claim on a one-off job stays held: longer than a message takes to reach every window. */
const CLAIM_HOLD_MS = 15_000;
/** How long a window remembers which draft id a rescue became, for a reload of the pop-out. */
const RESCUE_MEMORY_MS = 60_000;

/** The sessions this window can lend. Empty until it is signed in, and in the demo. */
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
 * Runs `work` in one of the main windows, the first to claim `name`. Held on
 * for a while afterwards, or a slower window would find it free. A browser
 * releases it with the window, so no window keeps a lock for long (one held for
 * life keeps a page out of the back/forward cache).
 */
function claimOnce(name: string, work: () => void | Promise<void>): void {
  void navigator.locks?.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    await work();
    await new Promise((resolve) => setTimeout(resolve, CLAIM_HOLD_MS));
  }).catch(() => {});
}

/**
 * The main window's side of pop-outs: lends them its session and renews it
 * for them, passes on that mail changed, and takes over what a pop-out can't
 * say any more once it has closed. Only where pop-outs are on offer: an
 * ordinary browser tab runs none of this.
 */
export function PopoutHost() {
  const available = usePopoutsAvailable();
  const t = useTranslations();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    if (!available) return;
    let channel: PopoutChannel | null = null;
    const windowId = newPopoutId();
    let closing = false;
    const rescues = new Map<string, Promise<string | null>>();

    const answerSessionRequest = async (message: Extract<PopoutMessage, { type: "session-request" }>) => {
      const { accountId, rejectedFingerprint } = message;
      // Locked: nobody gets a credential, whatever they ask.
      if (isAppLockedNow()) return;
      const auth = useAuthStore.getState();
      // Only a window holding the login answers: the first answer has to be usable.
      if (accountId && !shareableSessions().some((session) => session.accountId === accountId)) return;
      // The server refused what the pop-out holds. If that is what this window
      // holds too, renew it here, where the timers and the sign-out live.
      if (accountId && rejectedFingerprint) {
        const current = auth.getClientForAccount(accountId)?.getAuthHeader();
        if (current && await credentialFingerprint(current) === rejectedFingerprint) await auth.refreshAccessToken({ accountId });
      }
      const sessions = shareableSessions();
      if (sessions.length === 0 || isAppLockedNow()) return;
      const sealed = await sealFor(message.publicKey, { activeAccountId: useAuthStore.getState().activeAccountId, sessions });
      channel?.post({ type: "session-answer", requestId: message.requestId, sealed });
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

    const saveRescuedDraft = async (draft: RescuedDraft): Promise<string | null> => {
      const auth = useAuthStore.getState();
      const client = draft.localAccountId ? auth.getClientForAccount(draft.localAccountId) : auth.client;
      try {
        if (!client) throw new Error("No login to save through");
        const draftId = await client.createDraft(
          draft.to, draft.subject, draft.body, draft.cc, draft.bcc, draft.identityId, draft.fromEmail, draft.draftId,
          draft.attachments, draft.fromName, draft.htmlBody, draft.inReplyTo, draft.references, draft.options,
        );
        refreshList();
        return draftId;
      } catch (error) {
        // The text exists nowhere else now.
        console.error("Failed to save a closing window's draft:", error);
        keepRescuedDraft(draft.state);
        toast.error(tRef.current("email_composer.save_failed"));
        return null;
      }
    };

    const startRescue = (draft: RescuedDraft) => {
      const claim = draft.rescueKey ?? newPopoutId();
      claimOnce(`bulwark-popout-rescue:${claim}`, async () => {
        const saved = saveRescuedDraft(draft);
        if (draft.rescueKey) {
          rescues.set(draft.rescueKey, saved);
          setTimeout(() => rescues.delete(claim), RESCUE_MEMORY_MS);
        }
        await saved;
      });
    };

    channel = openPopoutChannel((message) => {
      switch (message.type) {
        case "session-request":
          void answerSessionRequest(message);
          break;
        case "sent":
          claimOnce(`bulwark-popout-sent:${message.requestId}`, () => {
            channel?.post({ type: "sent-ack", requestId: message.requestId });
            takeOverSent(message.notice);
          });
          break;
        case "moved":
          // Undo for what a message window archived, deleted or moved: it has closed.
          claimOnce(`bulwark-popout-moved:${message.requestId}`, () => {
            channel?.post({ type: "moved-ack", requestId: message.requestId });
            takeOverMoved(message.notice, (key, values) => tRef.current(`notifications.${key}`, values));
            refreshList();
          });
          break;
        case "draft-rescue":
          startRescue(message.draft);
          break;
        case "rescue-query": {
          const rescue = rescues.get(message.rescueKey);
          if (rescue) void rescue.then((draftId) => channel?.post({ type: "rescue-answer", rescueKey: message.rescueKey, draftId }));
          break;
        }
        case "composer-return": {
          const { returnId, accountId, payload } = message;
          if (closing || isAppLockedNow()) break;
          if (accountId && !shareableSessions().some((session) => session.accountId === accountId)) break;
          // Several main windows: one takes it, and only that one answers.
          claimOnce(`bulwark-popout-return:${returnId}`, () => {
            offerReturnedComposer({
              returnId,
              payload,
              answer: (status) => channel?.post({ type: "composer-return-answer", returnId, status }),
              sendReady: () => channel?.post({ type: "composer-return-ready", returnId }),
            });
          });
          break;
        }
        case "composer-return-commit":
          commitReturnedComposer(message.returnId);
          break;
        case "composer-return-cancel":
          dropReturnedComposer(message.returnId);
          break;
        case "main-ping":
          if (!closing) channel?.post({ type: "main-pong", windowId, accountIds: shareableSessions().map((session) => session.accountId) });
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
    // Hearing a ping late in closing, this window must not answer: a draft
    // handed to it now would be lost.
    const onPageHide = () => {
      closing = true;
      channel?.post({ type: "main-gone", windowId });
    };
    const onPageShow = () => {
      closing = false;
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      stopPush();
      stopList();
      stopAccounts();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (listTimer) clearTimeout(listTimer);
      channel?.close();
    };
  }, [available]);

  return null;
}
