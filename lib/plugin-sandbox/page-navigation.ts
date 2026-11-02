// A plugin moving the tab to one of its own pages (api.ui.openPage): a link
// in its dialog or banner to a record its page shows. Only the plugin's own
// pages, so a plugin can never send the tab anywhere else; the path is the
// one the `app-page` slot gets as `path`. The app's router answers through
// the handler PluginPageNavigator sets; without one (nothing mounted yet)
// the request resolves to false and the plugin can open a tab instead.

import { findPage } from './pages';
import { pluginPageHref } from '@/hooks/use-plugin-pages';

/** The longest path a plugin may pass. */
export const MAX_PAGE_PATH_LENGTH = 2000;

export type PageNavigationHandler = (href: string) => void;

let handler: PageNavigationHandler | null = null;

export function onPageNavigation(next: PageNavigationHandler): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

/**
 * The in-app href of a plugin's page and a path below it, each segment
 * encoded once (the route decodes each once), or an error the plugin sees.
 */
export function pagePathHref(pluginId: string, pageId: unknown, path: unknown): string {
  if (typeof pageId !== 'string' || !findPage(pluginId, pageId)) {
    throw new Error(`ui.openPage: "${String(pageId)}" is not a page of this plugin`);
  }
  const href = pluginPageHref({ pluginId, id: pageId });
  if (path === undefined || path === null || path === '') return href;
  if (typeof path !== 'string') throw new Error('ui.openPage: path must be a string');
  if (path.length > MAX_PAGE_PATH_LENGTH) throw new Error(`ui.openPage: path longer than ${MAX_PAGE_PATH_LENGTH} characters`);
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.some((s) => s === '.' || s === '..')) throw new Error('ui.openPage: path must not contain "." or ".." segments');
  return `${href}/${segments.map(encodeURIComponent).join('/')}`;
}

/** Checks the request and moves the tab: true when it went, false when nothing could take it. */
export function requestPageNavigation(pluginId: string, pageId: unknown, path: unknown): boolean {
  return navigateInApp(pagePathHref(pluginId, pageId, path));
}

/** Whether something can move the tab now (the router is mounted). */
export function canNavigateInApp(): boolean {
  return handler !== null;
}

/** Moves the tab to an in-app href the host built: false while nothing can. */
export function navigateInApp(href: string): boolean {
  if (!handler) return false;
  handler(href);
  return true;
}

/** Test helper. */
export function resetPageNavigation(): void {
  handler = null;
}
