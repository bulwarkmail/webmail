'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { ExternalMailSection } from '@/components/admin/org/sections/external-mail-section';
import { PhishingReportSection } from '@/components/admin/org/sections/phishing-report-section';
import { SessionsSection } from '@/components/admin/org/sections/sessions-section';
import { ThirdPartySection } from '@/components/admin/org/sections/third-party-section';

export function OrgSecurityPage() {
  const draft = useOrgPolicyDraft('org-security');
  return (
    <OrgPage pageId="org-security" draft={draft}>
      <ExternalMailSection draft={draft} />
      <PhishingReportSection draft={draft} />
      <SessionsSection draft={draft} />
      <ThirdPartySection draft={draft} />
    </OrgPage>
  );
}
