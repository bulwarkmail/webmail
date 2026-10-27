"use client";

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import type { MentionAddsRecipientTo, ReplyIdentityMatch, SendDelaySeconds } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { TemplateSettings } from './template-settings';
import { Button } from '@/components/ui/button';
import { X, ChevronRight } from '@/components/icons';

/**
 * The Composing page: the editor, replying, what happens before a send,
 * read receipts, templates (their own tab before) and a pointer to where
 * signatures live, since people look for them here.
 */
export function ComposingSettings() {
  const t = useTranslations('settings.email_behavior');
  const tPage = useTranslations('settings.composing_page');
  const templatesEnabled = usePolicyStore((s) => s.isFeatureEnabled('templatesEnabled'));
  const [newKeyword, setNewKeyword] = useState('');

  const {
    quickReplyEnabled,
    autoSelectReplyIdentity,
    replyIdentityMatch,
    plainTextMode,
    rtlEditingSupport,
    attachmentReminderEnabled,
    attachmentReminderKeywords,
    emptySubjectWarningEnabled,
    recipientMentionsEnabled,
    mentionAddsRecipientTo,
    sendDelaySeconds,
    signaturePosition,
    signatureSeparatorEnabled,
    requestReadReceiptDefault,
    readReceiptResponse,
    updateSetting,
  } = useSettingsStore();
  const { client } = useAuthStore();
  const delayedSendSupported = client?.hasDelayedSend() ?? false;
  // Catch-all matching only rewrites From, which the admin can switch off.
  const customFromEnabled = usePolicyStore((s) => s.isFeatureEnabled('customFromEnabled'));

  return (
    <div className="space-y-8">
      <SettingsSection id="editor" title={tPage('title')} description={tPage('description')}>
        <SettingItem label={t('plain_text_mode.label')} description={t('plain_text_mode.description')}>
          <ToggleSwitch
            checked={plainTextMode}
            onChange={(checked) => updateSetting('plainTextMode', checked)}
          />
        </SettingItem>

        <SettingItem label={t('recipient_mentions.label')} description={t('recipient_mentions.description')}>
          <ToggleSwitch
            checked={recipientMentionsEnabled}
            onChange={(checked) => updateSetting('recipientMentionsEnabled', checked)}
          />
        </SettingItem>

        {recipientMentionsEnabled && (
          <SettingItem nested label={t('mention_adds_recipient.label')} description={t('mention_adds_recipient.description')}>
            <Select
              value={mentionAddsRecipientTo}
              onChange={(value) => updateSetting('mentionAddsRecipientTo', value as MentionAddsRecipientTo)}
              options={[
                { value: 'to', label: t('mention_adds_recipient.to') },
                { value: 'cc', label: t('mention_adds_recipient.cc') },
                { value: 'off', label: t('mention_adds_recipient.off') },
              ]}
            />
          </SettingItem>
        )}

        <SettingItem advanced label={t('rtl_editing.label')} description={t('rtl_editing.description')}>
          <ToggleSwitch
            checked={rtlEditingSupport}
            onChange={(checked) => updateSetting('rtlEditingSupport', checked)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="replying" title={tPage('sections.replying')}>
        <SettingItem label={t('quick_reply.label')} description={t('quick_reply.description')}>
          <ToggleSwitch
            checked={quickReplyEnabled}
            onChange={(checked) => updateSetting('quickReplyEnabled', checked)}
          />
        </SettingItem>

        <SettingItem label={t('auto_select_reply_identity.label')} description={t('auto_select_reply_identity.description')}>
          <ToggleSwitch
            checked={autoSelectReplyIdentity}
            onChange={(checked) => updateSetting('autoSelectReplyIdentity', checked)}
          />
        </SettingItem>

        {autoSelectReplyIdentity && customFromEnabled && (
          <SettingItem nested label={t('reply_identity_match.label')} description={t('reply_identity_match.description')}>
            <Select
              value={replyIdentityMatch}
              onChange={(value) => updateSetting('replyIdentityMatch', value as ReplyIdentityMatch)}
              options={[
                { value: 'exact', label: t('reply_identity_match.exact') },
                { value: 'domain', label: t('reply_identity_match.domain') },
              ]}
            />
          </SettingItem>
        )}

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

        <SettingItem advanced label={t('signature_separator.label')} description={t('signature_separator.description')}>
          <ToggleSwitch
            checked={signatureSeparatorEnabled}
            onChange={(checked) => updateSetting('signatureSeparatorEnabled', checked)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="sending" title={tPage('sections.sending')}>
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

        <SettingItem label={t('empty_subject_warning.label')} description={t('empty_subject_warning.description')}>
          <ToggleSwitch
            checked={emptySubjectWarningEnabled}
            onChange={(checked) => updateSetting('emptySubjectWarningEnabled', checked)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="receipts" title={tPage('sections.receipts')}>
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
      </SettingsSection>

      {templatesEnabled && <TemplateSettings />}

      <SettingsSection id="signatures" title={t('signatures_link.label')}>
        <SettingItem label={t('signatures_link.label')} description={t('signatures_link.description')}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: { tab: 'account', section: 'addresses' } }))}
          >
            {t('signatures_link.button')}
            <ChevronRight className="w-4 h-4 ms-1" />
          </Button>
        </SettingItem>
      </SettingsSection>
    </div>
  );
}
