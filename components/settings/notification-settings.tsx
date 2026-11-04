"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { useEmailStore } from '@/stores/email-store';
import { useIdentityStore } from '@/stores/identity-store';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from './settings-section';
import { DesktopOsSettings } from './desktop-os-settings';
import { playNotificationSound, NOTIFICATION_SOUNDS } from '@/lib/notification-sound';
import type { NotificationSoundChoice } from '@/lib/notification-sound';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Volume2, XCircle } from '@/components/icons';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AccountPushSwitches, usePushAccounts } from './multi-account-push';
import { isDesktopApp } from '@/lib/desktop/bridge';
import { productName } from '@/lib/product-name';
import { useConfig } from '@/hooks/use-config';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import {
  WebPushUnsupportedError,
  disableWebPush,
  enableWebPush,
  isWebPushEnabled,
  isWebPushSupported,
  listPushDevices,
  mailAccountsWithoutPush,
  revokePushDevice,
  serverSupportsEmailPush,
} from '@/lib/web-push';
import { webPushErrorKey } from '@/lib/web-push-errors';
import type { PushDevice } from '@/lib/web-push';
import { IS_LITE } from '@/lib/lite';
import { useNoThirdPartyTraffic } from '@/hooks/use-third-party-mode';
import {
  resolveActiveRelayUrl,
  resolvePushRelayOptions,
} from '@/lib/push-relays';

type PushStatus =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'enabled' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

type DevicesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; devices: PushDevice[] }
  | { kind: 'error' };

/** iPhone or iPad, where Safari only pushes for a site on the home screen. iPadOS says it's a Mac with touch. */
function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function NotificationSettings() {
  const t = useTranslations('settings.notifications');
  const tAppearance = useTranslations('settings.appearance');
  const tDesktopP2 = useTranslations('uxp2_desktop');
  const tUnread = useTranslations('account_unread');
  const severalAccounts = useAccountStore((s) => s.accounts.length > 1);
  const tThirdParty = useTranslations('third_party');
  const tP2 = useTranslations('uxp2_settings');
  // The desktop app tells about new mail while it runs, in the tray too; the
  // browser's push section talks about websites and Safari (settings-p2-4).
  const inApp = isDesktopApp();
  const pushAccounts = usePushAccounts();
  const appName = productName(useConfig().appName);
  // The relay list depends on it; re-render once the config is known (#903).
  const noThirdParty = useNoThirdPartyTraffic();
  const {
    emailNotificationsEnabled,
    emailNotificationSound,
    notificationSoundChoice,
    pushNotifyInboxOnly,
    calendarNotificationsEnabled,
    calendarNotificationSound,
    faviconUnreadBadge,
    unreadBadgeAllAccounts,
    pushRelayUrl,
    updateSetting,
  } = useSettingsStore();
  const { isSettingLocked, isSettingHidden } = usePolicyStore();
  const policy = usePolicyStore((s) => s.policy);
  const pushRelayLocked = policy.pushRelayUrlLocked === true;
  const client = useAuthStore((s) => s.client);
  const username = useAuthStore((s) => s.username);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  // The demo client has no mail server to subscribe with. Enabling would get as
  // far as a relay record and a browser subscription, then fail.
  const isDemoMode = useAuthStore((s) => s.isDemoMode);
  const supported = typeof window !== 'undefined' && isWebPushSupported() && !isDemoMode;
  // "Inbox only" is enforced by the server's emailPush filter; without that
  // capability (Stalwart < 0.16.16) the toggle would do nothing.
  const inboxOnlyAvailable = supported && !inApp && !!client && serverSupportsEmailPush(client);
  const [pushStatus, setPushStatus] = useState<PushStatus>(
    supported ? { kind: 'idle' } : { kind: 'unsupported' },
  );
  const [devices, setDevices] = useState<DevicesState>({ kind: 'idle' });
  // Bumped when an account's own switch changed push, so this account's state is read again.
  const [pushRecheck, setPushRecheck] = useState(0);
  // Several accounts connected: a switch each instead of one for the account on screen (settings-p2-17).
  const perAccount = supported && pushAccounts.length > 1;
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Relay URLs come from admin policy only - users pick one of the offered
  // relays, they never type a URL.
  const relayOptions = resolvePushRelayOptions(policy);
  const activeRelayUrl = resolveActiveRelayUrl(policy, pushRelayUrl);
  const relayChoiceFixed = pushRelayLocked || relayOptions.length < 2;
  // Third-party traffic off and no relay of the organisation's own (#903).
  const noRelay = !activeRelayUrl;
  const activeRelayLabel =
    relayOptions.find((option) => option.url === activeRelayUrl)?.label ?? activeRelayUrl;

  const busy = pushStatus.kind === 'busy';

  useEffect(() => {
    if (!supported) return;
    if (!client) return;
    const accountId = client.getAccountId();
    if (!accountId) return;
    let cancelled = false;
    const refreshStatus = async () => {
      try {
        const enabled = await isWebPushEnabled(accountId);
        if (!cancelled) {
          setPushStatus(enabled ? { kind: 'enabled' } : { kind: 'idle' });
        }
      } catch {
        if (!cancelled) setPushStatus({ kind: 'idle' });
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshStatus();
    };
    if (pushStatus.kind === 'busy' || pushStatus.kind === 'error') return;
    void refreshStatus();
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [supported, client, pushStatus.kind, pushRecheck]);

  // The device list is worth loading even when push is off on this browser -
  // revoking a stale registration left on another device is exactly what you
  // come here for.
  const refreshDevices = useCallback(async () => {
    if (!client) return;
    setDevices({ kind: 'loading' });
    try {
      setDevices({ kind: 'loaded', devices: await listPushDevices({ client, relayBaseUrl: activeRelayUrl }) });
    } catch {
      setDevices({ kind: 'error' });
    }
  }, [client, activeRelayUrl]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const pushEnabled = pushStatus.kind === 'enabled';
  // In the static Lite build push is off by design (no service worker, see
  // components/service-worker-registration.tsx), not a browser limitation.
  const statusDescription = pushStatus.kind === 'unsupported'
    // Two sentences, and the home-screen hint only where it applies (settings-p2-4).
    ? (IS_LITE ? t('push.status_lite') : isDemoMode ? t('push.status_demo') : isAppleMobile() ? `${tP2('push_unsupported')} ${t('push.ios_hint')}` : tP2('push_unsupported'))
    : noRelay && !pushEnabled
      ? tThirdParty('push_needs_relay')
    : busy
      ? t('push.status_busy')
      : pushEnabled
        ? t('push.status_active')
        : t('push.status_inactive');

  // Stalwart pushes only the user's own mailboxes and their groups', so
  // mailboxes shared by other users stay silent in the background (they still
  // update while the app is open). Say so instead of leaving users to wonder.
  const mailboxes = useEmailStore((s) => s.mailboxes);
  // On 0.16 the user's identities tell their groups from mailboxes shared by
  // ACL (see mailAccountsWithoutPush).
  const identities = useIdentityStore((s) => s.identities);
  const sharedMailboxesWithoutPush = useMemo(() => {
    // Re-read after each enable run too: it may have added refused accounts.
    if (!client || pushStatus.kind === 'unsupported') return false;
    const accountIds = mailboxes.flatMap((m) => (m.isShared && m.accountId ? [m.accountId] : []));
    return mailAccountsWithoutPush(client, accountIds, identities.map((identity) => identity.email)).length > 0;
  }, [client, mailboxes, identities, pushStatus.kind]);

  // The refusals a user can do something about get readable text; anything
  // else keeps the error's own message.
  const pushErrorMessage = (err: unknown, fallback: string) => {
    const key = webPushErrorKey(err);
    if (key) return t(`push.${key}`);
    return err instanceof Error ? err.message : fallback;
  };

  // `forceRecreate` is what the Re-register button is for: without it the enable
  // path just refreshes the existing subscription's expiry, so a registration
  // holding stale shared-mailbox access survives the round trip (#841).
  const handleEnablePush = async (forceRecreate = false) => {
    if (!client) {
      setPushStatus({ kind: 'error', message: 'Sign in first' });
      return;
    }
    setPushStatus({ kind: 'busy' });
    try {
      await enableWebPush({
        client,
        relayBaseUrl: activeRelayUrl,
        accountLabel: username ?? undefined,
        forceRecreate,
        inboxOnly: pushNotifyInboxOnly,
        mutes: useSettingsStore.getState().notificationMutes,
      });
      setPushStatus({ kind: 'enabled' });
    } catch (err) {
      if (err instanceof WebPushUnsupportedError) {
        setPushStatus({ kind: 'unsupported' });
        return;
      }
      setPushStatus({ kind: 'error', message: pushErrorMessage(err, 'Failed to enable push') });
    } finally {
      await refreshDevices();
    }
  };

  // Flipping "Inbox only" only writes the setting; the server-side JMAP push
  // filter stays stale until the next app launch runs resyncWebPush. When push
  // is already on for this device, re-run the enable flow now so the toggle
  // takes effect immediately instead of "on next restart". The ref seeds to the
  // mounted value so this never fires on mount or on an unrelated re-render.
  const lastSyncedInboxOnly = useRef(pushNotifyInboxOnly);
  useEffect(() => {
    if (lastSyncedInboxOnly.current === pushNotifyInboxOnly) return;
    lastSyncedInboxOnly.current = pushNotifyInboxOnly;
    // Push off on this device: enabling it later builds the filter from the
    // current setting, so there's nothing to re-sync now.
    if (!client || pushStatus.kind !== 'enabled') return;

    let cancelled = false;
    setPushStatus({ kind: 'busy' });
    void enableWebPush({
      client,
      relayBaseUrl: activeRelayUrl,
      accountLabel: username ?? undefined,
      inboxOnly: pushNotifyInboxOnly,
      mutes: useSettingsStore.getState().notificationMutes,
    })
      .then(() => { if (!cancelled) setPushStatus({ kind: 'enabled' }); })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof WebPushUnsupportedError) {
          setPushStatus({ kind: 'unsupported' });
          return;
        }
        setPushStatus({ kind: 'error', message: pushErrorMessage(err, 'Failed to update push filter') });
      })
      .finally(() => { if (!cancelled) void refreshDevices(); });
    return () => { cancelled = true; };
    // Only the setting flip should trigger a re-sync. client / relay / username
    // are read live from the recreated closure; depending on pushStatus.kind
    // here would re-fire the effect on the busy->enabled transition it causes
    // and cancel its own in-flight call (leaving the row stuck on "Working").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushNotifyInboxOnly]);

  const handleDisablePush = async () => {
    if (!client) return;
    const confirmed = await confirmDialog({
      title: t('push.confirm_disable_title'),
      message: t('push.confirm_disable_message'),
      confirmText: t('push.disable'),
      variant: 'destructive',
    });
    if (!confirmed) return;
    setPushStatus({ kind: 'busy' });
    try {
      await disableWebPush({ client, relayBaseUrl: activeRelayUrl });
      setPushStatus({ kind: 'idle' });
    } catch (err) {
      setPushStatus({ kind: 'error', message: pushErrorMessage(err, 'Failed to disable push') });
    } finally {
      await refreshDevices();
    }
  };

  const handleRevokeDevice = async (device: PushDevice) => {
    if (!client) return;
    const confirmed = await confirmDialog({
      title: t('push.confirm_revoke_title'),
      message: device.isThisDevice
        ? t('push.confirm_revoke_message_this')
        : t('push.confirm_revoke_message'),
      confirmText: t('push.revoke'),
      variant: 'destructive',
    });
    if (!confirmed) return;
    setRevokingId(device.id);
    try {
      await revokePushDevice({ client, device, relayBaseUrl: activeRelayUrl });
      if (device.isThisDevice) setPushStatus({ kind: 'idle' });
    } catch (err) {
      setPushStatus({ kind: 'error', message: pushErrorMessage(err, 'Failed to revoke device') });
    } finally {
      setRevokingId(null);
      await refreshDevices();
    }
  };

  // Spelled out rather than interpolated so the translation-coverage test can
  // see every key that reaches next-intl.
  const relayStatusLabel = (status: PushDevice['relayStatus']) => {
    if (status === 'active') return t('push.device_status_active');
    if (status === 'inactive') return t('push.device_status_inactive');
    return t('push.device_status_unknown');
  };

  const soundOptions = NOTIFICATION_SOUNDS.map((s) => ({
    value: s.id,
    label: t(`sounds.${s.id}`),
  }));

  return (
    <div className="space-y-8">
      <SettingsSection id="mail" title={t('email.title')} description={t('email.description')}>
        {!isSettingHidden('emailNotificationsEnabled') && (
        <SettingItem
          label={t('email.enabled')}
          description={t('email.enabled_desc')}
          locked={isSettingLocked('emailNotificationsEnabled')}
        >
          <ToggleSwitch
            checked={emailNotificationsEnabled}
            onChange={(checked) => updateSetting('emailNotificationsEnabled', checked)}
          />
        </SettingItem>
        )}

        <SettingItem
          label={t('email.sound')}
          description={t('email.sound_desc')}
        >
          <ToggleSwitch
            checked={emailNotificationSound}
            onChange={(checked) => updateSetting('emailNotificationSound', checked)}
            disabled={!emailNotificationsEnabled}
          />
        </SettingItem>

        {inboxOnlyAvailable && !isSettingHidden('pushNotifyInboxOnly') && (
        <SettingItem
          label={t('email.inbox_only')}
          description={t('email.inbox_only_desc')}
          locked={isSettingLocked('pushNotifyInboxOnly')}
        >
          <ToggleSwitch
            checked={pushNotifyInboxOnly}
            onChange={(checked) => updateSetting('pushNotifyInboxOnly', checked)}
            disabled={!emailNotificationsEnabled}
          />
        </SettingItem>
        )}

        {/* The tab/app icon badge is a new-mail signal too; people look for it here. The desktop app has no tab: the taskbar icon. */}
        <SettingItem
          label={isDesktopApp() ? tDesktopP2('unread_badge_label') : tAppearance('favicon_unread_badge.label')}
          description={isDesktopApp() ? tDesktopP2('unread_badge_description') : tAppearance('favicon_unread_badge.description')}
        >
          <ToggleSwitch
            checked={faviconUnreadBadge}
            onChange={(checked) => updateSetting('faviconUnreadBadge', checked)}
          />
        </SettingItem>

        {/* Only means something with a second account. */}
        {severalAccounts && (
        <SettingItem label={tUnread('badge_all_accounts.label')} description={tUnread('badge_all_accounts.description')}>
          <ToggleSwitch
            checked={unreadBadgeAllAccounts}
            onChange={(checked) => updateSetting('unreadBadgeAllAccounts', checked)}
            disabled={!faviconUnreadBadge}
          />
        </SettingItem>
        )}
      </SettingsSection>

      <SettingsSection id="calendar" title={t('calendar.title')} description={t('calendar.description')}>
        {!isSettingHidden('calendarNotificationsEnabled') && (
        <SettingItem
          label={t('calendar.enabled')}
          description={t('calendar.enabled_desc')}
          locked={isSettingLocked('calendarNotificationsEnabled')}
        >
          <ToggleSwitch
            checked={calendarNotificationsEnabled}
            onChange={(checked) => updateSetting('calendarNotificationsEnabled', checked)}
          />
        </SettingItem>
        )}

        <SettingItem
          label={t('calendar.sound')}
          description={t('calendar.sound_desc')}
        >
          <ToggleSwitch
            checked={calendarNotificationSound}
            onChange={(checked) => updateSetting('calendarNotificationSound', checked)}
            disabled={!calendarNotificationsEnabled}
          />
        </SettingItem>
      </SettingsSection>

      <SettingsSection id="sound" title={t('sound_selection.title')} description={t('sound_selection.description')}>
        <SettingItem
          label={t('sound_selection.choose')}
          description={t('sound_selection.choose_desc')}
        >
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => playNotificationSound(notificationSoundChoice)}
              title={t('test_sound')}
            >
              <Volume2 className="w-4 h-4" />
            </Button>
            <Select
              value={notificationSoundChoice}
              onChange={(value) => {
                const choice = value as NotificationSoundChoice;
                updateSetting('notificationSoundChoice', choice);
                playNotificationSound(choice);
              }}
              options={soundOptions}
            />
          </div>
        </SettingItem>
      </SettingsSection>

      {/* The desktop app's taskbar flash and quiet hours. Nothing in a browser. */}
      <DesktopOsSettings part="notifications" />

      {!inApp && (
      <SettingsSection id="push" title={t('push.title', { appName })} description={t('push.description')} term="push">
        {perAccount ? (
          <>
            {noRelay && <p className="text-xs text-muted-foreground">{tThirdParty('push_needs_relay')}</p>}
            <AccountPushSwitches
              relayBaseUrl={activeRelayUrl}
              disabled={noRelay}
              onChanged={() => { setPushRecheck((n) => n + 1); void refreshDevices(); }}
            />
          </>
        ) : (
        <SettingItem label={t('push.enable')} description={statusDescription}>
          <div className="flex items-center gap-2">
            {pushEnabled && (
              <Button variant="ghost" size="sm" onClick={() => void handleEnablePush(true)} disabled={busy}>
                {t('push.reenable')}
              </Button>
            )}
            <ToggleSwitch
              checked={pushEnabled}
              onChange={(checked) => void (checked ? handleEnablePush() : handleDisablePush())}
              disabled={busy || pushStatus.kind === 'unsupported' || !client || (noRelay && !pushEnabled)}
            />
          </div>
        </SettingItem>
        )}

        {sharedMailboxesWithoutPush && (
          <p className="text-xs text-muted-foreground">{t('push.shared_mailboxes_no_push')}</p>
        )}

        <SettingItem
          advanced
          label={t('push.relay_label')}
          description={pushRelayLocked ? t('push.relay_locked_desc') : noThirdParty ? tThirdParty('relay_desc') : t('push.relay_desc')}
          locked={pushRelayLocked}
        >
          {relayChoiceFixed ? (
            <span className="text-sm text-muted-foreground">{noRelay ? tThirdParty('relay_none') : activeRelayLabel}</span>
          ) : (
            <Select
              value={activeRelayUrl}
              onChange={(value) => updateSetting('pushRelayUrl', value)}
              options={relayOptions.map((option) => ({ value: option.url, label: option.label }))}
              disabled={busy || pushStatus.kind === 'unsupported'}
            />
          )}
        </SettingItem>

        {pushStatus.kind === 'error' && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
            <XCircle className="w-3.5 h-3.5 mt-px shrink-0" />
            {pushStatus.message}
          </p>
        )}
      </SettingsSection>
      )}

      {client && (
        <SettingsSection id="devices" advanced title={t('push.devices_title')} description={t('push.devices_desc')}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {devices.kind === 'loading' && t('push.devices_loading')}
              {devices.kind === 'error' && t('push.devices_error')}
              {devices.kind === 'loaded' && devices.devices.length === 0 && t('push.devices_empty')}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshDevices()}
              disabled={devices.kind === 'loading'}
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${devices.kind === 'loading' ? 'animate-spin [animation-direction:reverse]' : ''}`} />
              {t('push.devices_refresh')}
            </Button>
          </div>

          {devices.kind === 'loaded' && devices.devices.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {devices.devices.map((device) => (
                <li key={device.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {device.isThisDevice ? t('push.device_this') : t('push.device_other')}
                      <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">
                        {device.deviceClientId.slice(0, 8)}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {relayStatusLabel(device.relayStatus)}
                      {device.expires
                        ? ` · ${t('push.device_expires', { date: new Date(device.expires).toLocaleDateString() })}`
                        : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => void handleRevokeDevice(device)}
                    disabled={revokingId !== null}
                  >
                    {revokingId === device.id && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                    {t('push.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsSection>
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
