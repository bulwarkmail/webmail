"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Folder, FolderOpen, FileText, FileCode, ImageIcon, FileAudio, File, Home, ChevronRight, ChevronDown } from "lucide-react";
import { SettingsSection, SettingItem, ToggleSwitch, RadioGroup } from "./settings-section";
import { loadFilesSettings, saveFilesSettings, type FilesSettings, type FolderLayout } from "@/components/files/files-settings-dialog";
import { cn } from "@/lib/utils";

interface SampleFile {
  name: string;
  isFolder: boolean;
  size: number;
  modified: string;
  hidden?: boolean;
  thumbnailUrl?: string;
}

const SAMPLE_FILES: SampleFile[] = [
  { name: "Documents", isFolder: true, size: 0, modified: "2026-03-10" },
  { name: "Photos", isFolder: true, size: 0, modified: "2026-03-14" },
  { name: "report.pdf", isFolder: false, size: 245000, modified: "2026-03-15" },
  { name: "notes.md", isFolder: false, size: 1200, modified: "2026-03-12" },
  { name: "vacation.jpg", isFolder: false, size: 3400000, modified: "2026-03-08", thumbnailUrl: "/branding/Bulwark_Logo_Color.png" },
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
  const sortedFiles = useMemo(() => {
    let files = SAMPLE_FILES.filter((f) => {
      if (!settings.showHiddenFiles && f.hidden) return false;
      if (settings.folderLayout === "sidebar" && f.isFolder) return false;
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
  }, [settings.showHiddenFiles, settings.folderLayout, settings.defaultSortKey, settings.defaultSortDir]);

  const listView = (
    <div className="flex-1 min-w-0 overflow-hidden">
      <div className="flex items-center gap-3 px-2 py-1 text-[10px] font-medium text-muted-foreground border-b border-border bg-muted/50">
        <span className="flex-1 min-w-0">Name</span>
        <span className="w-14 text-right">Size</span>
        <span className="w-16 text-right">Modified</span>
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
            <img src={file.thumbnailUrl} alt="" className="w-4 h-4 rounded object-cover flex-shrink-0" />
          ) : settings.showIcons ? (
            getPreviewIcon(file, settings.coloredIcons, "sm")
          ) : null}
          <span className={cn("flex-1 min-w-0 truncate text-[11px]", file.isFolder && "font-medium")}>
            {file.name}
          </span>
          <span className="w-14 text-right text-[10px] text-muted-foreground tabular-nums">
            {formatSize(file.size)}
          </span>
          <span className="w-16 text-right text-[10px] text-muted-foreground tabular-nums">
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
              <img src={file.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
            ) : settings.showIcons ? (
              getPreviewIcon(file, settings.coloredIcons, "lg")
            ) : (
              <div className="w-8 h-8" />
            )}
            <span className={cn("text-[9px] truncate w-full text-center", file.isFolder && "font-medium")}>
              {file.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  const sidebar = settings.folderLayout === "sidebar" && (
    <div className="w-24 border-r border-border bg-muted/30 py-1.5 flex-shrink-0">
      <div className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium text-foreground">
        <Home className="w-3 h-3 flex-shrink-0" />
        <span className="truncate">Files</span>
      </div>
      <div className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-foreground bg-accent rounded-sm mx-1">
        <ChevronDown className="w-2.5 h-2.5 flex-shrink-0" />
        <FolderOpen className="w-3 h-3 flex-shrink-0 text-blue-500" />
        <span className="truncate">Documents</span>
      </div>
      <div className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-muted-foreground" style={{ paddingLeft: "1.25rem" }}>
        <ChevronRight className="w-2.5 h-2.5 flex-shrink-0" />
        <Folder className="w-3 h-3 flex-shrink-0 text-blue-500" />
        <span className="truncate">Photos</span>
      </div>
    </div>
  );

  return (
    <div className="mt-4 rounded-lg border border-border overflow-hidden bg-background text-xs select-none">
      <div className="flex" style={{ minHeight: "10rem" }}>
        {sidebar}
        {settings.defaultViewMode === "grid" ? gridView : listView}
      </div>
    </div>
  );
}

export function FilesSettingsComponent() {
  const t = useTranslations("settings.files");
  const [settings, setSettings] = useState<FilesSettings>(loadFilesSettings);

  // Listen for external changes (e.g. if file-browser updates settings)
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "files-settings") {
        setSettings(loadFilesSettings());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const update = useCallback((patch: Partial<FilesSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveFilesSettings(next);
      return next;
    });
  }, []);

  return (
    <div>
      <div className="sticky top-0 z-10 bg-background pb-4 -mx-4 px-4 -mt-4 pt-4 lg:-mx-6 lg:px-6 lg:-mt-6 lg:pt-6 border-b border-border mb-6">
        <p className="text-sm font-medium text-foreground mb-1">{t("preview.label")}</p>
        <FilesSettingsPreview settings={settings} />
      </div>

      <div className="space-y-8">
        <SettingsSection title={t("display.title")} description={t("display.description")}>
        <SettingItem label={t("folder_layout.label")} description={t("folder_layout.description")}>
          <RadioGroup
            value={settings.folderLayout}
            onChange={(v) => update({ folderLayout: v as FolderLayout })}
            options={[
              { value: "inline", label: t("folder_layout.inline") },
              { value: "sidebar", label: t("folder_layout.sidebar") },
            ]}
          />
        </SettingItem>
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

      <SettingsSection title={t("icons.title")} description={t("icons.description")}>
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

      <SettingsSection title={t("behavior.title")} description={t("behavior.description")}>
        <SettingItem label={t("show_hidden.label")} description={t("show_hidden.description")}>
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
