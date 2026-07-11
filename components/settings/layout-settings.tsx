"use client";

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Folder } from 'lucide-react';
import { useSettingsStore, type ToolbarPosition, type MailLayout } from '@/stores/settings-store';
import { SettingsSection, SettingItem, RadioGroup, ToggleSwitch } from './settings-section';
import { cn } from '@/lib/utils';
import { usePolicyStore } from '@/stores/policy-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';

const MAIL_LAYOUT_PREVIEW_ROWS = [
  { sender: 'Alice', subject: 'Quarterly roadmap', preview: 'The draft is ready for review.', selected: false },
  { sender: 'Nadia', subject: 'Design sync', preview: 'Pushed updated mocks and notes.', selected: true },
  { sender: 'Billing', subject: 'Invoice 1042', preview: 'Your receipt is attached.', selected: false },
];

const MAIL_LAYOUT_PREVIEW_ROWS_FOCUS = [
  ...MAIL_LAYOUT_PREVIEW_ROWS,
  { sender: 'Sam', subject: 'Lunch?', preview: '', selected: false },
  { sender: 'Newsletter', subject: 'Weekly digest', preview: '', selected: false },
];

function MailLayoutPreview({
  value,
  t,
}: {
  value: MailLayout;
  t: (key: string) => string;
}) {
  return (
    <div className="mt-3 rounded-xl border border-border bg-background p-3">
      <div>
        <div className="text-sm font-medium text-foreground">{t(`mail_layout.${value}`)}</div>
        <div className="mt-1 text-xs text-muted-foreground">{t(`mail_layout.${value}_description`)}</div>
      </div>

      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-muted/20">
        <div className="flex h-28">
          <div className="w-11 border-e border-border bg-muted/40" />

          {value === 'split' && (
            <>
              <div className="w-28 border-e border-border bg-background">
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
          )}

          {value === 'focus' && (
            <div className="flex-1 bg-background">
              {MAIL_LAYOUT_PREVIEW_ROWS_FOCUS.map((row) => (
                <div
                  key={row.subject}
                  className={cn(
                    'border-b border-border px-2 py-1 text-[10px] last:border-b-0',
                    row.selected && 'bg-primary/10'
                  )}
                >
                  <div className="truncate text-foreground">
                    <span className="font-medium">{row.sender}</span>
                    <span className="mx-1.5 text-muted-foreground">{row.subject}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {value === 'horizontal' && (
            <div className="flex-1 flex flex-col bg-background">
              <div className="border-b border-border bg-background">
                {MAIL_LAYOUT_PREVIEW_ROWS.map((row) => (
                  <div
                    key={row.subject}
                    className={cn(
                      'border-b border-border px-2 py-1 text-[10px] last:border-b-0',
                      row.selected && 'bg-primary/10'
                    )}
                  >
                    <div className="truncate text-foreground">
                      <span className="font-medium">{row.sender}</span>
                      <span className="mx-1.5 text-muted-foreground">{row.subject}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex-1 bg-background px-3 py-2">
                <div className="h-2 w-20 rounded bg-foreground/10" />
                <div className="mt-1.5 h-1.5 w-full rounded bg-foreground/10" />
                <div className="mt-1 h-1.5 w-5/6 rounded bg-foreground/10" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LayoutSettings() {
  const t = useTranslations('settings.appearance');
  const tEmail = useTranslations('settings.email_behavior');
  const { toolbarPosition, showToolbarLabels, hideAccountSwitcher, showRailAccountList, enableUnifiedMailbox, includeGroupInUnified, enableAllMailView, allMailFolderIds, enableCrossUnreadView, enableCrossStarredView, enableCrossAllView, colorfulSidebarIcons, tintListRowsByTag, showFolderTotalCount, faviconUnreadBadge, mailLayout, proInterface, updateSetting } = useSettingsStore();
  const { isSettingLocked, isSettingHidden, isFeatureEnabled } = usePolicyStore();
  const accounts = useAccountStore(s => s.accounts);
  const activeAccountId = useAccountStore(s => s.activeAccountId);
  const mailboxes = useEmailStore(s => s.mailboxes);
  const hasGroupInboxes = useMemo(() => mailboxes.some(m => m.isShared), [mailboxes]);
  const allMailViewAllowed = isFeatureEnabled('allMailViewEnabled');
  // Cross-account "All accounts" views, each gated independently by the admin.
  const crossViews = [
    { setting: 'enableCrossUnreadView', value: enableCrossUnreadView, allowed: isFeatureEnabled('crossUnreadViewEnabled'), labelKey: 'cross_unread.label', descKey: 'cross_unread.description' },
    { setting: 'enableCrossStarredView', value: enableCrossStarredView, allowed: isFeatureEnabled('crossStarredViewEnabled'), labelKey: 'cross_starred.label', descKey: 'cross_starred.description' },
    { setting: 'enableCrossAllView', value: enableCrossAllView, allowed: isFeatureEnabled('crossAllViewEnabled'), labelKey: 'cross_all.label', descKey: 'cross_all.description' },
  ] as const;

  // Own (non-shared) folders and the active account's All Mail selection. The
  // selection is per account: a missing entry = never configured, which
  // defaults to all no-role folders; an explicit [] = no folders.
  const ownMailboxes = useMemo(() => mailboxes.filter(m => !m.isShared), [mailboxes]);
  const currentAllMailEntry = activeAccountId ? allMailFolderIds[activeAccountId] : undefined;
  const allMailSelected = new Set(
    currentAllMailEntry === undefined
      ? ownMailboxes.filter(m => !m.role).map(m => m.id)
      : currentAllMailEntry
  );
  const toggleAllMailFolder = (id: string) => {
    if (!activeAccountId) return;
    const next = new Set(allMailSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateSetting('allMailFolderIds', {
      ...allMailFolderIds,
      [activeAccountId]: ownMailboxes.filter(m => next.has(m.id)).map(m => m.id),
    });
  };
  // Name the account the selection applies to, but only when more than one is
  // logged in (otherwise it's unambiguous).
  const activeAccount = accounts.find(a => a.id === activeAccountId);
  const allMailAccountHint = accounts.length > 1 && activeAccount
    ? t('all_mail.account_hint', { account: activeAccount.displayName || activeAccount.email })
    : null;

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      {!isSettingHidden('mailLayout') && (
      <SettingItem label={tEmail('mail_layout.label')} description={tEmail('mail_layout.description')} locked={isSettingLocked('mailLayout')}>
        <div className="w-[22rem] max-w-full">
          <RadioGroup
            value={mailLayout}
            onChange={(value) => updateSetting('mailLayout', value as MailLayout)}
            options={[
              { value: 'split', label: tEmail('mail_layout.split') },
              { value: 'focus', label: tEmail('mail_layout.focus') },
              { value: 'horizontal', label: tEmail('mail_layout.horizontal') },
            ]}
          />
          <MailLayoutPreview value={mailLayout} t={tEmail} />
        </div>
      </SettingItem>
      )}

      <SettingItem label={t('toolbar_position.label')} description={t('toolbar_position.description')}>
        <RadioGroup
          value={toolbarPosition}
          onChange={(value) => updateSetting('toolbarPosition', value as ToolbarPosition)}
          options={[
            { value: 'top', label: t('toolbar_position.top') },
            { value: 'below-subject', label: t('toolbar_position.below_subject') },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('toolbar_labels.label')} description={t('toolbar_labels.description')}>
        <ToggleSwitch
          checked={showToolbarLabels}
          onChange={(checked) => updateSetting('showToolbarLabels', checked)}
        />
      </SettingItem>

      <SettingItem label={t('hide_account_switcher.label')} description={t('hide_account_switcher.description')}>
        <ToggleSwitch
          checked={hideAccountSwitcher}
          onChange={(checked) => updateSetting('hideAccountSwitcher', checked)}
        />
      </SettingItem>

      <SettingItem label={t('show_rail_account_list.label')} description={t('show_rail_account_list.description')}>
        <ToggleSwitch
          checked={showRailAccountList}
          onChange={(checked) => updateSetting('showRailAccountList', checked)}
        />
      </SettingItem>

      <SettingItem label={t('colorful_sidebar_icons.label')} description={t('colorful_sidebar_icons.description')}>
        <ToggleSwitch
          checked={colorfulSidebarIcons}
          onChange={(checked) => updateSetting('colorfulSidebarIcons', checked)}
        />
      </SettingItem>

      <SettingItem label={t('tint_list_rows.label')} description={t('tint_list_rows.description')}>
        <ToggleSwitch
          checked={tintListRowsByTag}
          onChange={(checked) => updateSetting('tintListRowsByTag', checked)}
        />
      </SettingItem>

      <SettingItem label={t('show_folder_total_count.label')} description={t('show_folder_total_count.description')}>
        <ToggleSwitch
          checked={showFolderTotalCount}
          onChange={(checked) => updateSetting('showFolderTotalCount', checked)}
        />
      </SettingItem>

      <SettingItem label={t('favicon_unread_badge.label')} description={t('favicon_unread_badge.description')}>
        <ToggleSwitch
          checked={faviconUnreadBadge}
          onChange={(checked) => updateSetting('faviconUnreadBadge', checked)}
        />
      </SettingItem>

      {(accounts.length > 1 || hasGroupInboxes) && !isSettingHidden('enableUnifiedMailbox') && (
        <SettingItem
          label={t('unified_mailbox.label')}
          description={t('unified_mailbox.description')}
          locked={isSettingLocked('enableUnifiedMailbox')}
        >
          <ToggleSwitch
            checked={enableUnifiedMailbox}
            onChange={(v) => updateSetting('enableUnifiedMailbox', v)}
          />
        </SettingItem>
      )}

      {enableUnifiedMailbox && hasGroupInboxes && !isSettingHidden('includeGroupInUnified') && (
        <div className="ms-4 border-s-2 border-border ps-4 -mt-2">
          <SettingItem
            label={t('unified_mailbox.include_group.label')}
            description={t('unified_mailbox.include_group.description')}
            locked={isSettingLocked('includeGroupInUnified')}
          >
            <ToggleSwitch
              checked={includeGroupInUnified}
              onChange={(v) => updateSetting('includeGroupInUnified', v)}
            />
          </SettingItem>
        </div>
      )}

      {enableUnifiedMailbox && crossViews.some(c => c.allowed) && (
        <div className="ms-4 border-s-2 border-border ps-4 -mt-2 space-y-2">
          {crossViews.map(({ setting, value, allowed, labelKey, descKey }) => (
            allowed && !isSettingHidden(setting) && (
              <SettingItem
                key={setting}
                label={t(labelKey)}
                description={t(descKey)}
                locked={isSettingLocked(setting)}
              >
                <ToggleSwitch
                  checked={value}
                  onChange={(v) => updateSetting(setting, v)}
                />
              </SettingItem>
            )
          ))}
        </div>
      )}

      {allMailViewAllowed && !isSettingHidden('enableAllMailView') && (
        <SettingItem
          label={t('all_mail.label')}
          description={t('all_mail.description')}
          locked={isSettingLocked('enableAllMailView')}
        >
          <ToggleSwitch
            checked={enableAllMailView}
            onChange={(v) => updateSetting('enableAllMailView', v)}
          />
        </SettingItem>
      )}

      {allMailViewAllowed && enableAllMailView && (
        <div className="ms-4 border-s-2 border-border ps-4 -mt-2 space-y-2">
          <div>
            <div className="text-sm font-medium text-foreground">{t('all_mail.folders_label')}</div>
            <div className="text-xs text-muted-foreground">{t('all_mail.folders_description')}</div>
            {allMailAccountHint && (
              <div className="text-xs italic text-muted-foreground mt-0.5">{allMailAccountHint}</div>
            )}
          </div>
          {ownMailboxes.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('all_mail.no_folders')}</p>
          ) : (
            <div className="space-y-0.5">
              {ownMailboxes.map((mb) => {
                const checked = allMailSelected.has(mb.id);
                return (
                  <button
                    key={mb.id}
                    type="button"
                    onClick={() => toggleAllMailFolder(mb.id)}
                    className="w-full flex items-center gap-2.5 py-1.5 px-2 rounded-md hover:bg-muted/50 text-start"
                    role="checkbox"
                    aria-checked={checked}
                  >
                    <span className={cn(
                      "flex items-center justify-center w-4 h-4 rounded border flex-shrink-0 transition-colors",
                      checked ? "bg-primary border-primary text-primary-foreground" : "border-border"
                    )}>
                      {checked && <Check className="w-3 h-3" />}
                    </span>
                    <Folder className={cn("w-4 h-4 flex-shrink-0", mb.role ? "text-primary" : "text-muted-foreground")} />
                    <span className="text-sm text-foreground truncate">{mb.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <SettingItem label={t('pro_interface.label')} description={t('pro_interface.description')}>
        <ToggleSwitch
          checked={proInterface}
          onChange={(v) => updateSetting('proInterface', v)}
        />
      </SettingItem>
    </SettingsSection>
  );
}
