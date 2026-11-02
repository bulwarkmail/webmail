"use client";

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { useEffectiveMailLayout } from '@/hooks/use-effective-mail-layout';
import { useMediaQuery } from '@/hooks/use-media-query';
import type { ArchiveMode, HoverAction, MvInboxType, SwipeAction } from '@/stores/settings-store';
import { ALL_HOVER_ACTIONS } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFaviconRefreshStore } from '@/stores/favicon-refresh-store';
import { toast } from '@/stores/toast-store';
import { cn } from '@/lib/utils';
import { IS_LITE } from '@/lib/lite';
import { useNoThirdPartyTraffic } from '@/hooks/use-third-party-mode';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { MessageListOrderSettings } from './message-list-order-settings';
import { Button } from '@/components/ui/button';
import { AlertTriangle, FolderSync, Loader2, RefreshCw } from '@/components/icons';
import { usePolicyStore } from '@/stores/policy-store';
import { allowEmailMove, createMailboxWithHooks, emitEmailMove } from '@/lib/plugin-mail-hooks';
import type { Mailbox } from '@/lib/jmap/types';
import type { SearchDefaultScope } from '@/lib/search-default-scope';

/**
 * The Message list page: what the list shows, who the senders look like,
 * what one hover or swipe does, and what Delete and Archive mean. These
 * rows used to be spread over Reading, Layout and Appearance.
 */
export function MessageListSettings() {
  const t = useTranslations('settings.email_behavior');
  // Sender icons come from an outside service: no setting for them in the mode (#903).
  const faviconsAllowed = !useNoThirdPartyTraffic();
  const tPage = useTranslations('settings.message_list');
  const tAppearance = useTranslations('settings.appearance');
  const tAdvanced = useTranslations('settings.advanced');
  const [isReorganizing, setIsReorganizing] = useState(false);
  const [reorganizeResult, setReorganizeResult] = useState<string | null>(null);
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();
  const archiveActionEnabled = isFeatureEnabled('archiveActionEnabled');
  const refreshFavicons = useFaviconRefreshStore((s) => s.refresh);
  // Swipes exist on touch screens only; a mouse user never sees these rows.
  const touchDevice = useMediaQuery('(pointer: coarse)');
  // With the Archive action off, a stored 'archive' swipe does nothing (the row
  // has no archive handler), so the select shows it as "none".
  const swipeShown = (action: SwipeAction) => (archiveActionEnabled || action !== 'archive' ? action : 'none');
  const swipeOptions = [
    { value: 'none', label: t('swipe_actions.none') },
    ...(archiveActionEnabled ? [{ value: 'archive', label: t('swipe_actions.archive') }] : []),
    { value: 'delete', label: t('swipe_actions.delete') },
    { value: 'markRead', label: t('swipe_actions.mark_read') },
    { value: 'star', label: t('swipe_actions.star') },
    { value: 'spam', label: t('swipe_actions.spam') },
  ];

  const {
    deleteAction,
    permanentlyDeleteJunk,
    confirmBulkDelete,
    swipeRightAction,
    swipeLeftAction,
    clearSearchOnFolderChange,
    searchDefaultScope,
    showPreview,
    showVerificationCodes,
    disableThreading,
    emailsPerPage,
    archiveMode,
    hoverActions,
    hoverActionsMode,
    hoverActionsCorner,
    listColumns,
    mailLayout,
    interfaceLayout,
    mvInboxType,
    tintListRowsByTag,
    senderFavicons,
    showAvatarsInJunk,
    updateSetting,
  } = useSettingsStore();

  const isFocusedLayout = useEffectiveMailLayout() === 'focus';
  const mountainView = interfaceLayout === 'mountain-view';

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
      const emails = await client.getEmailsInMailbox(archiveId);

      // One group per destination ("2024" or "2024/03"): plugins are asked
      // once per folder and move, and can refuse either; the groups they
      // refuse stay where they are.
      const groups = new Map<string, { year: string; month: string; ids: string[] }>();
      for (const email of emails) {
        const emailDate = new Date(email.receivedAt);
        const year = emailDate.getFullYear().toString();
        const month = (emailDate.getMonth() + 1).toString().padStart(2, '0');
        const key = archiveMode === 'year' ? year : `${year}/${month}`;
        const group = groups.get(key) ?? { year, month, ids: [] };
        group.ids.push(email.id);
        groups.set(key, group);
      }

      // An existing folder, or a new one; null when a plugin refused it.
      const folder = async (name: string, parentId: string): Promise<Mailbox | null> => {
        const existing = useEmailStore.getState().mailboxes.find(m => m.name === name && m.parentId === parentId);
        if (existing) return existing;
        const created = await createMailboxWithHooks(client, name, parentId);
        if (created) await fetchMailboxes(client);
        return useEmailStore.getState().mailboxes.find(m => m.name === name && m.parentId === parentId) ?? created;
      };

      let movedCount = 0;
      for (const { year, month, ids } of groups.values()) {
        const yearMailbox = await folder(year, archiveId);
        if (!yearMailbox) continue;
        const destination = archiveMode === 'year'
          ? yearMailbox
          : await folder(month, yearMailbox.originalId || yearMailbox.id);
        if (!destination) continue;

        const known = useEmailStore.getState().mailboxes;
        const move = { emailIds: ids, fromMailboxId: archiveMailbox.id, toMailboxId: destination.id };
        if (!(await allowEmailMove(move, known))) continue;
        await client.batchMoveEmails(ids, destination.originalId || destination.id);
        emitEmailMove(move, known);
        movedCount += ids.length;
      }

      setReorganizeResult(t('archive_mode.reorganize_success', { count: movedCount }));
    } catch (error) {
      console.error('Failed to reorganize archive:', error);
      setReorganizeResult(t('archive_mode.reorganize_error'));
    } finally {
      setIsReorganizing(false);
    }
  };

  const segment = (active: boolean) => cn(
    'px-3 py-1.5 text-xs rounded-md transition-colors duration-150',
    active ? 'bg-primary text-primary-foreground font-medium' : 'bg-muted hover:bg-accent text-foreground'
  );

  return (
    <div className="space-y-8">
      <SettingsSection id="display" title={tPage('title')} description={tPage('description')}>
        {/* Stored as "disable threading"; shown as the positive choice. */}
        <SettingItem label={t('group_conversations.label')} description={t('group_conversations.description')}>
          <ToggleSwitch
            checked={!disableThreading}
            onChange={(checked) => updateSetting('disableThreading', !checked)}
          />
        </SettingItem>

        {!isSettingHidden('showPreview') && (
        <SettingItem
          label={t('show_preview.label')}
          description={isFocusedLayout ? t('show_preview.focus_description') : t('show_preview.description')}
          locked={isSettingLocked('showPreview')}
        >
          <ToggleSwitch checked={showPreview} onChange={(checked) => updateSetting('showPreview', checked)} />
        </SettingItem>
        )}

        {/* Only the layouts with one-line rows can draw them as a table. */}
        {!isSettingHidden('listColumns') && !mountainView && mailLayout !== 'split' && (
        <SettingItem label={t('list_columns.label')} description={t('list_columns.description')} locked={isSettingLocked('listColumns')}>
          <ToggleSwitch
            checked={listColumns}
            onChange={(checked) => updateSetting('listColumns', checked)}
          />
        </SettingItem>
        )}

        {/* Gmail's inbox types; "Unread first" puts the newest unread mail in a section above the rest. */}
        {mountainView && (
        <SettingItem label={t('inbox_type.label')} description={t('inbox_type.description')}>
          <Select
            value={mvInboxType}
            onChange={(value) => {
              updateSetting('mvInboxType', value as MvInboxType);
              const client = useAuthStore.getState().client;
              const store = useEmailStore.getState();
              if (client && store.selectedMailbox) void store.fetchEmails(client, store.selectedMailbox, { background: true });
            }}
            options={[
              { value: 'default', label: t('inbox_type.default') },
              { value: 'unread-first', label: t('inbox_type.unread_first') },
            ]}
          />
        </SettingItem>
        )}

        <MessageListOrderSettings />

        <SettingItem label={tAppearance('tint_list_rows.label')} description={tAppearance('tint_list_rows.description')}>
          <ToggleSwitch
            checked={tintListRowsByTag}
            onChange={(checked) => updateSetting('tintListRowsByTag', checked)}
          />
        </SettingItem>

        <SettingItem label={t('show_verification_codes.label')} description={t('show_verification_codes.description')}>
          <ToggleSwitch
            checked={showVerificationCodes}
            onChange={(checked) => updateSetting('showVerificationCodes', checked)}
          />
        </SettingItem>
      </SettingsSection>

      {/* Sender favicons come from the /api/favicon proxy, absent in the static Lite build (components/ui/avatar.tsx). */}
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

      {(isFeatureEnabled('hoverActionsConfigEnabled') || touchDevice) && (
      <SettingsSection id="actions" title={tPage('sections.actions')}>
        {isFeatureEnabled('hoverActionsConfigEnabled') && (
        <div data-search-label={t('hover_actions.label')} className="py-3 border-b border-border last:border-0 space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground">{t('hover_actions.label')}</label>
            <p className="text-xs text-muted-foreground mt-1">{t('hover_actions.description')}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_HOVER_ACTIONS.filter((action) => archiveActionEnabled || action.id !== 'archive').map((action) => {
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
                  className={segment(isEnabled)}
                >
                  {t(`hover_actions.${action.labelKey}`)}
                </button>
              );
            })}
          </div>

          <div className="pt-2 space-y-2">
            <label className="text-xs font-medium text-foreground">{t('hover_actions.mode_label')}</label>
            <div className="flex gap-2">
              {(['inline', 'floating'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => updateSetting('hoverActionsMode', mode)}
                  className={segment(hoverActionsMode === mode)}
                >
                  {t(`hover_actions.mode_${mode}`)}
                </button>
              ))}
            </div>
          </div>

          {hoverActionsMode === 'floating' && (
            <div className="pt-1 space-y-2">
              <label className="text-xs font-medium text-foreground">{t('hover_actions.corner_label')}</label>
              <div className="grid grid-cols-2 gap-2 w-48">
                {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((corner) => (
                  <button
                    key={corner}
                    type="button"
                    onClick={() => updateSetting('hoverActionsCorner', corner)}
                    className={cn(segment(hoverActionsCorner === corner), 'px-2 text-center')}
                  >
                    {t(`hover_actions.corner_${corner}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        )}

        {touchDevice && (
          <SettingItem label={t('swipe_right_action.label')} description={t('swipe_right_action.description')}>
            <Select
              value={swipeShown(swipeRightAction)}
              onChange={(value) => updateSetting('swipeRightAction', value as typeof swipeRightAction)}
              options={swipeOptions}
            />
          </SettingItem>
        )}

        {touchDevice && (
          <SettingItem label={t('swipe_left_action.label')} description={t('swipe_left_action.description')}>
            <Select
              value={swipeShown(swipeLeftAction)}
              onChange={(value) => updateSetting('swipeLeftAction', value as typeof swipeLeftAction)}
              options={swipeOptions}
            />
          </SettingItem>
        )}
      </SettingsSection>
      )}

      <SettingsSection id="delete" title={tPage('sections.delete')}>
        {!isSettingHidden('deleteAction') && (
        <SettingItem label={t('delete_action.label')} description={t('delete_action.description')} locked={isSettingLocked('deleteAction')}>
          <div className="flex flex-col gap-2">
            <Select
              value={deleteAction}
              onChange={(value) => updateSetting('deleteAction', value as 'trash' | 'trash-and-read' | 'permanent')}
              options={[
                { value: 'trash', label: t('delete_action.trash') },
                { value: 'trash-and-read', label: t('delete_action.trash_and_read') },
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

        {archiveActionEnabled && (
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
        )}

        <SettingItem label={t('confirm_bulk_delete.label')} description={t('confirm_bulk_delete.description')}>
          <ToggleSwitch
            checked={confirmBulkDelete}
            onChange={(checked) => updateSetting('confirmBulkDelete', checked)}
          />
        </SettingItem>

        <SettingItem label={t('permanently_delete_junk.label')} description={t('permanently_delete_junk.description')} advanced>
          <ToggleSwitch
            checked={permanentlyDeleteJunk}
            onChange={(checked) => updateSetting('permanentlyDeleteJunk', checked)}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="loading" title={tPage('sections.loading')} advanced>
        {!isSettingHidden('emailsPerPage') && (
        <SettingItem label={t('emails_per_page.label')} description={t('emails_per_page.description')} locked={isSettingLocked('emailsPerPage')} advanced>
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

        {!isSettingHidden('searchDefaultScope') && (
        <SettingItem label={t('search_default_scope.label')} description={t('search_default_scope.description')} locked={isSettingLocked('searchDefaultScope')} advanced>
          <Select
            value={searchDefaultScope}
            onChange={(value) => updateSetting('searchDefaultScope', value as SearchDefaultScope)}
            options={[
              { value: 'all', label: t('search_default_scope.all') },
              { value: 'folder', label: t('search_default_scope.folder') },
            ]}
          />
        </SettingItem>
        )}

        <SettingItem label={t('clear_search_on_folder_change.label')} description={t('clear_search_on_folder_change.description')} advanced>
          <ToggleSwitch
            checked={clearSearchOnFolderChange}
            onChange={(checked) => updateSetting('clearSearchOnFolderChange', checked)}
          />
        </SettingItem>
      </SettingsSection>
    </div>
  );
}
