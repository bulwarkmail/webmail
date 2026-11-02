/**
 * The organisation part of the user policy (policy.json `organisation`):
 * settings an admin makes for everyone, as opposed to the per-setting
 * restrictions. Every section has one default that works without
 * configuration, and every section can be overridden per domain or group
 * through `scopes` (lib/admin/policy-scopes.ts).
 *
 * policy.json is written by hand and Lite reads it as a static file, so
 * sanitizeOrganisationPolicy accepts any input and keeps only known keys
 * with the right type, falling back to the default for each.
 */

import type { EmailTemplate } from '@/lib/template-types';
import { toAsciiDomain } from '@/lib/idn';

/** Details a user fills in once for the organisation signature. */
export const SIGNATURE_FIELDS = ['title', 'department', 'phone', 'mobile'] as const;
export type SignatureField = (typeof SIGNATURE_FIELDS)[number];

/** A template of the admin library: read-only for users. */
export type OrgTemplate = Pick<EmailTemplate, 'id' | 'name' | 'subject' | 'body' | 'isHTML' | 'category'>;

/** RFC 2156 Sensitivity values (what Outlook shows); '' writes none. */
export const LABEL_SENSITIVITIES = ['', 'Personal', 'Private', 'Company-Confidential'] as const;
export type LabelSensitivity = (typeof LABEL_SENSITIVITIES)[number];

/** A classification label the admin defines (item 3 of the enterprise pack). */
export interface ClassificationLabel {
  id: string;
  name: string;
  /** #rrggbb */
  color: string;
  description: string;
  /** The SIO-Label `marking` (RFC 7444); the name when empty. */
  marking: string;
  sensitivity: LabelSensitivity;
  /** Added in front of the subject, e.g. "[Confidential]"; '' for none. */
  subjectPrefix: string;
  /** Value of the admin's extra header for this label; '' writes none. */
  extraHeaderValue: string;
}

/** An out-of-office reply text of the admin library. */
export interface VacationTemplate {
  id: string;
  name: string;
  category: string;
  subject: string;
  /** Plain text with placeholders like {name}, {end}, {deputy}. */
  text: string;
  /** Optional HTML version; '' for none. */
  html: string;
}

/** An ICS feed every user in scope sees read-only. */
export interface CompanyFeed {
  id: string;
  name: string;
  /** The ICS address; '' when `urlHeld`. */
  url: string;
  /**
   * Set in the policy full Bulwark hands to users: the server keeps the
   * address back (it may hold a token) and fetches the feed by id
   * (app/api/fetch-ical, lib/admin/company-feeds.ts).
   */
  urlHeld?: boolean;
  /** #rrggbb */
  color: string;
  refreshMinutes: number;
}

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export const PHISHING_REPORT_FORMATS = ['forward', 'arf'] as const;
export type PhishingReportFormat = (typeof PHISHING_REPORT_FORMATS)[number];

/** The shortest refresh interval for company calendars (each refresh may cost an upload). */
export const MIN_FEED_REFRESH_MINUTES = 60;

export interface OrganisationPolicy {
  externalMail: {
    /** "External" chip on mail from senders outside the organisation domains. */
    senderLabel: boolean;
    /** Confirm before sending to recipients outside the organisation domains. */
    recipientWarning: boolean;
    /**
     * More organisation domains. The domains of the user's own identities
     * always count as internal; these are added to them. A domain covers its
     * subdomains (example.com covers eu.example.com). See lib/external-mail.ts.
     */
    domains: string[];
    /** Recipients in the user's contacts don't trigger the warning. */
    trustContacts: boolean;
  };
  signature: {
    /** HTML template with placeholders; empty html and text mean no organisation signature. */
    html: string;
    text: string;
    /** The details users fill in, as the template uses them. */
    fields: SignatureField[];
  };
  disclaimer: {
    /** Added below everything when a message is sent; empty means none. */
    html: string;
    text: string;
  };
  templates: {
    library: OrgTemplate[];
  };
  session: {
    /** Sign out after this many minutes without activity; 0 is off. */
    idleMinutes: number;
    /** Sign out this many hours after signing in; 0 is off. */
    maxHours: number;
    /** How long the warning counts down before signing out. */
    warnSeconds: number;
  };
  recovery: {
    /** How far back "Recover deleted items" lists; 0 is everything the server keeps. */
    days: number;
  };
  phishingReport: {
    /** Where "Report phishing" sends; '' turns the action off. */
    address: string;
    /** Forward the message as an attachment, or an ARF report (RFC 5965). */
    format: PhishingReportFormat;
  };
  /** A scope that sets this section replaces it as a whole. */
  labels: {
    /** [] turns classification labels off. */
    list: ClassificationLabel[];
    /** The label new messages start with; '' for none. */
    defaultId: string;
    /** Sending needs a label. Dropped when the list is empty. */
    required: boolean;
    /** Name of an extra header each label may set (e.g. X-Classification); '' for none. */
    extraHeader: string;
  };
  /** A scope that sets this section replaces it as a whole. */
  announcement: {
    /** Changes when the admin saves a new announcement, so dismissals reset. */
    id: string;
    severity: AnnouncementSeverity;
    /** Locale (en, de, pt-BR) to plain text with links; {} shows nothing. */
    text: Record<string, string>;
    /** The locale shown when the user's isn't in `text`. */
    fallbackLocale: string;
    /** ISO times; '' for no limit. */
    startsAt: string;
    endsAt: string;
    dismissible: boolean;
  };
  vacationTemplates: {
    /** Adds up across scopes by id, like templates.library. */
    library: VacationTemplate[];
  };
  retention: {
    /** Days the server keeps mail in Trash and Junk, as the admin set it in the mail server; 0 shows no line. */
    trashDays: number;
    junkDays: number;
  };
  devices: {
    noDownloads: boolean;
    noExport: boolean;
    noPrint: boolean;
    noInstallPrompt: boolean;
    pushWithoutContent: boolean;
    watermark: boolean;
    noOffline: boolean;
  };
  calendars: {
    /** Adds up across scopes by id. */
    feeds: CompanyFeed[];
    /** A group address that gets free/busy access to every user's default calendar; '' is off. */
    freeBusyGroup: string;
  };
}

export const DEFAULT_ORGANISATION_POLICY: OrganisationPolicy = {
  externalMail: { senderLabel: false, recipientWarning: false, domains: [], trustContacts: true },
  signature: { html: '', text: '', fields: [] },
  disclaimer: { html: '', text: '' },
  templates: { library: [] },
  session: { idleMinutes: 0, maxHours: 0, warnSeconds: 60 },
  recovery: { days: 0 },
  phishingReport: { address: '', format: 'forward' },
  labels: { list: [], defaultId: '', required: false, extraHeader: '' },
  announcement: { id: '', severity: 'info', text: {}, fallbackLocale: 'en', startsAt: '', endsAt: '', dismissible: true },
  vacationTemplates: { library: [] },
  retention: { trashDays: 0, junkDays: 0 },
  devices: {
    noDownloads: false, noExport: false, noPrint: false, noInstallPrompt: false,
    pushWithoutContent: false, watermark: false, noOffline: false,
  },
  calendars: { feeds: [], freeBusyGroup: '' },
};

/** Sections a scope replaces as a whole instead of per leaf. */
const WHOLE_SECTIONS = new Set<OrganisationSection>(['labels', 'announcement']);

export type OrganisationSection = keyof OrganisationPolicy;

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const MAX_TEXT = 64 * 1024;
const MAX_LIBRARY = 200;
const MAX_DOMAINS = 500;
// Same shape as the branding host rule, without the wildcard: a bare domain.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function count(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(0, Math.round(value)));
}

/**
 * A domain list taken apart: the usable domains, lowercased, deduplicated
 * and in ASCII form (an IDN like bücher.de becomes xn--bcher-kva.de, the
 * form mail servers use), and the entries that aren't domains.
 * "@example.com" and "*.example.com" are taken as example.com. Undefined for
 * anything that isn't a string or an array.
 */
export function parseDomainList(value: unknown): { domains: string[]; rejected: string[] } | undefined {
  const raw = typeof value === 'string' ? value.split(/[\s,;]+/) : Array.isArray(value) ? value : undefined;
  if (!raw) return undefined;
  const out = new Set<string>();
  const rejected: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const entry = item.trim();
    if (!entry) continue;
    const bare = entry.toLowerCase().replace(/^\*\./, '').replace(/^@/, '').replace(/\.+$/, '');
    const domain = bare ? toAsciiDomain(bare) : null;
    if (domain && DOMAIN_RE.test(domain)) {
      if (out.size < MAX_DOMAINS) out.add(domain);
    } else {
      rejected.push(entry);
    }
  }
  return { domains: [...out], rejected };
}

/** The usable domains of a list (see parseDomainList). */
export function normalizeDomainList(value: unknown): string[] | undefined {
  return parseDomainList(value)?.domains;
}

function sanitizeLibrary(value: unknown): OrgTemplate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: OrgTemplate[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 128) : '';
    const name = text(item.name)?.trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: name.slice(0, 200),
      subject: text(item.subject) ?? '',
      body: text(item.body) ?? '',
      isHTML: item.isHTML === true,
      category: (text(item.category) ?? '').slice(0, 100),
    });
    if (out.length >= MAX_LIBRARY) break;
  }
  return out;
}

const EMAIL_RE = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
// RFC 5322 field-name: printable ASCII but the colon (msip_labels has an underscore).
const HEADER_NAME_RE = /^[\x21-\x39\x3b-\x7e]{1,76}$/;
// Prefixes JMAP refuses at the top level or that say how mail travelled.
const RESERVED_HEADER_PREFIXES = ['content-', 'list-', 'resent-', 'arc-'];
// Headers the extra classification header may not be: they carry the
// message itself, or the labels Bulwark writes anyway.
const RESERVED_HEADERS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'date', 'message-id', 'sender', 'reply-to', 'in-reply-to',
  'references', 'mime-version', 'content-type', 'content-transfer-encoding', 'content-disposition',
  'received', 'return-path', 'dkim-signature', 'arc-seal', 'arc-message-signature', 'authentication-results',
  'sio-label', 'sio-label-history', 'sensitivity', 'x-bulwark-label', 'auto-submitted', 'precedence', 'importance', 'x-priority', 'disposition-notification-to',
]);
const MAX_LABELS = 50;
const MAX_FEEDS = 50;

/** Text for a header value or a one-line field: no line breaks or control characters. */
function line(value: unknown, max: number): string | undefined {
  const t = text(value);
  // eslint-disable-next-line no-control-regex
  return t === undefined ? undefined : t.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function email(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === '' || EMAIL_RE.test(v) ? v.slice(0, 320) : undefined;
}

/** Whether the admin page may store this as `phishingReport.address` (the sanitiser's rule). */
export function isPhishingReportAddress(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.length <= 320 && EMAIL_RE.test(v);
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && COLOR_RE.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '') return '';
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function itemId(value: unknown): string | null {
  return typeof value === 'string' && ID_RE.test(value.trim()) ? value.trim() : null;
}

/** Keeps the items with a valid, unique id, capped at `max`. */
function byIdList<T>(value: unknown, max: number, build: (item: Record<string, unknown>, id: string) => T | null): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = itemId(item.id);
    if (!id || seen.has(id)) continue;
    const built = build(item, id);
    if (!built) continue;
    seen.add(id);
    out.push(built);
    if (out.length >= max) break;
  }
  return out;
}

function sanitizeLabels(value: unknown): ClassificationLabel[] | undefined {
  return byIdList(value, MAX_LABELS, (item, id) => {
    const name = line(item.name, 100);
    if (!name) return null;
    return {
      id,
      name,
      color: color(item.color, '#6b7280'),
      description: (text(item.description) ?? '').slice(0, 1000),
      // A quoted header parameter: no double quotes or backslashes.
      marking: (line(item.marking, 200) ?? '').replace(/["\\]/g, ''),
      sensitivity: oneOf(item.sensitivity, LABEL_SENSITIVITIES) ?? '',
      subjectPrefix: line(item.subjectPrefix, 60) ?? '',
      extraHeaderValue: line(item.extraHeaderValue, 500) ?? '',
    };
  });
}

function reservedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return RESERVED_HEADERS.has(lower) || RESERVED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Whether the admin page may store this as `labels.extraHeader` (the sanitiser's rule). */
export function isLabelExtraHeaderName(value: string): boolean {
  const v = value.trim();
  return HEADER_NAME_RE.test(v) && !reservedHeader(v);
}

function headerName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '') return '';
  return HEADER_NAME_RE.test(v) && !reservedHeader(v) ? v : undefined;
}

function sanitizeLocaleText(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, body] of Object.entries(value)) {
    const t = text(body)?.trim();
    if (LOCALE_RE.test(locale) && t) out[locale] = t.slice(0, 4000);
  }
  return out;
}

function sanitizeVacationLibrary(value: unknown): VacationTemplate[] | undefined {
  return byIdList(value, MAX_LIBRARY, (item, id) => {
    const name = line(item.name, 200);
    if (!name) return null;
    return {
      id,
      name,
      category: line(item.category, 100) ?? '',
      subject: line(item.subject, 511) ?? '',
      text: text(item.text) ?? '',
      html: text(item.html) ?? '',
    };
  });
}

function feedUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeFeeds(value: unknown): CompanyFeed[] | undefined {
  return byIdList(value, MAX_FEEDS, (item, id) => {
    const name = line(item.name, 100);
    // An empty address only for a feed whose address the server held back.
    const held = item.urlHeld === true && item.url === '';
    const url = held ? '' : feedUrl(item.url);
    if (!name || url === null) return null;
    const minutes = count(item.refreshMinutes, 7 * 24 * 60) ?? MIN_FEED_REFRESH_MINUTES;
    return { id, name, url, color: color(item.color, '#2563eb'), refreshMinutes: Math.max(MIN_FEED_REFRESH_MINUTES, minutes), ...(held ? { urlHeld: true } : {}) };
  });
}

/**
 * The parts of `raw` that are valid organisation settings, without
 * defaults filled in. Used for scope overrides, where a missing key means
 * "inherit", and as the first step of sanitizeOrganisationPolicy.
 */
export function sanitizeOrganisationPartial(raw: unknown): DeepPartial<OrganisationPolicy> {
  if (!isRecord(raw)) return {};
  const out: DeepPartial<OrganisationPolicy> = {};
  const section = (key: OrganisationSection) => (isRecord(raw[key]) ? (raw[key] as Record<string, unknown>) : null);
  const assign = <S extends OrganisationSection>(key: S, values: Record<string, unknown>) => {
    const kept = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (Object.keys(kept).length > 0) (out as Record<string, unknown>)[key] = kept;
  };

  const ext = section('externalMail');
  if (ext) assign('externalMail', {
    senderLabel: bool(ext.senderLabel),
    recipientWarning: bool(ext.recipientWarning),
    domains: normalizeDomainList(ext.domains),
    trustContacts: bool(ext.trustContacts),
  });

  const sig = section('signature');
  if (sig) assign('signature', {
    html: text(sig.html),
    text: text(sig.text),
    fields: Array.isArray(sig.fields)
      ? SIGNATURE_FIELDS.filter((field) => (sig.fields as unknown[]).includes(field))
      : undefined,
  });

  const disc = section('disclaimer');
  if (disc) assign('disclaimer', { html: text(disc.html), text: text(disc.text) });

  const tpl = section('templates');
  if (tpl) assign('templates', { library: sanitizeLibrary(tpl.library) });

  const ses = section('session');
  if (ses) assign('session', {
    idleMinutes: count(ses.idleMinutes, 7 * 24 * 60),
    maxHours: count(ses.maxHours, 24 * 365),
    warnSeconds: count(ses.warnSeconds, 600),
  });

  const rec = section('recovery');
  if (rec) assign('recovery', { days: count(rec.days, 3650) });

  const phish = section('phishingReport');
  if (phish) assign('phishingReport', {
    address: email(phish.address),
    format: oneOf(phish.format, PHISHING_REPORT_FORMATS),
  });

  const lab = section('labels');
  if (lab) assign('labels', {
    list: sanitizeLabels(lab.list),
    defaultId: typeof lab.defaultId === 'string' ? (itemId(lab.defaultId) ?? '') : undefined,
    required: bool(lab.required),
    extraHeader: headerName(lab.extraHeader),
  });

  const ann = section('announcement');
  if (ann) assign('announcement', {
    id: typeof ann.id === 'string' ? (itemId(ann.id) ?? '') : undefined,
    severity: oneOf(ann.severity, ANNOUNCEMENT_SEVERITIES),
    text: sanitizeLocaleText(ann.text),
    fallbackLocale: typeof ann.fallbackLocale === 'string' && LOCALE_RE.test(ann.fallbackLocale) ? ann.fallbackLocale : undefined,
    startsAt: isoTime(ann.startsAt),
    endsAt: isoTime(ann.endsAt),
    dismissible: bool(ann.dismissible),
  });

  const vac = section('vacationTemplates');
  if (vac) assign('vacationTemplates', { library: sanitizeVacationLibrary(vac.library) });

  const ret = section('retention');
  if (ret) assign('retention', { trashDays: count(ret.trashDays, 3650), junkDays: count(ret.junkDays, 3650) });

  const dev = section('devices');
  if (dev) assign('devices', {
    noDownloads: bool(dev.noDownloads),
    noExport: bool(dev.noExport),
    noPrint: bool(dev.noPrint),
    noInstallPrompt: bool(dev.noInstallPrompt),
    pushWithoutContent: bool(dev.pushWithoutContent),
    watermark: bool(dev.watermark),
    noOffline: bool(dev.noOffline),
  });

  const cal = section('calendars');
  if (cal) assign('calendars', { feeds: sanitizeFeeds(cal.feeds), freeBusyGroup: email(cal.freeBusyGroup) });

  return out;
}

/** Arrays that add up across scopes by id instead of replacing. */
const ADDITIVE_LISTS: Record<string, string> = { templates: 'library', vacationTemplates: 'library', calendars: 'feeds' };

/** Settings that can't hold together after a merge: a default label that isn't in the list, a required label with none to pick. */
function normaliseMerged(policy: OrganisationPolicy): OrganisationPolicy {
  const labels = policy.labels;
  if (!labels) return policy;
  const hasDefault = labels.list.some((label) => label.id === labels.defaultId);
  const required = labels.required && labels.list.length > 0;
  if (hasDefault === (labels.defaultId !== '') && required === labels.required) return policy;
  return { ...policy, labels: { ...labels, defaultId: hasDefault ? labels.defaultId : '', required } };
}

/**
 * Merges `override` into `base` per leaf of plain objects; arrays and values
 * replace. Exceptions: the lists in ADDITIVE_LISTS add up by id, and the
 * sections in WHOLE_SECTIONS are replaced as a whole (a scope's own label
 * scheme or announcement never mixes with the inherited one), with the
 * built-in defaults for keys the override leaves out.
 */
export function mergeOrganisation(
  base: OrganisationPolicy,
  override: DeepPartial<OrganisationPolicy>,
): OrganisationPolicy {
  const out = { ...base } as Record<string, Record<string, unknown>>;
  const defaults = DEFAULT_ORGANISATION_POLICY as unknown as Record<string, Record<string, unknown>>;
  for (const [sectionKey, values] of Object.entries(override)) {
    if (!isRecord(values) || !isRecord(out[sectionKey])) continue;
    const merged = WHOLE_SECTIONS.has(sectionKey as OrganisationSection)
      ? { ...defaults[sectionKey] }
      : { ...out[sectionKey] };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (ADDITIVE_LISTS[sectionKey] === key && Array.isArray(value)) {
        // A scope's items join the ones it inherits; the same id replaces
        // the inherited item.
        const byId = new Map((merged[key] as Array<{ id: string }>).map((t) => [t.id, t]));
        for (const item of value as Array<{ id: string }>) byId.set(item.id, item);
        merged[key] = [...byId.values()];
      } else {
        merged[key] = value;
      }
    }
    out[sectionKey] = merged;
  }
  return normaliseMerged(out as unknown as OrganisationPolicy);
}

/** A complete organisation policy from anything: defaults for whatever is missing or invalid. */
export function sanitizeOrganisationPolicy(raw: unknown): OrganisationPolicy {
  return mergeOrganisation(DEFAULT_ORGANISATION_POLICY, sanitizeOrganisationPartial(raw));
}
