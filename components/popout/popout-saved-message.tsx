"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { EmailViewer } from "@/components/email/email-viewer";
import { ErrorBoundary, EmailViewerErrorFallback } from "@/components/error";
import { buildReplyContext } from "@/components/pro/pro-email-tab-body";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useDesktopCommands } from "@/lib/desktop/commands";
import { useDesktopWindowName } from "@/lib/desktop/window-name";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { composeOptionsFor, runBeforeCompose, type ComposePrefill } from "@/lib/plugin-compose-gate";
import { emailHooks } from "@/lib/plugin-hooks";
import { announceMailChanged } from "@/lib/popout/channel";
import { closePopoutWindow } from "@/lib/popout/window-role";
import { buildForwardSubject, buildReplySubject } from "@/lib/subject-prefix";
import type { Email } from "@/lib/jmap/types";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useIdentityStore } from "@/stores/identity-store";
import { usePolicyStore } from "@/stores/policy-store";
import type { ProComposeTabData } from "@/stores/pro-tab-store";
import { toast } from "@/stores/toast-store";
import { PopoutNotice, PopoutSkeleton } from "./popout-shell";

type ComposeData = Omit<ProComposeTabData, "sessionId">;

/**
 * A message from a file, opened from the OS (an .eml double-clicked in Explorer): the
 * main window uploaded it, the server parses it here (Email/parse), and the reader shows
 * it as it shows received mail. It is in no folder, so it offers reading, answering and
 * Print, and Move, which imports it into the folder picked (as the file drop overlay
 * does). Imported, the window shows it there, a message like any other.
 */
export function PopoutSavedMessage({ blobId, name, accountId, openCompose, onImported }: {
  blobId: string;
  /** The file's name, for the error when it can't be read or imported. */
  name?: string;
  /** The login it was uploaded through; left out, the active one. */
  accountId?: string;
  /** Opens a composer window (the message window's own). */
  openCompose: (data: ComposeData) => Promise<boolean>;
  /** Imported into a folder: the window goes on as that message's window. */
  onImported: (target: { emailId: string; ownerAccountId?: string }) => void;
}) {
  const t = useTranslations();
  const tLaunch = useTranslations("pwaLaunch");
  const tDrop = useTranslations("fileDrop");
  const tWindows = useTranslations("pwaWindows");
  const login = useAuthStore((s) => accountId ?? s.activeAccountId ?? undefined);
  const client = useAuthStore((s) => (login ? s.getClientForAccount(login) : undefined) ?? s.client);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const identities = useIdentityStore((s) => s.identities);
  const [email, setEmail] = useState<Email | null>(null);
  const [failed, setFailed] = useState(false);
  const subjectInTitle = usePolicyStore((s) => s.loaded && s.isFeatureEnabled("tabTitleSubjectEnabled"));
  const subject = email?.subject || null;
  useDocumentTitle(subjectInTitle ? subject : null);
  useDesktopWindowName(subjectInTitle ? subject : null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    // The folders are what Move offers.
    void Promise.resolve(useEmailStore.getState().fetchMailboxes(client)).catch(() => {});
    if (typeof client.parseEmailBlob !== "function") {
      setFailed(true);
      return;
    }
    client.parseEmailBlob(blobId)
      .then((parsed) => {
        if (cancelled) return;
        if (parsed) setEmail(parsed);
        else setFailed(true);
      })
      .catch((error) => {
        console.error("Reading a message from a file failed:", error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, blobId]);

  const blobSource = useMemo(() => ({ client: client ?? null, accountId: client?.getAccountId?.(), clientAccountId: login }), [client, login]);
  const writeSource = useMemo(() => ({ clientAccountId: login }), [login]);

  // A plugin's onBeforeCompose may stop or prefill it, as from any message.
  const compose = useCallback((data: ComposeData, source: Email, body?: string) => {
    const open = (prefill: ComposePrefill | null) => void openCompose({ ...data, prefill });
    if (emailHooks.onBeforeCompose.size === 0) {
      open(null);
      return;
    }
    void runBeforeCompose(composeOptionsFor(data.mode, {
      source,
      body: body ?? "",
      ownEmails: identities.map((identity) => identity.email).filter((address): address is string => Boolean(address)),
      replyPrefix: t("email_composer.prefix.reply"),
      forwardPrefix: t("email_composer.prefix.forward"),
    })).then((prefill) => {
      if (prefill) open(Object.keys(prefill).length > 0 ? prefill : null);
    });
  }, [identities, openCompose, t]);

  // No sourceEmailId: there is no stored message to mark answered or forwarded.
  const reply = useCallback((mode: "reply" | "replyAll", draftText?: string) => {
    if (!email) return;
    compose({
      mode,
      replyTo: buildReplyContext(email, writeSource),
      initialDraftText: draftText,
      title: buildReplySubject(email.subject || t("email_composer.new_message"), t("email_composer.prefix.reply")),
    }, email, draftText);
  }, [compose, email, t, writeSource]);

  const forward = useCallback(() => {
    if (!email) return;
    compose({
      mode: "forward",
      replyTo: buildReplyContext(email, writeSource),
      title: buildForwardSubject(email.subject || t("email_composer.new_message"), t("email_composer.prefix.forward")),
    }, email);
  }, [compose, email, t, writeSource]);

  const importInto = useCallback(async (mailboxId: string) => {
    const mailbox = mailboxes.find((entry) => entry.id === mailboxId);
    if (!client || !mailbox) return;
    const folder = localizeMailboxName(mailbox.role, mailbox.name, (key) => t(`sidebar.mailboxes.${key}`));
    try {
      // The file drop overlay's import: the message as it is, marked read.
      const raw = await client.fetchBlob(blobId, name, "message/rfc822");
      const emailId = await client.importRawEmail(raw, { [mailbox.id]: true }, { $seen: true }, mailbox.accountId);
      toast.success(tDrop("import_done", { count: 1, folder }));
      announceMailChanged(login ?? null);
      const own = client.getAccountId?.();
      onImported({ emailId, ownerAccountId: mailbox.accountId && mailbox.accountId !== own ? mailbox.accountId : undefined });
    } catch (error) {
      console.error("Importing a message from a file failed:", error);
      toast.error(tDrop("import_failed", { name: name || subject || blobId }));
    }
  }, [blobId, client, login, mailboxes, name, onImported, subject, t, tDrop]);

  useDesktopCommands({
    "message.reply": () => reply("reply"),
    "message.replyAll": () => reply("replyAll"),
    "message.forward": forward,
  }, {
    "message.reply": !!email,
    "message.replyAll": !!email,
    "message.forward": !!email,
  });

  if (failed) {
    return (
      <PopoutNotice title={tLaunch("open_failed")} body={name ?? ""}>
        <Button onClick={closePopoutWindow}>{tWindows("close_window")}</Button>
      </PopoutNotice>
    );
  }
  if (!email) return <PopoutSkeleton label={tWindows("opening")} />;

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col bg-background" data-popout-saved-message="">
      <ErrorBoundary fallback={EmailViewerErrorFallback}>
        <EmailViewer
          email={email}
          savedFile
          noAutomaticActions
          blobSource={blobSource}
          onReply={(draftText) => reply("reply", draftText)}
          onReplyAll={() => reply("replyAll")}
          onForward={forward}
          onQuickReply={async (body) => reply("reply", body)}
          onDownloadAttachment={(attachmentBlobId, attachmentName, type) => {
            void client?.downloadBlob(attachmentBlobId, attachmentName, type).catch((error: unknown) => {
              console.error("Download failed:", error);
            });
          }}
          onMoveToMailbox={(mailboxId) => void importInto(mailboxId)}
          currentUserEmail={client?.getUsername()}
          currentUserName={client?.getUsername()?.split("@")[0]}
          mailboxes={mailboxes}
          className="flex-1"
          withListSelection={false}
        />
      </ErrorBoundary>
    </div>
  );
}
