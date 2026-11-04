"use client";

import { useTranslations } from 'next-intl';
import { useSettingsStore, type AttachmentPosition } from '@/stores/settings-store';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { DownloadsSettings } from './downloads-settings';
import { PrivacyLinkRow } from './privacy-settings';
import { ChevronRight } from '@/components/icons';
import { usePolicyStore } from '@/stores/policy-store';
import { useReturnToListAfterAction } from '@/hooks/use-return-to-list';

/**
 * The Reading page: the open message. Opening it, how its body is drawn,
 * attachments, and (Advanced) how downloads are named, the former Downloads
 * tab. Remote images and trusted senders are on Privacy, with a link here;
 * list, delete and swipe rows live on the Message list page.
 */
export function ReadingSettings() {
  const t = useTranslations('settings.email_behavior');
  const tPage = useTranslations('settings.reading_page');
  const tPane = useTranslations('conversation_pane');
  // As it applies in this layout: left alone, it follows the layout.
  const returnToList = useReturnToListAfterAction();
  const { isSettingLocked, isSettingHidden } = usePolicyStore();

  const {
    markAsReadDelay,
    mailAttachmentAction,
    attachmentPosition,
    hideInlineImageAttachments,
    attachmentImagePreviewsEnabled,
    messageSpacing,
    emailAlwaysLightMode,
    updateSetting,
  } = useSettingsStore();

  return (
    <div className="space-y-8">
      <SettingsSection id="opening" title={tPage('title')} description={tPage('description')}>
        {!isSettingHidden('markAsReadDelay') && (
        <SettingItem label={t('mark_read.label')} description={t('mark_read.description')} locked={isSettingLocked('markAsReadDelay')}>
          <Select
            value={markAsReadDelay.toString()}
            onChange={(value) => updateSetting('markAsReadDelay', parseInt(value))}
            options={[
              { value: '0', label: t('mark_read.instant') },
              { value: '3000', label: t('mark_read.delay_3s') },
              { value: '5000', label: t('mark_read.delay_5s') },
              { value: '-1', label: t('mark_read.never') },
            ]}
          />
        </SettingItem>
        )}

        <SettingItem
          label={t('return_to_list_after_action.label')}
          description={returnToList.followsLayout
            ? `${t('return_to_list_after_action.description')} ${tPane('return_to_list_follows_layout')}`
            : t('return_to_list_after_action.description')}
        >
          <ToggleSwitch
            checked={returnToList.checked}
            onChange={(checked) => updateSetting('returnToListAfterAction', checked)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="display" title={tPage('sections.display')}>
        {!isSettingHidden('messageSpacing') && (
        <SettingItem label={t('message_spacing.label')} description={t('message_spacing.description')} locked={isSettingLocked('messageSpacing')}>
          <Select
            value={messageSpacing}
            onChange={(value) => updateSetting('messageSpacing', value as typeof messageSpacing)}
            options={[
              { value: 'auto', label: t('message_spacing.auto') },
              { value: 'always', label: t('message_spacing.always') },
              { value: 'edge', label: t('message_spacing.edge') },
            ]}
          />
        </SettingItem>
        )}

        {/* The plain text font is part of the font settings on Accessibility. */}
        <SettingItem label={tPage('plain_text_font_link.label')} description={tPage('plain_text_font_link.description')}>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: { tab: 'accessibility', section: 'text' } }))}
            className="flex items-center gap-2 px-3 py-1.5 bg-muted hover:bg-accent rounded-md transition-colors"
          >
            <span className="text-sm text-foreground">{tPage('plain_text_font_link.button')}</span>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </SettingItem>

        <SettingItem label={t('always_light_mode.label')} description={t('always_light_mode.description')}>
          <ToggleSwitch
            checked={emailAlwaysLightMode}
            onChange={(checked) => updateSetting('emailAlwaysLightMode', checked)}
          />
        </SettingItem>

        <PrivacyLinkRow topic="images" />
      </SettingsSection>

      <SettingsSection id="attachments" title={tPage('sections.attachments')}>
        <SettingItem label={t('attachment_position.label')} description={t('attachment_position.description')}>
          <Select
            value={attachmentPosition === 'below-message' ? 'below-message' : 'below-header'}
            onChange={(value) => updateSetting('attachmentPosition', value as AttachmentPosition)}
            options={[
              { value: 'below-header', label: t('attachment_position.below-header') },
              { value: 'below-message', label: t('attachment_position.below-message') },
            ]}
          />
        </SettingItem>

        <SettingItem label={t('attachment_click_action.label')} description={t('attachment_click_action.description')}>
          <Select
            value={mailAttachmentAction}
            onChange={(value) => updateSetting('mailAttachmentAction', value as 'preview' | 'download')}
            options={[
              { value: 'preview', label: t('attachment_click_action.preview') },
              { value: 'download', label: t('attachment_click_action.download') },
            ]}
          />
        </SettingItem>

        <SettingItem label={t('attachment_image_previews.label')} description={t('attachment_image_previews.description')}>
          <ToggleSwitch
            checked={attachmentImagePreviewsEnabled}
            onChange={(checked) => updateSetting('attachmentImagePreviewsEnabled', checked)}
          />
        </SettingItem>

        <SettingItem label={t('hide_inline_image_attachments.label')} description={t('hide_inline_image_attachments.description')}>
          <ToggleSwitch
            checked={hideInlineImageAttachments}
            onChange={(checked) => updateSetting('hideInlineImageAttachments', checked)}
          />
        </SettingItem>
      </SettingsSection>

      <DownloadsSettings />
    </div>
  );
}
