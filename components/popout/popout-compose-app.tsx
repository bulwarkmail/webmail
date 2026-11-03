"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { EmailComposer, type ComposerDraftData } from "@/components/email/email-composer";
import { ErrorBoundary, ComposerErrorFallback } from "@/components/error";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { usePluginStore } from "@/stores/plugin-store";
import { toast } from "@/stores/toast-store";
import { formatRejectedRecipients } from "@/lib/jmap/client";
import { debug } from "@/lib/debug";
import { composerSendOptions } from "@/lib/outgoing/composer-send-options";
import { announceSent } from "@/lib/plugin-after-send";
import { announceMailChanged, announceSentToMainWindow, askRescuedDraftId, watchMainWindow, type RescuedDraft } from "@/lib/popout/channel";
import { acknowledgeComposeHandoff, receiveComposeHandoff, rememberComposePayload, rememberedComposePayload, watchHandoffCancel } from "@/lib/popout/compose-handoff";
import type { ComposePopoutPayload } from "@/lib/popout/compose-payload";
import { returnComposerToMain, type ReturnResult } from "@/lib/popout/return-to-main";
import { closePopoutWindow } from "@/lib/popout/window-role";
import { hasDesktopWindows } from "@/lib/popout/support";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { Button } from "@/components/ui/button";
import { composerDataFromDraft, isRestorableDraft } from "@/lib/draft-composer-data";
import { noteOpenDraft } from "@/lib/desktop/window-restore";
import { findDraftIdentityIdForLogin } from "@/lib/draft-source";
import { emailHooks } from "@/lib/plugin-hooks";
import { useProMultiAccountIdentities } from "@/hooks/use-pro-multi-account-identities";
import { useIdentityStore } from "@/stores/identity-store";
import type { Email } from "@/lib/jmap/types";
import { PopoutNotice, PopoutShell, PopoutSkeleton } from "./popout-shell";

/** A warning with no main window left to show it stays this long before the window goes. */
const WARNING_READ_MS = 8000;

type ComposerProps = React.ComponentProps<typeof EmailComposer>;
type SendData = Parameters<NonNullable<ComposerProps["onSend"]>>[0];

const EMPTY_PAYLOAD: ComposePopoutPayload = { mode: "compose" };

/** How often the window looks whether a main window holding its login is still there. */
const MAIN_CHECK_MS = 1000;

/** How long a reloaded window waits to hear what became of the text it handed over on the way out. */
const RESCUE_ANSWER_MS = 2000;

function readLaunch(): { handoffId: string | null; accountId?: string; draftId?: string; ownerAccountId?: string } {
  if (typeof window === "undefined") return { handoffId: null };
  const search = new URLSearchParams(window.location.search);
  return {
    handoffId: search.get("handoff"),
    accountId: search.get("account") ?? undefined,
    draftId: search.get("draft") ?? undefined,
    ownerAccountId: search.get("owner") ?? undefined,
  };
}

/** How long a restored draft waits for the identity that wrote it to load. */
const IDENTITY_WAIT_MS = 4000;

/**
 * The composer that was open when the desktop app quit, back on its draft. A draft
 * that has gone since (sent or deleted elsewhere) means there's nothing to show.
 * A server that doesn't answer says nothing about it: the window stays, offers to try
 * again, and the draft stays on the list for the next start.
 *
 * Only through the login the address names, and never without one: ids repeat across
 * accounts, so another login could hold someone else's message under this id.
 *
 * The From stays what it was. With several accounts the other accounts' identities
 * load later, and the composer would otherwise start on the default and save that.
 */
function RestoredDraft({ draftId, accountId, ownerAccountId, onReady }: {
  draftId: string;
  accountId?: string;
  ownerAccountId?: string;
  onReady: (payload: ComposePopoutPayload) => void;
}) {
  const t = useTranslations();
  const tRestore = useTranslations("desktopUi.restore");
  const tWindows = useTranslations("pwaWindows");
  const client = useAuthStore((s) => (accountId ? s.getClientForAccount(accountId) : undefined));
  const ownIdentities = useIdentityStore((s) => s.identities);
  const multi = useProMultiAccountIdentities();
  const identities = multi.enabled ? multi.allIdentities : ownIdentities;
  const [draft, setDraft] = useState<Email | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [waitOver, setWaitOver] = useState(false);

  // Until the composer takes over, this window still stands for the draft.
  useEffect(() => {
    const key = `restored-${draftId}`;
    noteOpenDraft(key, { draftId, localAccountId: accountId, ownerAccountId });
    return () => noteOpenDraft(key, null);
  }, [draftId, accountId, ownerAccountId]);

  useEffect(() => {
    if (!accountId) {
      closePopoutWindow();
      return;
    }
    if (!client) return;
    let cancelled = false;
    setFailed(false);
    void Promise.all([client.getEmail(draftId, ownerAccountId), client.getMailboxes(ownerAccountId)]).then(async ([found, mailboxes]) => {
      if (cancelled) return;
      if (!found || !isRestorableDraft(found, mailboxes)) {
        closePopoutWindow();
        return;
      }
      const transformed = await emailHooks.onBeforeEditDraft.transform(found);
      if (!cancelled) setDraft(transformed);
    }).catch((error) => {
      debug.error("Failed to reopen a draft:", error);
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [client, accountId, draftId, ownerAccountId, attempt]);

  // Back online: try by itself.
  useEffect(() => {
    if (!failed) return;
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [failed]);

  useEffect(() => {
    const timer = setTimeout(() => setWaitOver(true), IDENTITY_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!draft) return;
    const from = draft.from?.[0];
    const matched = findDraftIdentityIdForLogin(identities, from, accountId);
    // The identity may still be on its way: wait for it, then keep the address as it was.
    if (!matched && from && !waitOver) return;
    const data = composerDataFromDraft(draft, {
      accountId: ownerAccountId,
      localAccountId: accountId,
      identities,
      noSubject: t("email_composer.no_subject"),
    });
    onReady({
      mode: "compose",
      initialData: !matched && from?.email
        ? { ...data, fromOverrideEnabled: true, fromOverrideEmail: from.email, fromOverrideName: from.name ?? "" }
        : data,
    });
    // onReady swaps this component out; `t` changes nothing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, identities, waitOver]);

  if (failed) {
    return (
      <PopoutNotice title={tRestore("unavailable_title")} body={tRestore("unavailable_body")}>
        <Button onClick={() => setAttempt((n) => n + 1)}>{tRestore("try_again")}</Button>
        <Button variant="ghost" onClick={closePopoutWindow}>{tRestore("close")}</Button>
      </PopoutNotice>
    );
  }
  return <PopoutSkeleton label={tWindows("opening")} />;
}

/** The composer alone, in its own window: sending, autosave and discard go through the shared stores, as in a Pro tab. */
function PopoutComposer({ payload, handoffId }: { payload: ComposePopoutPayload; handoffId: string | null }) {
  const t = useTranslations();
  const tQuick = useTranslations("desktopQuickCompose");
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

  // The way back into the main window, in the desktop app, while one holds this login.
  const [mainHoldsLogin, setMainHoldsLogin] = useState(false);
  useEffect(() => {
    if (!hasDesktopWindows()) return;
    const check = () => setMainHoldsLogin(mainWindow.alive(useAuthStore.getState().activeAccountId ?? undefined));
    check();
    const timer = setInterval(check, MAIN_CHECK_MS);
    return () => clearInterval(timer);
  }, [mainWindow]);

  const backToMain = useCallback(() => {
    let result: ReturnResult = "no-answer";
    return {
      cancel: () => {},
      notShownMessage: () => tQuick(result === "busy" ? "back_busy" : "back_no_answer"),
      handOver: async (state: ComposerDraftData) => {
        result = await returnComposerToMain(
          { ...payload, mode: state.mode, replyTo: state.replyTo, initialData: state, initialDraftText: undefined, prefill: null },
          state.draftLocalAccountId ?? useAuthStore.getState().activeAccountId,
        );
        if (result === "shown") getDesktopBridge()?.windows?.focus?.();
        return result === "shown";
      },
    };
  }, [payload, tQuick]);

  // The window that opened this one lets go of its copy now. Not without a
  // session: this one couldn't save or send the text.
  useEffect(() => {
    if (handoffId && client) acknowledgeComposeHandoff(handoffId);
  }, [handoffId, client]);

  const ownWindow = useMemo(() => ({
    rescueDraft: (draft: RescuedDraft) => {
      // A plugin that hasn't started may yet have a say in what a draft holds,
      // and it can only have it in this window's save.
      if (!usePluginStore.getState().initialized) return false;
      return mainWindow.rescue({
        ...draft,
        localAccountId: draft.localAccountId ?? useAuthStore.getState().activeAccountId ?? undefined,
        rescueKey: handoffId ?? undefined,
      });
    },
    // A reload of this window starts from where the text is now.
    onUnloadState: (state: ComposerDraftData) => {
      if (handoffId) rememberComposePayload(handoffId, { ...payload, initialData: state, prefill: null });
    },
    onDraftSaved: (draftId: string) => {
      announceMailChanged(useAuthStore.getState().activeAccountId);
      // A save makes a new id, and this address is what a reload starts from.
      const url = new URL(window.location.href);
      if (url.searchParams.has("draft")) {
        url.searchParams.set("draft", draftId);
        window.history.replaceState(null, "", `${url.pathname}${url.search}`);
      }
    },
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
        popOut={mainHoldsLogin ? backToMain : undefined}
        popOutToMainLabel={mainHoldsLogin ? tQuick("back_to_main") : undefined}
        className="min-h-0 flex-1"
      />
    </ErrorBoundary>
  );
}

/** `/popout/compose`: a draft handed over by another window, or a new message. */
export function PopoutComposeApp() {
  const t = useTranslations("pwaWindows");
  const [{ handoffId, accountId, draftId, ownerAccountId }] = useState(readLaunch);
  const [payload, setPayload] = useState<ComposePopoutPayload | null>(handoffId || draftId ? null : EMPTY_PAYLOAD);

  useEffect(() => {
    if (!handoffId) return;
    let cancelled = false;
    const reloaded = rememberedComposePayload(handoffId) !== null;
    void receiveComposeHandoff(handoffId).then(async (received) => {
      if (!received) {
        // Called off or never ready: the composer stayed where it was.
        if (!cancelled) closePopoutWindow();
        return;
      }
      // Reloaded: the text may have gone to a main window on the way out, under
      // a new id. Saving under the old one would leave two drafts.
      const draftId = reloaded && received.initialData ? await askRescuedDraftId(handoffId, RESCUE_ANSWER_MS) : null;
      if (cancelled) return;
      setPayload(draftId && received.initialData
        ? { ...received, initialData: { ...received.initialData, draftId, draftAccountId: undefined, unsaved: false } }
        : received);
    });
    // The opening window takes the draft back. Gone first, so that closing
    // doesn't save a copy of what that window still has.
    const stopWatching = watchHandoffCancel(handoffId, () => {
      setPayload(null);
      setTimeout(closePopoutWindow, 0);
    });
    return () => {
      cancelled = true;
      stopWatching();
    };
  }, [handoffId]);

  return (
    <PopoutShell kind="compose" accountId={accountId}>
      {payload ? <PopoutComposer payload={payload} handoffId={handoffId} />
        : draftId ? <RestoredDraft draftId={draftId} accountId={accountId} ownerAccountId={ownerAccountId} onReady={setPayload} />
        : <PopoutSkeleton label={t("opening")} />}
    </PopoutShell>
  );
}
