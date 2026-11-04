"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import {
  AlertCircle, AlertTriangle, ArrowDown, ArrowUp, FolderSync, HardDrive, HelpCircle, Loader2, Trash2, type AppIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FolderPickerDialog, type PickerFolder } from "@/components/files/folder-picker-dialog";
import { FilesSyncStatusLine } from "@/components/files-sync/files-sync-status-line";
import { MassDeleteQuestion, useInlineMassDeleteQuestions } from "@/components/files-sync/files-sync-prompts";
import { activityMessage, rootName, syncTimeOptions } from "@/components/files-sync/files-sync-text";
import { fileNodeKind } from "@/lib/jmap/filenode-kind";
import { findTrashFolder, trashSubtreeIds } from "@/lib/files-trash";
import { cn, formatFileSize } from "@/lib/utils";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopOsStatus, FilesDriveState, FilesError, FilesRoot } from "@/lib/desktop/types";
import type { FilesSyncActivity, FilesSyncActivityKind } from "@/lib/files-sync/types";
import { filesQuotaLevel } from "@/lib/files-sync/drive-status";
import { requestFlush } from "@/lib/files-sync/flush-requests";
import { useAuthStore } from "@/stores/auth-store";
import { useFilesSyncStore } from "@/stores/files-sync-store";
import { OrgLockedNote } from "./org-locked-note";
import { SettingItem, SettingsSection, Select, ToggleSwitch } from "./settings-section";

/**
 * Settings > Files on this computer, in the desktop app only: the Files drive
 * (Windows), folders kept the same as a Files folder, and what happened lately.
 * Everything comes from stores/files-sync-store.ts and goes to the engine's
 * controller; the page never talks to the bridge.
 */
export function DesktopFilesSettings() {
  const available = useFilesSyncStore((s) => s.available);
  const drive = useFilesSyncStore((s) => s.drive);
  // The page asks about a mass delete in the folder's row; the app-wide dialog waits.
  useInlineMassDeleteQuestions();
  if (!available) return null;
  return (
    <div className="space-y-8" data-testid="files-sync-settings">
      <StorageSection />
      {drive && <DriveSection drive={drive} />}
      <FoldersSection />
      <ActivitySection />
    </div>
  );
}

/**
 * What the account's Files take: the server's limit when it sets one (the same numbers the
 * Files screen's storage ring and Explorer show), else what the files take, with no total.
 */
function StorageSection() {
  const t = useTranslations("files_storage");
  const quota = useFilesSyncStore((s) => s.quota);
  // Shown while the numbers load too, so a settings search for storage lands on it.
  if (!quota) {
    return (
      <SettingsSection id="storage" title={t("title")}>
        <div className="space-y-2" data-testid="files-sync-storage" aria-busy="true">
          <div className="h-2 w-full rounded-full bg-muted animate-pulse" />
          <div className="h-3 w-32 rounded bg-muted animate-pulse" />
        </div>
      </SettingsSection>
    );
  }
  const level = filesQuotaLevel(quota);
  const used = formatFileSize(quota.used);
  const percent = quota.total ? Math.min(100, (quota.used / quota.total) * 100) : 0;
  return (
    <SettingsSection id="storage" title={t("title")}>
      <div className="space-y-2" data-testid="files-sync-storage" data-quota-level={level}>
        <p className="text-sm text-foreground tabular-nums">
          {quota.total === null ? t("used", { used }) : t("used_of", { used, total: formatFileSize(quota.total) })}
        </p>
        {quota.total !== null ? (
          <div
            className="w-full bg-muted rounded-full h-1.5"
            role="progressbar"
            aria-label={t("title")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <div
              className={cn("h-1.5 rounded-full", level === "full" ? "bg-destructive" : level === "warn" ? "bg-warning" : "bg-success")}
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t("no_limit")}</p>
        )}
        {level !== "ok" && (
          <p className={cn("text-xs", level === "full" ? "text-destructive" : "text-muted-foreground")}>
            {t(level === "full" ? "full" : "almost_full")}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

/** The app's own settings (start at login), as main has them now. Null until it answered, or outside the app. */
function useOsStatus(): DesktopOsStatus | null {
  const os = getDesktopBridge()?.os;
  const [status, setStatus] = useState<DesktopOsStatus | null>(null);
  useEffect(() => {
    if (!os) return;
    let stale = false;
    void os.getStatus().then((next) => { if (!stale) setStatus(next); }, () => {});
    const stop = os.onStatusChange(setStatus);
    return () => {
      stale = true;
      stop();
    };
  }, [os]);
  return status;
}

/** What went wrong turning something on, in words. */
function addErrorKey(error: FilesError): string | null {
  if (error === "cancelled") return null;
  if (error === "overlap" || error === "denied" || error === "policy") return `folders.add_failed.${error}`;
  return "folders.add_failed.failed";
}

function DriveSection({ drive }: { drive: FilesDriveState }) {
  const t = useTranslations("files_sync");
  const tx = useTranslations("files_sync_extra.drive");
  const rescued = useFilesSyncStore((s) => s.rescued);
  const osStatus = useOsStatus();
  const startAtLogin = osStatus?.settings.startAtLogin ?? null;
  // Turning it on needs the click it came from, as the drive does: called in the same handler.
  const setStartAtLogin = (on: boolean) => {
    void getDesktopBridge()?.os?.setSettings({ startAtLogin: on }).catch(() => null);
  };
  const account = useFilesSyncStore((s) => s.account);
  const roots = useFilesSyncStore((s) => s.roots);
  const status = useFilesSyncStore((s) => s.status);
  const controller = useFilesSyncStore((s) => s.controller);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const on = !drive.forcedOff && !!account && drive.wanted.includes(account);
  const driveRoot = roots.find((r) => r.kind === "drive" && r.account === account);
  const { letter } = drive;
  const letterValue = (letter.locked ? letter.letter : letter.chosen) ?? "none";
  const letters = [...new Set([...letter.available, letter.chosen, letter.letter].filter((l): l is string => !!l))].sort();

  const toggle = (next: boolean) => {
    if (!controller) return;
    setError(null);
    setBusy(true);
    // Off: what waits here goes up first, or the user keeps the drive (files-p3-2). Nothing
    // waiting answers at once. On: straight from the click, which turning it on needs.
    const apply = () => controller.setDriveEnabled(next).then(
      (result) => { if (!result.ok) setError(addErrorKey(result.error)); },
      () => setError("folders.add_failed.failed"),
    );
    // The drive needs the app running, as OneDrive does: it starts with Windows from now on (files-p3-4).
    if (next && startAtLogin === false) setStartAtLogin(true);
    const done = next || !driveRoot
      ? apply()
      : requestFlush({ rootId: driveRoot.id, kind: "drive", purpose: "turn-off" }).then((go) => (go ? apply() : undefined));
    void done.finally(() => setBusy(false));
  };
  const chooseLetter = (value: string) => {
    if (!controller) return;
    setError(null);
    void controller.setDriveLetter(value === "none" ? null : value).then(
      (result) => { if (!result.ok) setError(addErrorKey(result.error)); },
      () => setError("folders.add_failed.failed"),
    );
  };

  return (
    <SettingsSection id="drive" title={t("drive.title")}>
      <SettingItem
        label={t("drive.label")}
        description={drive.supported ? t("drive.description") : t("drive.unsupported")}
        locked={drive.forcedOff}
      >
        <ToggleSwitch
          checked={on}
          disabled={!drive.supported || drive.forcedOff || !controller || !account || busy}
          testId="files-sync-drive-toggle"
          onChange={toggle}
        />
      </SettingItem>
      {on && driveRoot && <FilesSyncStatusLine status={status[driveRoot.id]} paused={driveRoot.paused} />}
      {on && startAtLogin !== null && (
        <div className="ms-4 ps-3 border-s-2 border-s-border py-1 space-y-1">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              checked={startAtLogin}
              onChange={(event) => setStartAtLogin(event.target.checked)}
              data-testid="files-sync-start-at-login"
            />
            <span className="min-w-0">
              <span className="block text-sm text-foreground">{tx("start_at_login")}</span>
              <span className="block text-xs text-muted-foreground">{tx("start_at_login_why")}</span>
            </span>
          </label>
          {!startAtLogin && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400" data-testid="files-sync-closed-warning">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
              <span>{tx("closed_warning")}</span>
            </p>
          )}
        </div>
      )}
      {on && <p className="text-xs text-muted-foreground" data-testid="files-sync-drive-off-note">{tx("off_note")}</p>}
      {rescued && (
        <div role="status" className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-2" data-testid="files-sync-rescued">
          <p className="text-sm text-foreground break-words" dir="auto">{tx("rescued", { count: rescued.count, folder: rescued.folder })}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => { void controller?.openRescue(); }}>{tx("rescued_open")}</Button>
            <Button size="sm" variant="ghost" onClick={() => controller?.dismissRescue()}>{tx("rescued_dismiss")}</Button>
          </div>
        </div>
      )}
      {on && driveRoot && status[driveRoot.id]?.state === "confirm-delete" && status[driveRoot.id]?.massDelete && (
        <MassDeleteQuestion root={driveRoot} status={status[driveRoot.id]} />
      )}
      {(on || letter.locked) && drive.supported && (
        <SettingItem label={t("drive.letter_label")} description={t("drive.letter_description")} locked={letter.locked}>
          <Select
            value={letterValue}
            disabled={letter.locked || !controller}
            onChange={chooseLetter}
            options={[
              { value: "none", label: t("drive.letter_none") },
              ...letters.map((l) => ({ value: l, label: `${l}:` })),
            ]}
          />
        </SettingItem>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
    </SettingsSection>
  );
}

/** The folders of the user's own Files, for the picker: no trash, nothing shared. */
async function loadFolders(): Promise<PickerFolder[]> {
  const client = useAuthStore.getState().client;
  if (!client) throw new Error("not signed in");
  const nodes = await client.listAllFileNodes();
  const inTrash = trashSubtreeIds(nodes, findTrashFolder(nodes)?.id);
  return nodes
    .filter((n) => fileNodeKind(n) === "directory" && !n.discoverableOnly && !n.isShared && !inTrash.has(n.id) && !n.id.includes(":"))
    .map((n) => ({ id: n.id, name: n.name, parentId: n.parentId ?? null }));
}

/** "Projects / 2026" for a folder, "My files" for the top. */
function folderLabel(folders: PickerFolder[], id: string | null, top: string): string {
  if (id === null) return top;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    names.unshift(cur.name);
  }
  return names.join(" / ") || top;
}

function FoldersSection() {
  const t = useTranslations("files_sync");
  const tFiles = useTranslations("files");
  const account = useFilesSyncStore((s) => s.account);
  const roots = useFilesSyncStore((s) => s.roots);
  const controller = useFilesSyncStore((s) => s.controller);
  const forcedOff = useFilesSyncStore((s) => s.folderSyncForcedOff);
  const [folders, setFolders] = useState<PickerFolder[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FilesRoot | null>(null);

  const folderRoots = roots.filter((r) => r.kind === "folder" && (!account || r.account === account));

  const openPicker = () => {
    setError(null);
    setLoading(true);
    loadFolders().then(setFolders, () => setError("folders.load_failed")).finally(() => setLoading(false));
  };
  // Called from the picker's button: the OS folder picker needs that click, so
  // nothing is awaited before addFolder.
  const pick = (remoteId: string | null) => {
    if (!controller) return;
    const label = folderLabel(folders ?? [], remoteId, tFiles("my_files"));
    void controller.addFolder(remoteId, label).then(
      (result) => { if (!result.ok) setError(addErrorKey(result.error)); },
      () => setError("folders.add_failed.failed"),
    );
  };

  return (
    <SettingsSection id="folders" title={t("folders.title")} description={t("folders.description")}>
      {forcedOff && (
        <div className="space-y-1" data-testid="files-sync-folders-locked">
          <OrgLockedNote />
          <p className="text-sm text-muted-foreground">{t("folders.forced_off")}</p>
        </div>
      )}
      {folderRoots.length === 0 ? (
        !forcedOff && <p className="text-sm text-muted-foreground">{t("folders.empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {folderRoots.map((root) => (
            <FolderRow key={root.id} root={root} onRemove={() => setRemoving(root)} />
          ))}
        </ul>
      )}
      {!forcedOff && (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={openPicker} disabled={loading || !controller} data-testid="files-sync-add-folder">
            {loading ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" /> : <FolderSync className="w-4 h-4" />}
            {loading ? t("folders.loading") : t("folders.add")}
          </Button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{t(error)}</p>}
      {folders && (
        <FolderPickerDialog
          isOpen
          onClose={() => setFolders(null)}
          onPick={pick}
          title={t("folders.pick_title")}
          confirmText={t("folders.pick_confirm")}
          folders={folders}
          // Nothing is "where it is now": every folder, My files too, can be picked.
          currentId="#none"
        />
      )}
      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (!removing || !controller) return;
          const rootId = removing.id;
          // What waits here goes up first; whatever can't stays in the folder (files-p3-2).
          void requestFlush({ rootId, kind: "folder", purpose: "stop-folder" }).then((go) => {
            if (go) return controller.removeRoot(rootId);
          }).catch(() => {});
        }}
        title={t("folders.remove_title")}
        message={t("folders.remove_message")}
        confirmText={t("folders.remove_confirm")}
        variant="destructive"
      />
    </SettingsSection>
  );
}

function FolderRow({ root, onRemove }: { root: FilesRoot; onRemove: () => void }) {
  const t = useTranslations("files_sync");
  const status = useFilesSyncStore((s) => s.status[root.id]);
  const controller = useFilesSyncStore((s) => s.controller);
  const paused = root.paused || status?.state === "paused";
  const blocked = status?.state === "blocked";
  return (
    <li className="p-3" data-files-sync-root={root.id}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-2.5 min-w-0">
          <FolderSync className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-foreground break-all" dir="auto">{root.path}</p>
            <p className="text-xs text-muted-foreground break-words">{t("folders.paired_with", { folder: root.remoteLabel })}</p>
            <FilesSyncStatusLine status={status} paused={root.paused} />
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {!blocked && (
            <Button
              size="sm"
              variant="outline"
              disabled={!controller}
              onClick={() => { void controller?.setPaused(root.id, !paused).catch(() => {}); }}
            >
              {paused ? t("folders.resume") : t("folders.pause")}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onRemove}>{t("folders.remove")}</Button>
        </div>
      </div>
      {status?.state === "confirm-delete" && status.massDelete && <MassDeleteQuestion root={root} status={status} />}
    </li>
  );
}

const ERROR_KINDS: ReadonlySet<FilesSyncActivityKind> = new Set(["error", "too-large"]);

function ActivityMark({ item }: { item: FilesSyncActivity }) {
  const t = useTranslations("files_sync");
  let mark: { icon: AppIcon; label: string; className: string } | null = null;
  if (ERROR_KINDS.has(item.kind)) mark = { icon: AlertCircle, label: t("activity.mark_error"), className: "text-destructive" };
  else if (item.kind === "conflict") mark = { icon: AlertTriangle, label: t("activity.mark_conflict"), className: "text-amber-600 dark:text-amber-400" };
  else if (item.kind === "mass-delete") mark = { icon: HelpCircle, label: t("activity.mark_question"), className: "text-amber-600 dark:text-amber-400" };
  else if (item.direction === "up") mark = { icon: ArrowUp, label: t("activity.to_files"), className: "text-muted-foreground" };
  else if (item.direction === "down") mark = { icon: ArrowDown, label: t("activity.to_computer"), className: "text-muted-foreground" };
  if (!mark) return <span className="w-3.5 shrink-0" aria-hidden="true" />;
  const Icon = mark.icon;
  return (
    <span role="img" aria-label={mark.label} title={mark.label} className="inline-flex shrink-0 mt-0.5">
      <Icon className={cn("w-3.5 h-3.5", mark.className)} aria-hidden="true" />
    </span>
  );
}

function ActivitySection() {
  const t = useTranslations("files_sync");
  const format = useFormatter();
  const activity = useFilesSyncStore((s) => s.activity);
  const roots = useFilesSyncStore((s) => s.roots);
  const controller = useFilesSyncStore((s) => s.controller);
  const items = useMemo(() => [...activity].sort((a, b) => b.at - a.at), [activity]);
  const rootById = useMemo(() => new Map(roots.map((r) => [r.id, r])), [roots]);

  const message = (item: FilesSyncActivity) => activityMessage(t, item, formatFileSize);

  return (
    <SettingsSection id="activity" title={t("activity.title")}>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("activity.empty")}</p>
      ) : (
        <ul className="max-h-96 overflow-y-auto divide-y divide-border/60 rounded-md border border-border" data-testid="files-sync-activity">
          {items.map((item) => {
            const root = rootById.get(item.rootId);
            const marked = ERROR_KINDS.has(item.kind) || item.kind === "conflict" || item.kind === "mass-delete";
            return (
              <li
                key={item.id}
                className={cn("flex items-start gap-2 px-3 py-2 text-sm", ERROR_KINDS.has(item.kind) && "bg-destructive/5", item.kind === "conflict" && "bg-amber-500/5")}
                data-activity-kind={item.kind}
              >
                <ActivityMark item={item} />
                <time dateTime={new Date(item.at).toISOString()} className="text-xs text-muted-foreground tabular-nums shrink-0 mt-0.5">
                  {format.dateTime(new Date(item.at), syncTimeOptions(item.at))}
                </time>
                {root && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0 max-w-[30%] mt-0.5">
                    {root.kind === "drive" ? <HardDrive className="w-3 h-3 shrink-0" aria-hidden="true" /> : <FolderSync className="w-3 h-3 shrink-0" aria-hidden="true" />}
                    <span className="truncate">{rootName(root, t("drive.root_name"))}</span>
                  </span>
                )}
                <span className={cn("min-w-0 flex-1 break-words", marked && "font-medium")} dir="auto">{message(item)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          disabled={items.length === 0 || !controller}
          onClick={() => controller?.clearActivity()}
          data-testid="files-sync-clear-activity"
        >
          <Trash2 className="w-4 h-4" />{t("activity.clear")}
        </Button>
      </div>
    </SettingsSection>
  );
}
