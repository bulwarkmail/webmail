'use client';

import { useEffect, useId, useState } from 'react';
import { Info } from '@/components/icons';
import { SettingItem, SettingsSection } from '@/components/settings/settings-section';
import { isPhishingReportAddress, type PhishingReportFormat } from '@/lib/admin/organisation-policy';
import { cn } from '@/lib/utils';
import { InheritNote } from '../org-page';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

const DOCS_URL = 'https://bulwarkmail.org/docs/guides/organisation/phishing-reports';

const FORMATS: Array<{ value: PhishingReportFormat; label: string; description: string }> = [
  {
    value: 'forward',
    label: 'Forward as an attachment',
    description: 'The message goes out whole as an .eml attachment, with the subject "Phishing: <subject>". Security mailboxes, ticket systems and Microsoft Defender read this.',
  },
  {
    value: 'arf',
    label: 'Abuse report (ARF)',
    description: 'A machine-readable report (RFC 5965, Feedback-Type: fraud) with the message attached. For abuse desks and tools that parse feedback reports.',
  },
];

const inputClass =
  'h-9 w-full rounded-md border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground ' +
  'focus-visible:outline-hidden focus-visible:border-ring sm:w-72';

/**
 * Organisation > Security > Phishing reports (enterprise pack item 2):
 * where "Report phishing" sends a message and in which format
 * (policy.json `organisation.phishingReport`). Users see the action only
 * while an address is set.
 */
export function PhishingReportSection({ draft }: { draft: OrgPolicyDraft }) {
  const address = draft.orgValue('phishingReport', 'address');
  const format = draft.orgValue('phishingReport', 'format');
  const id = useId();

  // Typed freely, stored only once it is an address (or empty, which turns
  // the action off): the policy never holds half an address.
  const [text, setText] = useState(address.value);
  useEffect(() => { setText(address.value); }, [address.value]);
  const trimmed = text.trim().toLowerCase();
  const invalid = trimmed !== '' && !isPhishingReportAddress(trimmed);
  const postmaster = /^postmaster@/i.test(trimmed);
  const onText = (value: string) => {
    setText(value);
    const next = value.trim().toLowerCase();
    if (next !== '' && !isPhishingReportAddress(next)) return;
    if (next !== address.value || !address.own) draft.setOrgValue('phishingReport', 'address', next);
  };

  return (
    <SettingsSection
      id="phishing"
      title="Phishing reports"
      description="Adds “Report phishing” to the message menus. Bulwark sends the message to the address below, one report per message, without a copy in Sent, and moves it to Junk. Users confirm each report."
    >
      <SettingItem
        label="Send reports to"
        description="An address of your security team or ticket system. Empty turns reporting off."
      >
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <input
            id={`${id}-address`}
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="security@example.com"
            value={text}
            onChange={(e) => onText(e.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? `${id}-error` : undefined}
            data-testid="org-phishing-address"
            className={cn(inputClass, invalid ? 'border-red-500' : 'border-input')}
          />
          {invalid && (
            <p id={`${id}-error`} className="text-xs text-red-600 dark:text-red-400" role="alert">
              This isn&apos;t an email address. The saved address stays until you enter a valid one.
            </p>
          )}
          {postmaster && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="org-phishing-postmaster">
              Don&apos;t use postmaster@: Stalwart analyses mail to it as reports.
            </p>
          )}
          <InheritNote
            draft={draft}
            own={address.own}
            everyone={address.everyone || 'off'}
            onReset={() => draft.clearOrgValue('phishingReport', 'address')}
          />
        </div>
      </SettingItem>

      <SettingItem label="Report format" description="What the report looks like when it arrives.">
        <div className="flex w-full flex-col gap-2 sm:w-80" role="radiogroup" aria-label="Report format">
          {FORMATS.map((option) => (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm',
                format.value === option.value ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <input
                type="radio"
                name={`${id}-format`}
                value={option.value}
                checked={format.value === option.value}
                onChange={() => draft.setOrgValue('phishingReport', 'format', option.value)}
                className="mt-0.5"
                data-testid={`org-phishing-format-${option.value}`}
              />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </span>
            </label>
          ))}
          <InheritNote
            draft={draft}
            own={format.own}
            everyone={FORMATS.find((f) => f.value === format.everyone)?.label ?? format.everyone}
            onReset={() => draft.clearOrgValue('phishingReport', 'format')}
          />
        </div>
      </SettingItem>

      <div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p>
          Reports go out without the organisation signature, disclaimer, label or plugin checks. A reported message
          shows a banner and its links are turned off.{' '}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
            How reporting works
          </a>
        </p>
      </div>
    </SettingsSection>
  );
}
