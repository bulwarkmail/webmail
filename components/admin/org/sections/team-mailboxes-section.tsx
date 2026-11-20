'use client';

import { SettingItem, SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/team-mailboxes';

/**
 * Organisation > Team mailboxes: one switch, `organisation.teamMailboxes.enabled`,
 * off by default and scoped like every other section. In a group scope it
 * applies to that group's mailbox only (lib/team-mailboxes/policy.ts).
 */
export function TeamMailboxesSection({ draft }: { draft: OrgPolicyDraft }) {
  const { value, own, everyone } = draft.orgValue('teamMailboxes', 'enabled');
  return (
    <SettingsSection
      id="team-mailboxes"
      title="Team mailboxes"
      description="For mailboxes a group shares, such as info@ or support@."
    >
      <SettingItem
        label="Notes and assignment in team mailboxes"
        description="Members of a group mailbox can write notes beside its messages, assign messages to each other and mark them done. Notes are kept as messages in a “Team notes” folder of the group mailbox, which Bulwark doesn’t list. Nothing changes in people’s own mailboxes."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <ToggleSwitch checked={value} onChange={(v) => draft.setOrgValue('teamMailboxes', 'enabled', v)} testId="org-team-mailboxes-enabled" />
          <InheritNote draft={draft} own={own} everyone={everyone ? 'on' : 'off'} onReset={() => draft.clearOrgValue('teamMailboxes', 'enabled')} />
        </div>
      </SettingItem>
      <p className="pt-2 text-xs text-muted-foreground">
        To turn it on for one team only, pick that group in the bar above. Other mail apps show the “Team notes” folder as
        an ordinary folder.{' '}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
          How team mailboxes work
        </a>
      </p>
    </SettingsSection>
  );
}
