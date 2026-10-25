"use client";

// Step 27: the admin picks the mailbox that receives mail to addresses that
// do not exist on a domain of the company (catch-all), with a checkbox.
// Step 28: one setting per domain; any mailbox of the company can receive.
// Step 37: shared mailboxes (info@) too, in their own group of the list.
import { useCallback, useEffect, useState } from "react";
import { Notice } from "@/components/xenaxio/ui";
import { type CatchAll, type CatchAllTarget, type SharedMailbox, type WorkspaceUser, errorKey, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";

/** The list value of a mailbox: `user:<id>` or `shared:<id>`. */
function optionOf(c: CatchAll | null): string {
  if (c?.sharedMailboxId) return `shared:${c.sharedMailboxId}`;
  return c?.userId ? `user:${c.userId}` : "";
}

function targetOf(value: string): CatchAllTarget {
  const [kind, id] = value.split(":");
  if (!id) return null;
  return kind === "shared" ? { sharedMailboxId: id } : { userId: id };
}

export function CatchAllSettings({ domain, domainId }: { domain: string; domainId: string }) {
  const t = useXT();
  const [current, setCurrent] = useState<CatchAll | null | undefined>(undefined);
  const [users, setUsers] = useState<WorkspaceUser[]>([]);
  const [shared, setShared] = useState<SharedMailbox[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([xenaxio.catchAll(domainId), xenaxio.users(), xenaxio.sharedMailboxes()])
      .then(([res, list, sharedList]) => {
        const active = list.users.filter((u) => u.status === "active");
        setUsers(active);
        setShared(sharedList.sharedMailboxes);
        setCurrent(res.catchAll);
        // Off: the first admin is offered, so one click turns it on.
        const admin = (active.find((u) => u.role === "admin") ?? active[0])?.id;
        setSelected(optionOf(res.catchAll) || (admin ? `user:${admin}` : ""));
      })
      .catch((err) => setError(t(errorKey(err))));
  }, [t, domainId]);

  const save = useCallback(
    async (value: string | null) => {
      setBusy(true);
      setError(null);
      try {
        setCurrent((await xenaxio.setCatchAll(value ? targetOf(value) : null, domainId)).catchAll);
      } catch (err) {
        setError(t(errorKey(err)));
      } finally {
        setBusy(false);
      }
    },
    [t, domainId],
  );

  if (current === undefined) return error ? <Notice kind="error">{error}</Notice> : null;

  const on = current !== null;
  const userOptions = users.map((u) => (
    <option key={u.id} value={`user:${u.id}`}>
      {u.displayName} ({u.email})
    </option>
  ));
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="font-medium">{t("domain.catchall_title")}</h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={on}
          disabled={busy || (!on && !selected)}
          onChange={(e) => void save(e.target.checked ? selected : null)}
        />
        <span>
          <span className="font-medium">{t("domain.catchall_toggle")}</span>
          <span className="block text-xs text-muted-foreground">{t("domain.catchall_hint", { domain })}</span>
        </span>
      </label>
      <div className="space-y-1">
        <label htmlFor={`catch-all-mailbox-${domainId}`} className="text-sm text-muted-foreground">
          {t("domain.catchall_mailbox")}
        </label>
        <select
          id={`catch-all-mailbox-${domainId}`}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={selected}
          disabled={busy}
          onChange={(e) => {
            setSelected(e.target.value);
            if (on) void save(e.target.value);
          }}
        >
          {shared.length > 0 ? (
            <>
              <optgroup label={t("domain.catchall_group_users")}>{userOptions}</optgroup>
              <optgroup label={t("domain.catchall_group_shared")}>
                {shared.map((m) => (
                  <option key={m.id} value={`shared:${m.id}`}>
                    {m.displayName} ({m.email})
                  </option>
                ))}
              </optgroup>
            </>
          ) : (
            userOptions
          )}
        </select>
      </div>
      {on && <Notice kind="info">{t("domain.catchall_spam")} {t("domain.catchall_auto_off")}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
