'use client';

import { useId, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, Plus, RotateCcw, Trash2 } from '@/components/icons';
import { SettingItem, SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import {
  ANNOUNCEMENT_SEVERITIES,
  DEFAULT_ORGANISATION_POLICY,
  type AnnouncementSeverity,
  type OrganisationPolicy,
} from '@/lib/admin/organisation-policy';
import { announcementParts } from '@/lib/org-announcement';
import { routing } from '@/i18n/routing';
import { cn, generateUUID } from '@/lib/utils';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

type Announcement = OrganisationPolicy['announcement'];
const KEYS = ['id', 'severity', 'text', 'fallbackLocale', 'startsAt', 'endsAt', 'dismissible'] as const;
const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/announcements';
/** Same cap as the sanitiser. */
const MAX_TEXT = 4000;

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic', ca: 'Catalan', cs: 'Czech', da: 'Danish', de: 'German', en: 'English', es: 'Spanish',
  et: 'Estonian', fa: 'Persian', fr: 'French', he: 'Hebrew', hu: 'Hungarian', it: 'Italian', ja: 'Japanese',
  ko: 'Korean', lv: 'Latvian', mn: 'Mongolian', nb: 'Norwegian', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese',
  ro: 'Romanian', ru: 'Russian', sk: 'Slovak', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese',
  zh: 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)',
};
const languageName = (code: string) => LANGUAGE_NAMES[code] ?? code;

const SEVERITY: Record<AnnouncementSeverity, { label: string; hint: string; icon: typeof Info; className: string }> = {
  info: { label: 'Information', hint: 'Grey. For news and planned changes.', icon: Info, className: 'bg-muted/60 border-border text-foreground' },
  warning: { label: 'Warning', hint: 'Amber. For maintenance and things users have to do.', icon: AlertTriangle, className: 'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-200' },
  critical: { label: 'Critical', hint: 'Red, and screen readers interrupt to read it. For outages and security incidents.', icon: AlertCircle, className: 'bg-destructive/10 border-destructive/30 text-destructive' },
};

const inputClass =
  'block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-hidden focus-visible:border-ring';
const labelClass = 'mb-1 block text-xs font-medium text-foreground';

/** ISO time to the value of a datetime-local input, in this browser's zone. */
export function toLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function Preview({ announcement, locale }: { announcement: Announcement; locale: string }) {
  const text = announcement.text[locale] ?? '';
  const s = SEVERITY[announcement.severity] ?? SEVERITY.info;
  const Icon = s.icon;
  if (!text.trim()) return <p className="text-sm text-muted-foreground">No text in {languageName(locale)} yet.</p>;
  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 text-sm', s.className)} data-testid="org-announcement-preview">
      <Icon className="mt-3 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 whitespace-pre-line break-words py-2.5 [overflow-wrap:anywhere]">
        {announcementParts(text).map((part, i) => part.kind === 'link'
          ? <span key={i} className="font-medium underline underline-offset-2">{part.href}</span>
          : <span key={i}>{part.text}</span>)}
      </p>
    </div>
  );
}

/**
 * Organisation > Notices > Announcement (enterprise pack item 10): one
 * message across the top of every app, per language, with a severity, an
 * optional start and end, and whether users can close it. A scope that
 * sets an announcement replaces Everyone's as a whole, so every key is
 * written in a scope (mergeOrganisation's whole-section rule).
 */
export function AnnouncementSection({ draft }: { draft: OrgPolicyDraft }) {
  const id = useId();
  const inScope = !!draft.scope;
  const scopeOwn = inScope && KEYS.some((key) => draft.orgValue('announcement', key).own);
  const editing = !inScope || scopeOwn;
  const read = <K extends keyof Announcement>(key: K): Announcement[K] => {
    const v = draft.orgValue('announcement', key);
    if (!inScope) return v.value;
    if (!scopeOwn) return v.everyone;
    return v.own ? v.value : DEFAULT_ORGANISATION_POLICY.announcement[key];
  };
  const announcement = Object.fromEntries(KEYS.map((key) => [key, read(key)])) as unknown as Announcement;
  const everyoneHasText = Object.keys(draft.orgValue('announcement', 'text').everyone).length > 0;

  const setAll = (next: Announcement) => { for (const key of KEYS) draft.setOrgValue('announcement', key, next[key] as never); };
  const set = (patch: Partial<Announcement>) => setAll({ ...announcement, ...patch });
  const useEveryone = () => { for (const key of KEYS) draft.clearOrgValue('announcement', key); };

  const languages = Object.keys(announcement.text);
  const [shown, setShown] = useState<string | null>(null);
  const current = shown && languages.includes(shown)
    ? shown
    : (languages.includes(announcement.fallbackLocale) ? announcement.fallbackLocale : languages[0] ?? null);
  const unused = routing.locales.filter((code) => !languages.includes(code));
  const has = languages.length > 0;

  /** A new announcement (or a copy of Everyone's for a scope) gets a new id: dismissals don't carry over. */
  const create = (copyFrom?: Announcement) => {
    const base: Announcement = copyFrom
      ? JSON.parse(JSON.stringify(copyFrom)) as Announcement
      : { ...DEFAULT_ORGANISATION_POLICY.announcement, text: { en: '' } };
    setAll({ ...base, id: generateUUID().replace(/-/g, '').slice(0, 12) });
    setShown(Object.keys(base.text)[0] ?? 'en');
  };
  const setText = (locale: string, value: string) => set({ text: { ...announcement.text, [locale]: value.slice(0, MAX_TEXT) } });
  const addLanguage = (locale: string) => {
    if (!locale) return;
    set({ text: { ...announcement.text, [locale]: '' } });
    setShown(locale);
  };
  const removeLanguage = (locale: string) => {
    const text = { ...announcement.text };
    delete text[locale];
    const left = Object.keys(text);
    set({ text, fallbackLocale: text[announcement.fallbackLocale] !== undefined ? announcement.fallbackLocale : (left[0] ?? 'en') });
    setShown(left[0] ?? null);
  };
  const remove = () => setAll({ ...DEFAULT_ORGANISATION_POLICY.announcement });

  const { startsAt, endsAt } = announcement;
  const badRange = !!startsAt && !!endsAt && Date.parse(endsAt) <= Date.parse(startsAt);
  const ended = !!endsAt && Date.parse(endsAt) <= Date.now();

  return (
    <SettingsSection
      id="announcement"
      title="Announcement"
      description="A message across the top of mail, calendar, contacts, files and settings for everyone in scope: maintenance, outages, new rules. Plain text; web addresses become links."
    >
      <div className="space-y-4">
        {inScope && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm" data-testid="org-announcement-scope">
            <span>
              {scopeOwn
                ? 'This scope has its own announcement. Users here see it instead of Everyone’s.'
                : everyoneHasText ? 'This scope shows Everyone’s announcement.' : 'Everyone has no announcement.'}
            </span>
            {scopeOwn ? (
              <Button type="button" variant="outline" size="sm" onClick={useEveryone}>
                <RotateCcw className="me-1 h-3.5 w-3.5" /> Use Everyone&apos;s announcement
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => create(everyoneHasText ? announcement : undefined)} data-testid="org-announcement-own">
                Set an announcement for this scope
              </Button>
            )}
          </div>
        )}

        {editing && !has && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground" data-testid="org-announcement-empty">
              {inScope ? 'This scope shows no announcement.' : 'No announcement.'}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => create()} data-testid="org-announcement-add">
              <Plus className="me-1 h-4 w-4" /> Write an announcement
            </Button>
          </div>
        )}

        {!editing && has && current && <Preview announcement={announcement} locale={current} />}

        {editing && has && current && (
          <>
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2" role="group" aria-label="Languages">
                {languages.map((code) => (
                  <button
                    key={code}
                    type="button"
                    aria-pressed={code === current}
                    onClick={() => setShown(code)}
                    className={cn('h-8 rounded-md px-3 text-sm font-medium', code === current ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-accent')}
                  >
                    {languageName(code)}
                  </button>
                ))}
                {unused.length > 0 && (
                  <select
                    aria-label="Add a language"
                    data-testid="org-announcement-add-language"
                    className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-sm"
                    value=""
                    onChange={(e) => addLanguage(e.target.value)}
                  >
                    <option value="">Add a language…</option>
                    {unused.map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
                  </select>
                )}
              </div>
              <label htmlFor={`${id}-text`} className={labelClass}>Text in {languageName(current)}</label>
              <textarea
                id={`${id}-text`}
                data-testid="org-announcement-text"
                rows={3}
                dir="auto"
                maxLength={MAX_TEXT}
                className={inputClass}
                value={announcement.text[current] ?? ''}
                onChange={(e) => setText(current, e.target.value)}
              />
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Users see the text in their language, else in the fallback language. Keep it to a sentence or two.
                </p>
                {languages.length > 1 && (
                  <button type="button" onClick={() => removeLanguage(current)} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline">
                    <Trash2 className="h-3 w-3" /> Remove {languageName(current)}
                  </button>
                )}
              </div>
              {!(announcement.text[current] ?? '').trim() && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">An empty text is not saved.</p>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={`${id}-fallback`} className={labelClass}>Fallback language</label>
                <select
                  id={`${id}-fallback`}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={languages.includes(announcement.fallbackLocale) ? announcement.fallbackLocale : languages[0]}
                  onChange={(e) => set({ fallbackLocale: e.target.value })}
                >
                  {languages.map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-severity`} className={labelClass}>Severity</label>
                <select
                  id={`${id}-severity`}
                  data-testid="org-announcement-severity"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={announcement.severity}
                  onChange={(e) => set({ severity: e.target.value as AnnouncementSeverity })}
                >
                  {ANNOUNCEMENT_SEVERITIES.map((sev) => <option key={sev} value={sev}>{SEVERITY[sev].label}</option>)}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">{SEVERITY[announcement.severity]?.hint}</p>
              </div>
              <div>
                <label htmlFor={`${id}-start`} className={labelClass}>Show from</label>
                <input
                  id={`${id}-start`}
                  type="datetime-local"
                  data-testid="org-announcement-start"
                  className={inputClass}
                  value={toLocalInput(startsAt)}
                  onChange={(e) => set({ startsAt: fromLocalInput(e.target.value) })}
                />
                <p className="mt-1 text-xs text-muted-foreground">Empty: right away.</p>
              </div>
              <div>
                <label htmlFor={`${id}-end`} className={labelClass}>Show until</label>
                <input
                  id={`${id}-end`}
                  type="datetime-local"
                  data-testid="org-announcement-end"
                  className={inputClass}
                  value={toLocalInput(endsAt)}
                  onChange={(e) => set({ endsAt: fromLocalInput(e.target.value) })}
                />
                <p className="mt-1 text-xs text-muted-foreground">Empty: until you remove it.</p>
              </div>
            </div>
            {badRange && <p className="text-xs text-red-600 dark:text-red-400" role="alert">The end is before the start, so nobody sees it.</p>}
            {!badRange && ended && <p className="text-xs text-amber-700 dark:text-amber-300">The end time has passed, so nobody sees it.</p>}
            <p className="text-xs text-muted-foreground">Times are in your browser&apos;s time zone. Open tabs show and hide the announcement on time without a reload.</p>

            <SettingItem label="Users can close it" description="Closed stays closed for that account in that browser until you change its text or severity; moving the start or end doesn't show it again. Turn this off for messages everyone must see.">
              <ToggleSwitch checked={announcement.dismissible} onChange={(v) => set({ dismissible: v })} testId="org-announcement-dismissible" />
            </SettingItem>

            <div>
              <p className={labelClass}>Preview</p>
              <Preview announcement={announcement} locale={current} />
            </div>

            <div>
              <Button type="button" variant="outline" size="sm" onClick={remove} data-testid="org-announcement-remove">
                <Trash2 className="me-1 h-4 w-4" /> Remove the announcement
              </Button>
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">
          Open tabs pick up a change within 15 minutes, or when the user comes back to the tab. In Bulwark Lite the
          announcement is in policy.json, which anyone can read without signing in, and a Lite installed inside
          Stalwart needs a new bundle upload to change it.{' '}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
            How announcements work
          </a>
        </p>
      </div>
    </SettingsSection>
  );
}
