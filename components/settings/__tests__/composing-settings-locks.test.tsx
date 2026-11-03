import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposingSettings } from '../composing-settings';
import { useSettingsStore } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';

// The admin panel offers locks for these three rows (restriction-keys.ts);
// the page has to show them, or the user changes a value the next policy
// load puts back.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const ROWS = {
  plainTextMode: 'plain_text_mode.label',
  autoSelectReplyIdentity: 'auto_select_reply_identity.label',
  replyIdentityMatch: 'reply_identity_match.label',
} as const;

function setPolicy(locked: string[], hidden: string[] = []) {
  usePolicyStore.setState({
    ...usePolicyStore.getState(),
    policy: {},
    isSettingLocked: (key: string) => locked.includes(key),
    isSettingHidden: (key: string) => hidden.includes(key),
    isFeatureEnabled: (gate: string) => gate === 'customFromEnabled',
  } as never);
}

/** The SettingItem row of a label: the element that holds the control. */
function row(labelKey: string): HTMLElement {
  return screen.getByText(labelKey).closest('[data-search-label]') as HTMLElement;
}

describe('ComposingSettings admin locks', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetToDefaults();
    // The identity match row shows only with auto-select on.
    useSettingsStore.setState({ autoSelectReplyIdentity: true });
    useAuthStore.setState({ client: null });
  });

  it('shows the lock and makes the control inert for each locked row', () => {
    setPolicy(Object.keys(ROWS));
    render(<ComposingSettings />);
    for (const label of Object.values(ROWS)) {
      const item = row(label);
      expect(within(item).getByText('org_locked'), label).toBeTruthy();
      const control = item.querySelector('[role="switch"], select');
      expect(control, label).not.toBeNull();
      expect(control!.closest('[inert]'), label).not.toBeNull();
    }
  });

  it('leaves the rows editable without a lock', () => {
    setPolicy([]);
    render(<ComposingSettings />);
    for (const label of Object.values(ROWS)) {
      const item = row(label);
      expect(within(item).queryByText('org_locked'), label).toBeNull();
      expect(item.querySelector('[inert]'), label).toBeNull();
    }
  });

  it('hides the rows the organisation hides', () => {
    setPolicy([], Object.keys(ROWS));
    render(<ComposingSettings />);
    for (const label of Object.values(ROWS)) expect(screen.queryByText(label), label).toBeNull();
  });
});
