"use client";

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useConfig } from '@/hooks/use-config';
import { useSettingsStore } from '@/stores/settings-store';
import type { ArchiveMode, HoverAction, MailLayout } from '@/stores/settings-store';
import { ALL_HOVER_ACTIONS } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { cn } from '@/lib/utils';
import { RadioGroup, SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { TrustedSendersModal } from '@/components/trusted-senders-modal';
import { ChevronRight, AlertTriangle, FolderSync, Loader2, Mail, X } from 'lucide-react';
import { usePolicyStore } from '@/stores/policy-store';
import { useContactStore } from '@/stores/contact-store';

const MAIL_LAYOUT_PREVIEW_ROWS = [
  { sender: 'Alice', subject: 'Quarterly roadmap', preview: 'The draft is ready for review.', selected: false },
  { sender: 'Nadia', subject: 'Design sync', preview: 'Pushed updated mocks and notes.', selected: true },
  { sender: 'Billing', subject: 'Invoice 1042', preview: 'Your receipt is attached.', selected: false },
];

function MailLayoutPreview({
  value,
  t,
}: {
  value: MailLayout;
  t: (key: string) => string;
}) {
  const isSplit = value === 'split';

  return (
    <div className="mt-3 rounded-xl border border-border bg-background p-3">
      <div>
        <div className="text-sm font-medium text-foreground">{t(`mail_layout.${value}`)}</div>
        <div className="mt-1 text-xs text-muted-foreground">{t(`mail_layout.${value}_description`)}</div>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-muted/20">
        <div className="flex h-28">
          <div className="w-11 border-r border-border bg-muted/40" />

          {isSplit ? (
            <>
              <div className="w-28 border-r border-border bg-background">
                {MAIL_LAYOUT_PREVIEW_ROWS.map((row) => (
                  <div
                    key={row.subject}
                    className={cn(
                      'border-b border-border px-2 py-1.5 text-[10px] last:border-b-0',
                      row.selected && 'bg-primary/10'
                    )}
                  >
                    <div className="truncate font-medium text-foreground">{row.sender}</div>
                    <div className="truncate text-muted-foreground">{row.subject}</div>
                  </div>
                ))}
              </div>
              <div className="flex-1 bg-background px-3 py-2">
                <div className="h-2.5 w-20 rounded bg-foreground/10" />
                <div className="mt-2 h-2 w-full rounded bg-foreground/10" />
                <div className="mt-1.5 h-2 w-5/6 rounded bg-foreground/10" />
                <div className="mt-1.5 h-2 w-2/3 rounded bg-foreground/10" />
              </div>
            </>
          ) : (
            <div className="flex-1 bg-background px-2 py-2">
              <div className="space-y-1.5">
                {MAIL_LAYOUT_PREVIEW_ROWS.map((row) => (
                  <div
                    key={row.subject}
                    className={cn(
                      'rounded-md px-2 py-1 text-[10px]',
                      row.selected ? 'bg-primary/10' : 'bg-muted/20'
                    )}
                  >
                    <div className="truncate text-foreground">
                      <span className="font-medium">{row.sender}</span>
                      <span className="mx-1.5 text-muted-foreground">{row.subject}</span>
                      <span className="text-muted-foreground/80">{row.preview}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmailSettings() {
  const t = useTranslations('settings.email_behavior');
  const { appName } = useConfig();
  const [showTrustedModal, setShowTrustedModal] = useState(false);
  const [isReorganizing, setIsReorganizing] = useState(false);
  const [reorganizeResult, setReorganizeResult] = useState<string | null>(null);
  const [defaultMailStatus, setDefaultMailStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();

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

  const [newKeyword, setNewKeyword] = useState('');

  const {
    markAsReadDelay,
    deleteAction,
    permanentlyDeleteJunk,
    showPreview,
    mailLayout,
    disableThreading,
    autoSelectReplyIdentity,
    plainTextMode,
    emailsPerPage,
    externalContentPolicy,
    mailAttachmentAction,
    attachmentPosition,
    emailAlwaysLightMode,
    archiveMode,
    hoverActions,
    hoverActionsMode,
    hoverActionsCorner,
    trustedSenders,
    trustedSendersAddressBook,
    attachmentReminderEnabled,
    attachmentReminderKeywords,
    updateSetting,
  } = useSettingsStore();
  const { trustedSenderEmails } = useContactStore();

  // Get count label for trusted senders button
  const getTrustedSendersCount = () => {
    const count = trustedSendersAddressBook ? trustedSenderEmails.length : trustedSenders.length;
    if (count === 0) return t('trusted_senders.count_zero');
    if (count === 1) return t('trusted_senders.count_one');
    return t('trusted_senders.count_other', { count });
  };

  const isFocusedLayout = mailLayout === 'focus';

  const handleReorganizeArchive = async () => {
    const { client } = useAuthStore.getState();
    const { mailboxes, fetchMailboxes } = useEmailStore.getState();
    if (!client) return;

    const archiveMailbox = mailboxes.find(m => m.role === 'archive' || m.name.toLowerCase() === 'archive');
    if (!archiveMailbox) return;

    setIsReorganizing(true);
    setReorganizeResult(null);

    try {
      const archiveId = archiveMailbox.originalId || archiveMailbox.id;

      // Fetch all emails in the root archive mailbox
      const emails = await client.getEmailsInMailbox(archiveId);
      let movedCount = 0;

      for (const email of emails) {
        const emailDate = new Date(email.receivedAt);
        const year = emailDate.getFullYear().toString();
        const month = (emailDate.getMonth() + 1).toString().padStart(2, '0');

        // Re-read mailboxes from store each iteration in case new ones were created
        let currentMailboxes = useEmailStore.getState().mailboxes;

        // Find or create year subfolder
        let yearMailbox = currentMailboxes.find(
          m => m.name === year && m.parentId === archiveId
        );
        if (!yearMailbox) {
          yearMailbox = await client.createMailbox(year, archiveId);
          await fetchMailboxes(client);
          currentMailboxes = useEmailStore.getState().mailboxes;
        }

        if (archiveMode === 'year') {
          await client.moveEmail(email.id, yearMailbox.id);
          movedCount++;
        } else {
          // month mode
          const yearId = yearMailbox.originalId || yearMailbox.id;
          let monthMailbox = currentMailboxes.find(
            m => m.name === month && m.parentId === yearId
          );
          if (!monthMailbox) {
            monthMailbox = await client.createMailbox(month, yearId);
            await fetchMailboxes(client);
          }
          await client.moveEmail(email.id, monthMailbox.id);
          movedCount++;
        }
      }

      setReorganizeResult(t('archive_mode.reorganize_success', { count: movedCount }));
    } catch (error) {
      console.error('Failed to reorganize archive:', error);
      setReorganizeResult(t('archive_mode.reorganize_error'));
    } finally {
      setIsReorganizing(false);
    }
  };

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {/* Mark as Read */}
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

      {/* Delete Action */}
      {!isSettingHidden('deleteAction') && (
      <SettingItem label={t('delete_action.label')} description={t('delete_action.description')} locked={isSettingLocked('deleteAction')}>
        <div className="flex flex-col gap-2">
          <Select
            value={deleteAction}
            onChange={(value) => updateSetting('deleteAction', value as 'trash' | 'permanent')}
            options={[
              { value: 'trash', label: t('delete_action.trash') },
              { value: 'permanent', label: t('delete_action.permanent') },
            ]}
          />
          {deleteAction === 'permanent' && (
            <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{t('delete_action.warning')}</span>
            </div>
          )}
        </div>
      </SettingItem>
      )}

      {/* Archive Mode */}
      <SettingItem label={t('archive_mode.label')} description={t('archive_mode.description')}>
        <div className="flex flex-col gap-2">
          <Select
            value={archiveMode}
            onChange={(value) => updateSetting('archiveMode', value as ArchiveMode)}
            options={[
              { value: 'single', label: t('archive_mode.single') },
              { value: 'year', label: t('archive_mode.year') },
              { value: 'month', label: t('archive_mode.month') },
            ]}
          />
          {archiveMode !== 'single' && (
            <div className="flex flex-col gap-2">
              <button
                onClick={handleReorganizeArchive}
                disabled={isReorganizing}
                className="flex items-center gap-2 px-3 py-1.5 bg-muted hover:bg-accent rounded-md transition-colors text-sm disabled:opacity-50"
              >
                {isReorganizing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FolderSync className="w-4 h-4" />
                )}
                <span>{t('archive_mode.reorganize')}</span>
              </button>
              {reorganizeResult && (
                <p className="text-xs text-muted-foreground">{reorganizeResult}</p>
              )}
            </div>
          )}
        </div>
      </SettingItem>

      {/* Permanently Delete Junk */}
      <SettingItem label={t('permanently_delete_junk.label')} description={t('permanently_delete_junk.description')}>
        <ToggleSwitch
          checked={permanentlyDeleteJunk}
          onChange={(checked) => updateSetting('permanentlyDeleteJunk', checked)}
        />
      </SettingItem>

      {!isSettingHidden('mailLayout') && (
      <SettingItem label={t('mail_layout.label')} description={t('mail_layout.description')} locked={isSettingLocked('mailLayout')}>
        <div className="w-[22rem] max-w-full">
          <RadioGroup
            value={mailLayout}
            onChange={(value) => updateSetting('mailLayout', value as MailLayout)}
            options={[
              { value: 'split', label: t('mail_layout.split') },
              { value: 'focus', label: t('mail_layout.focus') },
            ]}
          />
          <MailLayoutPreview value={mailLayout} t={t} />
        </div>
      </SettingItem>
      )}

      {/* Show Preview */}
      {!isSettingHidden('showPreview') && (
      <SettingItem
        label={t('show_preview.label')}
        description={isFocusedLayout ? t('show_preview.focus_description') : t('show_preview.description')}
        locked={isSettingLocked('showPreview')}
      >
        <ToggleSwitch checked={showPreview} onChange={(checked) => updateSetting('showPreview', checked)} />
      </SettingItem>
      )}

      {/* Disable Thread Grouping */}
      <SettingItem label={t('disable_threading.label')} description={t('disable_threading.description')}>
        <ToggleSwitch
          checked={disableThreading}
          onChange={(checked) => updateSetting('disableThreading', checked)}
        />
      </SettingItem>

      {/* Plain Text Mode */}
      <SettingItem label={t('plain_text_mode.label')} description={t('plain_text_mode.description')}>
        <ToggleSwitch
          checked={plainTextMode}
          onChange={(checked) => updateSetting('plainTextMode', checked)}
        />
      </SettingItem>

      <SettingItem label={t('auto_select_reply_identity.label')} description={t('auto_select_reply_identity.description')}>
        <ToggleSwitch
          checked={autoSelectReplyIdentity}
          onChange={(checked) => updateSetting('autoSelectReplyIdentity', checked)}
        />
      </SettingItem>

      {/* Attachment Reminder */}
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

      {/* Quick Hover Actions */}
      {isFeatureEnabled('hoverActionsConfigEnabled') && (
      <div className="py-3 border-b border-border space-y-3">
        <div>
          <label className="text-sm font-medium text-foreground">{t('hover_actions.label')}</label>
          <p className="text-xs text-muted-foreground mt-1">{t('hover_actions.description')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ALL_HOVER_ACTIONS.map((action) => {
            const isEnabled = hoverActions.includes(action.id);
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => {
                  const newActions = isEnabled
                    ? hoverActions.filter((a: HoverAction) => a !== action.id)
                    : [...hoverActions, action.id];
                  updateSetting('hoverActions', newActions);
                }}
                className={cn(
                  'px-3 py-1.5 text-xs rounded-md transition-colors duration-150',
                  isEnabled
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'bg-muted hover:bg-accent text-foreground'
                )}
              >
                {t(`hover_actions.${action.labelKey}`)}
              </button>
            );
          })}
        </div>

        {/* Hover Actions Display Mode */}
        <div className="pt-2 space-y-2">
          <label className="text-xs font-medium text-foreground">{t('hover_actions.mode_label')}</label>
          <div className="flex gap-2">
            {(['inline', 'floating'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => updateSetting('hoverActionsMode', mode)}
                className={cn(
                  'px-3 py-1.5 text-xs rounded-md transition-colors duration-150',
                  hoverActionsMode === mode
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'bg-muted hover:bg-accent text-foreground'
                )}
              >
                {t(`hover_actions.mode_${mode}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Corner Selection (only when floating) */}
        {hoverActionsMode === 'floating' && (
          <div className="pt-1 space-y-2">
            <label className="text-xs font-medium text-foreground">{t('hover_actions.corner_label')}</label>
            <div className="grid grid-cols-2 gap-2 w-48">
              {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((corner) => (
                <button
                  key={corner}
                  type="button"
                  onClick={() => updateSetting('hoverActionsCorner', corner)}
                  className={cn(
                    'px-2 py-1.5 text-xs rounded-md transition-colors duration-150 text-center',
                    hoverActionsCorner === corner
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-muted hover:bg-accent text-foreground'
                  )}
                >
                  {t(`hover_actions.corner_${corner}`)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      )}

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

      <SettingItem label={t('attachment_position.label')} description={t('attachment_position.description')}>
        <Select
          value={attachmentPosition}
          onChange={(value) => updateSetting('attachmentPosition', value as 'beside-sender' | 'below-header')}
          options={[
            { value: 'beside-sender', label: t('attachment_position.beside-sender') },
            { value: 'below-header', label: t('attachment_position.below-header') },
          ]}
        />
      </SettingItem>

      {/* Emails Per Page */}
      {!isSettingHidden('emailsPerPage') && (
      <SettingItem label={t('emails_per_page.label')} description={t('emails_per_page.description')} locked={isSettingLocked('emailsPerPage')}>
        <Select
          value={emailsPerPage.toString()}
          onChange={(value) => updateSetting('emailsPerPage', parseInt(value))}
          options={[
            { value: '10', label: t('emails_per_page.10') },
            { value: '25', label: t('emails_per_page.25') },
            { value: '50', label: t('emails_per_page.50') },
            { value: '100', label: t('emails_per_page.100') },
          ]}
        />
      </SettingItem>
      )}

      {/* Always Light Mode for Emails */}
      <SettingItem label={t('always_light_mode.label')} description={t('always_light_mode.description')}>
        <ToggleSwitch
          checked={emailAlwaysLightMode}
          onChange={(checked) => updateSetting('emailAlwaysLightMode', checked)}
        />
      </SettingItem>

      {/* External Content */}
      {!isSettingHidden('externalContentPolicy') && (
      <SettingItem label={t('external_content.label')} description={t('external_content.description')} locked={isSettingLocked('externalContentPolicy')}>
        <Select
          value={externalContentPolicy}
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

      {/* Default Mail Program */}
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

      {/* Trusted Senders */}
      <SettingItem label={t('trusted_senders.label')} description={t('trusted_senders.description')}>
        <button
          onClick={() => setShowTrustedModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-muted hover:bg-accent rounded-md transition-colors"
        >
          <span className="text-sm text-foreground">{getTrustedSendersCount()}</span>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </button>
      </SettingItem>

      {/* Trusted Senders — address book storage */}
      <SettingItem label={t('trusted_senders.use_address_book_label')} description={t('trusted_senders.use_address_book_description')}>
        <ToggleSwitch
          checked={trustedSendersAddressBook}
          onChange={(checked) => updateSetting('trustedSendersAddressBook', checked)}
        />
      </SettingItem>

      {/* Trusted Senders Modal */}
      <TrustedSendersModal
        isOpen={showTrustedModal}
        onClose={() => setShowTrustedModal(false)}
      />
    </SettingsSection>
  );
}
