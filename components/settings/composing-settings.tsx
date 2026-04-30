"use client";

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useConfig } from '@/hooks/use-config';
import { useSettingsStore } from '@/stores/settings-store';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { Mail, X } from 'lucide-react';
import {
  SUPPORTED_SUB_ADDRESS_DELIMITERS,
  type SubAddressDelimiter,
} from '@/lib/sub-addressing';

export function ComposingSettings() {
  const t = useTranslations('settings.email_behavior');
  const { appName } = useConfig();
  const [defaultMailStatus, setDefaultMailStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [newKeyword, setNewKeyword] = useState('');

  const {
    autoSelectReplyIdentity,
    attachmentReminderEnabled,
    attachmentReminderKeywords,
    subAddressDelimiter,
    updateSetting,
  } = useSettingsStore();

  const handleSetDefaultMailProgram = useCallback(() => {
    try {
      if (typeof navigator !== 'undefined' && navigator.registerProtocolHandler) {
        navigator.registerProtocolHandler('mailto', `${window.location.origin}/compose?mailto=%s`);
        setDefaultMailStatus('success');
      }
    } catch {
      setDefaultMailStatus('error');
    }
  }, []);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <SettingItem label={t('auto_select_reply_identity.label')} description={t('auto_select_reply_identity.description')}>
        <ToggleSwitch
          checked={autoSelectReplyIdentity}
          onChange={(checked) => updateSetting('autoSelectReplyIdentity', checked)}
        />
      </SettingItem>

      <SettingItem
        label={t('sub_address_delimiter.label')}
        description={t('sub_address_delimiter.description', { delimiter: subAddressDelimiter })}
      >
        <Select
          value={subAddressDelimiter}
          onChange={(value) => updateSetting('subAddressDelimiter', value as SubAddressDelimiter)}
          options={SUPPORTED_SUB_ADDRESS_DELIMITERS.map((delim) => ({
            value: delim,
            label: t('sub_address_delimiter.option', { delimiter: delim }),
          }))}
        />
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

      <SettingItem label={t('default_mail_program.label')} description={t('default_mail_program.description', { appName: appName || 'Bulwark' })}>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={handleSetDefaultMailProgram}
            className="flex items-center gap-2 px-3 py-1.5 bg-muted hover:bg-accent rounded-md transition-colors"
          >
            <Mail className="w-4 h-4" />
            <span className="text-sm text-foreground">{t('default_mail_program.button')}</span>
          </button>
          {defaultMailStatus === 'success' && (
            <p className="text-xs text-green-600 dark:text-green-400">{t('default_mail_program.success')}</p>
          )}
          {defaultMailStatus === 'error' && (
            <p className="text-xs text-destructive">{t('default_mail_program.error')}</p>
          )}
        </div>
      </SettingItem>
    </SettingsSection>
  );
}
