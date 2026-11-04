"use client";

import { useTranslations } from "next-intl";
import { Download, ExternalLink } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PreviewShell, type PreviewNeighbours } from "@/components/files/preview-shell";
import { FileSize, ResourceIcon } from "@/components/files/file-item-parts";
import { useCloseOnBack } from "@/hooks/use-close-on-back";
import type { FileResource } from "@/stores/file-store";

const ICON_OPTIONS = { showIcons: true, coloredIcons: true };

/**
 * A file the app can't show and no office editor opens (a spreadsheet with
 * no Collabora or ONLYOFFICE set up, a zip): its icon, name and size, with
 * Download and, in the desktop app, Open in the program the computer uses
 * for it (pim-16). It used to download at once, with no word. The header is
 * the preview's, with the folder's previous and next file; Download is in
 * the body only, once (pim-p2-18).
 */
export function FileNoPreview({ resource, onClose, onDownload, onOpenInApp, appAction, neighbours }: {
  resource: FileResource;
  onClose: () => void;
  /** Left out when a device policy turned downloads off. */
  onDownload?: () => void;
  /** Only in the desktop app, for a file it may open. */
  onOpenInApp?: () => void;
  /** What the app itself does with this kind of file: "Import into contacts…" (pim-p2-7). */
  appAction?: { label: string; onRun: () => void };
  neighbours?: PreviewNeighbours;
}) {
  const t = useTranslations("files");
  const tUx = useTranslations("ux_pim_files");
  useCloseOnBack({ onBack: onClose });
  return (
    <PreviewShell name={resource.name} onClose={onClose} neighbours={neighbours}>
      <div className="flex-1 min-h-0 flex items-center justify-center p-4">
        <div
          data-testid="file-no-preview"
          className="bg-background rounded-lg p-8 max-w-sm w-full flex flex-col items-center gap-3 text-center"
          onClick={(e) => e.stopPropagation()}
        >
          <ResourceIcon resource={resource} size="xl" options={ICON_OPTIONS} />
          <p className="text-sm font-medium break-all" dir="auto">{resource.name}</p>
          <p className="text-xs text-muted-foreground"><FileSize bytes={resource.contentLength} /></p>
          <p className="text-sm text-muted-foreground">{tUx("no_preview")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            {appAction && (
              <Button size="sm" onClick={appAction.onRun} data-testid="file-app-action">
                {appAction.label}
              </Button>
            )}
            {onOpenInApp && (
              <Button size="sm" variant={appAction ? "outline" : "default"} onClick={onOpenInApp} className="gap-1.5">
                <ExternalLink className="w-4 h-4" />
                {tUx("open_in_app")}
              </Button>
            )}
            {onDownload && (
              <Button size="sm" variant={onOpenInApp || appAction ? "outline" : "default"} onClick={onDownload} className="gap-1.5">
                <Download className="w-4 h-4" />
                {t("download")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </PreviewShell>
  );
}
