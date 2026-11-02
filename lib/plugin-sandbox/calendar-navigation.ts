// A plugin moving the tab to a view of the calendar (api.ui.openCalendar),
// e.g. a count of due tasks opening the task view, which a plugin may draw
// itself (the calendar-task-view slot). The view is set in the calendar's
// store first, so a calendar already on screen switches in place, then the
// tab moves to the view's permalink (/calendar/<view>) through the same
// router handler as api.ui.openPage. Only the calendar's own views: a
// plugin can never send the tab anywhere else.

import type { InstalledPlugin, Permission } from '../plugin-types';
import type { CalendarViewMode } from '@/stores/calendar-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { buildCalendarPath } from '../deep-links';
import { readObject, withinRate } from './host-api-input';
import { pluginHasPermission } from './permissions';
import { canNavigateInApp, navigateInApp } from './page-navigation';

const METHOD = 'ui.openCalendar';

/** The views a plugin may open, each with the permissions of which one is enough. */
const VIEW_PERMISSIONS: Readonly<Record<CalendarViewMode, readonly Permission[]>> = {
  month: ['ui:calendar-action', 'calendar:read'],
  week: ['ui:calendar-action', 'calendar:read'],
  day: ['ui:calendar-action', 'calendar:read'],
  agenda: ['ui:calendar-action', 'calendar:read'],
  tasks: ['ui:tasks', 'tasks:read'],
};

/** At most this many moves a minute, so a plugin cannot keep pulling the tab away. */
export const CALENDAR_OPENS_PER_MINUTE = 10;

/**
 * Checks the request and opens the view: true when the tab went there,
 * false when nothing could take it (no router yet, or the task view while
 * the user has tasks turned off), or an error the plugin sees.
 */
export function requestCalendarView(plugin: InstalledPlugin, input: unknown): boolean {
  const data = readObject(input, METHOD, 'options', ['view']);
  const view = data.view;
  if (typeof view !== 'string' || !Object.prototype.hasOwnProperty.call(VIEW_PERMISSIONS, view)) {
    throw new Error(`${METHOD}: view must be one of ${Object.keys(VIEW_PERMISSIONS).join(', ')}`);
  }
  const mode = view as CalendarViewMode;
  const perms = VIEW_PERMISSIONS[mode];
  if (!perms.some((perm) => pluginHasPermission(plugin, perm))) {
    throw new Error(`Plugin "${plugin.id}" lacks permission "${perms.join('" or "')}"`);
  }
  if (mode === 'tasks' && !useSettingsStore.getState().enableCalendarTasks) return false;
  if (!canNavigateInApp()) return false;
  if (!withinRate('open-calendar', plugin.id, CALENDAR_OPENS_PER_MINUTE)) {
    throw new Error(`${METHOD}: at most ${CALENDAR_OPENS_PER_MINUTE} a minute`);
  }
  useCalendarStore.getState().setViewMode(mode);
  return navigateInApp(buildCalendarPath({ view: mode, date: null }));
}
