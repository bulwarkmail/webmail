"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useFilesSyncStore } from "@/stores/files-sync-store";
import type { FilesRoot } from "@/lib/desktop/types";
import type { FilesSyncRootStatus } from "@/lib/files-sync/types";
import { rootName } from "./files-sync-text";

/*
 * The mass-delete question (FILES-SYNC-BRIEF: more than 50 items or more than half a
 * pair at once pauses the pair and asks). The settings page asks it in the folder's
 * row; everywhere else FilesSyncPrompts asks it in a dialog, so the user sees it
 * wherever they are.
 */

let inlineHosts = 0;
const inlineListeners = new Set<() => void>();
const subscribeInline = (listener: () => void) => {
  inlineListeners.add(listener);
  return () => { inlineListeners.delete(listener); };
};
const inlineShown = () => inlineHosts > 0;

/** The settings page asks in its rows while it's open: the dialog stays away meanwhile. */
export function useInlineMassDeleteQuestions(): void {
  useEffect(() => {
    inlineHosts += 1;
    inlineListeners.forEach((listener) => listener());
    return () => {
      inlineHosts -= 1;
      inlineListeners.forEach((listener) => listener());
    };
  }, []);
}

/**
 * The question's text, for a root in `confirm-delete`. `deletedOn` is where the items were
 * deleted (MassDeleteOrigin); the question is about the other side. The drive is "Files drive"
 * on both sides, never the address it's registered with.
 */
export function useMassDeleteText(root: FilesRoot, massDelete: NonNullable<FilesSyncRootStatus["massDelete"]>): string {
  const t = useTranslations("files_sync");
  const driveName = t("drive.root_name");
  return massDelete.deletedOn === "this-computer"
    ? t("mass_delete.local", { count: massDelete.count, folder: rootName(root, driveName) })
    : t("mass_delete.remote", { count: massDelete.count, folder: root.kind === "drive" ? driveName : root.remoteLabel || driveName });
}

interface AnswerButtonsProps {
  rootId: string;
  count: number;
  /** After an answer went out. */
  onAnswered?: () => void;
}

/** "Delete them" and "Bring them back", straight to the engine. */
export function MassDeleteAnswers({ rootId, count, onAnswered }: AnswerButtonsProps) {
  const t = useTranslations("files_sync");
  const controller = useFilesSyncStore((s) => s.controller);
  const [busy, setBusy] = useState(false);
  const answer = (allow: boolean) => {
    if (!controller) return;
    setBusy(true);
    void controller.confirmMassDelete(rootId, allow).catch(() => {}).finally(() => {
      setBusy(false);
      onAnswered?.();
    });
  };
  return (
    <>
      <Button size="sm" variant="outline" disabled={busy || !controller} onClick={() => answer(false)} data-testid="files-sync-mass-delete-restore">
        {t("mass_delete.restore", { count })}
      </Button>
      <Button size="sm" variant="destructive" disabled={busy || !controller} onClick={() => answer(true)} data-testid="files-sync-mass-delete-allow">
        {t("mass_delete.allow", { count })}
      </Button>
    </>
  );
}

/** The question inside a folder's row on the settings page. */
export function MassDeleteQuestion({ root, status }: { root: FilesRoot; status: FilesSyncRootStatus }) {
  const massDelete = status.massDelete ?? { count: 0, deletedOn: "this-computer" as const };
  const text = useMassDeleteText(root, massDelete);
  return (
    <div role="group" aria-label={text} className="mt-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 space-y-3" data-files-sync-question={root.id}>
      <p className="flex items-start gap-2 text-sm text-foreground">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        <span>{text}</span>
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <MassDeleteAnswers rootId={root.id} count={massDelete.count} />
      </div>
    </div>
  );
}

function PromptDialog({ root, status, onLater }: { root: FilesRoot; status: FilesSyncRootStatus; onLater: () => void }) {
  const t = useTranslations("files_sync");
  const massDelete = status.massDelete!;
  const text = useMassDeleteText(root, massDelete);
  return (
    <Dialog
      isOpen
      onClose={onLater}
      role="alertdialog"
      title={t("mass_delete.title", { count: massDelete.count })}
      description={text}
      showClose={false}
      preventOutsideClose
      testId="files-sync-mass-delete-dialog"
      icon={(
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        </div>
      )}
      footer={(
        <>
          <Button variant="ghost" onClick={onLater}>{t("mass_delete.later")}</Button>
          <MassDeleteAnswers rootId={root.id} count={massDelete.count} />
        </>
      )}
    />
  );
}

/**
 * App-wide: asks about a mass delete wherever the user is, one root at a time.
 * "Decide later" hides it for this question; the folder's row on the settings page
 * still asks, and the pair stays paused until then.
 */
export function FilesSyncPrompts() {
  const available = useFilesSyncStore((s) => s.available);
  const roots = useFilesSyncStore((s) => s.roots);
  const status = useFilesSyncStore((s) => s.status);
  const controller = useFilesSyncStore((s) => s.controller);
  const pageAsks = useSyncExternalStore(subscribeInline, inlineShown, () => false);
  const [later, setLater] = useState<ReadonlySet<string>>(() => new Set());

  if (!available || !controller || pageAsks) return null;
  const keyOf = (s: FilesSyncRootStatus) => `${s.rootId}:${s.massDelete?.deletedOn}:${s.massDelete?.count}`;
  const root = roots.find((r) => {
    const s = status[r.id];
    return s?.state === "confirm-delete" && !!s.massDelete && !later.has(keyOf(s));
  });
  if (!root) return null;
  const rootStatus = status[root.id];
  return (
    <PromptDialog
      key={keyOf(rootStatus)}
      root={root}
      status={rootStatus}
      onLater={() => setLater((prev) => new Set(prev).add(keyOf(rootStatus)))}
    />
  );
}
