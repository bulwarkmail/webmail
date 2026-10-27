"use client";

// Step 43, part D: "In Chat teilen" on an open e-mail. Posts a card (subject,
// sender, beginning) with an optional note into a channel or a direct message.
// The e-mail itself stays in the mailbox: the card's link opens it only for
// people who have it (their own mail or a shared mailbox like info@).
import { IconHash, IconLock, IconMessageShare } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Email } from "@/lib/jmap/types";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import type { Room } from "@/lib/xenaxio/chat/client";
import { emailShareContent } from "@/lib/xenaxio/chat/format";
import { useChatStore } from "@/lib/xenaxio/chat/store";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { cn } from "@/lib/utils";
import { Modal } from "./dialogs";

type ShareableEmail = Pick<Email, "id" | "subject" | "from" | "preview" | "receivedAt">;

function ShareDialog({ email, onClose }: { email: ShareableEmail; onClose: () => void }) {
  const t = useXT();
  const client = useChatStore((s) => s.client);
  const connect = useChatStore((s) => s.connect);
  useChatStore((s) => s.version);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void connect();
  }, [connect]);

  const rooms = useMemo(() => {
    if (!client?.ready) return [];
    const q = query.trim().toLowerCase().replace(/^#/, "");
    return [...client.rooms.values()]
      .filter((r) => r.membership === "join" && (r.kind === "channel" || r.kind === "dm") && !r.archived && client.can(r, "send"))
      .filter((r) => !q || client.roomName(r).toLowerCase().includes(q))
      .sort((a, b) => b.lastTs - a.lastTs)
      .slice(0, 50);
  }, [client, query, client?.ready, client?.rooms.size]); // eslint-disable-line react-hooks/exhaustive-deps -- the client changes in place

  const share = async () => {
    if (!client || !target) return;
    const sender = email.from?.[0];
    setBusy(true);
    try {
      await client.send(
        target,
        emailShareContent(
          { emailId: email.id, subject: email.subject ?? "", from: sender?.name || sender?.email || "", fromEmail: sender?.email ?? "", preview: email.preview ?? "", date: email.receivedAt ?? null },
          note,
          t("chat.email_no_subject"),
        ),
      );
      toast.success(t("chat.email_shared", { name: client.roomName(client.rooms.get(target) as Room) }));
      onClose();
    } catch {
      toast.error(t("chat.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("chat.email_share_title")} onClose={onClose}>
      <div className="rounded-md border border-border bg-muted/40 p-2 text-sm">
        <div className="truncate font-semibold">{email.subject || t("chat.email_no_subject")}</div>
        <div className="truncate text-xs text-muted-foreground">{email.from?.[0]?.name || email.from?.[0]?.email}</div>
      </div>
      {!client?.ready ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("chat.loading")}</p>
      ) : (
        <>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chat.email_share_search")}
            className="mt-3 h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border" role="listbox" aria-label={t("chat.email_share_where")}>
            {rooms.length === 0 && <div className="p-3 text-sm text-muted-foreground">{t("chat.no_results")}</div>}
            {rooms.map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={target === r.id}
                onClick={() => setTarget(r.id)}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent", target === r.id && "bg-primary text-primary-foreground hover:bg-primary")}
              >
                {r.kind === "dm" ? <span className="w-4 text-center">@</span> : r.joinRule === "public" ? <IconHash size={15} /> : <IconLock size={15} />}
                <span className="truncate">{client.roomName(r)}</span>
              </button>
            ))}
          </div>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder={t("chat.email_share_note")}
            className="mt-3 w-full resize-none rounded-md border border-input bg-transparent p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t("chat.email_share_hint")}</p>
        </>
      )}
      <div className="mt-3 flex justify-end">
        <button type="button" disabled={!target || busy} onClick={() => void share()} className="h-9 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">
          {t("chat.email_share_send")}
        </button>
      </div>
    </Modal>
  );
}

/** The button in the e-mail's toolbar; only when the company's chat is on for this person. */
export function ShareToChatButton({ email }: { email: ShareableEmail }) {
  const t = useXT();
  const enabled = useChatStore((s) => !!s.status?.enabled);
  const loadStatus = useChatStore((s) => s.loadStatus);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (XENAXIO_BFF) void loadStatus();
  }, [loadStatus]);
  if (!XENAXIO_BFF || !enabled) return null;
  return (
    <>
      <Button variant="ghost" size="sm" className="sm:flex sm:flex-row sm:h-8 sm:gap-1.5 sm:py-0" title={t("chat.email_share")} onClick={() => setOpen(true)}>
        <IconMessageShare className="w-4 h-4" />
        <span className="hidden sm:inline text-sm">{t("chat.email_share")}</span>
      </Button>
      {open && <ShareDialog email={email} onClose={() => setOpen(false)} />}
    </>
  );
}
