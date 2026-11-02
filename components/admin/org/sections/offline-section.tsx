'use client';

import { SettingItem, SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/offline-mode';

/**
 * Organisation > Devices > Offline mode (#523): whether people may keep
 * mail on their devices (policy.json `organisation.devices.noOffline`).
 * Users turn offline mode on per device; this switch takes it away, and a
 * device that already keeps mail deletes it at its next policy fetch.
 */
export function OfflineSection({ draft }: { draft: OrgPolicyDraft }) {
  const { value, own, everyone } = draft.orgValue('devices', 'noOffline');
  return (
    <SettingsSection
      id="offline"
      title="Offline mode"
      description="People can turn on “Keep mail on this device” in Settings > Backup & reset to read and write mail without a connection. It is off on every device until someone turns it on there."
    >
      <SettingItem
        label="Don't let people keep mail on their devices"
        description="Hides the switch. A device that already keeps mail deletes it, unsent messages in its outbox included, the next time it fetches the policy (when the tab is opened or focused, and every 15 minutes)."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <ToggleSwitch checked={value} onChange={(v) => draft.setOrgValue('devices', 'noOffline', v)} testId="org-devices-noOffline" />
          <InheritNote draft={draft} own={own} everyone={everyone ? 'on' : 'off'} onReset={() => draft.clearOrgValue('devices', 'noOffline')} />
        </div>
      </SettingItem>
      <p className="pt-2 text-xs text-muted-foreground">
        What a device keeps: the last 30 days of the Inbox and of the folders the person opens, at most 250 MB, encrypted in
        the browser. That protects against someone copying the browser&apos;s files, not against someone using the unlocked
        browser. Every sign-out, the automatic one after inactivity included, deletes it. With several accounts signed in,
        each account follows its own setting. Bulwark Lite has no offline mode.{' '}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
          How offline mode works
        </a>
      </p>
    </SettingsSection>
  );
}
