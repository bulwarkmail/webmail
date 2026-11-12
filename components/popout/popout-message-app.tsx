"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ProEmailView } from "@/components/pro/pro-email-tab-body";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useDesktopWindowName } from "@/lib/desktop/window-name";
import { loginFingerprint } from "@/lib/pwa-notify/login-fingerprint";
import { severalLogins } from "@/lib/sole-login";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { usePolicyStore } from "@/stores/policy-store";
import { toast } from "@/stores/toast-store";
import type { Email } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { ProComposeTabData } from "@/stores/pro-tab-store";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { announceMailChanged, openPopoutChannel } from "@/lib/popout/channel";
import { messagePopoutUrl, openComposerWindow } from "@/lib/popout/open";
import { closePopoutWindow } from "@/lib/popout/window-role";
import { PopoutNotice, PopoutShell, PopoutSkeleton } from "./popout-shell";
import { PopoutSavedMessage } from "./popout-saved-message";

/** How often an open message checks that it is still there, without a main window to say so. */
const CHECK_INTERVAL_MS = 60_000;

/**
 * The id from the address bar: a page the service worker kept for a start
 * without the network was rendered for another id.
 */
interface Launch {
  emailId: string;
  accountId?: string;
  ownerAccountId?: string;
  fromLink?: boolean;
  /** A message from a file, uploaded as this blob (popout-saved-message.tsx). */
  blobId?: string;
  fileName?: string;
}

function readLaunch(paramId: string): Launch {
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
  return {
    emailId,
    accountId: search.get("account") ?? undefined,
    ownerAccountId: search.get("owner") ?? undefined,
    fromLink: search.get("via") === "link",
    blobId: search.get("blob") ?? undefined,
    fileName: search.get("name") ?? undefined,
  };
}

/** A login fingerprint (lib/pwa-notify/login-fingerprint.ts): 32 hex digits, where a login id has an "@". */
const LOGIN_FINGERPRINT = /^[0-9a-f]{32}$/;

/**
 * The login a window's address names in `account=`. A login id is taken as
 * it is. A login fingerprint, which is how a notification's or the desktop
 * tray's context names a login, is matched against this browser's logins;
 * one that matches none stays as it is, so the window says it is signed
 * out, as for any login this browser doesn't hold. `pending` while a
 * fingerprint is being matched.
 */
function useAddressLogin(named: string | undefined): { pending: boolean; login: string | undefined } {
  const fingerprint = !!named && LOGIN_FINGERPRINT.test(named)
    && !useAccountStore.getState().accounts.some((entry) => entry.id === named);
  const [matched, setMatched] = useState<{ named: string; login: string } | null>(null);
  useEffect(() => {
    if (!fingerprint || !named) return;
    let cancelled = false;
    const entries = useAccountStore.getState().accounts;
    void Promise.all(entries.map((entry) => loginFingerprint(entry.serverUrl, entry.username)))
      .then((prints) => entries.find((_, at) => prints[at] === named)?.id ?? named, () => named)
      .then((login) => {
        if (!cancelled) setMatched({ named, login });
      });
    return () => {
      cancelled = true;
    };
  }, [fingerprint, named]);
  if (!fingerprint) return { pending: false, login: named };
  return matched?.named === named ? { pending: false, login: matched.login } : { pending: true, login: undefined };
}

/** Reply and forward from a message window open a composer window of their own. */
function useComposeWindow(login: string | undefined): (data: Omit<ProComposeTabData, "sessionId">) => Promise<boolean> {
  const t = useTranslations("pwaWindows");
  return useCallback(async (data: Omit<ProComposeTabData, "sessionId">) => {
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
}

type Presence = "present" | "gone";
type LiveState = Pick<Email, "keywords" | "mailboxIds">;

/**
 * Whether the message still exists, and in which folders. A JMAP move keeps
 * the id, so moved mail stays readable here; only its folders change. Asked
 * through `client`, the client of the window's own login, or not at all.
 */
function useMessagePresence(emailId: string, ownerAccountId: string | undefined, client: IJMAPClient | null): { presence: Presence; mailboxIds: string[] | null; liveState: LiveState | null } {
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
  // The window's own login only (the auth store's client while the login
  // table has no entry for the active one). When that login has no client
  // the window shows nothing of the message: through another login the same
  // id is another message, with other folders.
  useAuthStore((s) => s.connectedAccountsRevision);
  const client: IJMAPClient | null = useAuthStore((s) => (login
    ? s.getClientForAccount(login) ?? (login === s.activeAccountId ? s.client : null)
    : null));
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const [subject, setSubject] = useState<string | null>(null);
  const subjectInTitle = usePolicyStore((s) => s.loaded && s.isFeatureEnabled("tabTitleSubjectEnabled"));
  // In the desktop app, "<subject> - Bulwark" in the taskbar: the main window is the one with the account (desktop-p2-5).
  useDocumentTitle(subjectInTitle ? subject : null, { showAccount: !getDesktopBridge()?.windows });
  // Kept out where the organisation keeps subjects out of titles: the shell then says "Message".
  useDesktopWindowName(subjectInTitle ? subject : null);

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

  const { presence, mailboxIds, liveState } = useMessagePresence(emailId, ownerAccountId, client);
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

  const openCompose = useComposeWindow(login);

  if (!client) {
    return (
      <PopoutNotice title={t("session_ended_title")} body={t("session_ended_body")}>
        <Button onClick={closePopoutWindow}>{t("close_window")}</Button>
      </PopoutNotice>
    );
  }

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
        client={client}
        clientAccountId={login}
        accountId={ownerAccountId}
        onLoaded={handleLoaded}
        onClose={handleClose}
        onOpenCompose={openCompose}
        liveState={liveState}
        onMailChanged={handleMailChanged}
        noAutomaticActions={fromLink}
        conversation
        className="min-h-0 w-full flex-1"
      />
    </>
  );
}

/** `/popout/message/<id>`: one message in its own window, with no rail, sidebar or list. */
export function PopoutMessageApp({ id }: { id: string }) {
  const t = useTranslations();
  const [launch, setLaunch] = useState(() => readLaunch(id));
  const { pending, login } = useAddressLogin(launch.accountId);
  const openCompose = useComposeWindow(login);
  // A message from a file went into a folder: from now on the window is that message's,
  // and a reload opens it there.
  const onImported = useCallback((target: { emailId: string; ownerAccountId?: string }) => {
    window.history.replaceState(window.history.state, "", messagePopoutUrl({ emailId: target.emailId, localAccountId: login, ownerAccountId: target.ownerAccountId }));
    setLaunch({ emailId: target.emailId, accountId: login, ownerAccountId: target.ownerAccountId });
  }, [login]);
  if (pending) return <PopoutSkeleton label={t("pwaWindows.opening")} />;
  // Message and blob ids repeat across logins. An address that names no
  // login (a link made without one, an old bookmark) is the only login's
  // where there is one; with several it could be any of theirs, and the
  // window opens nothing instead of the active login's message with that id.
  if (!login && severalLogins()) {
    return (
      <PopoutShell kind="message">
        <PopoutNotice title={t("account_routing.link_names_no_account")}>
          <Button onClick={closePopoutWindow}>{t("pwaWindows.close_window")}</Button>
        </PopoutNotice>
      </PopoutShell>
    );
  }
  return (
    <PopoutShell kind="message" accountId={login}>
      {launch.blobId ? (
        <PopoutSavedMessage blobId={launch.blobId} name={launch.fileName} accountId={login} openCompose={openCompose} onImported={onImported} />
      ) : (
        <PopoutMessage key={launch.emailId} emailId={launch.emailId} accountId={login} ownerAccountId={launch.ownerAccountId} fromLink={launch.fromLink} />
      )}
    </PopoutShell>
  );
}
