'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { X, Plus, Pencil, Trash2, ExternalLink, PanelRight } from 'lucide-react';
import { icons as lucideIcons, type LucideIcon } from 'lucide-react';
import { cn, generateUUID } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IconPicker } from './icon-picker';
import { useSettingsStore, type SidebarApp } from '@/stores/settings-store';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface SidebarAppFormData {
  name: string;
  url: string;
  icon: string;
  openMode: 'tab' | 'inline';
  showOnMobile: boolean;
}

function SidebarAppForm({
  app,
  onSave,
  onCancel,
}: {
  app?: SidebarApp;
  onSave: (data: SidebarAppFormData) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('sidebar_apps');
  const isEditing = !!app;

  const [formData, setFormData] = useState<SidebarAppFormData>({
    name: app?.name || '',
    url: app?.url || '',
    icon: app?.icon || 'Globe',
    openMode: app?.openMode || 'tab',
    showOnMobile: app?.showOnMobile ?? false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!formData.name.trim()) {
      newErrors.name = t('name_required');
    }
    if (!formData.url.trim()) {
      newErrors.url = t('url_required');
    } else {
      try {
        const parsed = new URL(formData.url);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          newErrors.url = t('url_invalid');
        }
      } catch {
        newErrors.url = t('url_invalid');
      }
    }
    if (!formData.icon) {
      newErrors.icon = t('icon_required');
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
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Name */}
      <div>
        <label htmlFor="app-name" className="block text-sm font-medium mb-1">
          {t('name_label')} <span className="text-destructive">*</span>
        </label>
        <Input
          id="app-name"
          type="text"
          maxLength={50}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={t('name_placeholder')}
          className={errors.name ? 'border-destructive' : ''}
        />
        {errors.name && (
          <p className="text-sm text-destructive mt-1">{errors.name}</p>
        )}
      </div>

      {/* URL */}
      <div>
        <label htmlFor="app-url" className="block text-sm font-medium mb-1">
          {t('url_label')} <span className="text-destructive">*</span>
        </label>
        <Input
          id="app-url"
          type="url"
          maxLength={2048}
          value={formData.url}
          onChange={(e) => setFormData({ ...formData, url: e.target.value })}
          placeholder="https://example.com"
          className={errors.url ? 'border-destructive' : ''}
        />
        {errors.url && (
          <p className="text-sm text-destructive mt-1">{errors.url}</p>
        )}
      </div>

      {/* Open Mode */}
      <div>
        <label className="block text-sm font-medium mb-2">{t('open_mode_label')}</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setFormData({ ...formData, openMode: 'tab' })}
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors flex-1',
              formData.openMode === 'tab'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            )}
          >
            <ExternalLink className="w-4 h-4" />
            {t('open_new_tab')}
          </button>
          <button
            type="button"
            onClick={() => setFormData({ ...formData, openMode: 'inline' })}
            className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors flex-1',
              formData.openMode === 'inline'
                ? 'bg-primary/10 border-primary/30 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground'
            )}
          >
            <PanelRight className="w-4 h-4" />
            {t('open_inline')}
          </button>
        </div>
      </div>

      {/* Icon Picker */}
      <div>
        <label className="block text-sm font-medium mb-2">
          {t('icon_label')} <span className="text-destructive">*</span>
          {SelectedIcon && (
            <span className="inline-flex items-center gap-1.5 ml-2 text-muted-foreground font-normal">
              - <SelectedIcon className="w-4 h-4" /> {formData.icon}
            </span>
          )}
        </label>
        <IconPicker
          value={formData.icon}
          onChange={(icon) => setFormData({ ...formData, icon })}
        />
        {errors.icon && (
          <p className="text-sm text-destructive mt-1">{errors.icon}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit">
          {isEditing ? t('update') : t('add')}
        </Button>
      </div>
    </form>
  );
}

interface SidebarAppsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SidebarAppsModal({ isOpen, onClose }: SidebarAppsModalProps) {
  const t = useTranslations('sidebar_apps');
  const { sidebarApps, addSidebarApp, updateSidebarApp, removeSidebarApp } = useSettingsStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  const modalRef = useFocusTrap({
    isActive: isOpen,
    onEscape: () => {
      if (isCreating || editingId) {
        setIsCreating(false);
        setEditingId(null);
      } else {
        onClose();
      }
    },
    restoreFocus: true,
  });

  const handleCreate = useCallback((data: SidebarAppFormData) => {
    const id = `app-${generateUUID()}`;
    addSidebarApp({ id, ...data });
    setIsCreating(false);
  }, [addSidebarApp]);

  const handleUpdate = useCallback((id: string, data: SidebarAppFormData) => {
    updateSidebarApp(id, data);
    setEditingId(null);
  }, [updateSidebarApp]);

  const handleDelete = useCallback(async (app: SidebarApp) => {
    const confirmed = await confirmDialog({
      title: t('delete_confirm_title'),
      message: t('delete_confirm', { name: app.name }),
      confirmText: t('delete'),
      variant: 'destructive',
    });
    if (!confirmed) return;
    removeSidebarApp(app.id);
  }, [removeSidebarApp, confirmDialog, t]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sidebar-apps-modal-title"
        className={cn(
          'bg-background border border-border rounded-lg shadow-xl',
          'w-full max-w-2xl max-h-[90vh] overflow-hidden',
          'animate-in zoom-in-95 duration-200'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id="sidebar-apps-modal-title" className="text-lg font-semibold text-foreground">
            {t('modal_title')}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {/* Create form */}
          {isCreating && (
            <div className="mb-6 p-4 border border-border rounded-lg bg-muted/30">
              <h3 className="text-sm font-semibold mb-4">{t('add_new')}</h3>
              <SidebarAppForm
                onSave={handleCreate}
                onCancel={() => setIsCreating(false)}
              />
            </div>
          )}

          {/* Add button */}
          {!isCreating && !editingId && (
            <Button
              onClick={() => setIsCreating(true)}
              className="mb-6 w-full sm:w-auto"
            >
              <Plus className="w-4 h-4 mr-2" />
              {t('add_new')}
            </Button>
          )}

          {/* Apps list */}
          <div className="space-y-3">
            {sidebarApps.map((app) => {
              const AppIcon = lucideIcons[app.icon as keyof typeof lucideIcons] as LucideIcon | undefined;

              if (editingId === app.id) {
                return (
                  <div key={app.id} className="p-4 border border-border rounded-lg bg-muted/30">
                    <h3 className="text-sm font-semibold mb-4">{t('edit_app')}</h3>
                    <SidebarAppForm
                      app={app}
                      onSave={(data) => handleUpdate(app.id, data)}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                );
              }

              return (
                <div
                  key={app.id}
                  className="flex items-center gap-3 p-3 border border-border rounded-lg"
                >
                  <div className="flex items-center justify-center w-9 h-9 rounded-md bg-muted">
                    {AppIcon ? <AppIcon className="w-5 h-5 text-muted-foreground" /> : null}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{app.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{app.url}</p>
                  </div>
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                    app.openMode === 'inline'
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400'
                      : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
                  )}>
                    {app.openMode === 'inline' ? t('inline_badge') : t('tab_badge')}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingId(app.id)}
                      disabled={!!editingId || isCreating}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(app)}
                      disabled={!!editingId || isCreating}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              );
            })}

            {sidebarApps.length === 0 && !isCreating && (
              <div className="text-center py-12 text-muted-foreground">
                <Plus className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="text-sm">{t('no_apps')}</p>
                <p className="text-xs mt-1">{t('no_apps_hint')}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
