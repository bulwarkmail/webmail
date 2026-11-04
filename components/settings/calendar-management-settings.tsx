"use client";

import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useCalendarStore } from '@/stores/calendar-store';
import { CALENDAR_KIND_COMPONENTS, CalendarKindPicker, type CalendarKind } from '@/components/calendar/calendar-kind-picker';
import type { Calendar, CalendarComponentType } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { getActiveAccountSlotHeaders } from '@/lib/auth/active-account-slot';
import { toast } from '@/stores/toast-store';
import { SettingsSection } from './settings-section';
import { Plus, Pencil, Trash2, Calendar as CalendarIcon, Copy, Link, Upload, Globe, RefreshCw, Eraser, Users, Bell, ArrowUp, ArrowDown, GripVertical, MoreVertical } from '@/components/icons';
import { IconButton } from '@/components/ui/icon-button';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { AlertListEditor } from '@/components/calendar/alert-list-editor';
import { alertsToRows, rowsToAlerts, type AlertRow } from '@/lib/calendar-alerts';
import { ShareCollectionDialog } from './share-collection-dialog';
import type { CalendarRights } from '@/lib/jmap/types';
import { cn, formatDateTime, redactUrlCredentials } from '@/lib/utils';
import { collectionDisplayName } from '@/lib/default-collection-name';
import { ICalImportModal } from '@/components/calendar/ical-import-modal';
import { ICalSubscriptionModal } from '@/components/calendar/ical-subscription-modal';
import { useSettingsStore } from '@/stores/settings-store';
import { useManagedAccountStore } from '@/stores/managed-account-store';
import { useAccountStore } from '@/stores/account-store';
import { apiFetch } from '@/lib/browser-navigation';
import { CALENDAR_COLORS, sharedCalendarColorKey } from '@/lib/shared-calendar-colors';
import { IS_LITE } from '@/lib/lite';
import { shareRecipientNames, useShareRecipientLabels } from '@/hooks/use-share-recipient-labels';
import { calendarAccountKey, moveCalendar } from '@/lib/calendar-sort';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TOUCH_HIT_AREA } from '@/components/ui/button';
import { TermInfo } from '@/components/ui/term';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useConfig } from '@/hooks/use-config';

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
  const customRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  // Take the custom color when the system dialog confirms it (`change`), not
  // at every step (`input`, React's onChange): the first step closed the
  // calendar menu around the picker and saved a color the user passed by
  // (#1366).
  useEffect(() => {
    const input = customRef.current;
    if (!input) return;
    const commit = () => onChangeRef.current(input.value);
    input.addEventListener('change', commit);
    return () => input.removeEventListener('change', commit);
  }, [allowCustom]);
  useEffect(() => {
    if (customRef.current) customRef.current.value = value || "#3b82f6";
  }, [value]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CALENDAR_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          className={cn(
            "w-6 h-6 rounded-full transition-transform hover:scale-110 focus-visible:outline-hidden",
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
            ref={customRef}
            type="color"
            defaultValue={value || "#3b82f6"}
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

export function CalendarEditForm({
  initial,
  onSave,
  onCancel,
  isLoading,
}: {
  initial?: { name: string; color: string };
  onSave: (data: { name: string; color: string; components?: CalendarComponentType[] }) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const t = useTranslations('calendar.management');
  const [name, setName] = useState(initial?.name || '');
  const [color, setColor] = useState(initial?.color || '#3b82f6');
  // Only meaningful when creating: the component set is fixed once the
  // collection exists (#760).
  const [kind, setKind] = useState<CalendarKind>('events');

  const isValid = name.trim().length > 0;
  const submit = () => onSave({
    name: name.trim(),
    color,
    ...(initial ? {} : { components: CALENDAR_KIND_COMPONENTS[kind] }),
  });

  return (
    <div className="space-y-3 p-3 rounded-md border border-primary/30 bg-accent/30">
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          {t('name')}
        </label>
        <input
          aria-label={t('name')}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && isValid) submit();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={t('name_placeholder')}
          className="w-full px-3 py-1.5 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-hidden"
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

      {!initial && (
        <CalendarKindPicker value={kind} onChange={setKind} disabled={isLoading} />
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => isValid && submit()}
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

type DefaultAlertsUpdate = Pick<Calendar, 'defaultAlertsWithTime' | 'defaultAlertsWithoutTime'>;

export function CalendarDefaultAlertsForm({
  calendar,
  otherAlertIds = [],
  onSave,
  onCancel,
  isLoading,
}: {
  calendar: Calendar;
  /** Default alert ids of the account's other calendars. */
  otherAlertIds?: string[];
  onSave: (updates: DefaultAlertsUpdate) => void;
  onCancel: () => void;
  isLoading: boolean;
}) {
  const t = useTranslations('calendar.management');
  const tWording = useTranslations('uxs_wording');
  // Alerts the rows can't show are written back unchanged.
  const [timed] = useState(() => alertsToRows(calendar.defaultAlertsWithTime));
  const [allDay] = useState(() => alertsToRows(calendar.defaultAlertsWithoutTime));
  const [timedRows, setTimedRows] = useState<AlertRow[]>(timed.rows);
  const [allDayRows, setAllDayRows] = useState<AlertRow[]>(allDay.rows);

  // An emptied list is sent as {}: Stalwart refuses null for these maps.
  // Stalwart 1.0 wants every default alert id in the account to be unique,
  // across both lists and all calendars (#1435), so the ids carry the
  // calendar and the list and skip any id another calendar already uses.
  const submit = () => {
    const taken = [...otherAlertIds, ...Object.keys(timed.preserved), ...Object.keys(allDay.preserved)];
    onSave({
      defaultAlertsWithTime: rowsToAlerts(timedRows, timed.preserved, { prefix: `${calendar.id}-timed-`, taken }),
      defaultAlertsWithoutTime: rowsToAlerts(allDayRows, allDay.preserved, { prefix: `${calendar.id}-allday-`, taken }),
    });
  };

  return (
    <div className="space-y-3 p-3 rounded-md border border-primary/30 bg-accent/30">
      <div>
        <h4 className="text-sm font-medium">{t('default_alerts_title', { name: collectionDisplayName(calendar.name, 'calendar', tWording('default_calendar')) })}</h4>
        <p className="text-xs text-muted-foreground mt-0.5">{t('default_alerts_hint')}</p>
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          {t('default_alerts_timed')}
        </label>
        <AlertListEditor
          rows={timedRows}
          onChange={setTimedRows}
          keptCount={Object.keys(timed.preserved).length}
          disabled={isLoading}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">
          {t('default_alerts_all_day')}
        </label>
        <AlertListEditor
          rows={allDayRows}
          onChange={setAllDayRows}
          keptCount={Object.keys(allDay.preserved).length}
          disabled={isLoading}
        />
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={submit}
          disabled={isLoading}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
        >
          {t('save')}
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

export function CalendarManagementSettings() {
  const t = useTranslations('calendar.management');
  const tWording = useTranslations('uxs_wording');
  const calName = (cal: { name: string }) => collectionDisplayName(cal.name, 'calendar', tWording('default_calendar'));
  const { client, serverUrl, username } = useAuthStore();
  const managedAccountId = useManagedAccountStore((s) => s.managedAccountId);
  const { calendars, updateCalendar, reorderCalendars, shareCalendar, createCalendar, removeCalendar, clearCalendarEvents, fetchCalendars, icalSubscriptions: allSubs, removeICalSubscription, refreshICalSubscription, isSubscriptionCalendar } = useCalendarStore();
  // Subscriptions are persisted globally but scoped per JMAP account via
  // accountId. Legacy entries with no accountId show in the active account.
  const currentAccountId = client?.getAccountId();
  const icalSubscriptions = useMemo(
    () => allSubs.filter(s => !s.accountId || s.accountId === currentAccountId),
    [allSubs, currentAccountId],
  );

  const [discoveredCalDavUrls, setDiscoveredCalDavUrls] = useState<Record<string, string | null>>({});
  const [wellKnownCalDavUrl, setWellKnownCalDavUrl] = useState<string | null>(null);

  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [alertsEditingId, setAlertsEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  // The calendar whose CalDAV address is open under "Use in other apps".
  const [shownUrlId, setShownUrlId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [editingSubscription, setEditingSubscription] = useState<typeof icalSubscriptions[0] | null>(null);
  const [deletingSubId, setDeletingSubId] = useState<string | null>(null);
  const [refreshingSubId, setRefreshingSubId] = useState<string | null>(null);
  const tImport = useTranslations('calendar.import');
  const tSub = useTranslations('calendar.subscription');
  const tConfirm = useTranslations('settings.calendar_management');
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const sharedCalendarColors = useSettingsStore((s) => s.sharedCalendarColors);
  const setSharedCalendarColor = useSettingsStore((s) => s.setSharedCalendarColor);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const { contextMenu, openContextMenu, openContextMenuFrom, closeContextMenu, menuRef } = useContextMenu<Calendar>();
  // No right-click on a touch screen, so the hint about it goes there.
  const touch = useMediaQuery('(pointer: coarse)');
  // The demo has no server to import into or subscribe from, as in Calendar.
  const { demoMode } = useConfig();

  const listedCalendars = calendars
    .filter(cal => !isSubscriptionCalendar(cal.id))
    .filter(cal => !managedAccountId || cal.accountId === managedAccountId);
  // Only the user's own calendars are offered for reordering; a shared
  // calendar's order is left to its owner.
  const orderableCalendars = listedCalendars.filter(cal => !cal.isShared);

  // Principal ids belong to one server: only calendars of the account
  // `client` talks to get their recipients named.
  const activeLocalAccountId = useAccountStore((s) => s.activeAccountId);
  const resolvesShares = (cal: Calendar) => !cal.localAccountId || cal.localAccountId === activeLocalAccountId;
  const shareLabels = useShareRecipientLabels(
    client,
    calendars.some(cal => !cal.isShared && Object.keys(cal.shareWith ?? {}).length > 0 && resolvesShares(cal)),
  );

  // Load calendars if not yet loaded
  useEffect(() => {
    if (client && calendars.length === 0) {
      fetchCalendars(client);
    }
  }, [client, calendars.length, fetchCalendars]);

  useEffect(() => {
    // CalDAV discovery runs through /api/caldav/discover, absent in the static build.
    if (!client || !serverUrl || !username || IS_LITE) {
      setDiscoveredCalDavUrls({});
      setWellKnownCalDavUrl(null);
      return;
    }

    const primaryKey = username;
    const accounts = new Map<string, string[]>();
    accounts.set(primaryKey, [username]);

    for (const calendar of calendars) {
      if (!calendar.isShared) continue;
      const key = calendar.accountId || calendar.accountName || calendar.id;
      const candidates = accounts.get(key) || [];
      if (calendar.accountId) candidates.push(calendar.accountId);
      if (calendar.accountName) candidates.push(calendar.accountName);
      accounts.set(key, candidates);
    }

    const controller = new AbortController();

    apiFetch('/api/caldav/discover', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getActiveAccountSlotHeaders(),
      },
      body: JSON.stringify({
        accounts: Array.from(accounts.entries()).map(([key, candidates]) => ({ key, candidates })),
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`CalDAV discovery failed: ${response.status}`);
        return response.json() as Promise<{
          wellKnownUrl?: string;
          accounts?: Record<string, { url: string | null }>;
        }>;
      })
      .then((payload) => {
        setWellKnownCalDavUrl(payload.wellKnownUrl || null);
        const next: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(payload.accounts || {})) {
          next[key] = value?.url || null;
        }
        setDiscoveredCalDavUrls(next);
      })
      .catch(() => {
        // Below the server address, which may carry a path (https://host/stalwart).
        const fallbackWellKnown = `${serverUrl.replace(/\/+$/, '')}/.well-known/caldav`;
        setDiscoveredCalDavUrls({});
        setWellKnownCalDavUrl(fallbackWellKnown);
      });

    return () => controller.abort();
  }, [client, calendars, serverUrl, username]);

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

  const handleCreate = async (data: { name: string; color: string; components?: CalendarComponentType[] }) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await createCalendar(client, {
        name: data.name,
        color: data.color,
        isVisible: true,
        isSubscribed: true,
      }, { components: data.components });
      setIsCreating(false);
      toast.success(t('calendar_created'));
    } catch {
      toast.error(t('error_create'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdate = async (
    calendarId: string,
    data: { name: string; color: string },
    shownColor: string,
  ) => {
    if (!client) return;
    setIsLoading(true);
    try {
      // The colour only when the user changed it: Stalwart 1.0 accepts only
      // #rgb, #rrggbb or a CSS colour name, so sending back one another
      // client stored (an 8-digit hex from Apple Calendar) failed the rename.
      await updateCalendar(client, calendarId, {
        name: data.name,
        ...(data.color !== shownColor ? { color: data.color } : {}),
      });
      setEditingId(null);
      toast.success(t('calendar_updated'));
    } catch {
      toast.error(t('error_update'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDefaultAlertsSave = async (calendarId: string, updates: DefaultAlertsUpdate) => {
    if (!client) return;
    setIsLoading(true);
    try {
      await updateCalendar(client, calendarId, updates);
      setAlertsEditingId(null);
      toast.success(t('default_alerts_updated'));
    } catch {
      toast.error(t('error_update'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleColorChange = async (calendarId: string, color: string) => {
    if (!client) return;
    // Shared calendars: recolor locally only - the viewer usually can't write
    // the owner's calendar and it'd recolor it for everyone (see #345).
    const cal = calendars.find((c) => c.id === calendarId);
    if (cal?.isShared) {
      setSharedCalendarColor(sharedCalendarColorKey(cal), color);
      toast.success(t('color_updated'));
      setColorPickerId(null);
      return;
    }
    try {
      await updateCalendar(client, calendarId, { color });
      toast.success(t('color_updated'));
    } catch {
      toast.error(t('error_update'));
    }
    setColorPickerId(null);
  };

  // Move a calendar next to `targetId` (before it when moving up, after it
  // when moving down) and store the new order as sortOrder.
  const handleMove = async (calendarId: string, targetId: string | undefined) => {
    if (!client || !targetId) return;
    const orderedIds = moveCalendar(calendars, calendarId, targetId);
    if (!orderedIds) return;
    try {
      await reorderCalendars(client, orderedIds);
    } catch {
      toast.error(t('error_update'));
    }
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
    const calendar = calendars.find((entry) => entry.id === calendarId);
    if (!calendar) return null;
    const accountKey = calendar.isShared ? (calendar.accountId || calendar.accountName || calendar.id) : username;
    return discoveredCalDavUrls[accountKey] || wellKnownCalDavUrl;
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

  // One action list per calendar (R6): the row's icons on wider screens, the
  // ⋮ and right-click menu everywhere.
  const calendarActions = (cal: Calendar) => {
    const actions: Array<{ id: string; label: string; icon: typeof Pencil; run: () => void; destructive?: boolean }> = [
      { id: 'edit', label: t('edit'), icon: Pencil, run: () => setEditingId(cal.id) },
    ];
    // The owner's defaults; a sharee can't write the calendar.
    if (!cal.isShared) {
      actions.push({ id: 'alerts', label: t('default_alerts'), icon: Bell, run: () => setAlertsEditingId(cal.id) });
    }
    if (cal.myRights?.mayShare && !cal.isShared && !isSubscriptionCalendar(cal.id)) {
      actions.push({ id: 'share', label: t('share'), icon: Users, run: () => setSharingId(cal.id) });
    }
    actions.push({ id: 'clear', label: t('clear_events'), icon: Eraser, run: () => setClearingId(cal.id) });
    if (!cal.isDefault) {
      actions.push({ id: 'delete', label: t('delete'), icon: Trash2, run: () => setDeletingId(cal.id), destructive: true });
    }
    return actions;
  };

  const renderRowMenu = () => {
    const cal = contextMenu.data;
    if (!cal) return null;
    const run = (fn: () => void) => () => { closeContextMenu(); fn(); };
    const siblings = cal.isShared ? [] : orderableCalendars.filter(c => calendarAccountKey(c) === calendarAccountKey(cal));
    const orderIndex = siblings.indexOf(cal);
    const previousId = siblings[orderIndex - 1]?.id;
    const nextId = siblings[orderIndex + 1]?.id;
    const buildUrl = buildCalDavUrl(cal.id);
    const actions = calendarActions(cal);
    const plain = actions.filter((a) => !a.destructive);
    const destructive = actions.filter((a) => a.destructive);
    return (
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        {plain.map((a) => (
          <ContextMenuItem key={a.id} icon={a.icon} label={a.label} onClick={run(a.run)} />
        ))}
        {buildUrl && (
          <ContextMenuItem icon={Copy} label={t('copy_url')} onClick={run(() => handleCopyUrl(buildUrl))} />
        )}
        {siblings.length > 1 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem icon={ArrowUp} label={t('move_up')} disabled={!previousId} onClick={run(() => void handleMove(cal.id, previousId))} />
            <ContextMenuItem icon={ArrowDown} label={t('move_down')} disabled={!nextId} onClick={run(() => void handleMove(cal.id, nextId))} />
          </>
        )}
        {destructive.length > 0 && <ContextMenuSeparator />}
        {destructive.map((a) => (
          <ContextMenuItem key={a.id} icon={a.icon} label={a.label} destructive onClick={run(a.run)} />
        ))}
      </ContextMenu>
    );
  };

  return (
    <SettingsSection id="calendars" title={t('title')} description={touch ? t('description_touch') : t('description')}>
      {renderRowMenu()}
      <div className="space-y-2">
        {listedCalendars.map((cal) => {
          const color = (cal.isShared && sharedCalendarColors[sharedCalendarColorKey(cal)]) || cal.color || '#3b82f6';
          // Up and down step over the neighbours of the same account.
          const siblings = cal.isShared ? [] : orderableCalendars.filter(c => calendarAccountKey(c) === calendarAccountKey(cal));
          const orderIndex = siblings.indexOf(cal);
          const isOrderable = siblings.length > 1;
          const previousId = siblings[orderIndex - 1]?.id;
          const nextId = siblings[orderIndex + 1]?.id;

          if (editingId === cal.id) {
            return (
              <CalendarEditForm
                key={cal.id}
                initial={{ name: calName(cal), color }}
                // Saved unchanged, the shown name keeps the server's own.
                onSave={(data) => handleUpdate(cal.id, { ...data, name: data.name === calName(cal) ? cal.name : data.name }, color)}
                onCancel={() => setEditingId(null)}
                isLoading={isLoading}
              />
            );
          }

          if (alertsEditingId === cal.id) {
            return (
              <CalendarDefaultAlertsForm
                key={cal.id}
                calendar={cal}
                otherAlertIds={calendars.filter((c) => c.id !== cal.id).flatMap((c) => [
                  ...Object.keys(c.defaultAlertsWithTime ?? {}),
                  ...Object.keys(c.defaultAlertsWithoutTime ?? {}),
                ])}
                onSave={(updates) => handleDefaultAlertsSave(cal.id, updates)}
                onCancel={() => setAlertsEditingId(null)}
                isLoading={isLoading}
              />
            );
          }

          return (
            <div
              key={cal.id}
              data-testid="calendar-settings-item"
              data-calendar-name={cal.name}
              draggable={isOrderable}
              onDragStart={isOrderable ? (e) => {
                setDraggingId(cal.id);
                // Firefox starts no drag without data.
                e.dataTransfer.setData('text/plain', cal.id);
                e.dataTransfer.effectAllowed = 'move';
              } : undefined}
              onDragOver={isOrderable && draggingId ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } : undefined}
              onDrop={isOrderable && draggingId ? (e) => { e.preventDefault(); void handleMove(draggingId, cal.id); setDraggingId(null); } : undefined}
              onDragEnd={() => setDraggingId(null)}
              onContextMenu={(e) => openContextMenu(e, cal)}
              className={cn(
                "flex items-center gap-2 sm:gap-3 py-2.5 px-3 rounded-md border border-border bg-background group",
                draggingId === cal.id && "opacity-50",
              )}
            >
              {isOrderable && (
                // No HTML drag and drop on touch screens: the arrows do it there.
                <GripVertical className="w-4 h-4 -me-1.5 text-muted-foreground/60 cursor-grab flex-shrink-0 pointer-coarse:hidden" aria-hidden="true" />
              )}
              {/* Color swatch - clickable to change color */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setColorPickerId(colorPickerId === cal.id ? null : cal.id)}
                  className={cn(
                    "block w-5 h-5 rounded-full shrink-0 transition-transform hover:scale-110 focus-visible:outline-hidden",
                    TOUCH_HIT_AREA,
                  )}
                  style={{ backgroundColor: color }}
                  title={t('change_color')}
                  aria-label={t('change_color')}
                />

                {/* Inline color picker popover */}
                {colorPickerId === cal.id && (
                  <div
                    ref={colorPickerRef}
                    className="absolute start-0 top-full mt-2 z-50 bg-background border border-border rounded-lg shadow-lg p-3 w-56"
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
                <span className="text-sm font-medium truncate block" title={calName(cal)} dir="auto">{calName(cal)}</span>
                {(() => {
                  const caldavUrl = buildCalDavUrl(cal.id);
                  if (!caldavUrl) return null;
                  if (shownUrlId !== cal.id) {
                    return (
                      <button
                        type="button"
                        aria-expanded={false}
                        data-testid="calendar-use-in-other-apps"
                        onClick={(e) => { e.stopPropagation(); setShownUrlId(cal.id); }}
                        className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Link className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                        {tWording('use_in_other_apps')}
                      </button>
                    );
                  }
                  return (
                    <div className="flex items-center gap-1 mt-0.5">
                      <Link className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      {/* An address reads left to right in Arabic too, cut at its end. */}
                      <span dir="ltr" className="text-xs text-muted-foreground truncate" title={caldavUrl}>
                        {caldavUrl}
                      </span>
                      <IconButton
                        label={t('copy_url')}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopyUrl(caldavUrl);
                        }}
                        className="-my-1.5 hidden sm:inline-flex flex-shrink-0 text-muted-foreground"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </IconButton>
                    </div>
                  );
                })()}
              </div>

              {cal.isDefault && (
                <span className="flex-shrink-0 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  {t('default')}
                </span>
              )}

              {(() => {
                const shareCount = Object.keys(cal.shareWith || {}).length;
                if (shareCount === 0 || cal.isShared) return null;
                const names = resolvesShares(cal) ? shareRecipientNames(cal.shareWith, shareLabels) : null;
                const label = names
                  ? t('shared_with', { names: names.join(', ') })
                  : t('shared_with_count', { count: shareCount });
                return (
                  <span
                    className="flex flex-shrink-0 items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full"
                    title={label}
                    data-testid="calendar-shared-indicator"
                  >
                    <Users className="w-3 h-3" aria-hidden="true" />
                    <span aria-hidden="true">{shareCount}</span>
                    <span className="sr-only">{label}</span>
                  </span>
                );
              })()}

              {/* Phone: seven icons next to the name left it a letter or two
                  and pushed the Default badge over the copy button, so the
                  row actions sit behind a ⋮ there, as for folders. */}
              <IconButton
                label={t('row_actions', { name: calName(cal) })}
                className="sm:hidden flex-shrink-0 text-muted-foreground"
                onClick={(e) => openContextMenuFrom(e.currentTarget, cal, 'end')}
              >
                <MoreVertical />
              </IconButton>

              {/* Shown for touch too: there is no hover, and no HTML drag and drop. */}
              {isOrderable && (
                <div className="hidden sm:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                  <IconButton label={t('move_up')} onClick={() => handleMove(cal.id, previousId)} disabled={!previousId} className="text-muted-foreground">
                    <ArrowUp />
                  </IconButton>
                  <IconButton label={t('move_down')} onClick={() => handleMove(cal.id, nextId)} disabled={!nextId} className="text-muted-foreground">
                    <ArrowDown />
                  </IconButton>
                </div>
              )}

              <div className="hidden sm:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                {calendarActions(cal).map((action) => (
                  <IconButton
                    key={action.id}
                    label={action.label}
                    onClick={action.run}
                    className={cn(
                      "text-muted-foreground",
                      action.destructive && "hover:text-destructive hover:bg-destructive/10",
                      action.id === 'clear' && "hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400",
                    )}
                  >
                    <action.icon />
                  </IconButton>
                ))}
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
          // Stacked on a phone: side by side the three labels wrapped.
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-2 flex-1 py-2.5 px-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border border-dashed border-border transition-colors whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              {t('add_calendar')}
            </button>
            {!demoMode && (
              <button
                type="button"
                data-search-label={tImport('title')}
                onClick={() => setShowImportModal(true)}
                className="flex items-center gap-2 py-2.5 px-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border border-dashed border-border transition-colors whitespace-nowrap"
              >
                <Upload className="w-4 h-4" />
                {tImport('title')}
              </button>
            )}
            {/* ICS URL subscriptions refresh via /api/fetch-ical, absent in the static build. */}
            {!IS_LITE && !demoMode && (
              <button
                type="button"
                data-search-label={tSub('title')}
                onClick={() => setShowSubscriptionModal(true)}
                className="flex items-center gap-2 py-2.5 px-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border border-dashed border-border transition-colors whitespace-nowrap"
              >
                <Globe className="w-4 h-4" />
                {tSub('title')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* iCal Subscriptions */}
      {icalSubscriptions.length > 0 && (
        <div className="mt-6 space-y-2">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-medium text-foreground flex items-center gap-2">
              <Globe className="w-4 h-4 text-muted-foreground" />
              {tSub('section_title')}
            </h4>
            <TermInfo id="icalendar" />
          </div>
          {icalSubscriptions.map((sub) => {
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
                  {(() => {
                    const safeUrl = redactUrlCredentials(sub.url);
                    return (
                      <span dir="ltr" className="text-xs text-muted-foreground truncate block rtl:text-right" title={safeUrl}>
                        {safeUrl}
                      </span>
                    );
                  })()}
                  {sub.lastRefreshed && (
                    <span className="text-xs text-muted-foreground">
                      {tSub('last_refreshed', { time: formatDateTime(sub.lastRefreshed, timeFormat, { month: 'short', day: 'numeric', year: 'numeric' }) })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                  <IconButton label={tSub('edit')} onClick={() => setEditingSubscription(sub)} className="text-muted-foreground">
                    <Pencil />
                  </IconButton>
                  <IconButton
                    label={tSub('refresh')}
                    onClick={() => handleRefreshSubscription(sub.id)}
                    disabled={refreshingSubId === sub.id}
                    className="text-muted-foreground"
                  >
                    <RefreshCw className={cn("w-4 h-4", refreshingSubId === sub.id && "animate-spin [animation-direction:reverse]")} />
                  </IconButton>
                  <IconButton
                    label={tSub('unsubscribe')}
                    onClick={() => setDeletingSubId(sub.id)}
                    className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Not reversible, so each asks first (R3). */}
      <ConfirmDialog
        isOpen={!!deletingId}
        onClose={() => setDeletingId(null)}
        onConfirm={() => { if (deletingId) void handleDelete(deletingId); }}
        title={tConfirm('delete_title')}
        message={t('confirm_delete', { name: calName(calendars.find((cal) => cal.id === deletingId) ?? { name: '' }) })}
        confirmText={t('delete')}
        variant="destructive"
      />
      <ConfirmDialog
        isOpen={!!clearingId}
        onClose={() => setClearingId(null)}
        onConfirm={() => { if (clearingId) void handleClear(clearingId); }}
        title={tConfirm('clear_title')}
        message={t('confirm_clear', { name: calName(calendars.find((cal) => cal.id === clearingId) ?? { name: '' }) })}
        confirmText={t('clear_events')}
        variant="destructive"
      />
      <ConfirmDialog
        isOpen={!!deletingSubId}
        onClose={() => setDeletingSubId(null)}
        onConfirm={() => { if (deletingSubId) void handleDeleteSubscription(deletingSubId); }}
        title={tConfirm('unsubscribe_title')}
        message={tSub('confirm_delete', { name: icalSubscriptions.find((sub) => sub.id === deletingSubId)?.name ?? '' })}
        confirmText={tSub('unsubscribe')}
        variant="destructive"
      />

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

      {editingSubscription && client && (
        <ICalSubscriptionModal
          client={client}
          editSubscription={editingSubscription}
          onClose={() => setEditingSubscription(null)}
        />
      )}

      {sharingId && client && (() => {
        const cal = calendars.find((c) => c.id === sharingId);
        if (!cal) return null;
        return (
          <ShareCollectionDialog
            client={client}
            kind="calendar"
            collectionName={calName(cal)}
            shareWith={cal.shareWith}
            ownAccountId={client.getAccountId()}
            onShare={async (principalId, rights) => {
              await shareCalendar(client, cal.id, principalId, rights as CalendarRights | null);
            }}
            onClose={() => setSharingId(null)}
          />
        );
      })()}
    </SettingsSection>
  );
}
