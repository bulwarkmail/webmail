'use client';

import { OrgPage } from '@/components/admin/org/org-page';
import { useOrgPolicyDraft } from '@/components/admin/org/use-org-policy-draft';
import { CompanyCalendarsSection } from '@/components/admin/org/sections/company-calendars-section';
import { FreeBusySection } from '@/components/admin/org/sections/free-busy-section';
import { OutOfOfficeCalendarSection } from '@/components/admin/org/sections/out-of-office-calendar-section';

export function OrgCalendarsPage() {
  const draft = useOrgPolicyDraft('org-calendars');
  return (
    <OrgPage pageId="org-calendars" draft={draft}>
      <CompanyCalendarsSection draft={draft} />
      <FreeBusySection draft={draft} />
      <OutOfOfficeCalendarSection draft={draft} />
    </OrgPage>
  );
}
