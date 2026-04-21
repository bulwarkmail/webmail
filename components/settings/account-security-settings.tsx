'use client';

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import * as OTPAuth from 'otpauth';
import { Shield, Key, Smartphone, Lock, Trash2, Plus, Eye, EyeOff, Copy, Check, Loader2, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { useAccountSecurityStore, type AppPasswordInfo } from '@/stores/account-security-store';
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
          placeholder={displayName || t('display_name.placeholder')}
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

function generateTotp(accountLabel: string): { totp: OTPAuth.TOTP; url: string } {
  const totp = new OTPAuth.TOTP({
    issuer: 'Stalwart',
    label: accountLabel || 'account',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });
  return { totp, url: totp.toString() };
}

function TotpSection() {
  const t = useTranslations('settings.security');
  const { otpEnabled, enableTotp, disableTotp, isSaving, isLoadingAuth } = useAccountSecurityStore();
  const { client } = useAuthStore();

  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [setupTotp, setSetupTotp] = useState<OTPAuth.TOTP | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [setupError, setSetupError] = useState<string | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);

  useEffect(() => {
    if (!setupUrl) { setQrDataUrl(null); return; }
    let cancelled = false;
    QRCode.toDataURL(setupUrl, { width: 220, margin: 1 })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [setupUrl]);

  const startSetup = () => {
    const { totp, url } = generateTotp(client?.getUsername() ?? 'account');
    setSetupTotp(totp);
    setSetupUrl(url);
    setPassword('');
    setOtpCode('');
    setSetupError(null);
  };

  const cancelSetup = () => {
    setSetupTotp(null);
    setSetupUrl(null);
    setPassword('');
    setOtpCode('');
    setSetupError(null);
  };

  const confirmSetup = async () => {
    if (!setupTotp || !setupUrl) return;
    if (!password) { setSetupError(t('totp.password_required')); return; }
    if (!otpCode.trim()) { setSetupError(t('totp.code_required')); return; }
    if (setupTotp.validate({ token: otpCode.trim(), window: 1 }) === null) {
      setSetupError(t('totp.code_invalid'));
      return;
    }

    try {
      await enableTotp(password, setupUrl, otpCode.trim());
      cancelSetup();
      toast.success(t('totp.enabled'));
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : t('totp.enable_error'));
    }
  };

  const handleDisable = async () => {
    if (!password) { setSetupError(t('totp.password_required')); return; }
    try {
      await disableTotp(password);
      setDisableOpen(false);
      setPassword('');
      setSetupError(null);
      toast.success(t('totp.disabled'));
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : t('totp.disable_error'));
    }
  };

  const handleToggle = (enable: boolean) => {
    setSetupError(null);
    if (enable) {
      startSetup();
    } else {
      setDisableOpen(true);
      setPassword('');
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
          <ToggleSwitch
            checked={otpEnabled || !!setupUrl}
            onChange={handleToggle}
            disabled={isSaving}
          />
          <span className={cn('text-xs font-medium', otpEnabled ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}>
            {otpEnabled ? t('totp.active') : t('totp.inactive')}
          </span>
        </div>
      </SettingItem>

      {setupUrl && (
        <div className="ml-4 p-3 bg-muted rounded-md space-y-3">
          <p className="text-xs text-muted-foreground">{t('totp.setup_instructions')}</p>
          {qrDataUrl && (
            <div className="flex justify-center">
              <img src={qrDataUrl} alt="TOTP QR code" className="rounded bg-white p-2" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <code className="text-xs bg-background px-2 py-1 rounded border border-border flex-1 truncate">{setupUrl}</code>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('password.current')}</label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('totp.verification_code')}</label>
            <Input value={otpCode} onChange={(e) => setOtpCode(e.target.value)} inputMode="numeric" maxLength={6} />
          </div>
          {setupError && <p className="text-xs text-destructive">{setupError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={confirmSetup} disabled={isSaving || !password || !otpCode}>
              {isSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('totp.confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelSetup}>{t('app_passwords.cancel')}</Button>
          </div>
        </div>
      )}

      {disableOpen && (
        <div className="ml-4 p-3 bg-muted rounded-md space-y-2">
          <p className="text-xs text-muted-foreground">{t('totp.disable_confirm_prompt')}</p>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('password.current')}
            autoComplete="current-password"
          />
          {setupError && <p className="text-xs text-destructive">{setupError}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={handleDisable} disabled={isSaving || !password}>
              {isSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {t('totp.disable')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setDisableOpen(false); setPassword(''); setSetupError(null); }}>
              {t('app_passwords.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function AppPasswordRow({ password, onRemove, isSaving }: { password: AppPasswordInfo; onRemove: (id: string) => void; isSaving: boolean }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 bg-muted/50 rounded-md">
      <div className="flex flex-col">
        <span className="text-sm text-foreground">{password.description || password.id}</span>
        {password.createdAt && (
          <span className="text-xs text-muted-foreground">
            {new Date(password.createdAt).toLocaleDateString()}
            {password.expiresAt ? ` · expires ${new Date(password.expiresAt).toLocaleDateString()}` : ''}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onRemove(password.id)}
        disabled={isSaving}
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </div>
  );
}

function AppPasswordsSection() {
  const t = useTranslations('settings.security');
  const { appPasswords, createAppPassword, removeAppPassword, isSaving, isLoadingAuth } = useAccountSecurityStore();
  const [showAdd, setShowAdd] = useState(false);
  const [newDescription, setNewDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDescription.trim()) return;

    try {
      const result = await createAppPassword(
        newDescription.trim(),
        expiresAt ? new Date(expiresAt).toISOString() : null,
      );
      setCreatedSecret(result.secret);
      setNewDescription('');
      setExpiresAt('');
      setShowAdd(false);
      toast.success(t('app_passwords.added'));
    } catch (err) {
      toast.error(t('app_passwords.add_error'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removeAppPassword(id);
      toast.success(t('app_passwords.removed'));
    } catch (err) {
      toast.error(t('app_passwords.remove_error'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleCopySecret = () => {
    if (!createdSecret) return;
    navigator.clipboard.writeText(createdSecret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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

      {createdSecret && (
        <div className="p-3 bg-muted rounded-md space-y-2">
          <p className="text-xs text-muted-foreground">{t('app_passwords.copy_now_warning')}</p>
          <div className="flex items-center gap-2">
            <code className="text-xs bg-background px-2 py-1 rounded border border-border flex-1 font-mono">
              {createdSecret}
            </code>
            <Button variant="outline" size="sm" onClick={handleCopySecret}>
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setCreatedSecret(null)}>
            {t('app_passwords.done')}
          </Button>
        </div>
      )}

      {showAdd && (
        <form onSubmit={handleAdd} className="p-3 bg-muted rounded-md space-y-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('app_passwords.name_label')}</label>
            <Input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder={t('app_passwords.name_placeholder')}
              required
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('app_passwords.expires_label')}</label>
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isSaving || !newDescription.trim()}>
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
          {appPasswords.map((p) => (
            <AppPasswordRow key={p.id} password={p} onRemove={handleRemove} isSaving={isSaving} />
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
  const { encryptionType, isLoadingCrypto } = useAccountSecurityStore();

  if (isLoadingCrypto) {
    return (
      <SettingItem label={t('encryption.label')} description={t('encryption.description')}>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </SettingItem>
    );
  }

  const isEnabled = encryptionType !== 'Disabled';
  return (
    <SettingItem label={t('encryption.label')} description={t('encryption.description')}>
      <span className={cn('text-xs font-medium', isEnabled ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground')}>
        {isEnabled ? t('encryption.active', { type: encryptionType }) : t('encryption.inactive')}
      </span>
    </SettingItem>
  );
}

function EmailClientSection() {
  const t = useTranslations('settings.security');
  const { client } = useAuthStore();
  const [copied, setCopied] = useState(false);

  const jmapUsername = useMemo(() => client?.getUsername() || '', [client]);

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
        <div className="text-sm text-muted-foreground py-4" dangerouslySetInnerHTML={{ __html: t('not_available') }} />
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
