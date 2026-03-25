'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, Key, Smartphone, Lock, Trash2, Plus, Eye, EyeOff, Copy, Check, Loader2, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { useAccountSecurityStore } from '@/stores/account-security-store';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/stores/toast-store';
import { cn } from '@/lib/utils';

function PasswordChangeSection() {
  const t = useTranslations('settings.security');
  const { changePassword, isSaving } = useAccountSecurityStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword.length < 8) {
      setError(t('password.error_min_length'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('password.error_mismatch'));
      return;
    }

    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success(t('password.success'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('password.error_generic');
      setError(msg);
      toast.error(t('password.error_title'), msg);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <Key className="w-4 h-4 text-muted-foreground" />
        <h4 className="text-sm font-medium text-foreground">{t('password.title')}</h4>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t('password.current')}</label>
          <div className="relative">
            <Input
              type={showCurrent ? 'text' : 'password'}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowCurrent(!showCurrent)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t('password.new')}</label>
          <div className="relative">
            <Input
              type={showNew ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowNew(!showNew)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">{t('password.confirm')}</label>
          <Input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </div>
        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}
        <Button
          type="submit"
          size="sm"
          disabled={isSaving || !currentPassword || !newPassword || !confirmPassword}
        >
          {isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
          {t('password.submit')}
        </Button>
      </form>
    </div>
  );
}

function DisplayNameSection() {
  const t = useTranslations('settings.security');
  const { displayName, updateDisplayName, isSaving, isLoadingPrincipal } = useAccountSecurityStore();
  const [name, setName] = useState(displayName);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(displayName);
  }, [displayName]);

  const handleSave = async () => {
    try {
      await updateDisplayName(name);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      toast.success(t('display_name.success'));
    } catch (err) {
      toast.error(t('display_name.error'), err instanceof Error ? err.message : undefined);
    }
  };

  if (isLoadingPrincipal) {
    return (
      <SettingItem label={t('display_name.label')} description={t('display_name.description')}>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </SettingItem>
    );
  }

  return (
    <SettingItem label={t('display_name.label')} description={t('display_name.description')}>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-48"
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isSaving || name === displayName}
        >
          {saved ? <Check className="w-4 h-4" /> : isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : t('display_name.save')}
        </Button>
      </div>
    </SettingItem>
  );
}

function TotpSection() {
  const t = useTranslations('settings.security');
  const { otpEnabled, enableTotp, disableTotp, isSaving, isLoadingAuth } = useAccountSecurityStore();
  const [totpUrl, setTotpUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleToggle = async (enable: boolean) => {
    try {
      if (enable) {
        const url = await enableTotp();
        setTotpUrl(url);
        toast.success(t('totp.enabled'));
      } else {
        await disableTotp();
        setTotpUrl(null);
        toast.success(t('totp.disabled'));
      }
    } catch (err) {
      toast.error(
        enable ? t('totp.enable_error') : t('totp.disable_error'),
        err instanceof Error ? err.message : undefined
      );
    }
  };

  const handleCopyUrl = () => {
    if (totpUrl) {
      navigator.clipboard.writeText(totpUrl).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  if (isLoadingAuth) {
    return (
      <SettingItem label={t('totp.label')} description={t('totp.description')}>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </SettingItem>
    );
  }

  return (
    <div className="space-y-3">
      <SettingItem label={t('totp.label')} description={t('totp.description')}>
        <div className="flex items-center gap-2">
          {isSaving ? (
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          ) : (
            <ToggleSwitch
              checked={otpEnabled}
              onChange={handleToggle}
              disabled={isSaving}
            />
          )}
          <span className={cn('text-xs font-medium', otpEnabled ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}>
            {otpEnabled ? t('totp.active') : t('totp.inactive')}
          </span>
        </div>
      </SettingItem>

      {totpUrl && (
        <div className="ml-4 p-3 bg-muted rounded-md space-y-2">
          <p className="text-xs text-muted-foreground">{t('totp.setup_instructions')}</p>
          <div className="flex items-center gap-2">
            <code className="text-xs bg-background px-2 py-1 rounded border border-border flex-1 truncate">
              {totpUrl}
            </code>
            <Button variant="outline" size="sm" onClick={handleCopyUrl}>
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AppPasswordsSection() {
  const t = useTranslations('settings.security');
  const { appPasswords, addAppPassword, removeAppPassword, isSaving, isLoadingAuth } = useAccountSecurityStore();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const generatePassword = useCallback(() => {
    const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    const array = new Uint8Array(24);
    crypto.getRandomValues(array);
    for (const byte of array) {
      result += chars[byte % chars.length];
    }
    // Format as xxxx-xxxx-xxxx-xxxx-xxxx-xxxx
    return result.match(/.{1,4}/g)?.join('-') ?? result;
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    const password = newPassword || generatePassword();

    try {
      await addAppPassword(newName.trim(), password);
      setNewName('');
      setNewPassword('');
      setShowAdd(false);
      toast.success(t('app_passwords.added'));
    } catch (err) {
      toast.error(t('app_passwords.add_error'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleRemove = async (name: string) => {
    try {
      await removeAppPassword(name);
      toast.success(t('app_passwords.removed'));
    } catch (err) {
      toast.error(t('app_passwords.remove_error'), err instanceof Error ? err.message : undefined);
    }
  };

  if (isLoadingAuth) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 mb-2">
          <Smartphone className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">{t('app_passwords.title')}</h4>
        </div>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Smartphone className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">{t('app_passwords.title')}</h4>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="w-3 h-3 mr-1" />
          {t('app_passwords.add')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('app_passwords.description')}</p>

      {showAdd && (
        <form onSubmit={handleAdd} className="p-3 bg-muted rounded-md space-y-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('app_passwords.name_label')}</label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('app_passwords.name_placeholder')}
              required
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('app_passwords.password_label')}</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder={t('app_passwords.password_placeholder')}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setNewPassword(generatePassword())}>
                {t('app_passwords.generate')}
              </Button>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isSaving || !newName.trim()}>
              {isSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('app_passwords.create')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
              {t('app_passwords.cancel')}
            </Button>
          </div>
        </form>
      )}

      {appPasswords.length > 0 ? (
        <div className="space-y-1">
          {appPasswords.map((name) => (
            <div key={name} className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-md">
              <span className="text-sm text-foreground">{name}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRemove(name)}
                disabled={isSaving}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">{t('app_passwords.none')}</p>
      )}
    </div>
  );
}

function EncryptionSection() {
  const t = useTranslations('settings.security');
  const { encryptionType, updateEncryption, isSaving, isLoadingCrypto } = useAccountSecurityStore();

  const handleToggle = async (enabled: boolean) => {
    try {
      if (enabled) {
        await updateEncryption({ type: 'pgp', algo: 'Aes256' });
        toast.success(t('encryption.enabled'));
      } else {
        await updateEncryption({ type: 'disabled' });
        toast.success(t('encryption.disabled_success'));
      }
    } catch (err) {
      toast.error(t('encryption.error'), err instanceof Error ? err.message : undefined);
    }
  };

  if (isLoadingCrypto) {
    return (
      <SettingItem label={t('encryption.label')} description={t('encryption.description')}>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </SettingItem>
    );
  }

  const isEnabled = encryptionType !== 'disabled';

  return (
    <SettingItem label={t('encryption.label')} description={t('encryption.description')}>
      <div className="flex items-center gap-2">
        {isSaving ? (
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        ) : (
          <ToggleSwitch
            checked={isEnabled}
            onChange={handleToggle}
            disabled={isSaving}
          />
        )}
        <span className={cn('text-xs font-medium', isEnabled ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}>
          {isEnabled ? t('encryption.active', { type: encryptionType.toUpperCase() }) : t('encryption.inactive')}
        </span>
      </div>
    </SettingItem>
  );
}

function EmailClientSection() {
  const t = useTranslations('settings.security');
  const { client } = useAuthStore();
  const [copied, setCopied] = useState(false);

  const jmapUsername = client?.getUsername() || '';

  const handleCopy = () => {
    navigator.clipboard.writeText(jmapUsername).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Monitor className="w-4 h-4 text-muted-foreground" />
        <h4 className="text-sm font-medium text-foreground">{t('email_client.title')}</h4>
      </div>
      <p className="text-xs text-muted-foreground">{t('email_client.description')}</p>
      <div className="p-3 bg-muted/70 dark:bg-muted/40 rounded-md space-y-2">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">
            {t('email_client.jmap_username_label')}
          </label>
          <div className="flex rounded-lg">
            <input
              type="text"
              readOnly
              value={jmapUsername}
              className="py-2 px-3 block w-full bg-background border border-border border-e-transparent rounded-s-lg text-sm text-foreground focus:z-10 focus:border-ring focus:ring-ring"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="h-[38px] px-3 shrink-0 inline-flex items-center gap-1.5 rounded-e-lg border border-border bg-muted text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t('email_client.copied') : t('email_client.copy')}
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground pt-1">{t('email_client.password_instructions')}</p>
      </div>
    </div>
  );
}

export function AccountSecuritySettings() {
  const t = useTranslations('settings.security');
  const { isStalwart, isProbing, probe, fetchAll, fetchAuthInfo } = useAccountSecurityStore();
  const { isAuthenticated, authMode } = useAuthStore();
  const isOAuth = authMode === 'oauth';

  useEffect(() => {
    if (isAuthenticated && isStalwart === null) {
      probe().then((detected) => {
        if (detected) {
          if (isOAuth) {
            fetchAuthInfo();
          } else {
            fetchAll();
          }
        }
      });
    }
  }, [isAuthenticated, isStalwart, probe, fetchAll, fetchAuthInfo, isOAuth]);

  if (isProbing) {
    return (
      <SettingsSection title={t('title')} description={t('description')}>
        <div className="flex items-center gap-2 py-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{t('detecting')}</span>
        </div>
      </SettingsSection>
    );
  }

  if (isStalwart === false) {
    return (
      <SettingsSection title={t('title')} description={t('description')}>
        <p className="text-sm text-muted-foreground py-4">{t('not_available')}</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <div className="space-y-6">
        {!isOAuth && (
          <>
            <PasswordChangeSection />
            <div className="border-t border-border" />
            <DisplayNameSection />
            <div className="border-t border-border" />
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Shield className="w-4 h-4 text-muted-foreground" />
                <h4 className="text-sm font-medium text-foreground">{t('totp.section_title')}</h4>
              </div>
              <TotpSection />
            </div>
            <div className="border-t border-border" />
          </>
        )}

        <AppPasswordsSection />

        {isOAuth && (
          <>
            <div className="border-t border-border" />
            <EmailClientSection />
          </>
        )}

        {!isOAuth && (
          <>
            <div className="border-t border-border" />
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Lock className="w-4 h-4 text-muted-foreground" />
                <h4 className="text-sm font-medium text-foreground">{t('encryption.section_title')}</h4>
              </div>
              <EncryptionSection />
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
