"use client";

import { useState, useRef, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Check, GripVertical, Plus, Star, AlertCircle, ChevronRight, ChevronUp, ChevronDown, X, ExternalLink } from '@/components/icons';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { useManagedAccountStore } from '@/stores/managed-account-store';
import type { SharedAccount } from '@/lib/jmap/types';
import { SettingsSection, SettingItem } from './settings-section';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { getMaxAccounts, accountRowText, accountSharesAddress } from '@/lib/account-utils';
import { formatFileSize, cn } from '@/lib/utils';
import { toUnicodeDomain, toUnicodeEmail } from '@/lib/idn';
import { IS_LITE } from '@/lib/lite';
import { usePolicyStore } from '@/stores/policy-store';
import { AccountArchiveSettings } from './account-archive-settings';
import { SignOutRow } from './sign-out-row';
import { YourNameRow } from './your-name-row';
import { EmailAddressesSection } from './identity-settings';
import { MultipleAccountsSection } from './layout-settings';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { useConfig } from '@/hooks/use-config';

function hostnameOf(serverUrl: string): string {
  try { return toUnicodeDomain(new URL(serverUrl).hostname); } catch { return serverUrl; }
}

// First scoped settings tab to land on for a shared account, by capability.
// Mirrors the scoped-tab gating in the settings page. null = nothing editable.
function firstScopedTab(caps: SharedAccount['capabilities']): string | null {
  if (caps.sieve) return 'filters';
  if (caps.mail) return 'vacation';
  if (caps.calendars) return 'calendar';
  if (caps.contacts) return 'contacts';
  return null;
}

export function AccountSettings() {
  const t = useTranslations('settings.account');
  const tCommon = useTranslations('common');
  const tSidebar = useTranslations('sidebar');
  const router = useRouter();
  const removeAccount = useAuthStore((s) => s.removeAccount);
  const { dialogProps: confirmDialogProps, confirm } = useConfirmDialog();
  const { username, serverUrl, isDemoMode, primaryIdentity, authMode, client } = useAuthStore();
  const { accountManagementUrl, accountManagementLabel } = useConfig();
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const setManagedAccount = useManagedAccountStore((s) => s.setManagedAccount);
  const archiveEnabled = usePolicyStore((s) => s.isFeatureEnabled('accountArchiveEnabled')) && !IS_LITE && !isDemoMode;

  // Shared/group accounts delegated to this session (excludes the user's own
  // primary account). These can be drilled into for scoped settings editing.
  const sharedAccounts = useMemo<SharedAccount[]>(
    () => (client?.getSharedAccounts() ?? []).filter((a) => !a.isPrimary),
    [client],
  );
  const { quota } = useEmailStore();
  const accounts = useAccountStore((s) => s.accounts);
  const setDefaultAccount = useAccountStore((s) => s.setDefaultAccount);
  const reorderAccounts = useAccountStore((s) => s.reorderAccounts);
  const account = useAccountStore((s) => activeAccountId ? s.getAccountById(activeAccountId) : undefined);

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const draggedIndexRef = useRef<number | null>(null);

  const quotaPercentage = quota && quota.total > 0 ? Math.min(Math.round((quota.used / quota.total) * 100), 100) : 0;
  // Shown when there is no identity to edit: the name the app knows.
  const displayName = primaryIdentity?.name || account?.displayName || (isDemoMode ? 'Nora Lindqvist' : undefined);
  const email = primaryIdentity?.email || account?.email || username;
  const max = getMaxAccounts();

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    draggedIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    setDragOverIndex(null);
    const fromIndex = draggedIndexRef.current;
    if (fromIndex === null || fromIndex === dropIndex) return;
    const next = accounts.map((a) => a.id);
    const [moved] = next.splice(fromIndex, 1);
    next.splice(dropIndex, 0, moved);
    reorderAccounts(next);
  }, [accounts, reorderAccounts]);

  const handleDragEnd = useCallback(() => {
    draggedIndexRef.current = null;
    setDragOverIndex(null);
  }, []);

  const moveAccount = useCallback((from: number, to: number) => {
    if (to < 0 || to >= accounts.length || from === to) return;
    const next = accounts.map((a) => a.id);
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorderAccounts(next);
  }, [accounts, reorderAccounts]);

  const handleSwitch = useCallback((id: string) => {
    if (id === activeAccountId) return;
    void switchAccount(id);
  }, [activeAccountId, switchAccount]);

  // The switcher has no remove button on its rows; an account you're not in
  // is removed here ("Manage accounts…" leads to this list).
  const handleRemove = useCallback(async (target: AccountEntry) => {
    const ok = await confirm({
      title: tSidebar('remove_account_title'),
      message: tSidebar('remove_account_confirm', { account: toUnicodeEmail(target.email || target.username) }),
      confirmText: tSidebar('remove_account'),
      variant: 'destructive',
    });
    if (ok) removeAccount(target.id);
  }, [confirm, removeAccount, tSidebar]);

  const handleAddAccount = useCallback(() => {
    router.push(`/login?mode=add-account` as never);
  }, [router]);

  // Enter scoped settings mode for a shared/group account: set the managed
  // account, then steer the settings panel to its first editable tab via the
  // existing 'settings-tab-change' event the page already listens for.
  const handleManageShared = useCallback((account: SharedAccount) => {
    const tab = firstScopedTab(account.capabilities);
    if (!tab) return;
    setManagedAccount(account);
    window.dispatchEvent(new CustomEvent('settings-tab-change', { detail: tab }));
  }, [setManagedAccount]);

  return (
    <div className="space-y-8">
      <SettingsSection id="profile" title={t('title')} description={t('description')}>
        {/* One name: the primary address's, what recipients see (settings-p2-2).
            Stalwart's principal description is an admin's field and isn't shown. */}
        <YourNameRow fallbackName={displayName} />

        {/* Email Address */}
        <SettingItem label={t('email.label')}>
          <span dir={email ? 'ltr' : undefined} className="text-sm text-foreground">{email ? toUnicodeEmail(email) : tCommon('unknown')}</span>
        </SettingItem>

        {/* Username / Login (show when it differs from email) */}
        {username && username !== email && (
          <SettingItem label={t('username_label')}>
            <span dir="ltr" className="text-sm text-foreground">{toUnicodeEmail(username)}</span>
          </SettingItem>
        )}

        {/* Authentication Method */}
        <SettingItem label={t('auth_method_label')}>
          <div className="flex flex-col items-end gap-1 text-end">
            <span className="text-sm text-foreground">
              {authMode === 'oauth'
                ? t('auth_method_oauth')
                : authMode === 'token' ? t('auth_method_token') : t('auth_method_basic')}
            </span>
            {/* The server's own page for 2FA and app passwords (#1570). */}
            {accountManagementUrl && (
              <a
                href={accountManagementUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                {accountManagementLabel || t('account_management_link')}
                <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              </a>
            )}
          </div>
        </SettingItem>

        {/* Server */}
        <SettingItem label={t('server.label')} advanced term="jmap">
          <span className="text-sm text-foreground truncate max-w-xs">
            {serverUrl || tCommon('unknown')}
          </span>
        </SettingItem>

        {/* Storage */}
        {quota && quota.total > 0 && (
          <SettingItem
            label={t('storage.label')}
            description={t('storage.used', {
              used: formatFileSize(quota.used),
              total: formatFileSize(quota.total),
            })}
          >
            <div className="flex flex-col items-end gap-1">
              <span className="text-sm text-foreground">
                {t('storage.percentage', { percent: quotaPercentage })}
              </span>
              <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${quotaPercentage}%` }}
                />
              </div>
            </div>
          </SettingItem>
        )}

        {/* Demo mode indicator */}
        {isDemoMode && (
          <SettingItem label={t('account_type_label')}>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              {t('demo_account')}
            </span>
          </SettingItem>
        )}

        <SignOutRow />
      </SettingsSection>

      <EmailAddressesSection />

      {/* Logged-in accounts list */}
      {accounts.length > 0 && (
        <SettingsSection
          id="browser"
          title={t('accounts.title')}
          // "Drag to change the order" says nothing with one account.
          description={accounts.length > 1 ? t('accounts.description') : undefined}
        >
          <div className="space-y-2">
            {accounts.map((a, index) => (
              <AccountRow
                key={a.id}
                account={a}
                text={accountRowText(a, accounts)}
                showServer={a.hasError || accountSharesAddress(a, accounts)}
                canReorder={accounts.length > 1}
                index={index}
                isActive={a.id === activeAccountId}
                isFirst={index === 0}
                isLast={index === accounts.length - 1}
                isDragOver={dragOverIndex === index}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onMoveUp={() => moveAccount(index, index - 1)}
                onMoveDown={() => moveAccount(index, index + 1)}
                onSwitch={() => handleSwitch(a.id)}
                onSetDefault={() => setDefaultAccount(a.id)}
                onRemove={() => void handleRemove(a)}
                labels={{
                  active: t('accounts.active'),
                  default: t('accounts.default_badge'),
                  setDefault: t('accounts.set_default'),
                  switchTo: t('accounts.switch_to'),
                  moveUp: t('accounts.move_up'),
                  moveDown: t('accounts.move_down'),
                  dragHandle: t('accounts.drag_handle'),
                  remove: tSidebar('remove_account'),
                }}
              />
            ))}

            {accounts.length < max && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddAccount}
                className="w-full"
              >
                <Plus className="w-4 h-4 me-2" />
                {t('accounts.add')}
              </Button>
            )}
          </div>
        </SettingsSection>
      )}

      <ConfirmDialog {...confirmDialogProps} />

      {archiveEnabled && <AccountArchiveSettings />}

      <MultipleAccountsSection />

      {/* Shared / group accounts delegated to this session. Clicking one drills
          into a scoped settings view (filters, vacation, calendars, contacts). */}
      {sharedAccounts.length > 0 && (
        <SettingsSection id="shared" title={t('shared_accounts.title')} description={t('shared_accounts.description')}>
          <div className="space-y-2">
            {sharedAccounts.map((acc) => {
              const editable = firstScopedTab(acc.capabilities) !== null;
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => handleManageShared(acc)}
                  disabled={!editable}
                  className={cn(
                    'flex items-center gap-3 w-full p-3 border border-border rounded-lg text-start transition-colors',
                    editable ? 'hover:bg-muted/50 cursor-pointer' : 'opacity-60 cursor-not-allowed',
                  )}
                >
                  <Avatar
                    name={acc.name}
                    size="sm"
                    className="w-9 h-9 text-sm flex-shrink-0"
                    disableFavicon
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{acc.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {t('shared_accounts.shared_label')}
                    </p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                </button>
              );
            })}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

interface AccountRowProps {
  account: AccountEntry;
  text: { title: string; subtitle: string | null };
  /** The server line: only for an account in trouble or a shared address. */
  showServer: boolean;
  /** Dragging and the arrows: only with two accounts or more. */
  canReorder: boolean;
  index: number;
  isActive: boolean;
  isFirst: boolean;
  isLast: boolean;
  isDragOver: boolean;
  onDragStart: (e: React.DragEvent, index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, index: number) => void;
  onDragEnd: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onSwitch: () => void;
  onSetDefault: () => void;
  onRemove: () => void;
  labels: {
    active: string;
    default: string;
    setDefault: string;
    switchTo: string;
    moveUp: string;
    moveDown: string;
    dragHandle: string;
    remove: string;
  };
}

function AccountRow({
  account,
  text,
  showServer,
  canReorder,
  index,
  isActive,
  isFirst,
  isLast,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMoveUp,
  onMoveDown,
  onSwitch,
  onSetDefault,
  onRemove,
  labels,
}: AccountRowProps) {
  return (
    <div
      draggable={canReorder}
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      onDragEnd={onDragEnd}
      className={cn(
        'flex items-center gap-3 p-3 border rounded-lg transition-colors',
        isDragOver
          ? 'border-primary bg-primary/5'
          : isActive
            ? 'border-border bg-accent/30'
            : 'border-border hover:bg-muted/50'
      )}
    >
      {canReorder && (
        <div
          className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground flex-shrink-0"
          title={labels.dragHandle}
        >
          <GripVertical className="w-4 h-4" />
        </div>
      )}

      <div className="relative flex-shrink-0">
        <Avatar
          name={account.displayName || account.label}
          email={account.email || account.username}
          size="sm"
          className="w-9 h-9 text-sm"
          disableFavicon
          fallbackColor={account.avatarColor}
        />
        {isActive && (
          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
            <Check className="w-2.5 h-2.5 text-primary-foreground" />
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onSwitch}
        disabled={isActive}
        className={cn(
          'min-w-0 flex-1 text-start',
          !isActive && 'cursor-pointer'
        )}
        title={isActive ? labels.active : labels.switchTo}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium wrap-anywhere" title={toUnicodeEmail(text.title)}>
            {toUnicodeEmail(text.title)}
          </span>
          {account.isDefault && (
            <Star className="w-3 h-3 text-amber-500 flex-shrink-0 fill-amber-500" aria-label={labels.default} />
          )}
        </div>
        {text.subtitle && (
          <p dir="ltr" className="text-xs text-muted-foreground wrap-anywhere rtl:text-right">
            {toUnicodeEmail(text.subtitle)}
          </p>
        )}
        {showServer && (
          <div className="flex items-center gap-1 mt-0.5" data-testid="account-server">
            {account.hasError && <AlertCircle className="w-3 h-3 text-destructive" />}
            <span className="text-xs text-muted-foreground truncate">
              {hostnameOf(account.serverUrl)}
            </span>
          </div>
        )}
      </button>

      <div className="flex items-center gap-0.5 flex-shrink-0">
        {!account.isDefault && (
          <button
            type="button"
            onClick={onSetDefault}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-amber-500 transition-colors"
            title={labels.setDefault}
            aria-label={labels.setDefault}
          >
            <Star className="w-3.5 h-3.5" />
          </button>
        )}
        {canReorder && (<>
        <button
          type="button"
          onClick={onMoveUp}
          disabled={isFirst}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
          title={labels.moveUp}
          aria-label={labels.moveUp}
        >
          <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={isLast}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
          title={labels.moveDown}
          aria-label={labels.moveDown}
        >
          <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        </>)}
        {!isActive && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            title={labels.remove}
            aria-label={labels.remove}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
