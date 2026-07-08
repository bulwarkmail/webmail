"use client";

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import type { SendDelaySeconds } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { X } from 'lucide-react';
import {
  SUPPORTED_SUB_ADDRESS_DELIMITERS,
  isSupportedSubAddressDelimiter,
  isValidSubAddressDelimiter,
} from '@/lib/sub-addressing';

const CUSTOM_DELIMITER_SENTINEL = '__custom__';
const DEFAULT_CUSTOM_DELIMITER = '~';

export function ComposingSettings() {
  const t = useTranslations('settings.email_behavior');
  const [newKeyword, setNewKeyword] = useState('');

  const {
    autoSelectReplyIdentity,
    plainTextMode,
    rtlEditingSupport,
    attachmentReminderEnabled,
    attachmentReminderKeywords,
    sendDelaySeconds,
    subAddressDelimiter,
    signaturePosition,
    signatureSeparatorEnabled,
    requestReadReceiptDefault,
    readReceiptResponse,
    updateSetting,
  } = useSettingsStore();
  const { client } = useAuthStore();
  const delayedSendSupported = client?.hasDelayedSend() ?? false;

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <SettingItem label={t('auto_select_reply_identity.label')} description={t('auto_select_reply_identity.description')}>
        <ToggleSwitch
          checked={autoSelectReplyIdentity}
          onChange={(checked) => updateSetting('autoSelectReplyIdentity', checked)}
        />
      </SettingItem>

      <SettingItem label={t('plain_text_mode.label')} description={t('plain_text_mode.description')}>
        <ToggleSwitch
          checked={plainTextMode}
          onChange={(checked) => updateSetting('plainTextMode', checked)}
        />
      </SettingItem>

      <SettingItem label={t('rtl_editing.label')} description={t('rtl_editing.description')}>
        <ToggleSwitch
          checked={rtlEditingSupport}
          onChange={(checked) => updateSetting('rtlEditingSupport', checked)}
        />
      </SettingItem>

      <SettingItem label={t('send_delay.label')} description={t('send_delay.description')}>
        <div className="flex flex-col items-end gap-1">
          <Select
            value={String(sendDelaySeconds)}
            onChange={(value) => updateSetting('sendDelaySeconds', Number(value) as SendDelaySeconds)}
            options={[
              { value: '0', label: t('send_delay.off') },
              { value: '10', label: t('send_delay.seconds', { seconds: 10 }) },
              { value: '30', label: t('send_delay.seconds', { seconds: 30 }) },
              { value: '60', label: t('send_delay.seconds', { seconds: 60 }) },
            ]}
          />
          {sendDelaySeconds > 0 && !delayedSendSupported && (
            <p className="max-w-64 text-end text-xs text-amber-600 dark:text-amber-400">{t('send_delay.unsupported')}</p>
          )}
        </div>
      </SettingItem>

      <SettingItem label={t('signature_position.label')} description={t('signature_position.description')}>
        <Select
          value={signaturePosition}
          onChange={(value) => updateSetting('signaturePosition', value as 'above_quote' | 'below_quote')}
          options={[
            { value: 'above_quote', label: t('signature_position.above_quote') },
            { value: 'below_quote', label: t('signature_position.below_quote') },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('signature_separator.label')} description={t('signature_separator.description')}>
        <ToggleSwitch
          checked={signatureSeparatorEnabled}
          onChange={(checked) => updateSetting('signatureSeparatorEnabled', checked)}
        />
      </SettingItem>

      <SettingItem label={t('request_read_receipt.label')} description={t('request_read_receipt.description')}>
        <ToggleSwitch
          checked={requestReadReceiptDefault}
          onChange={(checked) => updateSetting('requestReadReceiptDefault', checked)}
        />
      </SettingItem>

      <SettingItem label={t('read_receipt_response.label')} description={t('read_receipt_response.description')}>
        <Select
          value={readReceiptResponse}
          onChange={(value) => updateSetting('readReceiptResponse', value as 'ask' | 'always' | 'never')}
          options={[
            { value: 'ask', label: t('read_receipt_response.ask') },
            { value: 'always', label: t('read_receipt_response.always') },
            { value: 'never', label: t('read_receipt_response.never') },
          ]}
        />
      </SettingItem>

      <SettingItem
        label={t('sub_address_delimiter.label')}
        description={t('sub_address_delimiter.description', { delimiter: subAddressDelimiter })}
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
                label: t('sub_address_delimiter.option', { delimiter: delim }),
              })),
              { value: CUSTOM_DELIMITER_SENTINEL, label: t('sub_address_delimiter.custom') },
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
              aria-label={t('sub_address_delimiter.custom_input_label')}
              placeholder={DEFAULT_CUSTOM_DELIMITER}
              className="w-16 px-2 py-1 text-sm font-mono text-center bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </div>
      </SettingItem>

      <SettingItem label={t('attachment_reminder.label')} description={t('attachment_reminder.description')}>
        <ToggleSwitch
          checked={attachmentReminderEnabled}
          onChange={(checked) => updateSetting('attachmentReminderEnabled', checked)}
        />
      </SettingItem>
      {attachmentReminderEnabled && (
        <div className="py-3 border-b border-border space-y-2">
          <div>
            <label className="text-sm font-medium text-foreground">{t('attachment_reminder.keywords_label')}</label>
            <p className="text-xs text-muted-foreground mt-1">{t('attachment_reminder.keywords_description')}</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {attachmentReminderKeywords.map((kw) => (
              <span key={kw} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-muted text-foreground">
                {kw}
                <button
                  type="button"
                  aria-label={t('attachment_reminder.remove')}
                  onClick={() => updateSetting('attachmentReminderKeywords', attachmentReminderKeywords.filter(k => k !== kw))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = newKeyword.trim().toLowerCase();
              if (trimmed && !attachmentReminderKeywords.includes(trimmed)) {
                updateSetting('attachmentReminderKeywords', [...attachmentReminderKeywords, trimmed]);
              }
              setNewKeyword('');
            }}
          >
            <input
              type="text"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              placeholder={t('attachment_reminder.add_placeholder')}
              className="flex-1 min-w-0 px-2 py-1 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="submit"
              disabled={!newKeyword.trim()}
              className="px-3 py-1 text-sm bg-muted hover:bg-accent rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('attachment_reminder.add')}
            </button>
          </form>
        </div>
      )}
    </SettingsSection>
  );
}
