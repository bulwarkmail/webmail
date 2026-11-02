'use client';

import { SettingItem, SettingsSection } from '@/components/settings/settings-section';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';
import type { SettingRestriction } from '@/lib/admin/types';

const KEY = 'vacationBlockCalendar';
const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/out-of-office';

type Choice = 'users' | 'always' | 'never';

function choiceOf(r: SettingRestriction | undefined): Choice {
  if (r?.locked !== true) return 'users';
  return r.value === false ? 'never' : 'always';
}

const LABELS: Record<Choice, string> = {
  users: 'Users choose (on until they turn it off)',
  always: 'Always block the calendar',
  never: 'Never block the calendar',
};

/**
 * Organisation > Calendars > Out-of-office: whether an out-of-office reply
 * with dates puts a busy event in the user's calendar. Users choose by
 * default (on); a lock pins it on or off (restriction vacationBlockCalendar,
 * with its value).
 */
export function OutOfOfficeCalendarSection({ draft }: { draft: OrgPolicyDraft }) {
  const { value, own, everyone } = draft.restriction(KEY);
  const choice = choiceOf(value);
  const set = (next: Choice) => draft.setRestriction(KEY, next === 'users' ? undefined : { locked: true, value: next === 'always' });

  return (
    <SettingsSection
      id="out-of-office"
      title="Out-of-office"
      description="When a user sets an out-of-office reply with a start and an end, Bulwark adds a busy event for that time to their default calendar, so colleagues don't book meetings with them."
    >
      <SettingItem
        label="Out-of-office blocks the calendar"
        description="Locked, users see the choice as set by the organisation."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <select
            id="org-ooo-block"
            aria-label="Out-of-office blocks the calendar"
            value={choice}
            onChange={(e) => set(e.target.value as Choice)}
            className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm text-foreground sm:w-72"
          >
            {(Object.keys(LABELS) as Choice[]).map((c) => <option key={c} value={c}>{LABELS[c]}</option>)}
          </select>
          <InheritNote
            draft={draft}
            own={own}
            everyone={LABELS[choiceOf(everyone)]}
            onReset={() => draft.setRestriction(KEY, undefined)}
          />
        </div>
      </SettingItem>
      <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="org-ooo-notes">
        <p>
          The event is busy, visible to everyone who sees the calendar, has no attendees and sends no invitations. If a user
          moves or changes it, Bulwark leaves it alone. Ending the reply early ends or removes the event.
        </p>
        <p>
          Bulwark follows replies set through JMAP (Bulwark, other JMAP apps). A reply another app sets up as a Sieve script of
          its own isn&apos;t visible to Bulwark, and the event is only updated when the user opens Bulwark.{' '}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
            More about out-of-office
          </a>
        </p>
      </div>
    </SettingsSection>
  );
}
