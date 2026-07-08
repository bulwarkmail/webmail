"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Globe, ListTodo, Pencil, RefreshCw, Share2, Star, Trash2, Cake, User, Users, Plus, Eraser, Palette, Shuffle } from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";
import type { Calendar } from "@/lib/jmap/types";
import { CalendarColorPicker } from "@/components/settings/calendar-management-settings";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTaskStore } from "@/stores/task-store";
import { useAccountStore } from "@/stores/account-store";
import { BIRTHDAY_CALENDAR_ID } from "@/lib/birthday-calendar";
import { sharedCalendarColorKey } from "@/lib/shared-calendar-colors";
import { toast } from "@/stores/toast-store";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator, ContextMenuSubMenu } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * Split a per-account calendar list into "owned" (the user's own) and
 * "shared" sub-buckets, then group shared by the owning principal so each
 * delegator gets its own sub-section.
 */
type AccountCalendarSplit = {
  owned: Calendar[];
  sharedGroups: { label: string; calendars: Calendar[] }[];
};

function splitAccountCalendars(list: Calendar[]): AccountCalendarSplit {
  const owned: Calendar[] = [];
  const sharedBuckets = new Map<string, { label: string; calendars: Calendar[] }>();
  for (const cal of list) {
    if (cal.isShared) {
      const key = cal.accountId || cal.accountName || cal.id;
      const bucket = sharedBuckets.get(key);
      if (bucket) {
        bucket.calendars.push(cal);
      } else {
        sharedBuckets.set(key, { label: cal.accountName || key, calendars: [cal] });
      }
    } else {
      owned.push(cal);
    }
  }
  return { owned, sharedGroups: Array.from(sharedBuckets.values()) };
}

interface CalendarSidebarPanelProps {
  calendars: Calendar[];
  selectedCalendarIds: string[];
  onToggleVisibility: (id: string) => void;
  onColorChange?: (calendarId: string, color: string) => void;
  onResetColor?: (calendar: Calendar) => void;
  onShareCalendar?: (calendar: Calendar) => void;
  onCreateEvent?: (calendar: Calendar) => void;
  onClearCalendar?: (calendar: Calendar) => void;
  onDeleteCalendar?: (calendar: Calendar) => void;
  onCreateCalendar?: () => void;
  onSubscribe?: () => void;
  onEditSubscription?: (subscriptionId: string) => void;
  client?: IJMAPClient | null;
  /**
   * When true, render one collapsible section per connected local account,
   * mirroring the mail sidebar's Pro-shell layout. Calendars are bucketed
   * by their `localAccountId` and the active account is shown first.
   */
  multiAccountMode?: boolean;
}

export function CalendarSidebarPanel({
  calendars,
  selectedCalendarIds,
  onToggleVisibility,
  onColorChange,
  onResetColor,
  onShareCalendar,
  onCreateEvent,
  onClearCalendar,
  onDeleteCalendar,
  onCreateCalendar,
  onSubscribe,
  onEditSubscription,
  client,
  multiAccountMode,
}: CalendarSidebarPanelProps) {
  const t = useTranslations("calendar");
  const tSub = useTranslations("calendar.subscription");
  const tMgmt = useTranslations("calendar.management");
  const isSubscriptionCalendar = useCalendarStore((s) => s.isSubscriptionCalendar);
  const allSubs = useCalendarStore((s) => s.icalSubscriptions);
  const currentAccountId = client?.getAccountId();
  const icalSubscriptions = useMemo(
    () => allSubs.filter(s => !s.accountId || s.accountId === currentAccountId),
    [allSubs, currentAccountId],
  );
  const refreshICalSubscription = useCalendarStore((s) => s.refreshICalSubscription);
  const removeICalSubscription = useCalendarStore((s) => s.removeICalSubscription);
  const setDefaultCalendar = useCalendarStore((s) => s.setDefaultCalendar);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const sharedCalendarColors = useSettingsStore((s) => s.sharedCalendarColors);
  const enableCalendarTasks = useSettingsStore((s) => s.enableCalendarTasks);
  const tasks = useTaskStore((s) => s.tasks);
  const setViewMode = useCalendarStore((s) => s.setViewMode);

  const pendingTaskCount = useMemo(() => tasks.filter(t => t.progress !== 'completed' && t.progress !== 'cancelled').length, [tasks]);
  const overdueTaskCount = useMemo(() => {
    const now = new Date();
    return tasks.filter(t => t.progress !== 'completed' && t.progress !== 'cancelled' && t.due && new Date(t.due) < now).length;
  }, [tasks]);

  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<Calendar>();
  const [refreshingSubId, setRefreshingSubId] = useState<string | null>(null);

  // Persisted across mounts so toggle state survives tab switches in the
  // Pro shell (same key family as the mail sidebar's account collapse).
  const [collapsedAccountGroups, setCollapsedAccountGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('calendar-sidebar-collapsed-accounts');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const toggleAccountGroup = (key: string) => {
    setCollapsedAccountGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem('calendar-sidebar-collapsed-accounts', JSON.stringify(Array.from(next))); } catch { /* */ }
      return next;
    });
  };

  const localAccounts = useAccountStore((s) => s.accounts);
  const activeLocalAccountId = useAccountStore((s) => s.activeAccountId);

  const personalCalendars = useMemo(() => calendars.filter(c => !c.isShared), [calendars]);
  const sharedAccountGroups = useMemo(() => {
    const shared = calendars.filter(c => c.isShared);
    const groups = new Map<string, { accountName: string; calendars: Calendar[] }>();
    for (const cal of shared) {
      const key = cal.accountId || cal.accountName || cal.id;
      if (!groups.has(key)) {
        groups.set(key, { accountName: cal.accountName || key, calendars: [] });
      }
      groups.get(key)!.calendars.push(cal);
    }
    return Array.from(groups.values());
  }, [calendars]);

  /**
   * Pro / multi-account grouping: every calendar bucketed by its owning
   * local account. Active account comes first, then the rest in their
   * account-store order. Calendars without a `localAccountId` (e.g. the
   * birthday calendar) fall into a separate "other" bucket so they still
   * render.
   */
  const localAccountGroups = useMemo(() => {
    if (!multiAccountMode) return [];
    const byAccount = new Map<string, Calendar[]>();
    for (const cal of calendars) {
      const key = cal.localAccountId || '__other__';
      const list = byAccount.get(key) ?? [];
      list.push(cal);
      byAccount.set(key, list);
    }
    const ordered: { key: string; label: string; split: AccountCalendarSplit }[] = [];
    // Active account first.
    if (activeLocalAccountId && byAccount.has(activeLocalAccountId)) {
      const acct = localAccounts.find(a => a.id === activeLocalAccountId);
      ordered.push({
        key: activeLocalAccountId,
        label: acct?.label || acct?.email || acct?.username || activeLocalAccountId,
        split: splitAccountCalendars(byAccount.get(activeLocalAccountId)!),
      });
      byAccount.delete(activeLocalAccountId);
    }
    // Then the rest in account-store order so the layout matches the mail sidebar.
    for (const acct of localAccounts) {
      if (!byAccount.has(acct.id)) continue;
      ordered.push({
        key: acct.id,
        label: acct.label || acct.email || acct.username,
        split: splitAccountCalendars(byAccount.get(acct.id)!),
      });
      byAccount.delete(acct.id);
    }
    // Any leftover buckets (deleted accounts, untagged calendars).
    for (const [key, list] of byAccount.entries()) {
      const fallbackLabel = key === '__other__'
        ? t('my_calendars')
        : list[0]?.accountName || key;
      ordered.push({ key, label: fallbackLabel, split: splitAccountCalendars(list) });
    }
    return ordered;
  }, [multiAccountMode, calendars, localAccounts, activeLocalAccountId, t]);

  const getSubscriptionForCalendar = (calendarId: string) => {
    return icalSubscriptions.find(s => s.calendarId === calendarId);
  };

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

  const handleUnsubscribe = async (subId: string) => {
    if (!client) return;
    try {
      await removeICalSubscription(client, subId);
      toast.success(tSub('deleted'));
    } catch {
      toast.error(tSub('delete_error'));
    }
  };

  const handleSetDefault = async (calendarId: string) => {
    if (!client) return;
    try {
      await setDefaultCalendar(client, calendarId);
      toast.success(tMgmt('default_updated'));
    } catch {
      toast.error(tMgmt('error_default'));
    }
  };

  if (calendars.length === 0 && !onSubscribe) return null;

  const renderCalendarItem = (cal: Calendar) => {
    const isVisible = selectedCalendarIds.includes(cal.id);
    const color = cal.color || "#3b82f6";
    const hasMenu = isSubscriptionCalendar(cal.id) ? !!client : true;

    return (
      <div key={cal.id} className="relative">
        <button
          onClick={() => onToggleVisibility(cal.id)}
          onContextMenu={hasMenu ? (e) => openContextMenu(e, cal) : undefined}
          className={cn(
            "flex items-center gap-2 w-full px-1.5 py-1 rounded-md text-sm transition-colors duration-150",
            "hover:bg-muted"
          )}
        >
          <span
            className={cn(
              "w-3 h-3 rounded-sm border-2 flex-shrink-0 transition-colors",
              isVisible ? "border-transparent" : "border-muted-foreground/40 bg-transparent"
            )}
            style={isVisible ? { backgroundColor: color, borderColor: color } : undefined}
          />
          <span className={cn("truncate", !isVisible && "text-muted-foreground")}>
            {cal.name}
          </span>
          {isSubscriptionCalendar(cal.id) && (
            <>
              <Globe className="w-3 h-3 text-muted-foreground flex-shrink-0" />
              {refreshingSubId === getSubscriptionForCalendar(cal.id)?.id && (
                <RefreshCw className="w-3 h-3 text-muted-foreground flex-shrink-0 animate-spin" />
              )}
            </>
          )}
          {cal.id === BIRTHDAY_CALENDAR_ID && (
            <Cake className="w-3 h-3 text-muted-foreground flex-shrink-0" />
          )}
          {!cal.isShared && Object.keys(cal.shareWith || {}).length > 0 && (
            <Users
              className="w-3 h-3 text-muted-foreground flex-shrink-0"
              aria-label={tMgmt('share')}
            />
          )}
        </button>
      </div>
    );
  };

  const renderCalendarMenu = () => {
    const cal = contextMenu.data;
    if (!cal) return null;

    if (isSubscriptionCalendar(cal.id)) {
      const sub = getSubscriptionForCalendar(cal.id);
      if (!sub || !client) return null;
      return (
        <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
          <ContextMenuItem
            icon={Pencil}
            label={tSub('edit')}
            onClick={() => { closeContextMenu(); onEditSubscription?.(sub.id); }}
          />
          <ContextMenuItem
            icon={RefreshCw}
            label={tSub('refresh')}
            onClick={() => { closeContextMenu(); handleRefreshSubscription(sub.id); }}
          />
          <ContextMenuSeparator />
          <ContextMenuItem
            icon={Trash2}
            label={tSub('unsubscribe')}
            onClick={() => { closeContextMenu(); handleUnsubscribe(sub.id); }}
            destructive
          />
          {sub.lastRefreshed && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-t border-border mt-1 pt-1">
              {tSub('last_refreshed', { time: formatDateTime(sub.lastRefreshed, timeFormat, { month: 'short', day: 'numeric', year: 'numeric' }) })}
            </div>
          )}
        </ContextMenu>
      );
    }

    const isBirthday = cal.id === BIRTHDAY_CALENDAR_ID;
    const canCreate = onCreateEvent && !isBirthday && cal.myRights?.mayWriteOwn !== false;
    const canShare = onShareCalendar && cal.myRights?.mayShare && !cal.isShared;
    const canSetDefault = !!client && !isBirthday && !cal.isShared && !cal.isDefault;
    const canChangeColor = !!onColorChange;
    const hasColorOverride = !!cal.isShared && !!sharedCalendarColors[sharedCalendarColorKey(cal)];
    const canResetColor = !!onResetColor && hasColorOverride;
    const canClear = onClearCalendar && !isBirthday && cal.myRights?.mayDelete !== false;
    const canDelete = onDeleteCalendar && !isBirthday && !cal.isDefault && !cal.isShared;
    const showSeparator = (canCreate || canShare || canSetDefault || canChangeColor || canResetColor) && (canClear || canDelete);
    const color = cal.color || "#3b82f6";

    return (
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        {canCreate && (
          <ContextMenuItem
            icon={Plus}
            label={tMgmt('new_event_in_calendar')}
            onClick={() => { closeContextMenu(); onCreateEvent(cal); }}
          />
        )}
        {canShare && (
          <ContextMenuItem
            icon={Users}
            label={tMgmt('share')}
            onClick={() => { closeContextMenu(); onShareCalendar(cal); }}
          />
        )}
        {canSetDefault && (
          <ContextMenuItem
            icon={Star}
            label={tMgmt('set_default')}
            onClick={() => { closeContextMenu(); handleSetDefault(cal.id); }}
          />
        )}
        {canChangeColor && (
          <ContextMenuSubMenu icon={Palette} label={tMgmt('change_color')}>
            <div className="px-2 py-1.5 w-[200px]">
              <CalendarColorPicker
                value={color}
                onChange={(c) => { onColorChange(cal.id, c); closeContextMenu(); }}
                allowCustom
              />
            </div>
          </ContextMenuSubMenu>
        )}
        {canResetColor && (
          <ContextMenuItem
            icon={Shuffle}
            label={tMgmt('random_color')}
            onClick={() => { closeContextMenu(); onResetColor!(cal); }}
          />
        )}
        {showSeparator && <ContextMenuSeparator />}
        {canClear && (
          <ContextMenuItem
            icon={Eraser}
            label={tMgmt('clear_events')}
            onClick={() => { closeContextMenu(); onClearCalendar(cal); }}
          />
        )}
        {canDelete && (
          <ContextMenuItem
            icon={Trash2}
            label={tMgmt('delete')}
            onClick={() => { closeContextMenu(); onDeleteCalendar(cal); }}
            destructive
          />
        )}
      </ContextMenu>
    );
  };

  return (
    <div className="mt-4">
      {enableCalendarTasks && (
        <button
          onClick={() => setViewMode('tasks')}
          className="flex items-center gap-2 w-full px-1.5 py-1.5 mb-3 rounded-md text-sm hover:bg-muted transition-colors"
        >
          <ListTodo className="w-4 h-4 text-muted-foreground" />
          <span>{t('tasks.label')}</span>
          {pendingTaskCount > 0 && (
            <span className="ms-auto text-xs text-muted-foreground">{pendingTaskCount}</span>
          )}
          {overdueTaskCount > 0 && (
            <span className="text-xs text-destructive font-medium">{overdueTaskCount} {t('tasks.filter_overdue').toLowerCase()}</span>
          )}
        </button>
      )}
      {multiAccountMode && localAccountGroups.length > 0 ? (
        <>
          {localAccountGroups.map((group, idx) => {
            const expanded = !collapsedAccountGroups.has(group.key);
            const isActive = group.key === activeLocalAccountId;
            const { owned, sharedGroups } = group.split;
            return (
              <div key={group.key} className={cn(idx === 0 ? "" : "mt-3")}>
                <button
                  onClick={() => toggleAccountGroup(group.key)}
                  className="group w-full flex items-center gap-1.5 px-1 py-1 rounded-sm hover:bg-muted/40 transition-colors"
                >
                  {expanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  )}
                  <User className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-xs font-semibold text-foreground/90 truncate">
                    {group.label}
                  </span>
                  {isActive && onCreateCalendar && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); onCreateCalendar(); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onCreateCalendar();
                        }
                      }}
                      className="ms-auto p-0.5 rounded text-muted-foreground/70 opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
                      title={tMgmt('add_calendar')}
                    >
                      <Plus className="w-3 h-3" />
                    </span>
                  )}
                </button>
                {expanded && (
                  <div className="mt-1 ps-3">
                    {owned.length > 0 && (
                      <div>
                        <div className="px-1 mb-1 text-[10px] font-medium text-muted-foreground/80 uppercase tracking-wider">
                          {t('my_calendars')}
                        </div>
                        <div className="space-y-0.5">
                          {owned.map(renderCalendarItem)}
                        </div>
                      </div>
                    )}
                    {sharedGroups.map((sg) => (
                      <div key={`${group.key}-shared-${sg.label}`} className="mt-2">
                        <div className="px-1 mb-1 text-[10px] font-medium text-muted-foreground/80 uppercase tracking-wider flex items-center gap-1">
                          <Share2 className="w-3 h-3" />
                          {sg.label}
                        </div>
                        <div className="space-y-0.5">
                          {sg.calendars.map(renderCalendarItem)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between mb-2 px-1 group">
            {onCreateCalendar ? (
              <button
                onClick={onCreateCalendar}
                className="text-xs font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors flex items-center gap-1.5"
                title={tMgmt('add_calendar')}
              >
                {t('my_calendars')}
                <Plus className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            ) : (
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('my_calendars')}
              </h3>
            )}
          </div>
          <div className="space-y-0.5">
            {personalCalendars.map(renderCalendarItem)}
          </div>

          {sharedAccountGroups.map((group) => (
            <div key={group.accountName} className="mt-4">
              <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1 flex items-center gap-1.5">
                <Share2 className="w-3 h-3" />
                {group.accountName}
              </h3>
              <div className="space-y-0.5">
                {group.calendars.map(renderCalendarItem)}
              </div>
            </div>
          ))}
        </>
      )}

      {renderCalendarMenu()}
    </div>
  );
}
