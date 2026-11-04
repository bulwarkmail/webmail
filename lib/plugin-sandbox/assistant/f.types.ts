// Area f of the assistant's host APIs: its permissions and its flags in
// api.host.features (see README.md). Pure: no imports from the app (the
// view types below are type-only).

import type { CalendarEventView, ContactView, FileResourceView } from '../../plugin-types';

/** Permissions this area adds to ALL_PERMISSIONS. */
export const PERMISSIONS = ['ui:side-panel'] as const;

/** Flags this area adds to api.host.features. */
export interface AreaHostFeaturesF {
  /**
   * The app-side-panel slot: a side panel in Calendar, Contacts, Files and
   * Settings, which api.ui.openPanel / closePanel / togglePanel answer for.
   * Missing (false) on webmails before it.
   */
  sidePanel?: boolean;
}

/** The views that show the app-side-panel. Mail has the reader's panel (email-detail-sidebar). */
export const APP_SIDE_PANEL_VIEWS = ['calendar', 'contacts', 'files', 'settings'] as const;
export type AppSidePanelViewName = typeof APP_SIDE_PANEL_VIEWS[number];

/** The most selected files the panel names; more are only counted. */
export const MAX_SIDE_PANEL_FILES = 20;

/**
 * What the view shows, in the app-side-panel's `context` prop. Each field
 * reaches a plugin only with its permission (APP_SIDE_PANEL_CONTEXT_FIELDS):
 * the event with calendar:read, the contact and the selection count with
 * contacts:read, files and folder with files:read; the settings page with
 * none.
 */
export interface AppSidePanelContext {
  /** Calendar: the event open in the details or the editor. */
  event?: CalendarEventView;
  /** Contacts: the contact open in the details. */
  contact?: ContactView;
  /** Contacts: how many contacts are ticked in the list. */
  selectedCount?: number;
  /** Files: the selected files (at most 20). */
  files?: FileResourceView[];
  /** Files: how many files are selected, also past the 20 in `files`. */
  fileCount?: number;
  /** Files: the open folder. */
  folder?: { id: string | null; path: string };
  /** Settings: the open page, by its id and its name in the user's language. */
  page?: { id: string; label: string };
}

/** The app-side-panel's props. */
export interface AppSidePanelProps {
  view: AppSidePanelViewName;
  context: AppSidePanelContext;
  /** Counts up when the panel opens on request (the toggle, Alt+A, api.ui.openPanel). */
  focusRequest: number;
}

/** Which permission each field of the app-side-panel's `context` needs (null: none). */
export const APP_SIDE_PANEL_CONTEXT_FIELDS = {
  event: 'calendar:read',
  contact: 'contacts:read',
  selectedCount: 'contacts:read',
  files: 'files:read',
  fileCount: 'files:read',
  folder: 'files:read',
  page: null,
} as const satisfies Record<keyof AppSidePanelContext, string | null>;
