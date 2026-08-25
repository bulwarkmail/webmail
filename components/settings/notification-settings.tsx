"use client";

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSettingsStore } from '@/stores/settings-store';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from './settings-section';
import { playNotificationSound, NOTIFICATION_SOUNDS } from '@/lib/notification-sound';
import type { NotificationSoundChoice } from '@/lib/notification-sound';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Volume2, XCircle } from 'lucide-react';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import {
  WebPushUnsupportedError,
  disableWebPush,
  enableWebPush,
  isWebPushEnabled,
  isWebPushSupported,
  listPushDevices,
  revokePushDevice,
} from '@/lib/web-push';
import type { PushDevice } from '@/lib/web-push';
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

export function NotificationSettings() {
  const t = useTranslations('settings.notifications');
  const {
    emailNotificationsEnabled,
    emailNotificationSound,
    notificationSoundChoice,
    calendarNotificationsEnabled,
    calendarNotificationSound,
    calendarInvitationParsingEnabled,
    pushRelayUrl,
    updateSetting,
  } = useSettingsStore();
  const { isSettingLocked, isSettingHidden } = usePolicyStore();
  const policy = usePolicyStore((s) => s.policy);
  const pushRelayLocked = policy.pushRelayUrlLocked === true;
  const client = useAuthStore((s) => s.client);
  const username = useAuthStore((s) => s.username);
  const { dialogProps: confirmDialogProps, confirm: confirmDialog } = useConfirmDialog();

  const supported = typeof window !== 'undefined' && isWebPushSupported();
  const [pushStatus, setPushStatus] = useState<PushStatus>(
    supported ? { kind: 'idle' } : { kind: 'unsupported' },
  );
  const [devices, setDevices] = useState<DevicesState>({ kind: 'idle' });
  const [revokingId, setRevokingId] = useState<string | null>(null);

  // Relay URLs come from admin policy only - users pick one of the offered
  // relays, they never type a URL.
  const relayOptions = resolvePushRelayOptions(policy);
  const activeRelayUrl = resolveActiveRelayUrl(policy, pushRelayUrl);
  const relayChoiceFixed = pushRelayLocked || relayOptions.length < 2;
  const activeRelayLabel =
    relayOptions.find((option) => option.url === activeRelayUrl)?.label ?? activeRelayUrl;

  useEffect(() => {
    if (!supported) return;
    if (!client) return;
    const accountId = client.getAccountId();
    if (!accountId) return;
    void (async () => {
      const enabled = await isWebPushEnabled(accountId);
      setPushStatus(enabled ? { kind: 'enabled' } : { kind: 'idle' });
    })();
  }, [supported, client]);

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

  const busy = pushStatus.kind === 'busy';
  const pushEnabled = pushStatus.kind === 'enabled';
  const statusDescription = pushStatus.kind === 'unsupported'
    ? `${t('push.status_unsupported')} ${t('push.ios_hint')}`
    : busy
      ? t('push.status_busy')
      : pushEnabled
        ? t('push.status_active')
        : t('push.status_inactive');

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
      });
      setPushStatus({ kind: 'enabled' });
    } catch (err) {
      if (err instanceof WebPushUnsupportedError) {
        setPushStatus({ kind: 'unsupported' });
        return;
      }
      setPushStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to enable push',
      });
    } finally {
      await refreshDevices();
    }
  };

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
      setPushStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to disable push',
      });
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
      setPushStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to revoke device',
      });
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
      <SettingsSection title={t('push.title')} description={t('push.description')}>
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
              disabled={busy || pushStatus.kind === 'unsupported' || !client}
            />
          </div>
        </SettingItem>

        <SettingItem
          label={t('push.relay_label')}
          description={pushRelayLocked ? t('push.relay_locked_desc') : t('push.relay_desc')}
          locked={pushRelayLocked}
        >
          {relayChoiceFixed ? (
            <span className="text-sm text-muted-foreground">{activeRelayLabel}</span>
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

      {client && (
        <SettingsSection title={t('push.devices_title')} description={t('push.devices_desc')}>
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
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${devices.kind === 'loading' ? 'animate-spin' : ''}`} />
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

      <SettingsSection title={t('sound_selection.title')} description={t('sound_selection.description')}>
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

      <SettingsSection title={t('email.title')} description={t('email.description')}>
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
      </SettingsSection>

      <SettingsSection title={t('calendar.title')} description={t('calendar.description')}>
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

        <SettingItem
          label={t('calendar.invitation_parsing')}
          description={t('calendar.invitation_parsing_desc')}
        >
          <ToggleSwitch
            checked={calendarInvitationParsingEnabled}
            onChange={(checked) => updateSetting('calendarInvitationParsingEnabled', checked)}
          />
        </SettingItem>
      </SettingsSection>

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
