'use client';

import { useMemo } from 'react';
import { devicesForAccount, getStrictestDevices, type DevicePolicy, type DeviceSubject } from '@/lib/device-policy';
import { useAccountSubjects } from '@/lib/org/account-subjects';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';

type HookSubject = Exclude<DeviceSubject, { client: object }>;

/** The account id a hook subject stands for: a message without a stamp belongs to the account the sidebar shows. */
function subjectKey(subject: HookSubject, viewing: string | null): string {
  if (!subject) return '';
  return typeof subject === 'string' ? subject : subject.sourceClientAccountId ?? viewing ?? '';
}

/**
 * The device policy of the account a message, attachment or file belongs
 * to (the active account when left out). Follows the policy, the account's
 * groups and the active account as they load or change.
 */
export function useDevicePolicy(subject?: HookSubject): DevicePolicy {
  const viewing = useEmailStore((s) => s.viewingAccountId);
  const key = subjectKey(subject, viewing);
  const policy = usePolicyStore((s) => s.policy);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const policySubject = usePolicyStore((s) => s.subject);
  const subjects = useAccountSubjects((s) => s.subjects);
  const active = useAuthStore((s) => s.activeAccountId);
  return useMemo(
    () => devicesForAccount(key || null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, policy, rawPolicy, policySubject, subjects, active],
  );
}

/**
 * Every switch any signed-in account has on: for what isn't about one
 * account (the install prompt, Ctrl+P, a list that mixes accounts).
 */
export function useStrictestDevices(): DevicePolicy {
  const policy = usePolicyStore((s) => s.policy);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const policySubject = usePolicyStore((s) => s.subject);
  const subjects = useAccountSubjects((s) => s.subjects);
  const active = useAuthStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  return useMemo(
    () => getStrictestDevices(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [policy, rawPolicy, policySubject, subjects, active, accounts],
  );
}
