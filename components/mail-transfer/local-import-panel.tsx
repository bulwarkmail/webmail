"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Search } from "@/components/icons";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopLocalImportBook, DesktopLocalImportCandidate, DesktopLocalImportFile, DesktopLocalImportScanResult } from "@/lib/desktop/types";
import { roleFor } from "@/lib/mail-import/engine";
import { durationWords, importHours, WORTH_SAYING_HOURS, type DurationWords } from "@/lib/mail-import/estimate";
import { formatFileSize } from "@/lib/utils";

type Scan = Extract<DesktopLocalImportScanResult, { ok: true }>;

export interface LocalPick {
  jobId: string;
  files: DesktopLocalImportFile[];
  contacts: string[];
  refused: string[];
  thunderbirdRunning: boolean;
}

type T = ReturnType<typeof useTranslations>;

export function durationText(t: T, words: DurationWords): string {
  return t(`duration_${words.unit}`, { count: words.count });
}

/** Trash and Junk start unticked: the upload limit is better spent on mail someone kept. */
function startsTicked(candidate: DesktopLocalImportCandidate): boolean {
  const role = candidate.folder.length === 1 ? roleFor(candidate.folder[0]) : undefined;
  return role !== "trash" && role !== "junk";
}

/** Inbox first, then by path, so a profile reads the way Thunderbird shows it. */
function byFolder(a: DesktopLocalImportCandidate, b: DesktopLocalImportCandidate): number {
  const rank = (c: DesktopLocalImportCandidate) => (c.folder.length === 1 && roleFor(c.folder[0]) === "inbox" ? 0 : 1);
  return rank(a) - rank(b) || a.folder.join("/").localeCompare(b.folder.join("/")) || a.name.localeCompare(b.name);
}

function ThunderbirdWarning({ t }: { t: T }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground" data-testid="local-import-running">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
      <span>{t("thunderbird_running")}</span>
    </p>
  );
}

function GroupList({
  title, candidates, ticked, onToggle, onToggleAll, t,
}: {
  title: string;
  candidates: DesktopLocalImportCandidate[];
  ticked: Set<string>;
  onToggle: (handle: string) => void;
  onToggleAll: (handles: string[], on: boolean) => void;
  t: T;
}) {
  const handles = candidates.map((c) => c.handle);
  const on = handles.filter((h) => ticked.has(h)).length;
  return (
    <div>
      <label className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-foreground">
        <input
          type="checkbox"
          className="rounded border-border"
          checked={on === handles.length}
          ref={(el) => { if (el) el.indeterminate = on > 0 && on < handles.length; }}
          onChange={(e) => onToggleAll(handles, e.target.checked)}
        />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </label>
      <ul className="border-t border-border">
        {candidates.map((c) => {
          const label = c.kind === "pst" ? c.name.replace(/^Outlook\//, "") : c.folder.join(" / ");
          return (
            <li key={c.handle}>
              <label className="flex items-center gap-2 py-1.5 pe-3 ps-8 text-sm text-foreground hover:bg-muted/50">
                <input type="checkbox" className="rounded border-border" checked={ticked.has(c.handle)} onChange={() => onToggle(c.handle)} data-testid="local-import-item" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {c.messages !== undefined && <>{t("message_count", { count: c.messages })} · </>}
                  {formatFileSize(c.size)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The desktop app's "find it for me": the shell asks natively before it looks, the user
 * ticks what to bring, and the shell asks again with the real paths before anything is
 * read. Handed up as files for the import dialog's ordinary run.
 */
export function LocalImportPanel({ onPick, onListing }: {
  onPick: (pick: LocalPick) => void;
  /** Whether the list is open: the rest of the dialog waits until it's answered. */
  onListing?: (listing: boolean) => void;
}) {
  const t = useTranslations("desktopImport");
  const bridge = getDesktopBridge()?.localImport;
  const [scan, setScan] = useState<Scan | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const groups = useMemo(() => {
    const out = new Map<string, DesktopLocalImportCandidate[]>();
    for (const c of scan?.candidates ?? []) {
      const key = c.app === "outlook" ? t("outlook_files") : `${t("thunderbird_profile", { name: c.group })}${c.account ? ` · ${c.account}` : ""}`;
      out.set(key, [...(out.get(key) ?? []), c]);
    }
    for (const list of out.values()) list.sort(byFolder);
    return [...out];
  }, [scan, t]);

  const selected = (scan?.candidates ?? []).filter((c) => ticked.has(c.handle));
  const selectedBooks = (scan?.books ?? []).filter((b) => ticked.has(b.handle));
  const selectedBytes = selected.reduce((n, c) => n + c.size, 0);
  const knownMessages = selected.reduce((n, c) => n + (c.messages ?? 0), 0);

  if (!bridge) return null;

  const find = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await bridge.scan();
      if (!result.ok) {
        setNote(result.reason === "declined" ? t("scan_declined") : result.reason === "failed" ? t("scan_failed") : null);
        return;
      }
      setScan(result);
      onListing?.(true);
      setTicked(new Set([...result.candidates.filter(startsTicked).map((c) => c.handle), ...result.books.map((b) => b.handle)]));
    } catch {
      setNote(t("scan_failed"));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await bridge.grant([...ticked]);
      if (!result.ok) {
        setNote(result.reason === "declined" ? t("read_declined") : result.reason === "invalid" ? t("read_failed") : null);
        return;
      }
      setScan(null);
      onListing?.(false);
      onPick({ jobId: result.jobId, files: result.files, contacts: result.contacts, refused: result.refused, thunderbirdRunning: result.thunderbirdRunning });
    } catch {
      setNote(t("read_failed"));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (handle: string) => setTicked((prev) => {
    const next = new Set(prev);
    if (!next.delete(handle)) next.add(handle);
    return next;
  });
  const toggleAll = (handles: string[], on: boolean) => setTicked((prev) => {
    const next = new Set(prev);
    for (const h of handles) if (on) next.add(h); else next.delete(h);
    return next;
  });

  if (!scan) {
    return (
      <div data-testid="local-import-panel">
        <Button variant="outline" onClick={() => void find()} disabled={busy} data-testid="local-import-find">
          <Search className="me-2" aria-hidden="true" />
          {t("find")}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">{t("find_hint")}</p>
        {note && <p role="status" className="mt-2 text-sm text-muted-foreground" data-testid="local-import-note">{note}</p>}
      </div>
    );
  }

  const nothing = scan.candidates.length === 0 && scan.books.length === 0;
  const ost = scan.refused.filter((r) => r.reason === "ost").map((r) => r.name);
  const inUse = scan.refused.filter((r) => r.reason === "in-use").map((r) => r.name);
  const hours = importHours({ bytes: selectedBytes, messages: knownMessages });

  return (
    <div className="space-y-3" data-testid="local-import-panel">
      {nothing && <p role="status" className="text-sm text-muted-foreground" data-testid="local-import-nothing">{t("nothing_found")}</p>}
      {scan.incomplete && <p role="status" className="text-sm text-foreground" data-testid="local-import-incomplete">{t("scan_incomplete")}</p>}
      {scan.thunderbirdRunning && <ThunderbirdWarning t={t} />}
      {!nothing && (
        <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label={t("found_list")} data-testid="local-import-list">
          {groups.map(([title, candidates]) => (
            <GroupList key={title} title={title} candidates={candidates} ticked={ticked} onToggle={toggle} onToggleAll={toggleAll} t={t} />
          ))}
          {scan.books.map((book: DesktopLocalImportBook) => (
            <label key={book.handle} className="flex items-center gap-2 px-3 py-2 text-sm text-foreground">
              <input type="checkbox" className="rounded border-border" checked={ticked.has(book.handle)} onChange={() => toggle(book.handle)} data-testid="local-import-book" />
              <span className="min-w-0 flex-1 truncate">{t("address_book", { name: book.group })}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t("contact_count", { count: book.contacts })}</span>
            </label>
          ))}
        </div>
      )}
      {selected.length > 0 && hours >= WORTH_SAYING_HOURS && (
        <p className="text-sm text-foreground" data-testid="local-import-estimate">
          {t("estimate", { size: formatFileSize(selectedBytes), time: durationText(t, durationWords(hours)) })}
        </p>
      )}
      {ost.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="local-import-ost">
          {t("ost_refused", { names: ost.join(", ") })}
        </p>
      )}
      {inUse.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="local-import-in-use">
          {t("pst_in_use", { names: inUse.join(", ") })}
        </p>
      )}
      {scan.calendars > 0 && <p className="text-xs text-muted-foreground" data-testid="local-import-calendars">{t("calendars_left_out")}</p>}
      {scan.candidates.some((c) => c.kind === "pst") && <p className="text-xs text-muted-foreground">{t("pst_items_left_out")}</p>}
      {note && <p role="status" className="text-sm text-muted-foreground" data-testid="local-import-note">{note}</p>}
      <div className="flex gap-2">
        {!nothing && (
          <Button onClick={() => void confirm()} disabled={busy || ticked.size === 0} data-testid="local-import-confirm">
            {t("confirm", { count: selected.length + selectedBooks.length })}
          </Button>
        )}
        <Button variant="outline" onClick={() => { setScan(null); setNote(null); onListing?.(false); }} disabled={busy}>{t("back")}</Button>
      </div>
    </div>
  );
}

export { ThunderbirdWarning };
