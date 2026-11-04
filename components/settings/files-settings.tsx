"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Folder, FileText, FileCode, ImageIcon, FileAudio, File } from "@/components/icons";
import { SettingsSection, SettingItem, ToggleSwitch, RadioGroup } from "./settings-section";
import { useFilesSettings, type FilesSettings } from "@/components/files/files-settings";
import { cn } from "@/lib/utils";
import { withBasePath } from "@/lib/browser-navigation";
import { useConfig } from "@/hooks/use-config";

interface SampleFile {
  name: string;
  /** Folder names are translated; file names stay as they are. */
  labelKey?: "preview_documents" | "preview_photos";
  isFolder: boolean;
  size: number;
  modified: string;
  hidden?: boolean;
  thumbnailUrl?: string;
}

const SAMPLE_FILES: SampleFile[] = [
  { name: "Documents", labelKey: "preview_documents", isFolder: true, size: 0, modified: "2026-03-10" },
  { name: "Photos", labelKey: "preview_photos", isFolder: true, size: 0, modified: "2026-03-14" },
  { name: "report.pdf", isFolder: false, size: 245000, modified: "2026-03-15" },
  { name: "notes.md", isFolder: false, size: 1200, modified: "2026-03-12" },
  { name: "logo.png", isFolder: false, size: 34000, modified: "2026-03-08", thumbnailUrl: "/branding/Bulwark_Logo_Color.png" },
  { name: "song.mp3", isFolder: false, size: 5200000, modified: "2026-03-01" },
  { name: ".config", isFolder: false, size: 340, modified: "2026-02-20", hidden: true },
];

function getPreviewIcon(file: SampleFile, colored: boolean, size: "sm" | "lg") {
  const cls = size === "sm" ? "w-4 h-4 flex-shrink-0" : "w-8 h-8 flex-shrink-0";

  if (file.isFolder) {
    return <Folder className={cn(cls, colored ? "text-blue-500" : "text-muted-foreground")} />;
  }

  const ext = file.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg": case "png": case "gif":
      return <ImageIcon className={cn(cls, colored ? "text-emerald-500" : "text-muted-foreground")} />;
    case "mp3": case "wav":
      return <FileAudio className={cn(cls, colored ? "text-purple-500" : "text-muted-foreground")} />;
    case "pdf":
      return <FileText className={cn(cls, colored ? "text-red-600" : "text-muted-foreground")} />;
    case "md": case "json": case "js": case "ts":
      return <FileCode className={cn(cls, colored ? "text-yellow-600" : "text-muted-foreground")} />;
    default:
      return <File className={cn(cls, "text-muted-foreground")} />;
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilesSettingsPreview({ settings }: { settings: FilesSettings }) {
  const tFiles = useTranslations("files");
  const tWording = useTranslations("uxs_wording");
  // The sample thumbnail shows the configured logo on a branded deployment,
  // the bundled one otherwise. (#1160)
  const { appLogoLightUrl, appLogoDarkUrl } = useConfig();
  const thumbnailUrl = appLogoLightUrl || appLogoDarkUrl || "/branding/Bulwark_Logo_Color.png";
  const sortedFiles = useMemo(() => {
    let files = SAMPLE_FILES
      .map((f) => (f.labelKey ? { ...f, name: tWording(f.labelKey) } : f))
      .map((f) => (f.thumbnailUrl ? { ...f, thumbnailUrl } : f)).filter((f) => {
      if (!settings.showHiddenFiles && f.hidden) return false;
      return true;
    });

    files.sort((a, b) => {
      // Folders first
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;

      let cmp = 0;
      switch (settings.defaultSortKey) {
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "size": cmp = a.size - b.size; break;
        case "modified": cmp = a.modified.localeCompare(b.modified); break;
      }
      return settings.defaultSortDir === "desc" ? -cmp : cmp;
    });

    return files;
  }, [settings.showHiddenFiles, settings.defaultSortKey, settings.defaultSortDir, thumbnailUrl, tWording]);

  const listView = (
    <div className="flex-1 min-w-0 overflow-hidden">
      <div className="flex items-center gap-3 px-2 py-1 text-[0.625rem] font-medium text-muted-foreground border-b border-border bg-muted/50">
        <span className="flex-1 min-w-0">{tFiles("name")}</span>
        <span className="w-14 text-end">{tFiles("size")}</span>
        <span className="w-16 text-end">{tFiles("modified")}</span>
      </div>
      {sortedFiles.map((file) => (
        <div
          key={file.name}
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 border-b border-border last:border-b-0 transition-colors hover:bg-muted/50",
            file.hidden && "opacity-50"
          )}
        >
          {settings.showThumbnails && file.thumbnailUrl ? (
            <img src={withBasePath(file.thumbnailUrl)} alt="" className="w-4 h-4 rounded object-cover flex-shrink-0" />
          ) : settings.showIcons ? (
            getPreviewIcon(file, settings.coloredIcons, "sm")
          ) : null}
          <span className={cn("flex-1 min-w-0 truncate text-[0.6875rem]", file.isFolder && "font-medium")}>
            {file.name}
          </span>
          <span className="w-14 text-end text-[0.625rem] text-muted-foreground tabular-nums">
            {formatSize(file.size)}
          </span>
          <span className="w-16 text-end text-[0.625rem] text-muted-foreground tabular-nums">
            {file.modified.slice(5)}
          </span>
        </div>
      ))}
    </div>
  );

  const gridView = (
    <div className="flex-1 min-w-0 p-2">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1.5">
        {sortedFiles.map((file) => (
          <div
            key={file.name}
            className={cn(
              "flex flex-col items-center gap-1 p-2 rounded-md transition-colors hover:bg-muted/50",
              file.hidden && "opacity-50"
            )}
          >
            {settings.showThumbnails && file.thumbnailUrl ? (
              <img src={withBasePath(file.thumbnailUrl)} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
            ) : settings.showIcons ? (
              getPreviewIcon(file, settings.coloredIcons, "lg")
            ) : (
              <div className="w-8 h-8" />
            )}
            <span className={cn("text-[0.5625rem] truncate w-full text-center", file.isFolder && "font-medium")}>
              {file.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="mt-4 rounded-lg border border-border overflow-hidden bg-background text-xs select-none">
      <div className="flex" style={{ minHeight: "10rem" }}>
        {settings.defaultViewMode === "grid" ? gridView : listView}
      </div>
    </div>
  );
}

export function FilesSettingsComponent() {
  const t = useTranslations("settings.files");
  const [settings, update] = useFilesSettings();

  return (
    <div>
      <div className="[@media(min-height:640px)]:sticky top-0 z-10 bg-background pb-4 -mx-4 px-4 -mt-4 pt-4 lg:-mx-6 lg:px-6 lg:-mt-6 lg:pt-6 border-b border-border mb-6">
        <p className="text-sm font-medium text-foreground mb-1">{t("preview.label")}</p>
        <FilesSettingsPreview settings={settings} />
      </div>

      <div className="space-y-8">
        <SettingsSection id="display" title={t("display.title")} description={t("display.description")}>
        <SettingItem label={t("default_view.label")} description={t("default_view.description")}>
          <RadioGroup
            value={settings.defaultViewMode}
            onChange={(v) => update({ defaultViewMode: v as "list" | "grid" })}
            options={[
              { value: "list", label: t("default_view.list") },
              { value: "grid", label: t("default_view.grid") },
            ]}
          />
        </SettingItem>
        <SettingItem label={t("default_sort.label")} description={t("default_sort.description")}>
          <RadioGroup
            value={settings.defaultSortKey}
            onChange={(v) => update({ defaultSortKey: v as "name" | "size" | "modified" })}
            options={[
              { value: "name", label: t("default_sort.name") },
              { value: "size", label: t("default_sort.size") },
              { value: "modified", label: t("default_sort.modified") },
            ]}
          />
        </SettingItem>
        <SettingItem label={t("sort_direction.label")} description={t("sort_direction.description")}>
          <RadioGroup
            value={settings.defaultSortDir}
            onChange={(v) => update({ defaultSortDir: v as "asc" | "desc" })}
            options={[
              { value: "asc", label: t("sort_direction.ascending") },
              { value: "desc", label: t("sort_direction.descending") },
            ]}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="icons" title={t("icons.title")} description={t("icons.description")}>
        <SettingItem label={t("show_icons.label")} description={t("show_icons.description")}>
          <ToggleSwitch
            checked={settings.showIcons}
            onChange={(v) => update({ showIcons: v })}
          />
        </SettingItem>
        <SettingItem label={t("colored_icons.label")} description={t("colored_icons.description")}>
          <ToggleSwitch
            checked={settings.coloredIcons}
            onChange={(v) => update({ coloredIcons: v })}
            disabled={!settings.showIcons}
          />
        </SettingItem>
        <SettingItem label={t("show_thumbnails.label")} description={t("show_thumbnails.description")}>
          <ToggleSwitch
            checked={settings.showThumbnails}
            onChange={(v) => update({ showThumbnails: v })}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="behavior" advanced title={t("behavior.title")} description={t("behavior.description")}>
        <SettingItem advanced label={t("show_hidden.label")} description={t("show_hidden.description")}>
          <ToggleSwitch
            checked={settings.showHiddenFiles}
            onChange={(v) => update({ showHiddenFiles: v })}
          />
        </SettingItem>
      </SettingsSection>
      </div>
    </div>
  );
}
