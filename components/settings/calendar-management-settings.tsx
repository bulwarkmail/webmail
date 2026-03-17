"use client";

import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/stores/toast-store';
import { SettingsSection } from './settings-section';
import { Plus, Pencil, Trash2, Check, X, Calendar as CalendarIcon, Copy, Link, Upload, Globe, RefreshCw, Eraser } from 'lucide-react';
import { cn, formatDateTime } from '@/lib/utils';
import { ICalImportModal } from '@/components/calendar/ical-import-modal';
import { ICalSubscriptionModal } from '@/components/calendar/ical-subscription-modal';
import { useSettingsStore } from '@/stores/settings-store';

const CALENDAR_COLORS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#06b6d4", // cyan
  "#84cc16", // lime
  "#6366f1", // indigo
  "#a855f7", // purple
  "#e11d48", // rose
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#d946ef", // fuchsia
];

function CalendarColorPicker({
  value,
  onChange,
  allowCustom,
}: {
  value: string;
  onChange: (color: string) => void;
  allowCustom?: boolean;
}) {
  const selectedIsPreset = CALENDAR_COLORS.includes(value);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CALENDAR_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            "w-6 h-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            value === color && "ring-2 ring-offset-2 ring-offset-background ring-foreground"
          )}
          style={{ backgroundColor: color }}
          aria-label={color}
        />
      ))}
      {allowCustom && (
        <label
          className={cn(
            "relative w-6 h-6 rounded-full cursor-pointer transition-transform hover:scale-110 overflow-hidden border-2 border-dashed border-muted-foreground/40",
            !selectedIsPreset && value && "ring-2 ring-offset-2 ring-offset-background ring-foreground"
          )}
          style={!selectedIsPreset && value ? { backgroundColor: value } : undefined}
          title="Custom color"
        >
          <input
            type="color"
            value={value || "#3b82f6"}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
          />
          {(selectedIsPreset || !value) && (
            <span className="absolute inset-0 flex items-center justify-center text-muted-foreground text-xs font-bold">+</span>
          )}
        </label>
      )}
    </div>
  );
}

function CalendarEditForm({
  initial,
  onSave,
  onCancel,
  isLoading,
}: {
  initial?: { name: string; color: string };
  onSave: (data: { name: string; color: string }) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const t = useTranslations('calendar.management');
  const [name, setName] = useState(initial?.name || '');
  const [color, setColor] = useState(initial?.color || '#3b82f6');

  const isValid = name.trim().length > 0;

  return (
    <div className="space-y-3 p-3 rounded-md border border-primary/30 bg-accent/30">
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          {t('name')}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isValid) onSave({ name: name.trim(), color });
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={t('name_placeholder')}
          className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          autoFocus
          disabled={isLoading}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          {t('color')}
        </label>
        <CalendarColorPicker value={color} onChange={setColor} allowCustom />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => isValid && onSave({ name: name.trim(), color })}
          disabled={isLoading || !isValid}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          {initial ? t('save') : t('create')}
        </button>
        <button
          onClick={onCancel}
          disabled={isLoading}
          className="px-3 py-1.5 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

export { CalendarColorPicker, CALENDAR_COLORS };

export function CalendarManagementSettings() {
  const t = useTranslations('calendar.management');
  const { client, serverUrl, username } = useAuthStore();
  const { calendars, updateCalendar, createCalendar, removeCalendar, clearCalendarEvents, fetchCalendars, icalSubscriptions, removeICalSubscription, refreshICalSubscription, isSubscriptionCalendar } = useCalendarStore();

  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [deletingSubId, setDeletingSubId] = useState<string | null>(null);
  const [refreshingSubId, setRefreshingSubId] = useState<string | null>(null);
  const tImport = useTranslations('calendar.import');
  const tSub = useTranslations('calendar.subscription');
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // Load calendars if not yet loaded
  useEffect(() => {
    if (client && calendars.length === 0) {
      fetchCalendars(client);
    }
  }, [client, calendars.length, fetchCalendars]);

  const handleRefreshSubscription = async (subId: string) => {
    if (!client) return;
    setRefreshingSubId(subId);
    try {
      await refreshICalSubscription(client, subId);
      toast.success(tSub('refresh_success'));
    } catch {
      toast.error(tSub('refresh_error'));
    } finally {
      setRefreshingSubId(null);
    }
  };

  const handleDeleteSubscription = async (subId: string) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await removeICalSubscription(client, subId);
      setDeletingSubId(null);
      toast.success(tSub('deleted'));
    } catch {
      toast.error(tSub('delete_error'));
    } finally {
      setIsLoading(false);
    }
  };

  // Close color picker on click outside
  useEffect(() => {
    if (!colorPickerId) return;
    const handleClick = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerId(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColorPickerId(null);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [colorPickerId]);

  const handleCreate = async (data: { name: string; color: string }) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await createCalendar(client, {
        name: data.name,
        color: data.color,
        isVisible: true,
        isSubscribed: true,
      });
      setIsCreating(false);
      toast.success(t('calendar_created'));
    } catch {
      toast.error(t('error_create'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async (calendarId: string, data: { name: string; color: string }) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await updateCalendar(client, calendarId, { name: data.name, color: data.color });
      setEditingId(null);
      toast.success(t('calendar_updated'));
    } catch {
      toast.error(t('error_update'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleColorChange = async (calendarId: string, color: string) => {
    if (!client) return;
    try {
      await updateCalendar(client, calendarId, { color });
      toast.success(t('color_updated'));
    } catch {
      toast.error(t('error_update'));
    }
    setColorPickerId(null);
  };

  const handleDelete = async (calendarId: string) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await removeCalendar(client, calendarId);
      setDeletingId(null);
      toast.success(t('calendar_deleted'));
    } catch {
      toast.error(t('error_delete'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = async (calendarId: string) => {
    if (!client) return;
    setIsLoading(true);
    try {
      const count = await clearCalendarEvents(client, calendarId);
      setClearingId(null);
      toast.success(t('events_cleared', { count }));
    } catch {
      toast.error(t('error_clear'));
    } finally {
      setIsLoading(false);
    }
  };

  const buildCalDavUrl = (calendarId: string) => {
    if (!serverUrl || !username) return null;
    const base = serverUrl.replace(/\/$/, '');
    return `${base}/dav/calendars/user/${encodeURIComponent(username)}/${encodeURIComponent(calendarId)}/`;
  };

  const handleCopyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('url_copied'));
    } catch {
      // Fallback for non-HTTPS contexts
      const textArea = document.createElement('textarea');
      textArea.value = url;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      toast.success(t('url_copied'));
    }
  };

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <div className="space-y-2">
        {calendars.filter(cal => !isSubscriptionCalendar(cal.id)).map((cal) => {
          const color = cal.color || '#3b82f6';

          if (editingId === cal.id) {
            return (
              <CalendarEditForm
                key={cal.id}
                initial={{ name: cal.name, color }}
                onSave={(data) => handleUpdate(cal.id, data)}
                onCancel={() => setEditingId(null)}
                isLoading={isLoading}
              />
            );
          }

          if (deletingId === cal.id) {
            return (
              <div key={cal.id} className="flex items-center gap-3 py-2.5 px-3 bg-destructive/5 rounded-md border border-destructive/20">
                <Trash2 className="w-4 h-4 text-destructive flex-shrink-0" />
                <p className="text-sm text-foreground flex-1">
                  {t('confirm_delete', { name: cal.name })}
                </p>
                <button
                  onClick={() => handleDelete(cal.id)}
                  disabled={isLoading}
                  className="px-3 py-1 text-xs font-medium bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 disabled:opacity-50"
                >
                  {t('delete')}
                </button>
                <button
                  onClick={() => setDeletingId(null)}
                  className="px-3 py-1 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
                >
                  {t('cancel')}
                </button>
              </div>
            );
          }

          if (clearingId === cal.id) {
            return (
              <div key={cal.id} className="flex items-center gap-3 py-2.5 px-3 bg-amber-500/5 rounded-md border border-amber-500/20">
                <Eraser className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <p className="text-sm text-foreground flex-1">
                  {t('confirm_clear', { name: cal.name })}
                </p>
                <button
                  onClick={() => handleClear(cal.id)}
                  disabled={isLoading}
                  className="px-3 py-1 text-xs font-medium bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50"
                >
                  {t('clear_events')}
                </button>
                <button
                  onClick={() => setClearingId(null)}
                  className="px-3 py-1 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
                >
                  {t('cancel')}
                </button>
              </div>
            );
          }

          return (
            <div
              key={cal.id}
              className="flex items-center gap-3 py-2.5 px-3 rounded-md border border-border bg-background group"
            >
              {/* Color swatch - clickable to change color */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setColorPickerId(colorPickerId === cal.id ? null : cal.id)}
                  className="w-5 h-5 rounded-full shrink-0 transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  style={{ backgroundColor: color }}
                  title={t('change_color')}
                />

                {/* Inline color picker popover */}
                {colorPickerId === cal.id && (
                  <div
                    ref={colorPickerRef}
                    className="absolute left-0 top-full mt-2 z-50 bg-background border border-border rounded-lg shadow-lg p-3 w-56"
                  >
                    <CalendarColorPicker
                      value={color}
                      onChange={(c) => handleColorChange(cal.id, c)}
                      allowCustom
                    />
                  </div>
                )}
              </div>

              <CalendarIcon className="w-4 h-4 text-muted-foreground flex-shrink-0" />

              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium truncate block">{cal.name}</span>
                {(() => {
                  const caldavUrl = buildCalDavUrl(cal.id);
                  if (!caldavUrl) return null;
                  return (
                    <div className="flex items-center gap-1 mt-0.5">
                      <Link className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      <span className="text-xs text-muted-foreground truncate" title={caldavUrl}>
                        {caldavUrl}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyUrl(caldavUrl);
                        }}
                        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                        title={t('copy_url')}
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })()}
              </div>

              {cal.isDefault && (
                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  {t('default')}
                </span>
              )}

              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => setEditingId(cal.id)}
                  className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title={t('edit')}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setClearingId(cal.id)}
                  className="p-1.5 rounded-md hover:bg-amber-500/10 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 transition-colors"
                  title={t('clear_events')}
                >
                  <Eraser className="w-3.5 h-3.5" />
                </button>
                {!cal.isDefault && (
                  <button
                    type="button"
                    onClick={() => setDeletingId(cal.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    title={t('delete')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {isCreating ? (
          <CalendarEditForm
            onSave={handleCreate}
            onCancel={() => setIsCreating(false)}
            isLoading={isLoading}
          />
        ) : (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-2 flex-1 py-2.5 px-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border border-dashed border-border transition-colors"
            >
              <Plus className="w-4 h-4" />
              {t('add_calendar')}
            </button>
            <button
              type="button"
              onClick={() => setShowImportModal(true)}
              className="flex items-center gap-2 py-2.5 px-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border border-dashed border-border transition-colors"
            >
              <Upload className="w-4 h-4" />
              {tImport('title')}
            </button>
            <button
              type="button"
              onClick={() => setShowSubscriptionModal(true)}
              className="flex items-center gap-2 py-2.5 px-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border border-dashed border-border transition-colors"
            >
              <Globe className="w-4 h-4" />
              {tSub('title')}
            </button>
          </div>
        )}
      </div>

      {/* iCal Subscriptions */}
      {icalSubscriptions.length > 0 && (
        <div className="mt-6 space-y-2">
          <h4 className="text-sm font-medium text-foreground flex items-center gap-2">
            <Globe className="w-4 h-4 text-muted-foreground" />
            {tSub('section_title')}
          </h4>
          {icalSubscriptions.map((sub) => {
            if (deletingSubId === sub.id) {
              return (
                <div key={sub.id} className="flex items-center gap-3 py-2.5 px-3 bg-destructive/5 rounded-md border border-destructive/20">
                  <Trash2 className="w-4 h-4 text-destructive flex-shrink-0" />
                  <p className="text-sm text-foreground flex-1">
                    {tSub('confirm_delete', { name: sub.name })}
                  </p>
                  <button
                    onClick={() => handleDeleteSubscription(sub.id)}
                    disabled={isLoading}
                    className="px-3 py-1 text-xs font-medium bg-destructive text-destructive-foreground rounded-md hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {t('delete')}
                  </button>
                  <button
                    onClick={() => setDeletingSubId(null)}
                    className="px-3 py-1 text-xs bg-muted text-foreground rounded-md hover:bg-accent"
                  >
                    {t('cancel')}
                  </button>
                </div>
              );
            }

            return (
              <div
                key={sub.id}
                className="flex items-center gap-3 py-2.5 px-3 rounded-md border border-border bg-background group"
              >
                <span
                  className="w-5 h-5 rounded-full shrink-0"
                  style={{ backgroundColor: sub.color }}
                />
                <Globe className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium truncate block">{sub.name}</span>
                  <span className="text-xs text-muted-foreground truncate block" title={sub.url}>
                    {sub.url}
                  </span>
                  {sub.lastRefreshed && (
                    <span className="text-xs text-muted-foreground">
                      {tSub('last_refreshed', { time: formatDateTime(sub.lastRefreshed, timeFormat, { month: 'short', day: 'numeric', year: 'numeric' }) })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => handleRefreshSubscription(sub.id)}
                    disabled={refreshingSubId === sub.id}
                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    title={tSub('refresh')}
                  >
                    <RefreshCw className={cn("w-3.5 h-3.5", refreshingSubId === sub.id && "animate-spin")} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeletingSubId(sub.id)}
                    className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    title={tSub('unsubscribe')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showImportModal && client && (
        <ICalImportModal
          calendars={calendars}
          client={client}
          onClose={() => setShowImportModal(false)}
        />
      )}

      {showSubscriptionModal && client && (
        <ICalSubscriptionModal
          client={client}
          onClose={() => setShowSubscriptionModal(false)}
        />
      )}
    </SettingsSection>
  );
}
