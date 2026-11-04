"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { announceSent, cancelAnnouncedSend, releaseAnnouncedSend } from "@/lib/plugin-after-send";
import { cancelFailureToast } from "@/lib/send-failure-message";
import { announceDraftKept, announceMailChanged, announceSentToMainWindow, askRescuedDraftId, watchMainWindow, type PopoutSentNotice, type RescuedDraft } from "@/lib/popout/channel";
import { acknowledgeComposeHandoff, forgetComposePayload, receiveComposeHandoff, rememberComposePayload, rememberedComposePayload, watchHandoffCancel } from "@/lib/popout/compose-handoff";
import type { ComposePopoutPayload } from "@/lib/popout/compose-payload";
import { returnComposerToMain, type ReturnResult } from "@/lib/popout/return-to-main";
import { closePopoutWindow } from "@/lib/popout/window-role";
import { hasDesktopWindows } from "@/lib/popout/support";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { Button } from "@/components/ui/button";
import { composeOptionsFor, runBeforeCompose } from "@/lib/plugin-compose-gate";
import { composerDataFromDraft, isRestorableDraft } from "@/lib/draft-composer-data";
import { noteOpenDraft } from "@/lib/desktop/window-restore";
import { findDraftIdentityIdForLogin } from "@/lib/draft-source";
import { emailHooks } from "@/lib/plugin-hooks";
import { useProMultiAccountIdentities } from "@/hooks/use-pro-multi-account-identities";
import { useIdentityStore } from "@/stores/identity-store";
import type { Email } from "@/lib/jmap/types";
import { Send } from "@/components/icons";
import { PopoutNotice, PopoutShell, PopoutSkeleton } from "./popout-shell";

/** A warning with no main window left to show it stays this long before the window goes. */
const WARNING_READ_MS = 8000;

type ComposerProps = React.ComponentProps<typeof EmailComposer>;
type SendData = Parameters<NonNullable<ComposerProps["onSend"]>>[0];

const EMPTY_PAYLOAD: ComposePopoutPayload = { mode: "compose" };

/** How long a new message waits for plugins to start, so that their onBeforeCompose gets its say. */
const PLUGINS_WAIT_MS = 5000;

/** How often the window looks whether a main window holding its login is still there. */
const MAIN_CHECK_MS = 1000;

/** How long a reloaded window waits to hear what became of the text it handed over on the way out. */
const RESCUE_ANSWER_MS = 2000;

/** A send held this long or less is an undo window ("Sending in 5 s"), not a message scheduled for later. */
const UNDO_WINDOW_MS = 120_000;
/** Undo goes this long before the server lets the message go, as in the main window. */
const UNDO_MARGIN_MS = 1000;
/** What the plugins are told when the hold runs out gets this long before the window goes. */
const RELEASE_WAIT_MS = 1000;

type HeldSend = NonNullable<PopoutSentNotice["pendingUndoSend"]>;

/** A draft to open again in this window, after Undo brought the message back to Drafts. */
interface ReopenTarget {
  draftId: string;
  accountId: string;
  ownerAccountId?: string;
}

/**
 * A send held for undo, shown in the window it was sent from: that's where the
 * user is looking, and quick compose is used with the main window out of sight.
 * The window stays until the hold runs out, then goes.
 */
function SendingWithUndo({ held, onUndone, onGone }: {
  held: HeldSend;
  /** The send was taken back; the message, back in Drafts, when there is one to open. */
  onUndone: (restored: Email | null) => void;
  onGone: () => void;
}) {
  const tViewer = useTranslations("email_viewer");
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const sendAt = Date.parse(held.sendAt);
  const over = !Number.isFinite(sendAt) || now >= sendAt - UNDO_MARGIN_MS;

  useEffect(() => {
    if (over) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [over]);

  // Too late to undo: the plugins hear of the send now, and the window goes.
  useEffect(() => {
    if (!over || busy) return;
    releaseAnnouncedSend(held.submissionId);
    const timer = setTimeout(onGone, RELEASE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [over, busy, held.submissionId, onGone]);

  const undo = async () => {
    const auth = useAuthStore.getState();
    // Never another login: the submission id names another submission there.
    const client = held.localAccountId ? auth.getClientForAccount(held.localAccountId) : auth.client;
    if (!client) {
      toast.error(tViewer("undo_send_signed_out"));
      return;
    }
    setBusy(true);
    let restored: Email | null;
    try {
      restored = await useEmailStore.getState().cancelUndoSend(client, held);
    } catch (error) {
      debug.error("Failed to undo the send:", error);
      const { title, message } = cancelFailureToast(error, tViewer, tViewer("undo_send_failed"));
      toast.error(title, message ? { message } : undefined);
      setBusy(false);
      return;
    }
    // Never left the server: plugins don't hear about it.
    cancelAnnouncedSend(held.submissionId);
    onUndone(held.isSmime ? null : restored);
  };

  const seconds = Math.max(0, Math.ceil((sendAt - now) / 1000));
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center" data-testid="popout-sending">
      <Send className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
      <p role="status" className="text-sm text-foreground">{tViewer("sending_in", { seconds })}</p>
      {!over && (
        <Button onClick={() => void undo()} disabled={busy} data-testid="popout-undo-send">
          {tViewer("undo_send")}
        </Button>
      )}
    </div>
  );
}

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

/**
 * A new message with nothing handed over, from the desktop app's shortcut or File menu. Plugins
 * get the same say as in the main window: stop it, and nothing opens; or fill in fields.
 */
function NewMessageGate({ onReady }: { onReady: (payload: ComposePopoutPayload) => void }) {
  const t = useTranslations();
  const tWindows = useTranslations("pwaWindows");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await Promise.race([
        Promise.resolve(usePluginStore.getState().initializePlugins()).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, PLUGINS_WAIT_MS)),
      ]);
      if (cancelled) return;
      if (emailHooks.onBeforeCompose.size === 0) {
        onReady(EMPTY_PAYLOAD);
        return;
      }
      const prefill = await runBeforeCompose(composeOptionsFor("compose", {
        ownEmails: useIdentityStore.getState().identities.map((identity) => identity.email).filter((email): email is string => Boolean(email)),
        replyPrefix: t("email_composer.prefix.reply"),
        forwardPrefix: t("email_composer.prefix.forward"),
      }));
      if (cancelled) return;
      if (!prefill) {
        closePopoutWindow();
        return;
      }
      onReady(Object.keys(prefill).length > 0 ? { ...EMPTY_PAYLOAD, prefill } : EMPTY_PAYLOAD);
    })();
    return () => {
      cancelled = true;
    };
    // Once, as the window opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <PopoutSkeleton label={tWindows("opening")} />;
}

/** The composer alone, in its own window: sending, autosave and discard go through the shared stores, as in a Pro tab. */
function PopoutComposer({ payload, handoffId, onReopen }: {
  payload: ComposePopoutPayload;
  handoffId: string | null;
  /** Undo brought the message back to Drafts: open it again here. */
  onReopen: (target: ReopenTarget) => void;
}) {
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
    const withLogin = pending ? { ...pending, localAccountId: pending.localAccountId ?? accountId ?? undefined } : null;
    // An undo window stays here, where Send was pressed: the window shows it
    // and closes when it runs out. A message scheduled for later goes to the
    // main window as before.
    const remaining = withLogin ? Date.parse(withLogin.sendAt) - Date.now() : NaN;
    const keepHere = result.scheduled && withLogin && Number.isFinite(remaining) && remaining <= UNDO_WINDOW_MS ? withLogin : null;
    if (keepHere) {
      heldRef.current = keepHere;
      useEmailStore.setState({ pendingUndoSend: null });
    }
    const rejectedRecipients = result.rejectedRecipients?.length ? formatRejectedRecipients(result.rejectedRecipients) : undefined;
    const taken = await announceSentToMainWindow({
      accountId,
      scheduled: !!result.scheduled,
      queued: !!result.queued,
      filingError: !!result.filingError,
      rejectedRecipients,
      pendingUndoSend: keepHere ? null : withLogin,
      releasesAt: keepHere?.sendAt,
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

  // A send held for undo, kept in this window until it runs out.
  const heldRef = useRef<HeldSend | null>(null);
  const [held, setHeld] = useState<HeldSend | null>(null);

  const handleClose = useCallback(() => {
    announceMailChanged(useAuthStore.getState().activeAccountId);
    if (heldRef.current) {
      setHeld(heldRef.current);
      return;
    }
    closePopoutWindow();
  }, []);

  const heldGone = useCallback(() => {
    announceMailChanged(useAuthStore.getState().activeAccountId);
    closePopoutWindow();
  }, []);

  const heldUndone = useCallback((restored: Email | null) => {
    const sent = heldRef.current;
    heldRef.current = null;
    const login = sent?.localAccountId ?? useAuthStore.getState().activeAccountId;
    announceMailChanged(login);
    if (!restored || !login) {
      closePopoutWindow();
      return;
    }
    onReopen({ draftId: restored.id, accountId: login, ownerAccountId: sent?.submissionAccountId });
  }, [onReopen]);

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
          () => mainWindow.alive(),
        );
        if (result === "shown") getDesktopBridge()?.windows?.focus?.();
        return result === "shown";
      },
    };
  }, [mainWindow, payload, tQuick]);

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
    onDraftKept: (draftId: string, where: { accountId?: string; localAccountId?: string }) => {
      announceDraftKept({ draftId, ...where, localAccountId: where.localAccountId ?? useAuthStore.getState().activeAccountId ?? undefined });
    },
    onDraftSaved: (draftId: string, where: { accountId?: string; localAccountId?: string } = {}) => {
      const active = useAuthStore.getState().activeAccountId;
      announceMailChanged(active);
      // A save makes a new id, and this address is what a reload starts from: also the
      // shell's reload after this page crashed, when nothing else of it survives.
      const url = new URL(window.location.href);
      url.searchParams.set("draft", draftId);
      const login = where.localAccountId ?? url.searchParams.get("account") ?? active;
      if (login) url.searchParams.set("account", login);
      if (where.accountId) url.searchParams.set("owner", where.accountId);
      else url.searchParams.delete("owner");
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
      if (handoffId) forgetComposePayload(handoffId);
    },
  }), [handoffId, mainWindow, payload]);

  if (held) return <SendingWithUndo held={held} onUndone={heldUndone} onGone={heldGone} />;

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
  const [{ handoffId: named, accountId, draftId, ownerAccountId }] = useState(readLaunch);
  // Saved on the server and nothing remembered: this page crashed or was killed, and the
  // draft is the newest there is. An ordinary reload remembers as it unloads.
  const [handoffId] = useState(() => (named && draftId && !rememberedComposePayload(named) ? null : named));
  const [payload, setPayload] = useState<ComposePopoutPayload | null>(null);
  // After Undo: the message back in Drafts, opened again in a new composer here.
  const [reopen, setReopen] = useState<ReopenTarget | null>(null);
  const [generation, setGeneration] = useState(0);
  const handleReopen = useCallback((target: ReopenTarget) => {
    // A reload starts from the draft, as after a save.
    const url = new URL(window.location.href);
    url.searchParams.delete("handoff");
    url.searchParams.set("draft", target.draftId);
    url.searchParams.set("account", target.accountId);
    if (target.ownerAccountId) url.searchParams.set("owner", target.ownerAccountId);
    else url.searchParams.delete("owner");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    setPayload(null);
    setReopen(target);
  }, []);
  const reopened = useCallback((next: ComposePopoutPayload) => {
    setReopen(null);
    setGeneration((n) => n + 1);
    setPayload(next);
  }, []);

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
      {payload ? <PopoutComposer key={generation} payload={payload} handoffId={generation === 0 ? handoffId : null} onReopen={handleReopen} />
        : reopen ? <RestoredDraft draftId={reopen.draftId} accountId={reopen.accountId} ownerAccountId={reopen.ownerAccountId} onReady={reopened} />
        : handoffId ? <PopoutSkeleton label={t("opening")} />
        : draftId ? <RestoredDraft draftId={draftId} accountId={accountId} ownerAccountId={ownerAccountId} onReady={setPayload} />
        : <NewMessageGate onReady={setPayload} />}
    </PopoutShell>
  );
}
