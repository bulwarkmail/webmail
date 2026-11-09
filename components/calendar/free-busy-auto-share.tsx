'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { applyAdminFreeBusyShare } from '@/lib/free-busy-share';

/**
 * Applies the admin's free/busy group (organisation.calendars.freeBusyGroup)
 * to the signed-in account's default calendar, once per page load and
 * account: at sign-in, on a reload, and when another account becomes the
 * active one. Waits until the policy is resolved for that account, so a
 * group set in a domain or group scope applies to the right people. Renders
 * nothing.
 */
export function FreeBusyAutoShare() {
  const client = useAuthStore((s) => s.client);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loaded = usePolicyStore((s) => s.loaded);
  const subjectEmail = usePolicyStore((s) => s.subject?.email ?? null);
  const group = usePolicyStore((s) => s.policy.organisation?.calendars?.freeBusyGroup ?? '');

  useEffect(() => {
    if (!isAuthenticated || !client || !loaded || !group) return;
    // The policy is resolved for the active account a moment after it
    // changes; wait for that rather than apply another account's group.
    if (!subjectEmail || subjectEmail !== client.getUsername()?.trim().toLowerCase()) return;
    if (!client.supportsCalendars?.()) return;
    void applyAdminFreeBusyShare(client, group);
  }, [client, isAuthenticated, loaded, subjectEmail, group]);

  return null;
}
