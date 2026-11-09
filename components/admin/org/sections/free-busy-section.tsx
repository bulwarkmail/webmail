'use client';

import { useEffect, useState } from 'react';
import { SettingItem, SettingsSection } from '@/components/settings/settings-section';
import { isValidEmail } from '@/lib/validation';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/find-a-time';

/**
 * Organisation > Calendars > Free/busy sharing: a group that every user's
 * default calendar shares its free/busy with, applied by Bulwark at sign-in
 * (organisation.calendars.freeBusyGroup, '' is off).
 */
export function FreeBusySection({ draft }: { draft: OrgPolicyDraft }) {
  const { value, own, everyone } = draft.orgValue('calendars', 'freeBusyGroup');
  const [text, setText] = useState(value);
  // The field follows the scope picked in the scope bar and a discard.
  useEffect(() => setText(value), [value]);
  const trimmed = text.trim().toLowerCase();
  const invalid = trimmed !== '' && !isValidEmail(trimmed);

  return (
    <SettingsSection
      id="free-busy"
      title="Free/busy sharing"
      description="Suggest times and the attendee list only see busy times in calendars shared with the organiser. Name a group everyone is in, and Bulwark shares each user's busy times (not their events) with it."
    >
      <SettingItem
        label="Share free/busy with"
        description="A group address, for example staff@example.com. Empty turns it off."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <input
            id="org-free-busy-group"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            aria-label="Share free/busy with (group address)"
            aria-invalid={invalid}
            aria-describedby={invalid ? 'org-free-busy-group-error' : undefined}
            placeholder="staff@example.com"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const next = e.target.value.trim().toLowerCase();
              if (next === '' || isValidEmail(next)) draft.setOrgValue('calendars', 'freeBusyGroup', next);
            }}
            className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden sm:w-72"
          />
          {invalid && (
            <p id="org-free-busy-group-error" className="text-xs text-destructive">Enter a group address like staff@example.com.</p>
          )}
          <InheritNote
            draft={draft}
            own={own}
            everyone={everyone || 'off'}
            onReset={() => draft.clearOrgValue('calendars', 'freeBusyGroup')}
          />
        </div>
      </SettingItem>
      <div className="space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="org-free-busy-notes">
        <p>
          Bulwark adds the share to each user&apos;s default calendar when they sign in. It only adds: shares users made
          themselves stay, and a user who removes it gets it back at the next sign-in. It shows in the user&apos;s sharing list.
        </p>
        <p>
          Users who only use other apps (CalDAV, phones) and never sign in to Bulwark aren&apos;t covered. Users can also
          share their own free/busy under Settings &gt; Calendar.
        </p>
        <p>
          Looking people up also needs directory queries on in Stalwart (Settings &gt; Files &amp; Sharing &gt; Sharing &gt;
          Allow Directory Queries).{' '}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
            How to set it up
          </a>
        </p>
      </div>
    </SettingsSection>
  );
}
