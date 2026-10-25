"use client";

// Step 31: shared mailboxes (info@, rechnung@). The admin creates them and
// decides per employee: read (read and sort mail) or read and send from the
// shared address. They take no employee seat; the company has its own limit.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pencil, Plus } from "@/components/icons";
import { Field, Notice, TextField } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorKey, errorText, type SharedMailbox, type WorkspaceDomain, type WorkspaceUser, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

const MB = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  return `${(bytes / MB).toLocaleString(undefined, { maximumFractionDigits: bytes < 10 * MB ? 1 : 0 })} MB`;
}

type Level = "none" | "read" | "send";

function SharedEditor({ mailbox, users, maxQuotaBytes, onChanged, onMessage }: {
  mailbox: SharedMailbox;
  users: WorkspaceUser[];
  maxQuotaBytes: number;
  onChanged: () => Promise<void>;
  onMessage: (m: { kind: "error" | "success"; text: string }) => void;
}) {
  const t = useXT();
  const [levels, setLevels] = useState<Record<string, Level>>(() =>
    Object.fromEntries(users.map((u) => {
      const entry = mailbox.access.find((a) => a.userId === u.id);
      return [u.id, entry ? (entry.canSend ? "send" : "read") : "none"];
    })),
  );
  const [aliases, setAliases] = useState(mailbox.aliases.join(", "));
  const [quotaMb, setQuotaMb] = useState(String(Math.round(mailbox.quotaBytes / MB)));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string; field?: "aliases" } | null>(null);
  const run = async (action: () => Promise<unknown>, success: string, field?: "aliases") => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setNotice({ kind: "success", text: success });
      await onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err), field });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const typed = window.prompt(t("shared.delete_prompt", { email: mailbox.email }));
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== mailbox.email.toLowerCase()) {
      setNotice({ kind: "error", text: t("users.delete_mismatch") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await xenaxio.deleteSharedMailbox(mailbox.id);
      onMessage({ kind: "success", text: t("users.deleted", { email: mailbox.email }) });
      await onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err) });
      setBusy(false);
    }
  };
  const access = Object.entries(levels)
    .filter(([, level]) => level !== "none")
    .map(([userId, level]) => ({ userId, canSend: level === "send" }));
  const aliasError = notice?.kind === "error" && notice.field === "aliases" ? notice.text : undefined;

  return (
    <div className="space-y-4 rounded-md bg-muted/50 p-3">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => xenaxio.setSharedMailboxAccess(mailbox.id, access), t("shared.access_saved"));
        }}
      >
        <p className="text-sm font-medium">{t("shared.access")}</p>
        <p className="text-xs text-muted-foreground">{t("shared.access_hint")}</p>
        <ul className="space-y-2">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-sm">
                <span className="block truncate">{u.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {u.email}
                  {u.status === "disabled" ? ` · ${t("users.disabled_badge")}` : ""}
                </span>
              </span>
              <select
                aria-label={t("shared.access_for", { name: u.displayName })}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={levels[u.id] ?? "none"}
                onChange={(e) => setLevels({ ...levels, [u.id]: e.target.value as Level })}
              >
                <option value="none">{t("shared.level_none")}</option>
                <option value="read">{t("shared.level_read")}</option>
                <option value="send">{t("shared.level_send")}</option>
              </select>
            </li>
          ))}
        </ul>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>{t("shared.access_save")}</Button>
      </form>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          const list = aliases.split(/[,\s]+/).map((a) => a.trim().toLowerCase()).filter(Boolean);
          void run(() => xenaxio.setSharedMailboxAliases(mailbox.id, list), t("users.aliases_saved"), "aliases");
        }}
      >
        <TextField label={t("users.aliases")} hint={t("users.aliases_hint", { domain: mailbox.email.split("@")[1] ?? "" })} error={aliasError} value={aliases} onChange={(e) => setAliases(e.target.value)} autoCapitalize="none" spellCheck={false} />
        <Button type="submit" size="sm" variant="outline" disabled={busy}>{t("users.aliases_save")}</Button>
      </form>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => xenaxio.setSharedMailboxQuota(mailbox.id, Number(quotaMb)), t("users.quota_saved"));
        }}
      >
        <TextField
          label={t("users.quota")}
          hint={t("users.quota_hint", { max: Math.round(maxQuotaBytes / MB).toLocaleString() })}
          type="number"
          min={100}
          max={Math.round(maxQuotaBytes / MB)}
          value={quotaMb}
          onChange={(e) => setQuotaMb(e.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !Number(quotaMb)}>{t("users.quota_save")}</Button>
      </form>
      <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void remove()}>
        {t("users.delete")}
      </Button>
      {notice && !aliasError && <Notice kind={notice.kind}>{notice.text}</Notice>}
    </div>
  );
}

function SharedView() {
  const t = useXT();
  const me = useMe();
  const [domains, setDomains] = useState<WorkspaceDomain[]>([]);
  const [mailboxes, setMailboxes] = useState<SharedMailbox[] | null>(null);
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [limit, setLimit] = useState(0);
  const [maxQuota, setMaxQuota] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: "", localPart: "", domainId: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await xenaxio.sharedMailboxes();
      setMailboxes(res.sharedMailboxes);
      setLimit(res.limits.maxSharedMailboxes);
      setMaxQuota(res.limits.mailboxQuotaBytes);
      setUsers((await xenaxio.users()).users);
      setDomains((await xenaxio.domains()).domains);
    } catch (err) {
      setMessage({ kind: "error", text: t(errorKey(err)) });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { domainId, ...rest } = form;
      const created = await xenaxio.createSharedMailbox({ ...rest, localPart: form.localPart.trim().toLowerCase(), ...(domainId ? { domainId } : {}) });
      setForm({ displayName: "", localPart: "", domainId });
      setMessage({ kind: "success", text: t("shared.created", { email: created.email }) });
      await load();
      setEditing(created.id);
    } catch (err) {
      setMessage({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  if (!mailboxes) return message ? <Notice kind="error">{message.text}</Notice> : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  const names = new Map(users.map((u) => [u.id, u.displayName]));

  return (
    <div className="space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <p className="text-sm text-muted-foreground">{t("shared.intro")}</p>

      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
        <h2 className="font-medium">{t("shared.add")}</h2>
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2" noValidate>
          <TextField label={t("shared.name")} hint={t("shared.name_hint")} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} required />
          <Field label={t("users.address")} htmlFor="new-shared-address">
            <div className="flex items-center gap-2">
              <Input
                id="new-shared-address"
                value={form.localPart}
                onChange={(e) => setForm({ ...form, localPart: e.target.value })}
                placeholder="info"
                autoCapitalize="none"
                spellCheck={false}
                className="flex-1 min-w-0"
                required
              />
              {domains.length > 1 ? (
                <select
                  aria-label={t("users.domain")}
                  className="h-9 max-w-[55%] rounded-md border border-input bg-background px-2 text-sm"
                  value={form.domainId || domains[0]?.id}
                  onChange={(e) => setForm({ ...form, domainId: e.target.value })}
                >
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      {`@${d.name}${d.status === "active" ? "" : ` (${t("domain.status_pending")})`}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-muted-foreground truncate max-w-[50%]">@{domains[0]?.name ?? me.user.email.split("@")[1]}</span>
              )}
            </div>
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy || !form.displayName || !form.localPart || mailboxes.length >= limit}>
              <Plus className="w-4 h-4 mr-1.5" />
              {busy ? t("users.creating") : t("users.create")}
            </Button>
          </div>
        </form>
      </section>

      <section className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("shared.count", { count: mailboxes.length, limit })}</p>
        {mailboxes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("shared.empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {mailboxes.map((m) => {
              const senders = m.access.filter((a) => a.canSend).map((a) => names.get(a.userId) ?? "?");
              const readers = m.access.filter((a) => !a.canSend).map((a) => names.get(a.userId) ?? "?");
              return (
                <li key={m.id} className="p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{m.displayName}</p>
                      <p className="text-sm text-muted-foreground truncate">{m.email}</p>
                      {m.aliases.length > 0 && <p className="text-xs text-muted-foreground truncate">{m.aliases.join(", ")}</p>}
                      <p className="text-xs text-muted-foreground">
                        {t("users.used", { used: m.usedBytes != null ? formatBytes(m.usedBytes) : "–", quota: formatBytes(m.quotaBytes) })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {m.access.length === 0
                          ? t("shared.nobody")
                          : [senders.length ? t("shared.senders", { names: senders.join(", ") }) : "", readers.length ? t("shared.readers", { names: readers.join(", ") }) : ""].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setEditing(editing === m.id ? null : m.id)} aria-expanded={editing === m.id}>
                      <Pencil className="w-4 h-4 mr-1.5" />
                      {t("users.edit")}
                    </Button>
                  </div>
                  {editing === m.id && (
                    <SharedEditor
                      key={`${m.id}-${m.aliases.join()}-${m.quotaBytes}-${m.access.map((a) => `${a.userId}${a.canSend}`).join()}`}
                      mailbox={m}
                      users={users}
                      maxQuotaBytes={maxQuota}
                      onChanged={load}
                      onMessage={setMessage}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function SharedMailboxesPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("shared.title")} backHref="/workspace" requireAdmin>
      <SharedView />
    </WorkspaceShell>
  );
}
