"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Undo } from "@/components/icons";
import { SettingsSection } from "@/components/settings/settings-section";
import { usePolicyStore } from "@/stores/policy-store";
import { useRecoveryStore } from "@/stores/recovery-store";
import { toast } from "@/stores/toast-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDeletedItemsRecovery } from "@/hooks/use-deleted-items-recovery";
import { cn } from "@/lib/utils";
import { classifyArchiveError, visibleArchivedItems, type ArchivedEmail } from "@/lib/recovery/archived-items";

type ListState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; items: ArchivedEmail[]; nextPosition: number | null; loadingOlder: boolean };

interface Outcome {
  restored: number;
  failed: number;
  /** No longer in the archive: restored elsewhere, or the server stopped keeping it. */
  gone: number;
}

const NO_OUTCOME: Outcome = { restored: 0, failed: 0, gone: 0 };

/**
 * Settings > Recover deleted items: the messages the user deleted for good
 * that Stalwart still keeps (Enterprise, `archiveDeletedItemsFor`), newest
 * first, limited to the admin's `organisation.recovery.days`, read in pages
 * with "Show older" past 2000. Restoring asks the server to put them back in
 * the Inbox; it does that in the background.
 */
export function RecoverDeletedSettings() {
  const t = useTranslations("recover_deleted");
  const format = useFormatter();
  const hour12 = useSettingsStore((s) => s.timeFormat) === "12h";
  const { available, client, key } = useDeletedItemsRecovery();
  const days = usePolicyStore((s) => s.getOrganisation().recovery.days);
  const record = useRecoveryStore((s) => s.record);
  const forgetRecent = useRecoveryStore((s) => s.forgetRecent);

  const [list, setList] = useState<ListState>({ status: "loading" });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [restoring, setRestoring] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(NO_OUTCOME);

  // The account the page shows now: answers for another one are dropped.
  const keyRef = useRef(key);
  useEffect(() => {
    keyRef.current = key;
  }, [key]);
  // An answer that arrives after a newer read started is dropped too.
  const readSeq = useRef(0);

  const refused = useCallback((error: unknown, forKey: string) => {
    // A refusal now (the license ran out) hides the page like detection would.
    if (classifyArchiveError(error) === "unsupported") record(forKey, "unsupported");
  }, [record]);

  const load = useCallback(async () => {
    if (!client?.listArchivedEmails || !key) return;
    const seq = ++readSeq.current;
    setList({ status: "loading" });
    setSelected(new Set());
    setOutcome(NO_OUTCOME);
    try {
      const result = await client.listArchivedEmails(undefined, { days });
      if (seq !== readSeq.current) return;
      setList({ status: "ready", items: result.items, nextPosition: result.nextPosition, loadingOlder: false });
    } catch (error) {
      if (seq !== readSeq.current) return;
      refused(error, key);
      setList({ status: "error" });
    }
  }, [client, key, days, refused]);

  useEffect(() => {
    if (!available) return;
    void load();
    const reads = readSeq;
    return () => {
      reads.current++;
    };
  }, [available, load]);

  const items = useMemo(() => (list.status === "ready" ? visibleArchivedItems(list.items, days) : []), [list, days]);

  if (!available || !client || !key) return null;

  const showOlder = async () => {
    if (list.status !== "ready" || list.nextPosition === null || list.loadingOlder || !client.listArchivedEmails) return;
    const seq = readSeq.current;
    const start = list.nextPosition;
    setList({ ...list, loadingOlder: true });
    try {
      const result = await client.listArchivedEmails(undefined, { days, startPosition: start });
      if (seq !== readSeq.current) return;
      setList((prev) => {
        if (prev.status !== "ready") return prev;
        const known = new Set(prev.items.map((item) => item.id));
        return { status: "ready", items: [...prev.items, ...result.items.filter((item) => !known.has(item.id))], nextPosition: result.nextPosition, loadingOlder: false };
      });
    } catch (error) {
      if (seq !== readSeq.current) return;
      refused(error, key);
      setList((prev) => (prev.status === "ready" ? { ...prev, loadingOlder: false } : prev));
      toast.error(t("load_failed"));
    }
  };

  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)));
  const nothingSelected = !items.some((item) => selected.has(item.id));

  const restore = async () => {
    const ids = items.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (restoring || ids.length === 0 || !client.restoreArchivedItems) return;
    const forKey = key;
    const seq = readSeq.current;
    setRestoring(true);
    try {
      const results = await client.restoreArchivedItems(ids);
      forgetRecent(forKey);
      if (results.some((r) => r.type === "forbidden")) record(forKey, "unsupported");
      // Another account (or a reload of the list) since: none of this applies to what is shown now.
      if (keyRef.current !== forKey || seq !== readSeq.current) return;
      const done = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const gone = new Set(results.filter((r) => !r.ok && r.type === "notFound").map((r) => r.id));
      const failed = ids.filter((id) => !done.has(id) && !gone.has(id));
      setOutcome({ restored: done.size, failed: failed.length, gone: gone.size });
      // Restored and vanished items leave the list; the ones that failed stay selected to try again.
      setList((prev) => (prev.status === "ready" ? { ...prev, items: prev.items.filter((item) => !done.has(item.id) && !gone.has(item.id)) } : prev));
      setSelected(new Set(failed));
      if (done.size > 0) toast.success(t("restored", { count: done.size }));
      if (failed.length > 0) toast.error(t("restore_partial", { count: failed.length }));
    } finally {
      setRestoring(false);
    }
  };

  const dateOf = (iso: string | null) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short", hour12 }) : "");
  const outcomeLines = [
    outcome.restored > 0 ? t("restored", { count: outcome.restored }) : null,
    outcome.gone > 0 ? t("restore_gone", { count: outcome.gone }) : null,
  ].filter((line): line is string => !!line);

  return (
    <SettingsSection id="recover-deleted" title={t("title")} description={t("description")}>
      <p className="text-sm text-muted-foreground" data-testid="recover-deleted-range">
        {days > 0 ? t("range_days", { days }) : t("range_all")}
      </p>

      {list.status === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="recover-deleted-loading">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("loading")}
        </p>
      )}

      {list.status === "error" && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert" data-testid="recover-deleted-error">
          <span>{t("load_failed")}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>{t("retry")}</Button>
        </div>
      )}

      {list.status === "ready" && (
        <div className="space-y-3">
          {/* Always there, so what a restore did is read out while focus stays on the button. */}
          <div role="status" className="space-y-1 text-sm" data-testid="recover-deleted-status">
            {outcomeLines.map((line) => <p key={line} className="text-muted-foreground">{line}</p>)}
            {outcome.failed > 0 && (
              <p className="text-destructive" data-testid="recover-deleted-partial">{t("restore_partial", { count: outcome.failed })}</p>
            )}
          </div>

          {items.length === 0 ? (
            <div className="space-y-1" data-testid="recover-deleted-empty">
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
              <p className="text-xs text-muted-foreground">{t("empty_hint")}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-h-11 items-center gap-2 pe-2 text-sm sm:min-h-0">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} data-testid="recover-deleted-select-all" />
                  <span>{selected.size > 0 ? t("selected", { count: selected.size }) : t("select_all")}</span>
                </label>
                <div className="ms-auto flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void load()} disabled={restoring} aria-label={t("refresh")}>
                    <RefreshCw className="h-4 w-4 sm:me-2" />
                    <span className="hidden sm:inline">{t("refresh")}</span>
                  </Button>
                  {/* Never `disabled`: the button keeps focus through a restore. */}
                  <Button
                    size="sm"
                    onClick={() => void restore()}
                    aria-disabled={restoring || nothingSelected}
                    aria-busy={restoring}
                    className={cn((restoring || nothingSelected) && "cursor-not-allowed opacity-50")}
                    data-testid="recover-deleted-restore"
                  >
                    {restoring ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Undo className="me-2 h-4 w-4" />}
                    {t("restore")}
                  </Button>
                </div>
              </div>

              <ul className="divide-y divide-border rounded-md border border-border" data-testid="recover-deleted-list">
                {items.map((item) => {
                  const sender = item.fromName || item.fromEmail || t("unknown_sender");
                  const checkboxId = `recover-${item.id}`;
                  return (
                    <li key={item.id} className="flex items-start gap-3 px-3 py-3" data-testid="recover-deleted-row">
                      <input
                        id={checkboxId}
                        type="checkbox"
                        className="mt-1 shrink-0"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        disabled={restoring}
                      />
                      <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer">
                        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                          <span className="truncate text-sm font-medium" title={item.fromEmail || undefined}>{sender}</span>
                          {item.receivedAt && <span className="shrink-0 text-xs text-muted-foreground sm:ms-auto">{dateOf(item.receivedAt)}</span>}
                        </div>
                        <div className="truncate text-sm">{item.subject || t("no_subject")}</div>
                        <div className="text-xs text-muted-foreground">{t("deleted_on", { date: dateOf(item.archivedAt) })}</div>
                      </label>
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-muted-foreground">{t("restore_hint")}</p>
            </>
          )}

          {list.nextPosition !== null && (
            <Button variant="outline" size="sm" onClick={() => void showOlder()} disabled={list.loadingOlder} data-testid="recover-deleted-show-older">
              {list.loadingOlder && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t("show_older")}
            </Button>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
