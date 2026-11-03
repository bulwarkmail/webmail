'use client';

import { SettingItem, SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/offline-mode';

interface CapField {
  key: 'offlineMaxDays' | 'offlineMaxAttachmentMb' | 'offlineMaxTotalMb';
  label: string;
  description: string;
  unit: string;
  max: number;
}

const CAP_FIELDS: CapField[] = [
  {
    key: 'offlineMaxDays',
    label: 'Keep mail for at most',
    description: 'Mail older than this leaves the device at its next policy fetch, and calendar events that ended before it too. People can still choose less.',
    unit: 'days',
    max: 3650,
  },
  {
    key: 'offlineMaxAttachmentMb',
    label: 'Largest attachment or file kept',
    description: 'Anything bigger leaves the device and opens from the server when there is a connection. This also holds for files someone chose to keep offline.',
    unit: 'MB',
    max: 1024 * 1024,
  },
  {
    key: 'offlineMaxTotalMb',
    label: 'All attachments and files, per account',
    description: 'The oldest go first when a device is over this. Message text isn’t counted: limit that with the days above.',
    unit: 'MB',
    max: 1024 * 1024,
  },
];

const describeCap = (value: number, unit: string) => (value > 0 ? `${value} ${unit}` : 'no limit');

/**
 * Organisation > Devices > Offline mode (#523): whether people may keep mail
 * on their devices, and how much (policy.json `organisation.devices`). These
 * win over what a user picks and over the desktop app's default. Nothing on
 * the server can check them, since the mail is on the device: the app holds
 * itself to them, which the text says.
 */
export function OfflineSection({ draft }: { draft: OrgPolicyDraft }) {
  const forbid = draft.orgValue('devices', 'noOffline');
  const noAttachments = draft.orgValue('devices', 'noOfflineAttachments');
  const wipeOnRefused = draft.orgValue('devices', 'wipeOnForcedSignOut');
  return (
    <SettingsSection
      id="offline"
      title="Offline mode"
      description="People can keep mail on a device to read and write it without a connection. In browsers it is off until someone turns on “Keep mail on this device” in Settings > Backup & reset. In the Bulwark desktop app it is on unless you forbid it here."
    >
      <SettingItem
        label="Don't let people keep mail on their devices"
        description="Hides the switch. A device that already keeps mail deletes it, unsent messages in its outbox included, the next time it fetches the policy (when the tab is opened or focused, and every 15 minutes)."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <ToggleSwitch checked={forbid.value} onChange={(v) => draft.setOrgValue('devices', 'noOffline', v)} testId="org-devices-noOffline" />
          <InheritNote draft={draft} own={forbid.own} everyone={forbid.everyone ? 'on' : 'off'} onReset={() => draft.clearOrgValue('devices', 'noOffline')} />
        </div>
      </SettingItem>
      {CAP_FIELDS.map((field) => {
        const { value, own, everyone } = draft.orgValue('devices', field.key);
        return (
          <SettingItem key={field.key} label={field.label} description={field.description}>
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={field.max}
                  step={1}
                  data-testid={`org-devices-${field.key}`}
                  aria-label={`${field.label} (${field.unit})`}
                  placeholder="No limit"
                  value={value > 0 ? value : ''}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const parsed = raw === '' ? 0 : Math.round(Number(raw));
                    if (!Number.isFinite(parsed)) return;
                    draft.setOrgValue('devices', field.key, Math.min(field.max, Math.max(0, parsed)));
                  }}
                  className="h-9 w-28 rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden"
                />
                <span className="text-sm text-muted-foreground">{field.unit}</span>
              </div>
              <InheritNote draft={draft} own={own} everyone={describeCap(everyone, field.unit)} onReset={() => draft.clearOrgValue('devices', field.key)} />
            </div>
          </SettingItem>
        );
      })}
      <SettingItem
        label="Don't keep attachments or files"
        description="Mail stays on the device without its attachments, and files kept for offline use are removed. They open from the server when there is a connection."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <ToggleSwitch checked={noAttachments.value} onChange={(v) => draft.setOrgValue('devices', 'noOfflineAttachments', v)} testId="org-devices-noOfflineAttachments" />
          <InheritNote draft={draft} own={noAttachments.own} everyone={noAttachments.everyone ? 'on' : 'off'} onReset={() => draft.clearOrgValue('devices', 'noOfflineAttachments')} />
        </div>
      </SettingItem>
      <SettingItem
        label="Delete a device's mail as soon as it's signed out with nobody asking"
        description="That's when the server refuses its login, or the idle or session limit runs out. Off: the device signs out and hides what it keeps, unsent messages included, until the next sign-in, or for 30 days. That's what a password changed on another device needs. On: it's deleted right away, unsent messages included, and only that account's. A wipe you ask for below is immediate either way."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <ToggleSwitch checked={wipeOnRefused.value} onChange={(v) => draft.setOrgValue('devices', 'wipeOnForcedSignOut', v)} testId="org-devices-wipeOnForcedSignOut" />
          <InheritNote draft={draft} own={wipeOnRefused.own} everyone={wipeOnRefused.everyone ? 'on' : 'off'} onReset={() => draft.clearOrgValue('devices', 'wipeOnForcedSignOut')} />
        </div>
      </SettingItem>
      <p className="pt-2 text-xs text-muted-foreground">
        What a device keeps: mail in every folder from the window the person picks (30 days, 90 days, a year or everything),
        with calendar, contacts and files, encrypted on the device. That protects against someone copying its files, not
        against someone using the unlocked browser or app. The limits above can only lower what people pick: where several
        scopes apply, the lowest value counts, so a scope can&apos;t raise what another one lowered. The app holds itself to
        them when it fetches the policy; the server can&apos;t check what is on a device. A sign-out someone asks for deletes everything.
        One that nobody asked for hides it, as the switch above says. With several accounts signed in, each account follows its own settings.
        Bulwark Lite reads the same policy but has no offline mode.{' '}
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
          How offline mode works
        </a>
      </p>
    </SettingsSection>
  );
}
