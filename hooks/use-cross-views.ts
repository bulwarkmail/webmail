import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';

/** Shared/group mailboxes and multiple connected accounts retain unified semantics. */
export function useSimpleSingleAccount() {
  const connected = useAccountStore((s) => s.accounts.filter((a) => a.isConnected).length);
  const hasShared = useEmailStore((s) => s.mailboxes.some((m) => m.isShared));
  return connected === 1 && !hasShared;
}

/** Own-account virtual views do not require the unified mailbox master switch. */
export function useCrossViews() {
  const simpleSingleAccount = useSimpleSingleAccount();
  const enabled = useSettingsStore((s) => s.enableUnifiedMailbox);
  const unread = useSettingsStore((s) => s.enableCrossUnreadView);
  const starred = useSettingsStore((s) => s.enableCrossStarredView);
  const all = useSettingsStore((s) => s.enableCrossAllView);
  const unreadGate = usePolicyStore((s) => s.isFeatureEnabled('crossUnreadViewEnabled'));
  const starredGate = usePolicyStore((s) => s.isFeatureEnabled('crossStarredViewEnabled'));
  const allGate = usePolicyStore((s) => s.isFeatureEnabled('crossAllViewEnabled'));
  return {
    showCrossUnread: (simpleSingleAccount || enabled) && unreadGate && unread,
    showCrossStarred: (simpleSingleAccount || enabled) && starredGate && starred,
    showCrossAll: enabled && allGate && all,
  };
}
