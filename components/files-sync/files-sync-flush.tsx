"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { CloudOff, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { answerFlush, currentFlushRequest, subscribeFlushRequests, type FilesFlushRequest } from "@/lib/files-sync/flush-requests";
import { useFilesSyncStore } from "@/stores/files-sync-store";

/*
 * Before the Files drive goes or a synced folder stops: what was changed here and isn't in
 * Files yet goes up first, with its progress (pass-3 files-p3-2, files-p3-3). The user can stop
 * waiting either way: keep the drive (stay signed in, keep syncing), or go on now. Going on
 * loses nothing: the drive's files that weren't uploaded are copied to Documents by the
 * desktop app, a folder's stay where they are.
 */

const PURPOSE_KEY = { "turn-off": "turn_off", "sign-out": "sign_out", "stop-folder": "stop_folder" } as const;
const SHOWN_NAMES = 3;

/** "notes.txt, plan.docx, photo.jpg, …" */
function namesOf(paths: string[]): string {
  const names = paths.slice(0, SHOWN_NAMES).map((path) => path.split("/").pop() ?? path);
  return paths.length > SHOWN_NAMES ? `${names.join(", ")}, …` : names.join(", ");
}

type Phase = { kind: "checking" } | { kind: "uploading"; waiting: string[]; total: number } | { kind: "cannot"; waiting: string[]; offline: boolean };

function FlushDialog({ request }: { request: FilesFlushRequest }) {
  const t = useTranslations("files_sync_extra.flush");
  const controller = useFilesSyncStore((s) => s.controller);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  useEffect(() => {
    if (!controller) {
      answerFlush(request.id, true);
      return;
    }
    const abort = new AbortController();
    let last: string[] = [];
    void controller.flushRoot(request.rootId, {
      signal: abort.signal,
      onProgress: (waiting, total) => {
        last = waiting;
        if (!abort.signal.aborted && total > 0) setPhase({ kind: "uploading", waiting, total });
      },
    }).then((outcome) => {
      if (abort.signal.aborted || outcome === "cancelled") return;
      if (outcome === "done" || outcome === "gone") answerFlush(request.id, true);
      else setPhase({ kind: "cannot", waiting: last, offline: outcome === "offline" });
    }, () => {
      if (!abort.signal.aborted) setPhase({ kind: "cannot", waiting: last, offline: false });
    });
    return () => abort.abort();
  }, [controller, request.id, request.rootId]);

  // Nothing shows while it's still looking: most of the time nothing waits.
  if (phase.kind === "checking") return null;
  const purpose = PURPOSE_KEY[request.purpose];
  const keep = () => answerFlush(request.id, false);
  const go = () => answerFlush(request.id, true);
  const where = request.kind === "drive" ? "drive" : "folder";
  const done = phase.kind === "uploading" ? phase.total - phase.waiting.length : 0;

  return (
    <Dialog
      isOpen
      onClose={keep}
      role="alertdialog"
      title={t(phase.kind === "cannot" ? "cannot_title" : `title_${purpose}`)}
      showClose={false}
      preventOutsideClose
      testId="files-sync-flush-dialog"
      icon={phase.kind === "cannot" ? (
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
          <CloudOff className="w-5 h-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
        </div>
      ) : undefined}
      footer={(
        <>
          <Button variant="outline" onClick={keep} data-testid="files-sync-flush-keep">{t(`keep_${purpose}`)}</Button>
          <Button variant="destructive" onClick={go} data-testid="files-sync-flush-go">{t(`go_${purpose}`)}</Button>
        </>
      )}
    >
      {phase.kind === "uploading" ? (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="w-4 h-4 shrink-0 animate-spin motion-reduce:animate-none text-primary" aria-hidden="true" />
            <span>{t("waiting", { count: phase.waiting.length, names: namesOf(phase.waiting) })}</span>
          </p>
          <div
            className="w-full bg-muted rounded-full h-1.5"
            role="progressbar"
            aria-label={t("progress", { done, total: phase.total })}
            aria-valuemin={0}
            aria-valuemax={phase.total}
            aria-valuenow={done}
          >
            <div className="h-1.5 rounded-full bg-primary" style={{ width: `${(done / phase.total) * 100}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">{t(`go_note_${where}`)}</p>
        </div>
      ) : (
        <div className="space-y-2 text-sm text-foreground">
          <p>{t(phase.offline ? "cannot_offline" : "cannot_other", { count: phase.waiting.length, names: namesOf(phase.waiting) })}</p>
          <p>{t(`go_note_${where}`)}</p>
        </div>
      )}
    </Dialog>
  );
}

/** App-wide, next to the mass-delete question: shows while a root waits to stop. */
export function FilesFlushDialog() {
  const request = useSyncExternalStore(subscribeFlushRequests, currentFlushRequest, () => null);
  if (!request) return null;
  return <FlushDialog key={request.id} request={request} />;
}
