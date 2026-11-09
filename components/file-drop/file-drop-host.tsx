"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Upload } from "@/components/icons";
import { announce } from "@/lib/announce";
import { flushComposers } from "@/lib/compose-flush-registry";
import { matchSurface } from "@/lib/deep-links";
import { isAppLocked } from "@/lib/desktop/app-lock-state";
import { pasteTarget, visibleComposer } from "@/lib/desktop/window-files";
import { runFileDropZone, type FileDropEnv } from "@/lib/file-drop/actions";
import { listenForFileChoices, type FileChoiceRequest } from "@/lib/file-drop/choice";
import { importKeywords } from "@/lib/file-drop/import-keywords";
import { startDragWatch } from "@/lib/file-drop/drag-watch";
import { filesDropTarget } from "@/lib/file-drop/files-target";
import { readDroppedFiles, type DroppedFiles } from "@/lib/file-drop/read";
import {
  defaultZone,
  fileDropZones,
  filesTakeDropsAsIs,
  filesWithinLimits,
  kindForName,
  type DropFiles,
  type DropPlace,
  type FileDropZone,
  type FileDropZoneId,
} from "@/lib/file-drop/zones";
import { localizeMailboxName } from "@/lib/mailbox-label";
import { isOfflineNow, useOfflineStore } from "@/lib/offline/state";
import { isPopoutPath } from "@/lib/popout/window-role";
import { formatFileSize } from "@/lib/utils";
import { useAccountStore } from "@/stores/account-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useCalendarStore } from "@/stores/calendar-store";
import { toast } from "@/stores/toast-store";
import { useZoneText, ZoneCard, zoneGridClass } from "./file-drop-zones";
import { cn } from "@/lib/utils";

/** How long leaving the page may take to save an open composer. */
const FLUSH_BEFORE_LEAVING_MS = 5000;
const NAMES_SHOWN = 3;

/** Where a dropped .eml could go: the real folder in view on the mail screen, if new mail may go in. */
function importFolder(pathname: string, translate: (key: string) => string): { id: string; name: string; accountId?: string; role?: string | null } | null {
  if (matchSurface(pathname)?.surface !== "mail") return null;
  const { selectedMailbox, mailboxes } = useEmailStore.getState();
  const mailbox = mailboxes.find((entry) => entry.id === selectedMailbox);
  if (!mailbox || mailbox.isShared || mailbox.myRights?.mayAddItems === false) return null;
  return { id: mailbox.id, name: localizeMailboxName(mailbox.role, mailbox.name, translate), accountId: mailbox.accountId, role: mailbox.role };
}

/** Whatever would stop a drop now. A dialog of its own (an import, a picker) keeps its own drop zone. */
function overlayBlocked(): boolean {
  if (isAppLocked() || !useAuthStore.getState().isAuthenticated) return true;
  const modal = document.querySelector('[aria-modal="true"]');
  return !!modal && !modal.querySelector('[data-testid="email-composer"]');
}

/** What can be done with files here and now. Read at the moment of the drag, not kept. */
function currentPlace(pathname: string, translate: (key: string) => string): { place: DropPlace; folder: ReturnType<typeof importFolder> } {
  const auth = useAuthStore.getState();
  const client = auth.client;
  const features = usePolicyStore.getState();
  const account = auth.activeAccountId ? useAccountStore.getState().accounts.find((entry) => entry.id === auth.activeAccountId) : undefined;
  const folder = importFolder(pathname, translate);
  const place: DropPlace = {
    composer: !!visibleComposer(),
    inlineImages: !!visibleComposer()?.images?.available(),
    popout: isPopoutPath(window.location.pathname),
    files: !!client?.supportsFiles?.() && features.isFeatureEnabled("filesEnabled"),
    filesFolder: filesDropTarget()?.folder ?? null,
    onFiles: filesDropTarget() !== null,
    calendar: useCalendarStore.getState().supportsCalendar && features.isFeatureEnabled("calendarEnabled"),
    contacts: !!client?.supportsContacts?.() && features.isFeatureEnabled("contactsEnabled"),
    contactsScreen: matchSurface(pathname)?.surface === "contacts",
    importFolder: folder?.name ?? null,
    offline: isOfflineNow(account?.serverUrl),
    keepsOffline: !!auth.activeAccountId && useOfflineStore.getState().enabled.includes(auth.activeAccountId),
    maxUploadBytes: client?.getMaxSizeUpload?.() ?? 0,
    maxMessageBytes: client?.getMaxSizeAttachmentsPerEmail?.() ?? 0,
  };
  return { place, folder };
}

interface DragState {
  files: DropFiles;
  zones: FileDropZone[];
  place: DropPlace;
  folder: ReturnType<typeof importFolder>;
}

interface ChoiceState extends DragState {
  list: File[];
  preferred?: FileDropZoneId;
}

function asDropped(files: File[]): DroppedFiles {
  return { plain: files, all: files, folders: false };
}

function summaryOf(files: readonly File[]): DropFiles {
  return { count: files.length, kinds: files.map((file) => kindForName(file)), bytes: files.reduce((sum, file) => sum + file.size, 0) };
}

/**
 * The file drop overlay on every screen: files dragged in from outside get big zones to drop
 * on, the same zones come up as a dialog for a pasted file or a file opened with the desktop
 * app. Mounted once in the locale layout, in pop-outs too, where only their own composer
 * takes files.
 */
export function FileDropHost() {
  const t = useTranslations("fileDrop");
  const tSidebar = useTranslations("sidebar");
  const { label, note } = useZoneText();
  const router = useRouter();
  const pathname = usePathname();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [active, setActive] = useState<FileDropZoneId | null>(null);
  const [choice, setChoice] = useState<ChoiceState | null>(null);
  const [pendingChoices, setPendingChoices] = useState<FileChoiceRequest[]>([]);
  const defaultRef = useRef<HTMLButtonElement & HTMLDivElement>(null);

  const ctx = useRef({ pathname, router, t, tSidebar, label });
  ctx.current = { pathname, router, t, tSidebar, label };
  const translateMailbox = useCallback((key: string) => ctx.current.tSidebar(`mailboxes.${key}`), []);

  const countText = useCallback((files: DropFiles) => {
    if (files.count === null) return t("files_unknown");
    if (files.bytes !== null) return t("files_summary_size", { count: files.count, size: formatFileSize(files.bytes) });
    return t("files_summary", { count: files.count });
  }, [t]);

  const env = useCallback((folder: ReturnType<typeof importFolder>): FileDropEnv => ({
    goTo: async (path) => {
      const result = await flushComposers(FLUSH_BEFORE_LEAVING_MS);
      if (result.failed > 0 || result.timedOut) {
        toast.error(ctx.current.t("save_first_failed"));
        return;
      }
      if (ctx.current.pathname !== path) ctx.current.router.push(path);
    },
    importMessages: async (files) => {
      const client = useAuthStore.getState().client;
      if (!client || !folder) return;
      let done = 0;
      for (const file of files) {
        try {
          await client.importRawEmail(file, { [folder.id]: true }, importKeywords(folder.role), folder.accountId);
          done += 1;
        } catch (error) {
          console.error("Importing a dropped message failed:", error);
          toast.error(ctx.current.t("import_failed", { name: file.name }));
        }
      }
      if (done > 0) toast.success(ctx.current.t("import_done", { count: done, folder: folder.name }));
    },
  }), []);

  /** Checks what only the files in hand can tell, then hands them over. */
  const run = useCallback((zone: FileDropZoneId, dropped: DroppedFiles, state: DragState) => {
    const upload = zone === "upload";
    if (!upload && dropped.folders) toast.info(ctx.current.t("folders_left_out"));
    const { fitting, tooLarge, overMessage } = filesWithinLimits(zone, upload ? dropped.all : dropped.plain, state.place);
    for (const file of tooLarge) toast.error(ctx.current.t("too_large_file", { name: file.name, max: formatFileSize(state.place.maxUploadBytes) }));
    if (overMessage) toast.error(ctx.current.t("too_large_message", { max: formatFileSize(state.place.maxMessageBytes) }));
    if (fitting.length === 0) return;
    const what = upload ? { files: fitting, asFolder: dropped.folders } : undefined;
    void runFileDropZone(zone, fitting, env(state.folder), what).catch((error) => {
      console.error("A file drop failed:", error);
    });
  }, [env]);

  // Files dragged in from outside, anywhere.
  useEffect(() => {
    return startDragWatch({
      enter: (files) => {
        if (overlayBlocked()) return false;
        const { place, folder } = currentPlace(ctx.current.pathname, translateMailbox);
        // The Files screen takes the drop itself: the folder in view, or the folder row it lands on.
        if (filesTakeDropsAsIs(place)) return false;
        const zones = fileDropZones(files, place);
        if (zones.length === 0) return false;
        setActive(null);
        setDrag({ files, zones, place, folder });
        const choices = zones.map((zone) => ctx.current.label(zone)).join(", ");
        announce(ctx.current.t("announce", { files: files.count ?? 0, choices }));
        return true;
      },
      leave: () => {
        setDrag(null);
        setActive(null);
      },
    });
  }, [translateMailbox]);

  // A file pasted outside a text field: the same choices, from the keyboard.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const where = pasteTarget(event);
      if (!where) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (where === "composer") {
        event.preventDefault();
        visibleComposer()?.take(files);
        return;
      }
      if (overlayBlocked()) return;
      event.preventDefault();
      setPendingChoices((list) => [...list, { files, preferred: visibleComposer() ? "attach-here" : "new-message" }]);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Files opened with the desktop app.
  useEffect(() => listenForFileChoices((request) => setPendingChoices((list) => [...list, request])), []);

  // One question at a time, and none while signed out or locked.
  useEffect(() => {
    if (choice || pendingChoices.length === 0 || !isAuthenticated || isAppLocked()) return;
    const [next, ...rest] = pendingChoices;
    setPendingChoices(rest);
    const { place, folder } = currentPlace(ctx.current.pathname, translateMailbox);
    const files = summaryOf(next.files);
    const zones = fileDropZones(files, place);
    const usable = zones.filter((zone) => !zone.disabled);
    if (usable.length === 1) {
      run(usable[0].id, asDropped(next.files), { files, zones, place, folder });
      return;
    }
    if (zones.length === 0) {
      toast.error(ctx.current.t("nothing_here"));
      return;
    }
    setChoice({ files, zones, place, folder, list: next.files, preferred: next.preferred });
  }, [choice, pendingChoices, isAuthenticated, run, translateMailbox]);

  const pick = (zone: FileDropZone) => {
    if (!choice || zone.disabled) return;
    const state = choice;
    setChoice(null);
    run(zone.id, asDropped(state.list), state);
  };

  const zoneAt = (target: EventTarget | null): FileDropZone | null => {
    const element = (target as Element | null)?.closest?.("[data-drop-zone]");
    const id = element?.getAttribute("data-drop-zone");
    return drag?.zones.find((zone) => zone.id === id) ?? null;
  };

  const overlay = drag && typeof document !== "undefined" && createPortal(
    <div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-6 bg-background/85 p-6 backdrop-blur-sm pt-[calc(1.5rem+var(--titlebar-row-height,0px))] animate-in fade-in duration-100"
      data-testid="file-drop-overlay"
      role="region"
      aria-label={t("overlay_label")}
      onDragOver={(event) => {
        event.preventDefault();
        const zone = zoneAt(event.target);
        const usable = zone && !zone.disabled ? zone : null;
        event.dataTransfer.dropEffect = usable ? "copy" : "none";
        if ((usable?.id ?? null) !== active) setActive(usable?.id ?? null);
      }}
      onDrop={(event) => {
        event.preventDefault();
        const zone = zoneAt(event.target);
        const state = drag;
        setDrag(null);
        setActive(null);
        if (!zone || zone.disabled) return;
        void readDroppedFiles(event.dataTransfer).then((dropped) => run(zone.id, dropped, state));
      }}
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <Upload className="h-8 w-8 text-primary" aria-hidden="true" />
        <p className="text-xl font-semibold text-foreground">{t("overlay_title")}</p>
        <p className="text-sm text-muted-foreground" data-testid="file-drop-count">{countText(drag.files)}</p>
      </div>
      <div className={cn("grid w-full gap-4", zoneGridClass(drag.zones.length))}>
        {drag.zones.map((zone) => (
          <ZoneCard key={zone.id} zone={zone} label={label(zone)} note={note(zone.note)} active={active === zone.id} />
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{t("overlay_hint")}</p>
    </div>,
    document.body,
  );

  const preferred = choice ? defaultZone(choice.zones, choice.preferred) : undefined;
  const names = choice?.list.map((file) => file.name) ?? [];

  return (
    <>
      {overlay}
      <Dialog
        isOpen={!!choice}
        onClose={() => setChoice(null)}
        title={t("choose_title", { count: choice?.list.length ?? 0 })}
        description={choice ? `${names.slice(0, NAMES_SHOWN).join(", ")}${names.length > NAMES_SHOWN ? ", …" : ""} (${countText(choice.files)})` : undefined}
        size="lg"
        initialFocus={defaultRef}
        testId="file-drop-choice"
      >
        {choice && (
          <div
            className={cn("mt-4 grid w-full gap-3", zoneGridClass(Math.min(choice.zones.length, 2)))}
            role="group"
            aria-label={t("choose_title", { count: choice.list.length })}
            onKeyDown={(event) => {
              if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-drop-zone]"));
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (at === -1) return;
              event.preventDefault();
              const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
              buttons[(at + step + buttons.length) % buttons.length].focus();
            }}
          >
            {choice.zones.map((zone) => (
              <ZoneCard
                key={zone.id}
                ref={zone.id === preferred?.id ? defaultRef : undefined}
                as="button"
                zone={zone}
                label={label(zone)}
                note={note(zone.note)}
                onClick={() => pick(zone)}
              />
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}
