'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import type { TaskViewFilter } from '@/stores/task-store';
import { cn } from '@/lib/utils';
import { PluginIframeSlot } from './plugin-iframe-slot';

// The `calendar-task-view` slot: a plugin drawing the calendar's task view
// below its toolbar, in place of Bulwark's task list. One plugin at a time,
// the first offering it (by its offer's order, then the plugins' order);
// none, and the calendar shows its own list. So does a plugin whose
// shouldShow says no or whose frame fails to start.

/** The plugin drawing the task view, or null when none offers it. */
export function usePluginTaskView(): { pluginId: string; fill: boolean } | null {
  const offers = usePluginSlotOffers('calendar-task-view');
  const first = offers[0];
  return useMemo(() => (first ? { pluginId: first.pluginId, fill: !!first.fill } : null), [first]);
}

/**
 * The plugin's frame in the area below the task toolbar: filled when the
 * plugin asks for it (it scrolls inside), else the area scrolls. Its props:
 * the toolbar's filter and the calendars ticked in the sidebar. `fallback`
 * (Bulwark's list) stands in while the frame is not drawn.
 */
export function PluginTaskView({ pluginId, fill, filter, calendarIds, fallback }: {
  pluginId: string;
  fill: boolean;
  filter: TaskViewFilter;
  calendarIds: readonly string[];
  fallback: ReactNode;
}) {
  // One array per set of ids, so the frame gets no update while they stay.
  const idsKey = calendarIds.join('\u0000');
  const ids = useMemo(() => (idsKey ? idsKey.split('\u0000') : []), [idsKey]);
  const extraProps = useMemo(() => ({ filter, calendarIds: ids }), [filter, ids]);
  // The plugin whose frame is not drawn. The frame stays mounted (hidden),
  // so a shouldShow that says yes for another filter takes the view back.
  const [notShownBy, setNotShownBy] = useState<string | null>(null);
  const notShown = notShownBy === pluginId;
  const onShownChange = useCallback((shown: boolean) => setNotShownBy(shown ? null : pluginId), [pluginId]);
  return (
    <>
      {notShown && fallback}
      <div
        data-plugin-slot="calendar-task-view"
        data-plugin-task-view={pluginId}
        className={cn('min-h-0 flex-1', fill ? 'flex flex-col' : 'overflow-y-auto', notShown && 'hidden')}
      >
        <PluginIframeSlot key={pluginId} pluginId={pluginId} slot="calendar-task-view" extraProps={extraProps} fill={fill} onShownChange={onShownChange} />
      </div>
    </>
  );
}
