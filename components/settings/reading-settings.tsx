"use client";

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore, type AttachmentPosition } from '@/stores/settings-store';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { DownloadsSettings } from './downloads-settings';
import { TrustedSendersModal } from '@/components/trusted-senders-modal';
import { ChevronRight } from '@/components/icons';
import { usePolicyStore } from '@/stores/policy-store';
import { useContactStore } from '@/stores/contact-store';
import { useAuthStore } from '@/stores/auth-store';
import { useRemoteContentBlockedByOrg } from '@/hooks/use-third-party-mode';

/**
 * The Reading page: the open message. Opening it, how its body is drawn,
 * remote images and trusted senders (the former Content & Senders tab), and
 * attachments, and (Advanced) how downloads are named, the former Downloads
 * tab. List, delete and swipe rows live on the Message list page.
 */
export function ReadingSettings() {
  // No third-party traffic (#903), or the organisation locked "block":
  // remote content never loads, so the setting shows as the organisation's,
  // set to block, and trusting senders has no effect.
  const remoteBlockedByOrg = useRemoteContentBlockedByOrg();
  const tLock = useTranslations('remote_content_lock');
  const t = useTranslations('settings.email_behavior');
  const tPage = useTranslations('settings.reading_page');
  const [showTrustedModal, setShowTrustedModal] = useState(false);
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();

  const {
    markAsReadDelay,
    returnToListAfterAction,
    mailAttachmentAction,
    attachmentPosition,
    hideInlineImageAttachments,
    attachmentImagePreviewsEnabled,
    messageSpacing,
    externalContentPolicy,
    emailAlwaysLightMode,
    trustedSenders,
    trustedSendersAddressBook,
    updateSetting,
  } = useSettingsStore();
  const { trustedSenderEmails, trustedSendersLoaded, loadTrustedSendersBook } = useContactStore();
  const client = useAuthStore((state) => state.client);

  // Load the address book so the count reflects the synced senders, not 0.
  useEffect(() => {
    if (trustedSendersAddressBook && client && !trustedSendersLoaded) {
      loadTrustedSendersBook(client);
    }
  }, [trustedSendersAddressBook, client, trustedSendersLoaded, loadTrustedSendersBook]);

  const getTrustedSendersCount = () => {
    const count = trustedSendersAddressBook ? trustedSenderEmails.length : trustedSenders.length;
    if (count === 0) return t('trusted_senders.count_zero');
    if (count === 1) return t('trusted_senders.count_one');
    return t('trusted_senders.count_other', { count });
  };

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

        <SettingItem label={t('return_to_list_after_action.label')} description={t('return_to_list_after_action.description')}>
          <ToggleSwitch
            checked={returnToListAfterAction}
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
      </SettingsSection>

      <SettingsSection id="images" title={tPage('sections.images')} description={tPage('sections.images_description')}>
        {isFeatureEnabled('externalContentEnabled') && !isSettingHidden('externalContentPolicy') && (
        <SettingItem label={t('external_content.label')} description={t('external_content.description')} locked={isSettingLocked('externalContentPolicy') || remoteBlockedByOrg}>
          <Select
            value={remoteBlockedByOrg ? 'block' : externalContentPolicy}
            onChange={(value) =>
              updateSetting('externalContentPolicy', value as 'ask' | 'block' | 'allow')
            }
            options={[
              { value: 'ask', label: t('external_content.ask') },
              { value: 'block', label: t('external_content.block') },
              { value: 'allow', label: t('external_content.allow') },
            ]}
          />
        </SettingItem>
        )}

        <SettingItem
          label={t('trusted_senders.label')}
          description={remoteBlockedByOrg ? tLock('trusted_senders_note') : t('trusted_senders.description')}
        >
          <button
            onClick={() => setShowTrustedModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-muted hover:bg-accent rounded-md transition-colors"
          >
            <span className="text-sm text-foreground">{getTrustedSendersCount()}</span>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </button>
        </SettingItem>

        <SettingItem nested label={t('trusted_senders.use_address_book_label')} description={t('trusted_senders.use_address_book_description')} locked={remoteBlockedByOrg}>
          <ToggleSwitch
            checked={!!trustedSendersAddressBook}
            onChange={(checked) => updateSetting('trustedSendersAddressBook', checked)}
          />
        </SettingItem>

        <TrustedSendersModal
          isOpen={showTrustedModal}
          onClose={() => setShowTrustedModal(false)}
          readOnly={remoteBlockedByOrg}
        />
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
