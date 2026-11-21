'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { TeamMailboxesSection } from '@/components/admin/org/sections/team-mailboxes-section';

export function OrgTeamMailboxesPage() {
  const draft = useOrgPolicyDraft('org-team-mailboxes');
  return (
    <OrgPage pageId="org-team-mailboxes" draft={draft}>
      <TeamMailboxesSection draft={draft} />
    </OrgPage>
  );
}
