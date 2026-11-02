'use client';

import { AlertTriangle } from '@/components/icons';
import { SettingItem, SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/device-policies';

type DeviceKey = 'noDownloads' | 'noExport' | 'noPrint' | 'noInstallPrompt' | 'pushWithoutContent' | 'watermark';

interface DeviceField {
  key: DeviceKey;
  label: string;
  description: string;
  /** Where it holds: on the server too, or only in the browser. */
  enforced: 'server' | 'browser' | 'both';
}

export const DEVICE_FIELDS: DeviceField[] = [
  {
    key: 'noDownloads',
    label: 'No downloads',
    description: 'Attachments and files open in the preview only: no Download, Download all, Open in new tab, Save to Files, dragging out or saving from the PDF viewer. Covers the Files app too, so Save to Files can’t get around it.',
    enforced: 'both',
  },
  {
    key: 'noExport',
    label: 'No export',
    description: 'Hides saving a message as .eml, View source, dragging messages out, and exporting a folder or the whole account (mbox, ZIP). Importing mail stays. Contacts (vCard) and events (.ics) can still be exported.',
    enforced: 'both',
  },
  {
    key: 'noPrint',
    label: 'No printing',
    description: 'Hides every Print button in mail, calendar and contacts. Ctrl+P and the browser’s menu print a page that says printing is turned off.',
    enforced: 'both',
  },
  {
    key: 'noInstallPrompt',
    label: 'No install prompt',
    description: 'Bulwark doesn’t offer to install itself as an app and holds back the browser’s own install banner. The browser’s menu can still install Bulwark.',
    enforced: 'browser',
  },
  {
    key: 'pushWithoutContent',
    label: 'Push without sender and subject',
    description: 'Browser notifications say only “New mail”. The server leaves sender, subject and text out of what it sends to the browser and the push service, also for browsers that still run an old Bulwark. The Bulwark mobile app isn’t covered yet: its notifications still show sender and subject.',
    enforced: 'server',
  },
  {
    key: 'watermark',
    label: 'Watermark',
    description: 'The user’s address and the date across the message, previews of attachments and files, and every printout.',
    enforced: 'both',
  },
];

const ENFORCED: Record<DeviceField['enforced'], string> = {
  server: 'Checked by the server.',
  both: 'In the office editor checked by the server; elsewhere in the browser only.',
  browser: 'In the browser only.',
};

const onOff = (on: boolean) => (on ? 'on' : 'off');

/**
 * Organisation > Devices (enterprise pack item 13): the switches of
 * policy.json `organisation.devices`, each off by default and scoped. A
 * message's own account decides; where there is none (the install prompt,
 * Ctrl+P) the strictest account signed in decides.
 */
export function DevicesSection({ draft }: { draft: OrgPolicyDraft }) {
  return (
    <SettingsSection
      id="devices"
      title="Downloads, printing and notifications"
      description="Make it harder to copy mail out of Bulwark on the devices people use. Each switch is off until you turn it on."
    >
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200" data-testid="org-devices-warning">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p>
          These settings make copying harder in Bulwark. They don&apos;t stop screenshots, other mail apps, or someone who
          knows the browser&apos;s tools: the browser fetches mail from the mail server directly, so only the push text and
          the office editor are checked on the server.{' '}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-2">
            What each switch covers
          </a>
        </p>
      </div>

      {DEVICE_FIELDS.map((field) => {
        const { value, own, everyone } = draft.orgValue('devices', field.key);
        return (
          <SettingItem key={field.key} label={field.label} description={`${field.description} ${ENFORCED[field.enforced]}`}>
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <ToggleSwitch checked={value} onChange={(v) => draft.setOrgValue('devices', field.key, v)} testId={`org-devices-${field.key}`} />
              <InheritNote draft={draft} own={own} everyone={onOff(everyone)} onReset={() => draft.clearOrgValue('devices', field.key)} />
            </div>
          </SettingItem>
        );
      })}

      <p className="pt-2 text-xs text-muted-foreground">
        With several accounts signed in, each message follows its own account&apos;s settings. What isn&apos;t about one
        message (the install prompt, Ctrl+P, the Files app) follows the strictest account. Lite has no push and no office
        editor, so there everything is checked in the browser.
      </p>
    </SettingsSection>
  );
}
