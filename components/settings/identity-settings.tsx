'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { SettingsSection, SettingItem, Select } from './settings-section';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { SignatureDetailsSection } from './signature-details-section';
import { useIdentityStore } from '@/stores/identity-store';
import { useSettingsStore } from '@/stores/settings-store';
import {
  SUPPORTED_SUB_ADDRESS_DELIMITERS,
  isSupportedSubAddressDelimiter,
  isValidSubAddressDelimiter,
} from '@/lib/sub-addressing';

const CUSTOM_DELIMITER_SENTINEL = '__custom__';
const DEFAULT_CUSTOM_DELIMITER = '~';

/**
 * The Account page's "Email addresses" section: the identities you send
 * from (each with its name and signature), sub-addressing and, with
 * Advanced on, the delimiter the server uses for it. Was its own
 * Identities tab, with the delimiter over on Composing.
 */
export function EmailAddressesSection() {
  const t = useTranslations('settings.identities');
  const tAccount = useTranslations('settings.account');
  const tEmail = useTranslations('settings.email_behavior');
  const tAddr = useTranslations('uxs2_ident.addresses');
  const { identities } = useIdentityStore();
  const { subAddressDelimiter, updateSetting } = useSettingsStore();
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      {/* The section says what the addresses are; the row under it doesn't
          say it again (settings-p2-18). No "identity": a developer word. */}
      <SettingsSection id="addresses" title={tAccount('sections.addresses')} description={tAddr('description')}>
        <SettingItem label={tAddr('label')}>
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">
              {tAddr('count', { count: identities.length })}
            </span>
            <Button onClick={() => setShowModal(true)} size="sm">
              {tAddr('manage')}
            </Button>
          </div>
        </SettingItem>

        {/* Sub-Addressing Info: the description says it all. Its "Learn
            more" opened the identity manager, which says nothing about it. */}
        <SettingItem
          label={t('sub_addressing.label')}
          description={t('sub_addressing.description')}
          term="sub_addressing"
        >
          {null}
        </SettingItem>

        <SettingItem
          nested
          advanced
          label={tEmail('sub_address_delimiter.label')}
          description={tEmail('sub_address_delimiter.description', { delimiter: subAddressDelimiter })}
        >
          <div className="flex flex-col items-end gap-2">
            <Select
              value={isSupportedSubAddressDelimiter(subAddressDelimiter) ? subAddressDelimiter : CUSTOM_DELIMITER_SENTINEL}
              onChange={(value) => {
                if (value === CUSTOM_DELIMITER_SENTINEL) {
                  if (isSupportedSubAddressDelimiter(subAddressDelimiter)) {
                    updateSetting('subAddressDelimiter', DEFAULT_CUSTOM_DELIMITER);
                  }
                } else {
                  updateSetting('subAddressDelimiter', value);
                }
              }}
              options={[
                ...SUPPORTED_SUB_ADDRESS_DELIMITERS.map((delim) => ({
                  value: delim,
                  label: tEmail('sub_address_delimiter.option', { delimiter: delim }),
                })),
                { value: CUSTOM_DELIMITER_SENTINEL, label: tEmail('sub_address_delimiter.custom') },
              ]}
            />
            {!isSupportedSubAddressDelimiter(subAddressDelimiter) && (
              <input
                type="text"
                maxLength={1}
                value={subAddressDelimiter}
                onChange={(e) => {
                  const next = e.target.value.slice(0, 1);
                  if (next && isValidSubAddressDelimiter(next)) {
                    updateSetting('subAddressDelimiter', next);
                  }
                }}
                aria-label={tEmail('sub_address_delimiter.custom_input_label')}
                placeholder={DEFAULT_CUSTOM_DELIMITER}
                className="w-16 px-2 py-1 text-sm font-mono text-center bg-background border border-border rounded-md focus:outline-hidden"
              />
            )}
          </div>
        </SettingItem>
      </SettingsSection>

      {/* The details the organisation signature asks for, if it asks. */}
      <SignatureDetailsSection />

      {/* Identity Manager Modal */}
      <IdentityManagerModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
      />
    </>
  );
}
