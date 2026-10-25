"use client";

// Step 31: resources (meeting room, vehicle, equipment). Everyone books one by
// inviting it to an event; the platform accepts free times and declines
// overlaps. The admin creates them and picks who manages their bookings.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pencil, Plus } from "@/components/icons";
import { Field, Notice, TextField } from "@/components/xenaxio/ui";
import { useMe, WorkspaceShell } from "@/components/xenaxio/workspace-shell";
import { errorKey, errorText, type WorkspaceDomain, type WorkspaceResource, type WorkspaceUser, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

const TYPES: WorkspaceResource["type"][] = ["room", "vehicle", "equipment"];

/** "Besprechungsraum 1" → "besprechungsraum-1": a suggestion for the address. */
function suggestLocalPart(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function ResourceEditor({ resource, users, onChanged, onMessage }: {
  resource: WorkspaceResource;
  users: WorkspaceUser[];
  onChanged: () => Promise<void>;
  onMessage: (m: { kind: "error" | "success"; text: string }) => void;
}) {
  const t = useXT();
  const [managers, setManagers] = useState<Set<string>>(() => new Set(resource.managers));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await xenaxio.setResourceManagers(resource.id, [...managers]);
      setNotice({ kind: "success", text: t("resources.managers_saved") });
      await onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const typed = window.prompt(t("resources.delete_prompt", { email: resource.email }));
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== resource.email.toLowerCase()) {
      setNotice({ kind: "error", text: t("users.delete_mismatch") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await xenaxio.deleteResource(resource.id);
      onMessage({ kind: "success", text: t("users.deleted", { email: resource.email }) });
      await onChanged();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(t, err) });
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4 rounded-md bg-muted/50 p-3">
      <form className="space-y-2" onSubmit={save}>
        <p className="text-sm font-medium">{t("resources.managers")}</p>
        <p className="text-xs text-muted-foreground">{t("resources.managers_hint")}</p>
        <ul className="space-y-1">
          {users.map((u) => (
            <li key={u.id}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={managers.has(u.id)}
                  onChange={(e) => {
                    const next = new Set(managers);
                    if (e.target.checked) next.add(u.id);
                    else next.delete(u.id);
                    setManagers(next);
                  }}
                />
                <span className="min-w-0 truncate">
                  {u.displayName} <span className="text-muted-foreground">{u.email}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>{t("resources.managers_save")}</Button>
      </form>
      <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => void remove()}>
        {t("users.delete")}
      </Button>
      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
    </div>
  );
}

function ResourcesView() {
  const t = useXT();
  const me = useMe();
  const [domains, setDomains] = useState<WorkspaceDomain[]>([]);
  const [resources, setResources] = useState<WorkspaceResource[] | null>(null);
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [limit, setLimit] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ displayName: "", localPart: "", type: "room" as WorkspaceResource["type"], domainId: "" });
  const [addressTouched, setAddressTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await xenaxio.resources();
      setResources(res.resources);
      setLimit(res.limits.maxResources);
      setUsers((await xenaxio.users()).users.filter((u) => u.status === "active"));
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
      const created = await xenaxio.createResource({ ...rest, localPart: form.localPart.trim().toLowerCase(), ...(domainId ? { domainId } : {}) });
      setForm({ displayName: "", localPart: "", type: form.type, domainId });
      setAddressTouched(false);
      setMessage({ kind: "success", text: t("resources.created", { email: created.email }) });
      await load();
    } catch (err) {
      setMessage({ kind: "error", text: errorText(t, err) });
    } finally {
      setBusy(false);
    }
  };

  if (!resources) return message ? <Notice kind="error">{message.text}</Notice> : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  const names = new Map(users.map((u) => [u.id, u.displayName]));

  return (
    <div className="space-y-6">
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      <p className="text-sm text-muted-foreground">{t("resources.intro")}</p>

      <section className="rounded-lg border border-border bg-card p-4 space-y-4">
        <h2 className="font-medium">{t("resources.add")}</h2>
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2" noValidate>
          <TextField
            label={t("resources.name")}
            hint={t("resources.name_hint")}
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value, ...(addressTouched ? {} : { localPart: suggestLocalPart(e.target.value) }) })}
            required
          />
          <Field label={t("resources.type")} htmlFor="new-resource-type">
            <select
              id="new-resource-type"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as WorkspaceResource["type"] })}
            >
              {TYPES.map((type) => (
                <option key={type} value={type}>{t(`resources.type_${type}`)}</option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("users.address")} htmlFor="new-resource-address" hint={t("resources.address_hint")}>
              <div className="flex items-center gap-2">
                <Input
                  id="new-resource-address"
                  value={form.localPart}
                  onChange={(e) => {
                    setAddressTouched(true);
                    setForm({ ...form, localPart: e.target.value });
                  }}
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
                      <option key={d.id} value={d.id}>{`@${d.name}`}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm text-muted-foreground truncate max-w-[50%]">@{domains[0]?.name ?? me.user.email.split("@")[1]}</span>
                )}
              </div>
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy || !form.displayName || !form.localPart || resources.length >= limit}>
              <Plus className="w-4 h-4 mr-1.5" />
              {busy ? t("users.creating") : t("users.create")}
            </Button>
          </div>
        </form>
      </section>

      <section className="space-y-2">
        <p className="text-sm text-muted-foreground">{t("resources.count", { count: resources.length, limit })}</p>
        {resources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("resources.empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {resources.map((r) => (
              <li key={r.id} className="p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      {r.displayName} <span className="ml-1 rounded-full bg-muted px-2 py-0.5 text-xs font-normal">{t(`resources.type_${r.type}`)}</span>
                    </p>
                    <p className="text-sm text-muted-foreground truncate">{r.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.managers.length === 0 ? t("resources.managers_none") : t("resources.managers_list", { names: r.managers.map((id) => names.get(id) ?? "?").join(", ") })}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setEditing(editing === r.id ? null : r.id)} aria-expanded={editing === r.id}>
                    <Pencil className="w-4 h-4 mr-1.5" />
                    {t("users.edit")}
                  </Button>
                </div>
                {editing === r.id && (
                  <ResourceEditor key={`${r.id}-${r.managers.join()}`} resource={r} users={users} onChanged={load} onMessage={setMessage} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default function ResourcesPage() {
  const t = useXT();
  return (
    <WorkspaceShell title={t("resources.title")} backHref="/workspace" requireAdmin>
      <ResourcesView />
    </WorkspaceShell>
  );
}
