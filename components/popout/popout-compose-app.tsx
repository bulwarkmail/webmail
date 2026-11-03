"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { EmailComposer, type ComposerDraftData } from "@/components/email/email-composer";
import { ErrorBoundary, ComposerErrorFallback } from "@/components/error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { toast } from "@/stores/toast-store";
import { formatRejectedRecipients } from "@/lib/jmap/client";
import { debug } from "@/lib/debug";
import { composerSendOptions } from "@/lib/outgoing/composer-send-options";
import { announceSent } from "@/lib/plugin-after-send";
import { announceMailChanged, announceSentToMainWindow, watchMainWindow } from "@/lib/popout/channel";
import { receiveComposeHandoff, rememberComposePayload } from "@/lib/popout/compose-handoff";
import type { ComposePopoutPayload } from "@/lib/popout/compose-payload";
import { closePopoutWindow } from "@/lib/popout/window-role";
import { PopoutShell, PopoutSkeleton } from "./popout-shell";

/** A warning with no main window left to show it stays this long before the window goes. */
const WARNING_READ_MS = 8000;

type ComposerProps = React.ComponentProps<typeof EmailComposer>;
type SendData = Parameters<NonNullable<ComposerProps["onSend"]>>[0];

const EMPTY_PAYLOAD: ComposePopoutPayload = { mode: "compose" };

function readLaunch(): { handoffId: string | null; accountId?: string } {
  if (typeof window === "undefined") return { handoffId: null };
  const search = new URLSearchParams(window.location.search);
  return { handoffId: search.get("handoff"), accountId: search.get("account") ?? undefined };
}

/** The composer alone, in its own window: sending, autosave and discard go through the shared stores, as in a Pro tab. */
function PopoutComposer({ payload, handoffId }: { payload: ComposePopoutPayload; handoffId: string | null }) {
  const t = useTranslations();
  const client = useAuthStore((s) => s.client);
  const [sessionKey] = useState(() => `popout-${handoffId ?? Date.now().toString(36)}`);

  const mode = payload.initialData?.mode ?? payload.mode;
  useDocumentTitle(
    mode === "reply" ? t("email_composer.reply")
      : mode === "replyAll" ? t("email_composer.reply_all")
      : mode === "forward" ? t("email_composer.forward")
      : t("email_composer.new_message"),
  );

  const handleSend = useCallback(async (data: SendData) => {
    if (!client) return false;
    const sendClient = data.localAccountId
      ? (useAuthStore.getState().getClientForAccount(data.localAccountId) ?? client)
      : client;
    const emailStore = useEmailStore.getState();
    // A send that fails goes to the composer, which stays open with the text.
    const result = await emailStore.sendEmail(
      sendClient,
      data.to,
      data.subject,
      data.body,
      data.cc,
      data.bcc,
      data.identityId,
      data.fromEmail,
      data.draftId,
      data.fromName,
      data.htmlBody,
      data.attachments,
      data.inReplyTo,
      data.references,
      data.delayedUntil,
      data.envelopeMailFrom,
      composerSendOptions(data),
    );
    announceSent(result, data);

    if (payload.sourceEmailId && (mode === "reply" || mode === "replyAll" || mode === "forward")) {
      const keyword = mode === "forward" ? "$forwarded" : "$answered";
      try {
        await useEmailStore.getState().markEmailKeyword(client, payload.sourceEmailId, keyword, payload.sourceEmailSource ?? undefined);
      } catch (error) {
        debug.error(`Failed to set ${keyword} keyword:`, error);
      }
    }

    const accountId = data.localAccountId ?? useAuthStore.getState().activeAccountId;
    const pending = useEmailStore.getState().pendingUndoSend;
    const rejectedRecipients = result.rejectedRecipients?.length ? formatRejectedRecipients(result.rejectedRecipients) : undefined;
    const taken = await announceSentToMainWindow({
      accountId,
      scheduled: !!result.scheduled,
      queued: !!result.queued,
      filingError: !!result.filingError,
      rejectedRecipients,
      pendingUndoSend: pending ? { ...pending, localAccountId: pending.localAccountId ?? accountId ?? undefined } : null,
    });
    // No main window to say so, and this is the only notice these get (#1123).
    if (!taken && (result.filingError || rejectedRecipients)) {
      if (result.filingError) toast.warning(t("email_composer.send_filing_warning"));
      if (rejectedRecipients) toast.warning(t("email_composer.send_some_recipients_rejected"), { message: rejectedRecipients, duration: WARNING_READ_MS });
      await new Promise((resolve) => setTimeout(resolve, WARNING_READ_MS));
    }
  }, [client, mode, payload.sourceEmailId, payload.sourceEmailSource, t]);

  const handleDiscardDraft = useCallback(async (draftId: string, draft?: { accountId?: string; localAccountId?: string }) => {
    if (!client) return;
    // Through the login the draft was saved with, and never another: the id names another message there.
    const draftClient = draft?.localAccountId
      ? useAuthStore.getState().getClientForAccount(draft.localAccountId)
      : client;
    if (!draftClient) {
      toast.error(t("email_composer.discard_signed_out"));
      return;
    }
    try {
      await draftClient.deleteEmail(draftId, draft?.accountId);
    } catch (error) {
      console.error("Failed to discard draft:", error);
    }
  }, [client, t]);

  const handleClose = useCallback(() => {
    announceMailChanged(useAuthStore.getState().activeAccountId);
    closePopoutWindow();
  }, []);

  const [mainWindow] = useState(watchMainWindow);
  useEffect(() => () => mainWindow.stop(), [mainWindow]);

  const ownWindow = useMemo(() => ({
    rescueDraft: mainWindow.rescue,
    // A reload of this window starts from where the text is now.
    onUnloadState: (state: ComposerDraftData) => {
      if (handoffId) rememberComposePayload(handoffId, { ...payload, initialData: state, prefill: null });
    },
    onDraftSaved: () => announceMailChanged(useAuthStore.getState().activeAccountId),
  }), [handoffId, mainWindow, payload]);

  return (
    <ErrorBoundary fallback={ComposerErrorFallback}>
      <EmailComposer
        mode={mode}
        replyTo={payload.replyTo}
        initialDraftText={payload.initialDraftText}
        initialData={payload.initialData}
        prefill={payload.prefill}
        sessionKey={sessionKey}
        sourceEmailId={payload.sourceEmailId ?? undefined}
        composeFromAccountEmail={payload.composeFromAccountEmail
          ?? useAccountStore.getState().getAccountById(useAuthStore.getState().activeAccountId ?? "")?.email}
        onSend={handleSend}
        onClose={handleClose}
        onDiscardDraft={handleDiscardDraft}
        ownWindow={ownWindow}
        className="min-h-0 flex-1"
      />
    </ErrorBoundary>
  );
}

/** `/popout/compose`: a draft handed over by another window, or a new message. */
export function PopoutComposeApp() {
  const t = useTranslations("pwaWindows");
  const [{ handoffId, accountId }] = useState(readLaunch);
  const [payload, setPayload] = useState<ComposePopoutPayload | null>(handoffId ? null : EMPTY_PAYLOAD);

  useEffect(() => {
    if (!handoffId) return;
    let cancelled = false;
    void receiveComposeHandoff(handoffId).then((received) => {
      if (cancelled) return;
      // Called off or never ready: the composer stayed where it was.
      if (received) setPayload(received);
      else closePopoutWindow();
    });
    return () => {
      cancelled = true;
    };
  }, [handoffId]);

  return (
    <PopoutShell kind="compose" accountId={accountId}>
      {payload ? <PopoutComposer payload={payload} handoffId={handoffId} /> : <PopoutSkeleton label={t("opening")} />}
    </PopoutShell>
  );
}
