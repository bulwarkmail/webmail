"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ProEmailView } from "@/components/pro/pro-email-tab-body";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import type { Email } from "@/lib/jmap/types";
import type { ProComposeTabData } from "@/stores/pro-tab-store";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { announceMailChanged, openPopoutChannel } from "@/lib/popout/channel";
import { openComposerWindow } from "@/lib/popout/open";
import { closePopoutWindow } from "@/lib/popout/window-role";
import { PopoutNotice, PopoutShell, PopoutSkeleton } from "./popout-shell";

/** How often an open message checks that it is still there, without a main window to say so. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * The id from the address bar: a page the service worker kept for a start
 * without the network was rendered for another id.
 */
function readLaunch(paramId: string): { emailId: string; accountId?: string; ownerAccountId?: string; fromLink?: boolean } {
  if (typeof window === "undefined") return { emailId: paramId };
  const segments = window.location.pathname.split("/").filter(Boolean);
  const at = segments.lastIndexOf("message");
  let emailId = paramId;
  try {
    if (at >= 0 && segments[at + 1]) emailId = decodeURIComponent(segments[at + 1]);
  } catch {
    // A malformed address: the route's own value.
  }
  const search = new URLSearchParams(window.location.search);
  return { emailId, accountId: search.get("account") ?? undefined, ownerAccountId: search.get("owner") ?? undefined, fromLink: search.get("via") === "link" };
}

type Presence = "present" | "gone";
type LiveState = Pick<Email, "keywords" | "mailboxIds">;

/**
 * Whether the message still exists, and in which folders. A JMAP move keeps
 * the id, so moved mail stays readable here; only its folders change.
 */
function useMessagePresence(emailId: string, ownerAccountId: string | undefined): { presence: Presence; mailboxIds: string[] | null; liveState: LiveState | null } {
  const client = useAuthStore((s) => s.client);
  const [presence, setPresence] = useState<Presence>("present");
  const [mailboxIds, setMailboxIds] = useState<string[] | null>(null);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const checking = useRef(false);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const check = async () => {
      if (checking.current) return;
      checking.current = true;
      try {
        const [found] = await client.getSomeEmails([emailId], ownerAccountId);
        if (cancelled) return;
        setPresence(found ? "present" : "gone");
        if (found?.mailboxIds) setMailboxIds(Object.keys(found.mailboxIds).sort());
        if (found) {
          setLiveState({ keywords: found.keywords, mailboxIds: found.mailboxIds });
          // What the next star or read toggle starts from.
          useEmailStore.setState((state) => ({
            emails: state.emails.map((email) => (email.id === emailId ? { ...email, keywords: found.keywords, mailboxIds: found.mailboxIds } : email)),
          }));
        }
      } catch {
        // No answer says nothing about the message: it stays on screen.
      } finally {
        checking.current = false;
      }
    };
    void check();
    const channel = openPopoutChannel((message) => {
      if (message.type === "state-change") void check();
    });
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      channel?.close();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [client, emailId, ownerAccountId]);

  return { presence, mailboxIds, liveState };
}

function PopoutMessage({ emailId, accountId, ownerAccountId, fromLink }: { emailId: string; accountId?: string; ownerAccountId?: string; fromLink?: boolean }) {
  const t = useTranslations("pwaWindows");
  const tSidebar = useTranslations("sidebar");
  const login = useAuthStore((s) => accountId ?? s.activeAccountId ?? undefined);
  const client = useAuthStore((s) => (login ? s.getClientForAccount(login) : undefined) ?? s.client);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [subject, setSubject] = useState<string | null>(null);
  const subjectInTitle = usePolicyStore((s) => s.loaded && s.isFeatureEnabled("tabTitleSubjectEnabled"));
  useDocumentTitle(subjectInTitle ? subject : null);

  // Folders first: without them Delete has no Trash to move to, Archive has no
  // button yet, and the toolbar moves under the pointer once they arrive.
  const [foldersReady, setFoldersReady] = useState(mailboxes.length > 0);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void Promise.resolve(useEmailStore.getState().fetchMailboxes(client)).catch(() => {}).finally(() => {
      if (!cancelled) setFoldersReady(true);
    });
    return () => {
      cancelled = true;
    };
    // Once per client: an account without folders shouldn't ask forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const { presence, mailboxIds, liveState } = useMessagePresence(emailId, ownerAccountId);
  const firstMailboxIds = useRef<string | null>(null);
  if (mailboxIds && firstMailboxIds.current === null) firstMailboxIds.current = mailboxIds.join();
  const moved = !!mailboxIds && firstMailboxIds.current !== mailboxIds.join();
  const movedTo = moved ? mailboxes.find((mailbox) => mailboxIds.includes(mailbox.originalId || mailbox.id)) : undefined;

  const handleClose = useCallback(() => {
    announceMailChanged(login ?? null);
    closePopoutWindow();
  }, [login]);

  const handleMailChanged = useCallback(() => announceMailChanged(login ?? null), [login]);

  const handleLoaded = useCallback((email: Email) => {
    setSubject(email.subject || null);
    // Delete, move, star and read look the message up in the list and do
    // nothing when it isn't there, and this window has no list of its own.
    useEmailStore.setState({ emails: [email], selectedMailbox: Object.keys(email.mailboxIds ?? {})[0] ?? "" });
  }, []);

  // Reply and forward open a composer window of their own.
  const openCompose = useCallback(async (data: Omit<ProComposeTabData, "sessionId">) => {
    const opened = openComposerWindow(login);
    if (!opened) {
      toast.error(t("popup_blocked"));
      return false;
    }
    const shown = await opened.handOver({
      mode: data.mode,
      replyTo: data.replyTo,
      initialDraftText: data.initialDraftText,
      initialData: data.initialData,
      prefill: data.prefill,
      sourceEmailId: data.sourceEmailId,
      sourceEmailSource: data.sourceEmailSource,
    });
    if (!shown) {
      opened.cancel();
      toast.error(t("window_not_ready"));
    }
    return shown;
  }, [login, t]);

  if (!foldersReady) return <PopoutSkeleton label={t("opening")} />;

  if (presence === "gone") {
    return (
      <PopoutNotice title={t("message_gone_title")} body={t("message_gone_body")}>
        <Button onClick={handleClose}>{t("close_window")}</Button>
      </PopoutNotice>
    );
  }

  return (
    <>
      {moved && (
        <div role="status" data-popout-moved="" data-window-top-row="" className="flex shrink-0 items-center border-b border-border bg-muted px-4 py-2 text-sm text-foreground">
          {movedTo
            ? t("message_moved_to", { folder: localizeMailboxName(movedTo.role, movedTo.name, (key) => tSidebar(`mailboxes.${key}`)) })
            : t("message_moved")}
        </div>
      )}
      <ProEmailView
        emailId={emailId}
        client={client ?? undefined}
        clientAccountId={login}
        accountId={ownerAccountId}
        onLoaded={handleLoaded}
        onClose={handleClose}
        onOpenCompose={openCompose}
        liveState={liveState}
        onMailChanged={handleMailChanged}
        noAutomaticActions={fromLink}
        className="min-h-0 w-full flex-1"
      />
    </>
  );
}

/** `/popout/message/<id>`: one message in its own window, with no rail, sidebar or list. */
export function PopoutMessageApp({ id }: { id: string }) {
  const [launch] = useState(() => readLaunch(id));
  return (
    <PopoutShell kind="message" accountId={launch.accountId}>
      <PopoutMessage emailId={launch.emailId} accountId={launch.accountId} ownerAccountId={launch.ownerAccountId} fromLink={launch.fromLink} />
    </PopoutShell>
  );
}
