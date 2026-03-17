"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Globe, Plus, RefreshCw, Trash2 } from "lucide-react";
import { cn, formatDateTime } from "@/lib/utils";
import type { Calendar } from "@/lib/jmap/types";
import { CalendarColorPicker } from "@/components/settings/calendar-management-settings";
import { useCalendarStore } from "@/stores/calendar-store";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "@/stores/toast-store";
import type { JMAPClient } from "@/lib/jmap/client";

interface CalendarSidebarPanelProps {
  calendars: Calendar[];
  selectedCalendarIds: string[];
  onToggleVisibility: (id: string) => void;
  onColorChange?: (calendarId: string, color: string) => void;
  onSubscribe?: () => void;
  client?: JMAPClient | null;
}

export function CalendarSidebarPanel({
  calendars,
  selectedCalendarIds,
  onToggleVisibility,
  onColorChange,
  onSubscribe,
  client,
}: CalendarSidebarPanelProps) {
  const t = useTranslations("calendar");
  const tSub = useTranslations("calendar.subscription");
  const isSubscriptionCalendar = useCalendarStore((s) => s.isSubscriptionCalendar);
  const icalSubscriptions = useCalendarStore((s) => s.icalSubscriptions);
  const refreshICalSubscription = useCalendarStore((s) => s.refreshICalSubscription);
  const removeICalSubscription = useCalendarStore((s) => s.removeICalSubscription);
  const timeFormat = useSettingsStore((s) => s.timeFormat);

  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const [contextMenuCalId, setContextMenuCalId] = useState<string | null>(null);
  const [refreshingSubId, setRefreshingSubId] = useState<string | null>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!colorPickerId && !contextMenuCalId) return;
    const handleClick = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
        setColorPickerId(null);
      }
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenuCalId(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setColorPickerId(null);
        setContextMenuCalId(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [colorPickerId, contextMenuCalId]);

  const getSubscriptionForCalendar = (calendarId: string) => {
    return icalSubscriptions.find(s => s.calendarId === calendarId);
  };

  const handleRefreshSubscription = async (subId: string) => {
    if (!client) return;
    setRefreshingSubId(subId);
    setContextMenuCalId(null);
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
    setContextMenuCalId(null);
    try {
      await removeICalSubscription(client, subId);
      toast.success(tSub('deleted'));
    } catch {
      toast.error(tSub('delete_error'));
    }
  };

  if (calendars.length === 0 && !onSubscribe) return null;

  return (
    <div className="mt-4">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
        {t("my_calendars")}
      </h3>
      <div className="space-y-0.5">
        {calendars.map((cal) => {
          const isVisible = selectedCalendarIds.includes(cal.id);
          const color = cal.color || "#3b82f6";

          return (
            <div key={cal.id} className="relative">
              <button
                onClick={() => onToggleVisibility(cal.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (isSubscriptionCalendar(cal.id) && client) {
                    setContextMenuCalId(contextMenuCalId === cal.id ? null : cal.id);
                    setColorPickerId(null);
                  } else if (onColorChange) {
                    setColorPickerId(colorPickerId === cal.id ? null : cal.id);
                    setContextMenuCalId(null);
                  }
                }}
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
              </button>

              {/* Subscription context menu on right-click */}
              {contextMenuCalId === cal.id && isSubscriptionCalendar(cal.id) && client && (() => {
                const sub = getSubscriptionForCalendar(cal.id);
                if (!sub) return null;
                return (
                  <div
                    ref={contextMenuRef}
                    className="absolute left-6 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg py-1 w-48"
                  >
                    <button
                      onClick={() => handleRefreshSubscription(sub.id)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-muted transition-colors"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      {tSub('refresh')}
                    </button>
                    <button
                      onClick={() => handleUnsubscribe(sub.id)}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      {tSub('unsubscribe')}
                    </button>
                    {sub.lastRefreshed && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground border-t border-border mt-1 pt-1">
                        {tSub('last_refreshed', { time: formatDateTime(sub.lastRefreshed, timeFormat, { month: 'short', day: 'numeric', year: 'numeric' }) })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Color picker popover on right-click */}
              {colorPickerId === cal.id && onColorChange && (
                <div
                  ref={colorPickerRef}
                  className="absolute left-6 top-full mt-1 z-50 bg-background border border-border rounded-lg shadow-lg p-3 w-56"
                >
                  <p className="text-xs font-medium text-muted-foreground mb-2">{t("management.change_color")}</p>
                  <CalendarColorPicker
                    value={color}
                    onChange={(c) => {
                      onColorChange(cal.id, c);
                      setColorPickerId(null);
                    }}
                    allowCustom
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
