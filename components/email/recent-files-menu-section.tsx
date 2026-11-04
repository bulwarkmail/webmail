"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CONTEXT_MENU_ITEM_CLASS, menuLevelItems } from "@/components/ui/context-menu";
import { attachmentIcon } from "@/components/email/attachment-chips";
import { listRecentFiles, recentWhen, shortFolder } from "@/lib/desktop/recent-files";
import type { DesktopRecentFile } from "@/lib/desktop/types";
import { cn } from "@/lib/utils";

/** Only an icon the shell made: a PNG as a data: URL. */
const ICON_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/**
 * The top of the composer's Attach menu in the desktop app: the files the OS says were
 * used last, as Outlook lists them. Mounted when the menu opens, from that click, which is
 * what the shell asks for. Until the list is there, and when it's empty, it takes no room.
 * It stays an HTML menu (data-native-menu): a native one can't show the icons and folders.
 */
export function RecentFilesMenuSection({ onPick }: { onPick: (file: DesktopRecentFile) => void }) {
  const t = useTranslations("desktopAttachRecent");
  const locale = useLocale();
  const [files, setFiles] = useState<DesktopRecentFile[] | null>(null);
  // One request per opening, also when a strict-mode remount runs the effect twice.
  const request = useRef<Promise<DesktopRecentFile[]> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    request.current ??= listRecentFiles();
    void request.current.then((list) => {
      if (!cancelled) setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The menu put the focus on its first entry before the list came. If it's still
  // there, the first file takes it: the list is what comes first.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const menu = root?.closest<HTMLElement>('[role="menu"]');
    if (!root || !menu || !files?.length) return;
    const active = document.activeElement;
    const others = menuLevelItems(menu).filter((item) => !root.contains(item));
    if (active && active === others[0]) root.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [files]);

  const now = Date.now();
  return (
    <div ref={rootRef} data-native-menu="html" data-testid="composer-recent-files" hidden={!files?.length}>
      {files && files.length > 0 && (
        <>
          <div role="presentation" className="px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            {t("heading")}
          </div>
          {files.map((file) => {
            const Fallback = attachmentIcon(null, file.name).icon;
            return (
              <button
                key={file.id}
                type="button"
                role="menuitem"
                title={file.path}
                onClick={() => onPick(file)}
                data-testid="composer-recent-file"
                // As wide as the menu and never wider: the row was 24rem in a menu of at
                // most 22rem, so the dates were cut and the menu scrolled sideways (compose-p3-5).
                className={cn(CONTEXT_MENU_ITEM_CLASS, "w-full min-w-[min(20rem,calc(100vw-3rem))] gap-2.5")}
              >
                {file.icon && ICON_URL.test(file.icon) ? (
                  <img src={file.icon} alt="" aria-hidden="true" draggable={false} className="h-4 w-4 shrink-0" />
                ) : (
                  <Fallback className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{file.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{shortFolder(file.folder)}</span>
                </span>
                <span className="shrink-0 self-start whitespace-nowrap pt-0.5 text-xs text-muted-foreground" data-testid="composer-recent-file-when">{recentWhen(file.usedAt, now, locale)}</span>
              </button>
            );
          })}
          <div role="separator" className="my-1 h-px bg-border" />
        </>
      )}
    </div>
  );
}
