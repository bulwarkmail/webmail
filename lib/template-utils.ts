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

// Compose bodies carry the embedded signature bracketed by
// data-signature-block markers (see email-composer's
// buildEmbeddedSignatureHtml). Applying a template must replace only the
// message content, so splice the template above the signature range instead
// of overwriting the whole body.
export function spliceTemplateAboveSignature(prevHtml: string, templateHtml: string): string {
  const doc = new DOMParser().parseFromString(prevHtml, 'text/html');
  const startEl = doc.querySelector('[data-signature-block="separator"], [data-signature-block="start"]');
  if (!startEl) return templateHtml;
  const endEl = doc.querySelector('[data-signature-block="end"]');
  const host = doc.createElement('div');
  let cursor: Node | null = startEl;
  while (cursor) {
    host.appendChild(cursor.cloneNode(true));
    if (cursor === endEl) break;
    cursor = cursor.nextSibling;
  }
  return templateHtml + host.innerHTML;
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
