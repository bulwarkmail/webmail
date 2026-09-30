"use client";

import { useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SettingsSection, SettingItem, ToggleSwitch, RadioGroup } from "@/components/settings/settings-section";

export type FolderLayout = "inline" | "sidebar";

export interface FilesSettings {
  defaultViewMode: "list" | "grid";
  showIcons: boolean;
  coloredIcons: boolean;
  defaultSortKey: "name" | "size" | "modified";
  defaultSortDir: "asc" | "desc";
  showHiddenFiles: boolean;
  showThumbnails: boolean;
  folderLayout: FolderLayout;
}

export const DEFAULT_FILES_SETTINGS: FilesSettings = {
  defaultViewMode: "list",
  showIcons: true,
  coloredIcons: true,
  defaultSortKey: "name",
  defaultSortDir: "asc",
  showHiddenFiles: false,
  showThumbnails: true,
  folderLayout: "inline",
};

export function loadFilesSettings(): FilesSettings {
  if (typeof window === "undefined") return DEFAULT_FILES_SETTINGS;
  try {
    const raw = localStorage.getItem("files-settings");
    if (raw) return { ...DEFAULT_FILES_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_FILES_SETTINGS;
}

export function saveFilesSettings(settings: FilesSettings) {
  localStorage.setItem("files-settings", JSON.stringify(settings));
  // Dispatch custom event for same-tab listeners (StorageEvent only fires cross-tab)
  window.dispatchEvent(new CustomEvent("files-settings-changed"));
}

interface FilesSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: FilesSettings;
  onSettingsChange: (settings: FilesSettings) => void;
}

export function FilesSettingsDialog({ isOpen, onClose, settings, onSettingsChange }: FilesSettingsDialogProps) {
  const t = useTranslations("files");
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (isOpen) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const update = (patch: Partial<FilesSettings>) => {
    const next = { ...settings, ...patch };
    onSettingsChange(next);
    saveFilesSettings(next);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings_title")}
        className="bg-background border border-border rounded-lg shadow-lg w-full max-w-md mx-4 max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">{t("settings_title")}</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="overflow-y-auto p-4 space-y-6">
          <SettingsSection title={t("settings_display")}>
            <SettingItem label={t("settings_folder_layout")} description={t("settings_folder_layout_desc")}>
              <RadioGroup
                value={settings.folderLayout}
                onChange={(v) => update({ folderLayout: v as FolderLayout })}
                options={[
                  { value: "inline", label: t("settings_folder_layout_inline") },
                  { value: "sidebar", label: t("settings_folder_layout_sidebar") },
                ]}
              />
            </SettingItem>
            <SettingItem label={t("settings_default_view")} description={t("settings_default_view_desc")}>
              <RadioGroup
                value={settings.defaultViewMode}
                onChange={(v) => update({ defaultViewMode: v as "list" | "grid" })}
                options={[
                  { value: "list", label: t("list_view") },
                  { value: "grid", label: t("grid_view") },
                ]}
              />
            </SettingItem>
            <SettingItem label={t("settings_default_sort")} description={t("settings_default_sort_desc")}>
              <RadioGroup
                value={settings.defaultSortKey}
                onChange={(v) => update({ defaultSortKey: v as "name" | "size" | "modified" })}
                options={[
                  { value: "name", label: t("name") },
                  { value: "size", label: t("size") },
                  { value: "modified", label: t("modified") },
                ]}
              />
            </SettingItem>
            <SettingItem label={t("settings_sort_direction")} description={t("settings_sort_direction_desc")}>
              <RadioGroup
                value={settings.defaultSortDir}
                onChange={(v) => update({ defaultSortDir: v as "asc" | "desc" })}
                options={[
                  { value: "asc", label: t("settings_ascending") },
                  { value: "desc", label: t("settings_descending") },
                ]}
              />
            </SettingItem>
          </SettingsSection>

          <SettingsSection title={t("settings_icons")}>
            <SettingItem label={t("settings_show_icons")} description={t("settings_show_icons_desc")}>
              <ToggleSwitch
                checked={settings.showIcons}
                onChange={(v) => update({ showIcons: v })}
              />
            </SettingItem>
            <SettingItem label={t("settings_colored_icons")} description={t("settings_colored_icons_desc")}>
              <ToggleSwitch
                checked={settings.coloredIcons}
                onChange={(v) => update({ coloredIcons: v })}
                disabled={!settings.showIcons}
              />
            </SettingItem>
            <SettingItem label={t("settings_show_thumbnails")} description={t("settings_show_thumbnails_desc")}>
              <ToggleSwitch
                checked={settings.showThumbnails}
                onChange={(v) => update({ showThumbnails: v })}
              />
            </SettingItem>
          </SettingsSection>

          <SettingsSection title={t("settings_behavior")}>
            <SettingItem label={t("settings_show_hidden")} description={t("settings_show_hidden_desc")}>
              <ToggleSwitch
                checked={settings.showHiddenFiles}
                onChange={(v) => update({ showHiddenFiles: v })}
              />
            </SettingItem>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
