/**
 * Who each signed-in account is for the domain and group scopes, so a
 * message written from another account than the active one (the composer
 * of an account the user switched away from, an identity of another
 * account in the From list) gets that account's organisation signature and
 * disclaimer. The active account's subject is the policy store's; the
 * others are worked out here once per account, the same way
 * (policySubjectForClient), and kept until the account's client changes.
 */

import { create } from 'zustand';
import type { PolicySubject } from '@/lib/admin/policy-scopes';
import { policySubjectForClient } from '@/lib/admin/policy-subject';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';

interface AccountSubjectsState {
  /** Resolved subjects by local account id. */
  subjects: Record<string, PolicySubject>;
  /** Accounts whose subject was worked out, found or not. */
  settled: Record<string, true>;
}

export const useAccountSubjects = create<AccountSubjectsState>()(() => ({ subjects: {}, settled: {} }));

const pending = new Map<string, unknown>();

type SubjectSource = Parameters<typeof policySubjectForClient>[0];

/** Starts working out an account's subject, once per client. */
function resolveSubject(accountId: string, client: NonNullable<SubjectSource>): void {
  if (pending.get(accountId) === client) return;
  pending.set(accountId, client);
  const settle = (subject: PolicySubject | null) => {
    if (pending.get(accountId) !== client) return;
    useAccountSubjects.setState((state) => ({
      subjects: subject ? { ...state.subjects, [accountId]: subject } : state.subjects,
      settled: { ...state.settled, [accountId]: true },
    }));
  };
  void policySubjectForClient(client).then(settle, () => settle(null));
}

/**
 * Whether another signed-in account's subject is still being worked out,
 * so its group scopes may not apply yet. False for the active account
 * (see the policy store's subjectPending) and for accounts not signed in.
 */
export function accountSubjectPending(accountId: string | null | undefined): boolean {
  const auth = useAuthStore.getState();
  if (!accountId || accountId === auth.activeAccountId) return false;
  const client = auth.getClientForAccount?.(accountId);
  if (!client) return false;
  if (useAccountSubjects.getState().settled[accountId]) return false;
  resolveSubject(accountId, client as unknown as NonNullable<SubjectSource>);
  return !useAccountSubjects.getState().settled[accountId];
}

/**
 * The subject of a signed-in account: the policy store's for the active
 * account (or when no account is named), otherwise the one worked out
 * here. Until that is done, the account's address with no groups, so its
 * domain scopes apply at once and group scopes follow.
 */
export function subjectForAccount(accountId: string | null | undefined): PolicySubject | null {
  const auth = useAuthStore.getState();
  const policySubject = usePolicyStore.getState().subject;
  if (!accountId || accountId === auth.activeAccountId) return policySubject;
  const client = auth.getClientForAccount?.(accountId);
  if (!client) return policySubject;
  const known = useAccountSubjects.getState().subjects[accountId];
  resolveSubject(accountId, client as unknown as NonNullable<SubjectSource>);
  if (known) return known;
  const email = typeof client.getUsername === 'function' ? client.getUsername()?.trim().toLowerCase() : '';
  return email ? { email, groups: [] } : policySubject;
}

/** For tests: forget every subject worked out. */
export function resetAccountSubjects(): void {
  pending.clear();
  useAccountSubjects.setState({ subjects: {}, settled: {} });
}
