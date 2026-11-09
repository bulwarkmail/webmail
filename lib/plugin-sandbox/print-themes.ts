// Print styles plugins register (`api.ui.registerPrintTheme`): CSS for the
// printout and a letterhead, a header and a footer of plain text. The user
// picks one under Settings > Appearance > Printing; Standard is the default.
// Data only: the host sanitises the CSS (lib/print/print-theme.ts) and draws
// the letterhead as text.

import { useSyncExternalStore } from 'react';
import { sanitizePrintThemeCss } from '@/lib/print/print-theme';

export interface PrintThemeInput {
  /** Unique within the plugin: letters, digits, "-" and "_", at most 40. */
  id: string;
  /** The name in the picker, at most 60 characters. */
  label: string;
  /** CSS for the printout; see sanitizePrintThemeCss for what stays. */
  css?: string;
  /** Plain text above the message, such as a company name and address. Line breaks stay. */
  header?: string;
  /** Plain text under the message. */
  footer?: string;
}

export interface RegisteredPrintTheme {
  /** `<pluginId>/<id>`, what the setting stores. */
  key: string;
  id: string;
  label: string;
  pluginId: string;
  pluginName: string;
  /** Sanitised and scoped. */
  css: string;
  /** From the CSS's `@page { margin }`, for printed messages. */
  pageMargin: string | null;
  header: string;
  footer: string;
}

/** The setting's value for the standard printout. */
export const STANDARD_PRINT_THEME = 'standard';
export const MAX_PRINT_THEMES_PER_PLUGIN = 5;
const MAX_LABEL = 60;
const MAX_LETTERHEAD = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`ui.registerPrintTheme: ${field} must be a string`);
  if (value.length > max) throw new Error(`ui.registerPrintTheme: ${field} must be at most ${max} characters`);
  // eslint-disable-next-line no-control-regex -- letterhead lines keep \n, nothing else
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
}

/** Checks a plugin's print style and sanitises its CSS. */
export function checkPrintTheme(input: unknown): { theme: PrintThemeInput & { css: string; pageMargin: string | null; header: string; footer: string }; warnings: string[] } {
  if (!input || typeof input !== 'object') throw new Error('ui.registerPrintTheme: pass { id, label, css?, header?, footer? }');
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    throw new Error('ui.registerPrintTheme: id must be 1 to 40 letters, digits, "-" or "_"');
  }
  const label = text(raw.label, 'label', MAX_LABEL);
  if (!label || label.includes('\n')) throw new Error('ui.registerPrintTheme: label must be one line of text');
  if (raw.css !== undefined && typeof raw.css !== 'string') throw new Error('ui.registerPrintTheme: css must be a string');
  const { css, pageMargin, warnings } = sanitizePrintThemeCss(typeof raw.css === 'string' ? raw.css : '');
  return {
    theme: {
      id: raw.id,
      label,
      css,
      pageMargin,
      header: text(raw.header, 'header', MAX_LETTERHEAD),
      footer: text(raw.footer, 'footer', MAX_LETTERHEAD),
    },
    warnings,
  };
}

const byPlugin = new Map<string, RegisteredPrintTheme[]>();
const listeners = new Set<() => void>();
let snapshot: RegisteredPrintTheme[] = [];

function changed(): void {
  snapshot = [...byPlugin.values()].flat();
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

export function subscribePrintThemes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Adds or replaces (same id) one of the plugin's print styles. */
export function registerPrintTheme(pluginId: string, pluginName: string, input: unknown): { warnings: string[] } {
  const { theme, warnings } = checkPrintTheme(input);
  const list = (byPlugin.get(pluginId) ?? []).filter((t) => t.id !== theme.id);
  if (list.length >= MAX_PRINT_THEMES_PER_PLUGIN) {
    throw new Error(`ui.registerPrintTheme: at most ${MAX_PRINT_THEMES_PER_PLUGIN} print styles per plugin`);
  }
  list.push({ ...theme, key: `${pluginId}/${theme.id}`, pluginId, pluginName });
  byPlugin.set(pluginId, list);
  changed();
  return { warnings };
}

export function unregisterPrintTheme(pluginId: string, id: unknown): void {
  const list = byPlugin.get(pluginId);
  if (!list || typeof id !== 'string') return;
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return;
  if (next.length) byPlugin.set(pluginId, next);
  else byPlugin.delete(pluginId);
  changed();
}

/** A plugin stopped: its print styles go with it, and printouts fall back to Standard. */
export function clearPrintThemes(pluginId: string): void {
  if (byPlugin.delete(pluginId)) changed();
}

/** Every registered print style. Stable between changes (for useSyncExternalStore). */
export function listPrintThemes(): RegisteredPrintTheme[] {
  return snapshot;
}

/** The print style for a setting's value, or null for Standard (or one whose plugin isn't running). */
export function findPrintTheme(key: string | null | undefined): RegisteredPrintTheme | null {
  if (!key || key === STANDARD_PRINT_THEME) return null;
  return snapshot.find((t) => t.key === key) ?? null;
}

const EMPTY: RegisteredPrintTheme[] = [];

export function usePrintThemes(): RegisteredPrintTheme[] {
  return useSyncExternalStore(subscribePrintThemes, listPrintThemes, () => EMPTY);
}

/** Test helper. */
export function resetPrintThemes(): void {
  byPlugin.clear();
  changed();
}
