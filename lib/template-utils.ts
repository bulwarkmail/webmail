import DOMPurify from 'dompurify';
import type { EmailTemplate } from './template-types';
import { BUILT_IN_PLACEHOLDERS } from './template-types';
import { generateUUID } from './utils';

const PLACEHOLDER_REGEX = /\{\{(\w+)\}\}/g;
const MAX_TEMPLATE_NAME_LENGTH = 200;
const STRIP_HTML_CONFIG = { ALLOWED_TAGS: [] as string[], ALLOWED_ATTR: [] as string[] };

export function extractPlaceholders(text: string): string[] {
  const matches = new Set<string>();
  let match: RegExpExecArray | null;
  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  while ((match = regex.exec(text)) !== null) {
    matches.add(match[1]);
  }
  return Array.from(matches);
}

export function substitutePlaceholders(
  text: string,
  values: Record<string, string>
): string {
  return text.replace(PLACEHOLDER_REGEX, (full, name) => {
    if (values[name] === undefined) return full;
    return DOMPurify.sanitize(values[name], STRIP_HTML_CONFIG);
  });
}

export function hasUnresolvedPlaceholders(text: string): boolean {
  return new RegExp(PLACEHOLDER_REGEX.source).test(text);
}

export function validateTemplateName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > MAX_TEMPLATE_NAME_LENGTH) return 'too_long';
  return null;
}

export interface AutoFillContext {
  senderName?: string;
  locale?: string;
}

export function getAutoFilledPlaceholders(
  context: AutoFillContext
): Record<string, string> {
  const now = new Date();
  const locale = context.locale || 'en';

  const values: Record<string, string> = {
    date: now.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' }),
    day_of_week: now.toLocaleDateString(locale, { weekday: 'long' }),
  };

  if (context.senderName) {
    values.sender_name = context.senderName;
  }

  return values;
}

export function getPlaceholdersFromTemplate(template: EmailTemplate): string[] {
  const combined = `${template.subject} ${template.body}`;
  return extractPlaceholders(combined);
}

export function isBuiltInPlaceholder(name: string): boolean {
  return (BUILT_IN_PLACEHOLDERS as readonly string[]).includes(name);
}

export function filterTemplates(templates: EmailTemplate[], query: string): EmailTemplate[] {
  const lower = query.toLowerCase();
  return templates.filter(
    (t) =>
      t.name.toLowerCase().includes(lower) ||
      t.subject.toLowerCase().includes(lower) ||
      t.category.toLowerCase().includes(lower)
  );
}

const SIGNATURE_START_SELECTOR = '[data-signature-block="separator"], [data-signature-block="start"]';
const SIGNATURE_END_SELECTOR = '[data-signature-block="end"]';

// Compose bodies carry the embedded signature bracketed by
// data-signature-block markers (see email-composer's
// buildEmbeddedSignatureHtml). Applying a template must replace only the
// message content, so splice the template above the signature range instead
// of overwriting the whole body.
export function spliceTemplateAboveSignature(prevHtml: string, templateHtml: string): string {
  const doc = new DOMParser().parseFromString(prevHtml, 'text/html');
  const startEl = doc.querySelector(SIGNATURE_START_SELECTOR);
  if (!startEl) return templateHtml;
  const endEl = doc.querySelector(SIGNATURE_END_SELECTOR);
  const host = doc.createElement('div');
  let cursor: Node | null = startEl;
  while (cursor) {
    host.appendChild(cursor.cloneNode(true));
    if (cursor === endEl) break;
    cursor = cursor.nextSibling;
  }
  return templateHtml + host.innerHTML;
}

/**
 * Whether a compose body holds anything the user wrote above the embedded
 * signature. A fresh compose body is just an empty paragraph plus the
 * signature range, so this stays false until the user types something -
 * the composer then inserts the template at the caret rather than splicing
 * it over the draft (#540).
 */
export function composeBodyHasUserContent(prevHtml: string): boolean {
  if (!prevHtml.trim()) return false;

  const doc = new DOMParser().parseFromString(prevHtml, 'text/html');
  const startEl = doc.querySelector(SIGNATURE_START_SELECTOR);
  if (startEl) {
    // Drop the signature range [start … end] inclusive, mirroring the
    // traversal spliceTemplateAboveSignature uses to keep it.
    const endEl = doc.querySelector(SIGNATURE_END_SELECTOR);
    let cursor: Node | null = startEl;
    while (cursor) {
      const next: Node | null = cursor.nextSibling;
      const isEnd = cursor === endEl;
      cursor.parentNode?.removeChild(cursor);
      if (isEnd) break;
      cursor = next;
    }
  }

  if (doc.body.textContent?.trim()) return true;
  // Text-free content still counts as a draft worth keeping.
  return doc.body.querySelector('img, table, hr, [data-quoted-html]') !== null;
}

function sanitizeText(value: unknown): string {
  return DOMPurify.sanitize(String(value || ''), STRIP_HTML_CONFIG);
}

interface ExportData {
  version: 1;
  type: 'webmail-templates';
  exportedAt: string;
  templates: EmailTemplate[];
}

export function exportTemplates(templates: EmailTemplate[]): string {
  const data: ExportData = {
    version: 1,
    type: 'webmail-templates',
    exportedAt: new Date().toISOString(),
    templates,
  };
  return JSON.stringify(data, null, 2);
}

export interface ImportResult {
  templates: EmailTemplate[];
  errors: string[];
}

// --- Cross-device sync (settings blob) helpers -----------------------------
// Templates ride along in the per-account settings sync blob (see
// settings-store exportSettings/importSettings, #825). Unlike the file import
// below, synced templates keep their ids so the same template converges to a
// single entry across devices instead of duplicating on every server load.

/**
 * Tombstones older than this are pruned from the synced blob. A device that
 * stays offline longer than this may resurrect a deletion - the accepted
 * trade-off for keeping the blob bounded.
 */
export const TEMPLATE_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface SyncedTemplateState {
  templates: EmailTemplate[];
  /** Template id -> ISO time it was deleted. */
  deletedTemplateIds: Record<string, string>;
}

/**
 * Structurally validates a `templates` value from a synced settings blob or
 * settings-file import. Returns null when the value is not an array (a blob
 * from a build that predates template sync), so callers can leave the local
 * store untouched; malformed entries are dropped, ids are preserved.
 */
export function parseSyncedTemplates(value: unknown): EmailTemplate[] | null {
  if (!Array.isArray(value)) return null;

  const templates: EmailTemplate[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || seen.has(t.id)) continue;
    if (typeof t.name !== 'string' || !t.name.trim()) continue;
    seen.add(t.id);

    const recipients = t.defaultRecipients as Record<string, unknown> | undefined;
    const now = new Date().toISOString();

    templates.push({
      id: t.id,
      name: sanitizeText(t.name),
      subject: sanitizeText(t.subject),
      body: t.isHTML ? String(t.body || '') : sanitizeText(t.body),
      isHTML: Boolean(t.isHTML),
      category: sanitizeText(t.category),
      defaultRecipients: recipients && typeof recipients === 'object'
        ? {
            to: Array.isArray(recipients.to) ? (recipients.to as string[]).map(String) : undefined,
            cc: Array.isArray(recipients.cc) ? (recipients.cc as string[]).map(String) : undefined,
            bcc: Array.isArray(recipients.bcc) ? (recipients.bcc as string[]).map(String) : undefined,
          }
        : undefined,
      identityId: typeof t.identityId === 'string' ? t.identityId : undefined,
      isFavorite: Boolean(t.isFavorite),
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : now,
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : now,
    });
  }
  return templates;
}

/** Structurally validates a `deletedTemplateIds` map from a synced blob. */
export function parseTemplateTombstones(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, deletedAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof deletedAt === 'string' && !Number.isNaN(Date.parse(deletedAt))) {
      out[id] = deletedAt;
    }
  }
  return out;
}

/**
 * Merges a synced template state into the local one. Per template id the
 * newer `updatedAt` wins (ties keep the local copy); a deletion tombstone
 * beats a template unless the template was edited after the deletion, which
 * resurrects it and clears the tombstone. Merging (rather than replacing)
 * keeps a stale per-account blob from wiping templates created under another
 * account or on another device.
 */
export function mergeSyncedTemplates(
  local: SyncedTemplateState,
  incoming: SyncedTemplateState,
  now: Date = new Date()
): SyncedTemplateState {
  const cutoff = now.getTime() - TEMPLATE_TOMBSTONE_TTL_MS;

  // Union of tombstones, newest deletion time per id, pruned by TTL.
  const tombstones: Record<string, string> = {};
  for (const source of [local.deletedTemplateIds, incoming.deletedTemplateIds]) {
    for (const [id, deletedAt] of Object.entries(source)) {
      if (Date.parse(deletedAt) < cutoff) continue;
      if (!tombstones[id] || Date.parse(deletedAt) > Date.parse(tombstones[id])) {
        tombstones[id] = deletedAt;
      }
    }
  }

  const byId = new Map<string, EmailTemplate>();
  for (const t of local.templates) byId.set(t.id, t);
  for (const t of incoming.templates) {
    const existing = byId.get(t.id);
    if (!existing || Date.parse(t.updatedAt) > Date.parse(existing.updatedAt)) {
      byId.set(t.id, t);
    }
  }

  const templates: EmailTemplate[] = [];
  for (const t of byId.values()) {
    const deletedAt = tombstones[t.id];
    if (deletedAt !== undefined) {
      if (Date.parse(t.updatedAt) <= Date.parse(deletedAt)) continue;
      delete tombstones[t.id];
    }
    templates.push(t);
  }

  return { templates, deletedTemplateIds: tombstones };
}

export function importTemplates(json: string): ImportResult {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { templates: [], errors: ['invalid_json'] };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { templates: [], errors: ['invalid_format'] };
  }

  const data = parsed as Record<string, unknown>;

  if (data.type !== 'webmail-templates') {
    return { templates: [], errors: ['invalid_type'] };
  }

  if (data.version !== 1) {
    return { templates: [], errors: ['unsupported_version'] };
  }

  if (!Array.isArray(data.templates)) {
    return { templates: [], errors: ['invalid_templates'] };
  }

  const templates: EmailTemplate[] = [];
  for (const item of data.templates) {
    if (typeof item !== 'object' || item === null) {
      errors.push('invalid_template_entry');
      continue;
    }

    const t = item as Record<string, unknown>;
    if (typeof t.name !== 'string' || !t.name.trim()) {
      errors.push('missing_template_name');
      continue;
    }

    const recipients = t.defaultRecipients as Record<string, unknown> | undefined;

    templates.push({
      id: generateUUID(),
      name: sanitizeText(t.name),
      subject: sanitizeText(t.subject),
      body: t.isHTML ? String(t.body || '') : sanitizeText(t.body),
      isHTML: Boolean(t.isHTML),
      category: sanitizeText(t.category),
      defaultRecipients: recipients && typeof recipients === 'object'
        ? {
            to: Array.isArray(recipients.to) ? (recipients.to as string[]).map(String) : undefined,
            cc: Array.isArray(recipients.cc) ? (recipients.cc as string[]).map(String) : undefined,
            bcc: Array.isArray(recipients.bcc) ? (recipients.bcc as string[]).map(String) : undefined,
          }
        : undefined,
      identityId: typeof t.identityId === 'string' ? t.identityId : undefined,
      isFavorite: Boolean(t.isFavorite),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return { templates, errors };
}
