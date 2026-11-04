"use client";

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useContactStore } from '@/stores/contact-store';
import { useAuthStore } from '@/stores/auth-store';
import { useFaviconRefreshStore } from '@/stores/favicon-refresh-store';
import { toast } from '@/stores/toast-store';
import { useNoThirdPartyTraffic, useRemoteContentBlockedByOrg } from '@/hooks/use-third-party-mode';
import { IS_LITE } from '@/lib/lite';
import { TrustedSendersModal } from '@/components/trusted-senders-modal';
import { Button } from '@/components/ui/button';
import { ChevronRight, RefreshCw } from '@/components/icons';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { DesktopTelemetrySettings } from './desktop-telemetry-settings';

/** Opens another settings page (and section) the way deep links do. */
export function goToSettings(tab: string, section?: string) {
  window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: section ? { tab, section } : tab }));
}

/**
 * A row that only points to the page holding a setting now, so people who
 * look for it in the old place still find it (one setting, one place).
 */
export function SettingsLinkRow({ label, description, button, onClick }: { label: string; description: string; button: string; onClick: () => void }) {
  return (
    <SettingItem label={label} description={description}>
      <Button variant="outline" size="sm" onClick={onClick}>
        {button}
        <ChevronRight className="w-4 h-4 ms-1 rtl:rotate-180" />
      </Button>
    </SettingItem>
  );
}

/** The link to Privacy on the pages these settings came from. */
export function PrivacyLinkRow({ topic }: { topic: 'images' | 'receipts' | 'senders' }) {
  const t = useTranslations('uxs_structure.privacy_links');
  return (
    <SettingsLinkRow
      label={t(`${topic}_label`)}
      description={t('description')}
      button={t('button')}
      onClick={() => goToSettings('privacy', topic)}
    />
  );
}

/** Remote images and trusted senders (the former Content & Senders tab, then a section of Reading). */
function RemoteContentSection() {
  // No third-party traffic (#903), or the organisation locked "block":
  // remote content never loads, so the setting shows as the organisation's,
  // set to block, and trusting senders has no effect.
  const remoteBlockedByOrg = useRemoteContentBlockedByOrg();
  const tLock = useTranslations('remote_content_lock');
  const t = useTranslations('settings.email_behavior');
  const tPage = useTranslations('settings.reading_page');
  const [showTrustedModal, setShowTrustedModal] = useState(false);
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();
  const { externalContentPolicy, trustedSenders, trustedSendersAddressBook, updateSetting } = useSettingsStore();
  const { trustedSenderEmails, trustedSendersLoaded, loadTrustedSendersBook } = useContactStore();
  const client = useAuthStore((state) => state.client);

  // Load the address book so the count reflects the synced senders, not 0.
  useEffect(() => {
    if (trustedSendersAddressBook && client && !trustedSendersLoaded) {
      loadTrustedSendersBook(client);
    }
  }, [trustedSendersAddressBook, client, trustedSendersLoaded, loadTrustedSendersBook]);

  const trustedCount = () => {
    const count = trustedSendersAddressBook ? trustedSenderEmails.length : trustedSenders.length;
    if (count === 0) return t('trusted_senders.count_zero');
    if (count === 1) return t('trusted_senders.count_one');
    return t('trusted_senders.count_other', { count });
  };

  return (
    <SettingsSection id="images" title={tPage('sections.images')} description={tPage('sections.images_description')}>
      {isFeatureEnabled('externalContentEnabled') && !isSettingHidden('externalContentPolicy') && (
        <SettingItem label={t('external_content.label')} description={t('external_content.description')} locked={isSettingLocked('externalContentPolicy') || remoteBlockedByOrg}>
          <Select
            value={remoteBlockedByOrg ? 'block' : externalContentPolicy}
            onChange={(value) => updateSetting('externalContentPolicy', value as 'ask' | 'block' | 'allow')}
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
          <span className="text-sm text-foreground">{trustedCount()}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground rtl:rotate-180" />
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
  );
}

/** Asking for read receipts and answering them (a section of Composing before). */
function ReadReceiptsSection() {
  const t = useTranslations('settings.email_behavior');
  const tPage = useTranslations('settings.composing_page');
  const { requestReadReceiptDefault, readReceiptResponse, updateSetting } = useSettingsStore();
  return (
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
  );
}

/**
 * Sender pictures fetched from senders' websites (a section of Message list
 * before). They come from the /api/favicon proxy, absent in the static Lite
 * build, and from an outside service, so not in the no-third-party mode (#903).
 */
function SenderPicturesSection() {
  const tPage = useTranslations('settings.message_list');
  const tAdvanced = useTranslations('settings.advanced');
  const faviconsAllowed = !useNoThirdPartyTraffic();
  const refreshFavicons = useFaviconRefreshStore((s) => s.refresh);
  const { senderFavicons, showAvatarsInJunk, updateSetting } = useSettingsStore();
  return (
    <SettingsSection id="senders" title={tPage('sections.senders')}>
      {!IS_LITE && faviconsAllowed && (
        <SettingItem label={tAdvanced('sender_favicons.label')} description={tAdvanced('sender_favicons.description')}>
          <ToggleSwitch checked={senderFavicons} onChange={(checked) => updateSetting('senderFavicons', checked)} />
        </SettingItem>
      )}

      {!IS_LITE && faviconsAllowed && senderFavicons && (
        <SettingItem nested label={tAdvanced('sender_favicons.refresh_label')} description={tAdvanced('sender_favicons.refresh_description')}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { refreshFavicons(); toast.success(tAdvanced('sender_favicons.refresh_done')); }}
            className="text-xs h-7"
          >
            <RefreshCw className="w-3.5 h-3.5 me-1" />
            {tAdvanced('sender_favicons.refresh_button')}
          </Button>
        </SettingItem>
      )}

      <SettingItem label={tAdvanced('show_avatars_in_junk.label')} description={tAdvanced('show_avatars_in_junk.description')} advanced>
        <ToggleSwitch checked={showAvatarsInJunk} onChange={(checked) => updateSetting('showAvatarsInJunk', checked)} />
      </SettingItem>
    </SettingsSection>
  );
}

/**
 * Settings > Privacy: what tells others about you or fetches from outside.
 * Remote content and trusted senders, read receipts, sender pictures from
 * the web, and in the desktop app usage info and crash reports. Background
 * notifications through the push relay stay on Notifications, with a link.
 */
export function PrivacySettings() {
  const t = useTranslations('uxs_structure.privacy');
  return (
    <div className="space-y-8">
      <RemoteContentSection />
      <ReadReceiptsSection />
      <SenderPicturesSection />
      <DesktopTelemetrySettings />
      <SettingsSection id="push" title={t('push_title')}>
        <SettingsLinkRow
          label={t('push_link.label')}
          description={t('push_link.description')}
          button={t('push_link.button')}
          onClick={() => goToSettings('notifications', 'push')}
        />
      </SettingsSection>
    </div>
  );
}
