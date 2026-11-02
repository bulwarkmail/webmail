'use client';

import { useId } from 'react';
import { Plus, Trash2 } from '@/components/icons';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { MIN_FEED_REFRESH_MINUTES, type CompanyFeed } from '@/lib/admin/organisation-policy';
import { generateUUID } from '@/lib/utils';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const inputClass =
  'block w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-hidden focus-visible:border-ring';
const labelClass = 'mb-1 block text-xs font-medium text-foreground';
const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/company-calendars';
/** Same cap as the sanitiser (organisation-policy.ts). */
const MAX_FEEDS = 50;
const MAX_REFRESH = 7 * 24 * 60;

/** The address as it will be saved, or null when it can't be one. */
function feedUrlProblem(value: string): string | null {
  const v = value.trim().replace(/^webcals?:\/\//i, 'https://');
  if (!v) return 'Enter the address of the ICS feed.';
  try {
    const url = new URL(v);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an https:// (or webcal://) address.';
    return null;
  } catch {
    return 'This isn\'t a web address.';
  }
}

function FeedEditor({ feed, onChange, onRemove }: { feed: CompanyFeed; onChange: (feed: CompanyFeed) => void; onRemove: () => void }) {
  const id = useId();
  const set = (patch: Partial<CompanyFeed>) => onChange({ ...feed, ...patch });
  const urlProblem = feedUrlProblem(feed.url);
  return (
    <li className="space-y-3 rounded-md border border-border p-3" data-testid="org-feed-item">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label htmlFor={`${id}-name`} className={labelClass}>Name</label>
          <input id={`${id}-name`} data-testid="org-feed-name" className={inputClass} value={feed.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div>
          <label htmlFor={`${id}-color`} className={labelClass}>Colour</label>
          <input id={`${id}-color`} type="color" className="h-9 w-16 cursor-pointer rounded-md border border-input bg-background" value={feed.color || '#2563eb'} onChange={(e) => set({ color: e.target.value })} />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-url`} className={labelClass}>ICS address</label>
        <input
          id={`${id}-url`}
          data-testid="org-feed-url"
          type="url"
          inputMode="url"
          spellCheck={false}
          className={inputClass}
          placeholder="https://calendar.example.com/holidays.ics"
          value={feed.url}
          aria-invalid={!!urlProblem}
          aria-describedby={urlProblem ? `${id}-url-error` : undefined}
          onChange={(e) => set({ url: e.target.value })}
        />
        {urlProblem && <p id={`${id}-url-error`} className="mt-1 text-xs text-red-600 dark:text-red-400">{urlProblem} A feed without one is not saved.</p>}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor={`${id}-refresh`} className={labelClass}>Refresh every (minutes)</label>
          <input
            id={`${id}-refresh`}
            type="number"
            inputMode="numeric"
            min={MIN_FEED_REFRESH_MINUTES}
            max={MAX_REFRESH}
            step={15}
            className={`${inputClass} w-32`}
            value={feed.refreshMinutes}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) set({ refreshMinutes: Math.min(MAX_REFRESH, Math.max(MIN_FEED_REFRESH_MINUTES, n)) });
            }}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} className="h-9 px-2 hover:text-red-600" aria-label={`Remove ${feed.name || 'calendar'}`}>
          <Trash2 className="me-1 h-4 w-4" /> Remove
        </Button>
      </div>
      {!feed.name.trim() && <p className="text-xs text-red-600 dark:text-red-400">A calendar without a name is not saved. Give it one.</p>}
    </li>
  );
}

/**
 * Organisation > Calendars > Company calendars
 * (policy.json `organisation.calendars.feeds`): ICS feeds every user in the
 * scope sees read-only under "Organisation". A scope's feeds add to
 * Everyone's by id.
 */
export function CompanyCalendarsSection({ draft }: { draft: OrgPolicyDraft }) {
  const feeds = draft.orgValue('calendars', 'feeds');
  const inScope = !!draft.scope;
  const own: CompanyFeed[] = inScope ? (feeds.own ? feeds.value : []) : feeds.value;
  const everyone = feeds.everyone;
  const setOwn = (next: CompanyFeed[]) => {
    if (inScope && next.length === 0) draft.clearOrgValue('calendars', 'feeds');
    else draft.setOrgValue('calendars', 'feeds', next);
  };
  const add = () => setOwn([...own, { id: generateUUID(), name: '', url: '', color: '#2563eb', refreshMinutes: MIN_FEED_REFRESH_MINUTES }]);
  const total = new Set([...everyone.map((f) => f.id), ...own.map((f) => f.id)]).size;

  return (
    <SettingsSection
      id="company-calendars"
      title="Company calendars"
      description="ICS feeds such as holidays, office closures or company events. Users in the scope see them read-only under “Organisation” in Calendar and can hide them, not remove them."
    >
      <div className="space-y-4">
        {inScope && (
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">From Everyone</p>
            {everyone.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everyone has no company calendars.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="org-feed-inherited">
                {everyone.map((feed) => (
                  <li key={feed.id} className="flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm">
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: feed.color }} aria-hidden="true" />
                    <span className="min-w-0 truncate">{feed.name}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 mb-1 text-sm font-medium text-foreground">For this scope</p>
            <p className="mb-2 text-xs text-muted-foreground">Users in this scope get Everyone&apos;s calendars and these.</p>
          </div>
        )}

        {own.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="org-feed-empty">
            {inScope ? 'Nothing added for this scope.' : 'No company calendars yet.'}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="org-feed-list">
            {own.map((feed, index) => (
              <FeedEditor
                key={feed.id}
                feed={feed}
                onChange={(next) => setOwn(own.map((f, i) => (i === index ? next : f)))}
                onRemove={() => setOwn(own.filter((_, i) => i !== index))}
              />
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={add} disabled={total >= MAX_FEEDS} data-testid="org-feed-add">
            <Plus className="me-1 h-4 w-4" /> Add calendar
          </Button>
          {total >= MAX_FEEDS && <span className="text-xs text-muted-foreground">At most {MAX_FEEDS} company calendars.</span>}
        </div>

        <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="org-feed-notes">
          <p>
            Bulwark&apos;s server fetches the feeds, at most once per refresh interval for everyone, and keeps the addresses to
            itself: users never see them. A feed may be on your intranet when its address names it: an intranet IP address
            (10.x, 172.16-31.x, 192.168.x), a .local or .internal name, or a name without dots. Loopback and link-local
            addresses are never reached. Feeds stay reachable with &quot;No third-party traffic&quot; on and are listed on
            Organisation &gt; Security.
          </p>
          <p>
            Each refresh that changed the feed uploads it once to Stalwart for every user who has Calendar open, which counts
            against Stalwart&apos;s upload limit (1000 files or 50 MB an hour per user). Keep feeds small and the interval long.
          </p>
          <p>
            Bulwark Lite has no server: the browser fetches the feed itself, so the feed host must send CORS headers
            (Access-Control-Allow-Origin), and policy.json is a public file there, so don&apos;t put tokens in the addresses. A
            Lite build without third-party traffic only reaches the mail server: put the feed on the same host as Lite or the
            mail server.{' '}
            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
              How to set it up
            </a>
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
