"use client";

import { useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { Plus, Pencil, Trash2, ExternalLink, PanelRight, GripVertical } from "lucide-react";
import { icons as lucideIcons, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsSection, SettingItem, ToggleSwitch } from "./settings-section";
import { IconPicker } from "@/components/layout/icon-picker";
import { useSettingsStore, type SidebarApp } from "@/stores/settings-store";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

interface SidebarAppFormData {
  name: string;
  url: string;
  icon: string;
  openMode: "tab" | "inline";
  showOnMobile: boolean;
}

function AppForm({
  app,
  onSave,
  onCancel,
}: {
  app?: SidebarApp;
  onSave: (data: SidebarAppFormData) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("sidebar_apps");
  const isEditing = !!app;

  const [formData, setFormData] = useState<SidebarAppFormData>({
    name: app?.name || "",
    url: app?.url || "",
    icon: app?.icon || "Globe",
    openMode: app?.openMode || "tab",
    showOnMobile: app?.showOnMobile ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!formData.name.trim()) {
      newErrors.name = t("name_required");
    }
    if (!formData.url.trim()) {
      newErrors.url = t("url_required");
    } else {
      try {
        const parsed = new URL(formData.url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          newErrors.url = t("url_invalid");
        }
      } catch {
        newErrors.url = t("url_invalid");
      }
    }
    if (!formData.icon) {
      newErrors.icon = t("icon_required");
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    onSave(formData);
  };

  const SelectedIcon = formData.icon
    ? (lucideIcons[formData.icon as keyof typeof lucideIcons] as LucideIcon | undefined)
    : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border border-border rounded-lg bg-secondary/30">
      <div>
        <label className="text-sm font-medium">{t("name_label")}</label>
        <Input
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={t("name_placeholder")}
          className="mt-1"
        />
        {errors.name && <p className="text-xs text-destructive mt-1">{errors.name}</p>}
      </div>

      <div>
        <label className="text-sm font-medium">{t("url_label")}</label>
        <Input
          value={formData.url}
          onChange={(e) => setFormData({ ...formData, url: e.target.value })}
          placeholder="https://example.com"
          className="mt-1"
        />
        {errors.url && <p className="text-xs text-destructive mt-1">{errors.url}</p>}
      </div>

      <div>
        <label className="text-sm font-medium block mb-1">{t("icon_label")}</label>
        <div className="flex items-center gap-2 mb-2">
          {SelectedIcon && (
            <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center">
              <SelectedIcon className="w-4 h-4" />
            </div>
          )}
          <span className="text-sm text-muted-foreground">{formData.icon}</span>
        </div>
        <IconPicker value={formData.icon} onChange={(icon) => setFormData({ ...formData, icon })} />
        {errors.icon && <p className="text-xs text-destructive mt-1">{errors.icon}</p>}
      </div>

      <div>
        <label className="text-sm font-medium block mb-2">{t("open_mode_label")}</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFormData({ ...formData, openMode: "tab" })}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-colors",
              formData.openMode === "tab"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-muted"
            )}
          >
            <ExternalLink className="w-4 h-4" />
            {t("open_new_tab")}
          </button>
          <button
            type="button"
            onClick={() => setFormData({ ...formData, openMode: "inline" })}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm border transition-colors",
              formData.openMode === "inline"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-muted"
            )}
          >
            <PanelRight className="w-4 h-4" />
            {t("open_inline")}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">{t("show_on_mobile")}</label>
        <button
          type="button"
          onClick={() => setFormData({ ...formData, showOnMobile: !formData.showOnMobile })}
          className={cn(
            "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
            formData.showOnMobile ? "bg-primary" : "bg-muted-foreground/30"
          )}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              formData.showOnMobile ? "translate-x-4.5" : "translate-x-0.5"
            )}
          />
        </button>
      </div>

      <div className="flex gap-2 justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" size="sm">
          {isEditing ? t("update") : t("add")}
        </Button>
      </div>
    </form>
  );
}

export function SidebarAppsSettings() {
  const t = useTranslations("settings.sidebar_apps");
  const tApps = useTranslations("sidebar_apps");
  const { sidebarApps, keepAppsLoaded, addSidebarApp, updateSidebarApp, removeSidebarApp, reorderSidebarApps, updateSetting } = useSettingsStore();
  const [editingApp, setEditingApp] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const draggedIndexRef = useRef<number | null>(null);

  const handleAdd = useCallback((data: SidebarAppFormData) => {
    const id = `app-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    addSidebarApp({ id, ...data });
    setShowAddForm(false);
  }, [addSidebarApp]);

  const handleUpdate = useCallback((id: string, data: SidebarAppFormData) => {
    updateSidebarApp(id, data);
    setEditingApp(null);
  }, [updateSidebarApp]);

  const handleDelete = useCallback(async (app: SidebarApp) => {
    const confirmed = await confirmDialog({
      title: tApps("delete_confirm_title"),
      message: tApps("delete_confirm", { name: app.name }),
      confirmText: tApps("delete"),
      variant: 'destructive',
    });
    if (!confirmed) return;
    removeSidebarApp(app.id);
  }, [confirmDialog, tApps, removeSidebarApp]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    draggedIndexRef.current = index;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    setDragOverIndex(null);
    const fromIndex = draggedIndexRef.current;
    if (fromIndex === null || fromIndex === dropIndex) return;
    const newApps = [...sidebarApps];
    const [moved] = newApps.splice(fromIndex, 1);
    newApps.splice(dropIndex, 0, moved);
    reorderSidebarApps(newApps);
  }, [sidebarApps, reorderSidebarApps]);

  const handleDragEnd = useCallback(() => {
    draggedIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  return (
    <>
      <SettingsSection title={t("title")} description={t("description")}>
        <SettingItem label={t("keep_loaded")} description={t("keep_loaded_description")}>
          <ToggleSwitch
            checked={keepAppsLoaded}
            onChange={(v) => updateSetting("keepAppsLoaded", v)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection title={t("manage_title")} description={t("manage_description")}>
        <div className="space-y-3">
          {sidebarApps.length === 0 && !showAddForm && (
            <p className="text-sm text-muted-foreground py-4 text-center">{tApps("no_apps_hint")}</p>
          )}

          {sidebarApps.map((app, index) => {
            if (editingApp === app.id) {
              return (
                <AppForm
                  key={app.id}
                  app={app}
                  onSave={(data) => handleUpdate(app.id, data)}
                  onCancel={() => setEditingApp(null)}
                />
              );
            }

            const AppIcon = lucideIcons[app.icon as keyof typeof lucideIcons] as LucideIcon | undefined;
            return (
              <div
                key={app.id}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                className={cn(
                  "flex items-center gap-3 p-3 border rounded-lg transition-colors",
                  dragOverIndex === index
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/50"
                )}
              >
                <div className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground flex-shrink-0">
                  <GripVertical className="w-4 h-4" />
                </div>
                <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                  {AppIcon ? <AppIcon className="w-4 h-4" /> : null}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{app.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{app.url}</div>
                </div>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0",
                  app.openMode === "inline"
                    ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "bg-muted text-muted-foreground"
                )}>
                  {app.openMode === "inline" ? tApps("inline_badge") : tApps("tab_badge")}
                </span>
                <button
                  onClick={() => setEditingApp(app.id)}
                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(app)}
                  className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}

          {showAddForm && (
            <AppForm
              onSave={handleAdd}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {!showAddForm && !editingApp && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddForm(true)}
              className="w-full"
            >
              <Plus className="w-4 h-4 mr-2" />
              {tApps("add_new")}
            </Button>
          )}
        </div>
      </SettingsSection>

      <ConfirmDialog {...confirmDialogProps} />
    </>
  );
}
