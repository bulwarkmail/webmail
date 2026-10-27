"use client";

// Step 43, part D: a channel's integrations — incoming webhooks in Slack's
// format. Anyone in the channel adds one, copies its address into the other
// service (CI, monitoring, forms, Zapier), gives it a new address or removes it.
import { IconCopy, IconRefresh, IconTrash } from "@tabler/icons-react";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/browser-navigation";
import type { Room } from "@/lib/xenaxio/chat/client";
import { useXT } from "@/lib/xenaxio/i18n";
import { toast } from "@/stores/toast-store";
import { Modal, useChatDialogs } from "./dialogs";

export interface ChatHook {
  id: string;
  name: string;
  url: string;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

const headers = { Accept: "application/json", "Content-Type": "application/json", "x-xenaxio-csrf": "1" };
const base = (roomId: string) => `/api/chat/rooms/${encodeURIComponent(roomId)}/hooks`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method, credentials: "same-origin", headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `http_${res.status}`);
  return data;
}

export const chatHooks = {
  list: (roomId: string) => call<{ hooks: ChatHook[] }>("GET", base(roomId)).then((r) => r.hooks),
  create: (roomId: string, name: string) => call<ChatHook>("POST", base(roomId), { name }),
  rotate: (roomId: string, id: string) => call<ChatHook>("POST", `${base(roomId)}/${id}/rotate`),
  remove: (roomId: string, id: string) => call<{ ok: true }>("DELETE", `${base(roomId)}/${id}`),
};

/** A ready-to-run test command, like Slack shows one. */
export function curlExample(url: string): string {
  return `curl -X POST -H 'Content-type: application/json' --data '{"text":"Hallo aus xenaxio!"}' ${url}`;
}

export function IntegrationsDialog({ room, roomName, onClose }: { room: Room; roomName: string; onClose: () => void }) {
  const t = useXT();
  const locale = useLocale();
  const { confirm } = useChatDialogs();
  const [hooks, setHooks] = useState<ChatHook[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    chatHooks.list(room.id).then(setHooks, () => {
      setHooks([]);
      toast.error(t("chat.error"));
    });
  }, [room.id, t]);
  useEffect(load, [load]);

  const run = async (job: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await job();
      load();
    } catch (err) {
      toast.error((err as Error).message === "chat_hook_limit" ? t("chat.hooks_limit") : t("chat.error"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("chat.copied"));
    } catch {
      toast.error(t("chat.error"));
    }
  };

  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : t("chat.hooks_never"));

  return (
    <Modal title={t("chat.hooks_title", { name: roomName })} onClose={onClose} wide>
      <p className="text-sm text-muted-foreground">{t("chat.hooks_intro")}</p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const clean = name.trim();
          if (!clean) return;
          void run(async () => {
            await chatHooks.create(room.id, clean);
            setName("");
          });
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          placeholder={t("chat.hooks_name_hint")}
          aria-label={t("chat.hooks_name")}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button type="submit" disabled={busy || !name.trim()} className="h-9 shrink-0 rounded-md bg-primary px-3 text-sm text-primary-foreground disabled:opacity-50">
          {t("chat.hooks_add")}
        </button>
      </form>

      <div className="mt-4 space-y-3">
        {hooks === null && <p className="text-sm text-muted-foreground">{t("chat.loading")}</p>}
        {hooks?.length === 0 && <p className="text-sm text-muted-foreground">{t("chat.hooks_none")}</p>}
        {hooks?.map((h) => (
          <div key={h.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="rounded bg-muted px-1.5 text-[10px] font-semibold uppercase text-muted-foreground">{t("chat.app")}</span>
              <span className="min-w-0 flex-1 truncate font-semibold">{h.name}</span>
              <button type="button" disabled={busy} onClick={async () => (await confirm({ title: t("chat.hooks_rotate"), message: t("chat.hooks_rotate_confirm"), confirmText: t("chat.hooks_rotate") })) && void run(() => chatHooks.rotate(room.id, h.id))} className="rounded p-1 hover:bg-accent" title={t("chat.hooks_rotate")} aria-label={t("chat.hooks_rotate")}>
                <IconRefresh size={16} />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => (await confirm({ title: t("chat.hooks_remove"), message: t("chat.hooks_remove_confirm", { name: h.name }), confirmText: t("chat.hooks_remove"), variant: "destructive" })) && void run(() => chatHooks.remove(room.id, h.id))}
                className="rounded p-1 text-destructive hover:bg-accent"
                title={t("chat.hooks_remove")}
                aria-label={t("chat.hooks_remove")}
              >
                <IconTrash size={16} />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" title={h.url}>
                {h.url}
              </code>
              <button type="button" onClick={() => void copy(h.url)} className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-accent">
                <IconCopy size={14} />
                {t("chat.hooks_copy")}
              </button>
            </div>
            <button type="button" onClick={() => void copy(curlExample(h.url))} className="mt-1 text-xs text-primary hover:underline">
              {t("chat.hooks_copy_test")}
            </button>
            <div className="mt-1 text-xs text-muted-foreground">
              {t("chat.hooks_meta", { who: h.createdBy ?? "–", created: date(h.createdAt), used: date(h.lastUsedAt) })}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t("chat.hooks_secret_note")}</p>
    </Modal>
  );
}
