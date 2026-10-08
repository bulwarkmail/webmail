'use client';

import { useState, useEffect, useMemo, useCallback, useId, useRef } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import * as OTPAuth from 'otpauth';
import { Shield, Key, Smartphone, Lock, Trash2, Plus, Eye, EyeOff, Copy, Check, CheckCircle, Loader2, Monitor, Terminal, QrCode, Unlock, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { useAccountSecurityStore, type AppPasswordInfo, type ApiKeyInfo, type AppCredentialInput } from '@/stores/account-security-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { apiFetch, getPathPrefix } from '@/lib/browser-navigation';
import { toast } from '@/stores/toast-store';
import { cn } from '@/lib/utils';
import { sanitizeI18nHtml } from '@/lib/email-sanitization';
import { IS_LITE } from '@/lib/lite';
import { useConfig } from '@/hooks/use-config';
import { totpIssuer } from '@/lib/totp-issuer';

function PasswordChangeSection() {
  const t = useTranslations('settings.security');
  const { changePassword, isSaving, otpEnabled } = useAccountSecurityStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
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
      await changePassword(currentPassword, newPassword, otpEnabled ? otpCode : undefined);
      setCurrentPassword('');
      setOtpCode('');
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
              className="pe-10"
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
        {otpEnabled && (
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('totp.verification_code')}</label>
            <Input
              value={otpCode}
              onChange={(e) => setOtpCode(e.target.value)}
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
          </div>
        )}
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
              className="pe-10"
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
          disabled={isSaving || !currentPassword || !newPassword || !confirmPassword || (otpEnabled && !otpCode.trim())}
        >
          {isSaving ? <Loader2 className="w-4 h-4 me-2 animate-spin" /> : null}
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

function generateTotp(accountLabel: string, issuer: string): { totp: OTPAuth.TOTP; url: string } {
  const totp = new OTPAuth.TOTP({
    issuer,
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
  const { appName } = useConfig();

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
    const { totp, url } = generateTotp(client?.getUsername() ?? 'account', totpIssuer(appName));
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
    if (!otpCode.trim()) { setSetupError(t('totp.code_required')); return; }
    try {
      await disableTotp(password, otpCode);
      setDisableOpen(false);
      setPassword('');
      setOtpCode('');
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
      setOtpCode('');
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
        <div className="ms-4 p-3 bg-muted rounded-md space-y-3">
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
              {isSaving ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : null}
              {t('totp.confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={cancelSetup}>{t('app_passwords.cancel')}</Button>
          </div>
        </div>
      )}

      {disableOpen && (
        <div className="ms-4 p-3 bg-muted rounded-md space-y-2">
          <p className="text-xs text-muted-foreground">{t('totp.disable_confirm_prompt')}</p>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('password.current')}
            autoComplete="current-password"
          />
          <Input
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value)}
            placeholder={t('totp.verification_code')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          {setupError && <p className="text-xs text-destructive">{setupError}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={handleDisable} disabled={isSaving || !password || !otpCode.trim()}>
              {isSaving ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : null}
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

function parseIpList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function CredentialRow({ entry, onRemove, isSaving }: { entry: AppPasswordInfo | ApiKeyInfo; onRemove: (id: string) => void; isSaving: boolean }) {
  return (
    <div className="flex items-start justify-between py-2 px-3 bg-muted/50 rounded-md gap-2">
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm text-foreground truncate">{entry.description || entry.id}</span>
        {entry.createdAt && (
          <span className="text-xs text-muted-foreground">
            {new Date(entry.createdAt).toLocaleDateString()}
            {entry.expiresAt ? ` · expires ${new Date(entry.expiresAt).toLocaleDateString()}` : ''}
          </span>
        )}
        {entry.allowedIps.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {entry.allowedIps.map((ip) => (
              <span
                key={ip}
                className="text-[10px] font-mono bg-background border border-border rounded px-1.5 py-0.5 text-muted-foreground"
              >
                {ip}
              </span>
            ))}
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onRemove(entry.id)}
        disabled={isSaving}
        className="text-destructive hover:text-destructive shrink-0"
      >
        <Trash2 className="w-3 h-3" />
      </Button>
    </div>
  );
}

interface CredentialSectionProps {
  icon: typeof Smartphone;
  i18nNamespace: 'app_passwords' | 'api_keys';
  entries: Array<AppPasswordInfo | ApiKeyInfo>;
  onCreate: (input: AppCredentialInput) => Promise<{ id: string; secret: string }>;
  onRemove: (id: string) => Promise<void>;
}

function CredentialSection({ icon: Icon, i18nNamespace, entries, onCreate, onRemove }: CredentialSectionProps) {
  const t = useTranslations('settings.security');
  const tk = (key: string) => t(`${i18nNamespace}.${key}`);
  const { isSaving, isLoadingAuth } = useAccountSecurityStore();
  const [showAdd, setShowAdd] = useState(false);
  const [newDescription, setNewDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [allowedIpsRaw, setAllowedIpsRaw] = useState('');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDescription.trim()) return;

    try {
      const result = await onCreate({
        description: newDescription.trim(),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        allowedIps: parseIpList(allowedIpsRaw),
      });
      setCreatedSecret(result.secret);
      setNewDescription('');
      setExpiresAt('');
      setAllowedIpsRaw('');
      setShowAdd(false);
      toast.success(tk('added'));
    } catch (err) {
      toast.error(tk('add_error'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await onRemove(id);
      toast.success(tk('removed'));
    } catch (err) {
      toast.error(tk('remove_error'), err instanceof Error ? err.message : undefined);
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
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">{tk('title')}</h4>
        </div>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">{tk('title')}</h4>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="w-3 h-3 me-1" />
          {t('app_passwords.add')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{tk('description')}</p>

      {createdSecret && (
        <div className="p-3 bg-muted rounded-md space-y-2">
          <p className="text-xs text-muted-foreground">{tk('copy_now_warning')}</p>
          <div className="flex items-center gap-2">
            <code className="text-xs bg-background px-2 py-1 rounded border border-border flex-1 font-mono break-all">
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
            <label className="text-xs text-muted-foreground mb-1 block">{tk('name_label')}</label>
            <Input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder={tk('name_placeholder')}
              required
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('app_passwords.expires_label')}</label>
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('app_passwords.allowed_ips_label')}</label>
            <textarea
              value={allowedIpsRaw}
              onChange={(e) => setAllowedIpsRaw(e.target.value)}
              placeholder={t('app_passwords.allowed_ips_placeholder')}
              rows={2}
              className="w-full text-xs font-mono px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-[10px] text-muted-foreground mt-1">{t('app_passwords.allowed_ips_hint')}</p>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isSaving || !newDescription.trim()}>
              {isSaving ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : null}
              {t('app_passwords.create')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
              {t('app_passwords.cancel')}
            </Button>
          </div>
        </form>
      )}

      {entries.length > 0 ? (
        <div className="space-y-1">
          {entries.map((entry) => (
            <CredentialRow key={entry.id} entry={entry} onRemove={handleRemove} isSaving={isSaving} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">{tk('none')}</p>
      )}
    </div>
  );
}

function AppPasswordsSection() {
  const { appPasswords, createAppPassword, removeAppPassword } = useAccountSecurityStore();
  return (
    <CredentialSection
      icon={Smartphone}
      i18nNamespace="app_passwords"
      entries={appPasswords}
      onCreate={createAppPassword}
      onRemove={removeAppPassword}
    />
  );
}

function ApiKeysSection() {
  const { apiKeys, createApiKey, removeApiKey } = useAccountSecurityStore();
  return (
    <CredentialSection
      icon={Terminal}
      i18nNamespace="api_keys"
      entries={apiKeys}
      onCreate={createApiKey}
      onRemove={removeApiKey}
    />
  );
}

function PublicKeysSection() {
  const t = useTranslations('settings.security');
  const tk = (key: string) => t(`public_keys.${key}`);
  const {
    publicKeys,
    createPublicKey,
    removePublicKey,
    encryptionConfig,
    updateEncryptionAtRest,
    isSaving,
    isLoadingAuth,
  } = useAccountSecurityStore();

  const [showAdd, setShowAdd] = useState(false);
  const [description, setDescription] = useState('');
  const [publicKey, setPublicKey] = useState('');

  // Encryption config dialog state
  const [selectedKeyForEncryption, setSelectedKeyForEncryption] = useState<string | null>(null);
  const [selectedAlgorithm, setSelectedAlgorithm] = useState<'Aes128' | 'Aes256'>('Aes256');
  const [encryptOnAppend, setEncryptOnAppend] = useState(false);
  const [allowSpamTraining, setAllowSpamTraining] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim() || !publicKey.trim()) return;

    try {
      await createPublicKey({
        description: description.trim(),
        key: publicKey.trim(),
      });
      setDescription('');
      setPublicKey('');
      setShowAdd(false);
      toast.success(tk('added'));
    } catch (err) {
      toast.error(tk('add_error'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await removePublicKey(id);
      toast.success(tk('removed'));
    } catch (err) {
      toast.error(tk('remove_error'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleToggleEncryption = async (keyId: string) => {
    const isCurrentlyActiveKey =
      encryptionConfig.type !== 'Disabled' && encryptionConfig.publicKeyId === keyId;

    if (isCurrentlyActiveKey) {
      // Disable encryption
      try {
        await updateEncryptionAtRest({ type: 'Disabled' });
        toast.success(t('encryption.disabled_success'));
      } catch (err) {
        toast.error(t('encryption.error'), err instanceof Error ? err.message : undefined);
      }
    } else {
      // Open algorithm selection dialog for this key
      setSelectedKeyForEncryption(keyId);
      setSelectedAlgorithm('Aes256');
      setEncryptOnAppend(false);
      setAllowSpamTraining(false);
    }
  };

  const handleEnableEncryptionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedKeyForEncryption) return;

    try {
      await updateEncryptionAtRest({
        type: selectedAlgorithm,
        publicKeyId: selectedKeyForEncryption,
        encryptOnAppend,
        allowSpamTraining,
      });
      setSelectedKeyForEncryption(null);
      toast.success(t('encryption.enabled_success'));
    } catch (err) {
      toast.error(t('encryption.error'), err instanceof Error ? err.message : undefined);
    }
  };

  if (isLoadingAuth) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 mb-2">
          <Lock className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">{tk('title')}</h4>
        </div>
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-muted-foreground" />
          <h4 className="text-sm font-medium text-foreground">{t('encryption.section_title')}</h4>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="w-3 h-3 me-1" />
          {t('app_passwords.add')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('encryption.description')}</p>

      {showAdd && (
        <form onSubmit={handleAdd} className="p-3 bg-muted rounded-md space-y-2">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{tk('name_label')}</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tk('name_placeholder')}
              required
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{tk('key_label')}</label>
            <textarea
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder={tk('key_placeholder')}
              rows={3}
              required
              className="w-full text-xs font-mono px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={isSaving || !description.trim() || !publicKey.trim()}>
              {isSaving ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : null}
              {t('app_passwords.create')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
              {t('app_passwords.cancel')}
            </Button>
          </div>
        </form>
      )}

      {selectedKeyForEncryption && (
        <form onSubmit={handleEnableEncryptionSubmit} className="p-3 bg-muted border border-border rounded-md space-y-3">
          <h5 className="text-xs font-semibold text-foreground">{t('encryption.configure_title')}</h5>
          
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">{t('encryption.algorithm_label')}</label>
            <select
              value={selectedAlgorithm}
              onChange={(e) => setSelectedAlgorithm(e.target.value as 'Aes128' | 'Aes256')}
              className="w-full text-xs px-3 py-1.5 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="Aes256">AES-256</option>
              <option value="Aes128">AES-128</option>
            </select>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground">
              <input
                type="checkbox"
                checked={encryptOnAppend}
                onChange={(e) => setEncryptOnAppend(e.target.checked)}
                className="rounded border-border text-primary focus:ring-ring"
              />
              {t('encryption.encrypt_on_append')}
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-xs text-foreground">
              <input
                type="checkbox"
                checked={allowSpamTraining}
                onChange={(e) => setAllowSpamTraining(e.target.checked)}
                className="rounded border-border text-primary focus:ring-ring"
              />
              {t('encryption.allow_spam_training')}
            </label>
          </div>

          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={isSaving}>
              {isSaving ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : null}
              {t('encryption.enable_button')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelectedKeyForEncryption(null)}
            >
              {t('app_passwords.cancel')}
            </Button>
          </div>
        </form>
      )}

      {publicKeys.length > 0 ? (
        <div className="space-y-1">
          {publicKeys.map((key) => {
            const isEncryptedWithThisKey =
              encryptionConfig.type !== 'Disabled' && encryptionConfig.publicKeyId === key.id;

            return (
              <div key={key.id} className="flex items-start justify-between py-2 px-3 bg-muted/50 rounded-md gap-2">
                <div className="flex flex-col min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground truncate">{key.description || key.id}</span>
                    {isEncryptedWithThisKey && (
                      <span className="text-[10px] bg-green-500/10 text-green-600 dark:text-green-400 font-medium px-1.5 py-0.5 rounded border border-green-500/20">
                        {encryptionConfig.type}
                      </span>
                    )}
                  </div>
                  {key.createdAt && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(key.createdAt).toLocaleDateString()}
                    </span>
                  )}
                  <code className="text-[10px] font-mono bg-background border border-border rounded px-1.5 py-0.5 text-muted-foreground truncate mt-1">
                    {key.key}
                  </code>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggleEncryption(key.id)}
                    disabled={isSaving}
                    title={isEncryptedWithThisKey ? t('encryption.disable_tooltip') : t('encryption.enable_tooltip')}
                    className={cn(
                      isEncryptedWithThisKey
                        ? 'text-green-600 hover:text-green-700 dark:text-green-400'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {isEncryptedWithThisKey ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
                  </Button>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(key.id)}
                    disabled={isSaving || isEncryptedWithThisKey}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">{tk('none')}</p>
      )}
    </div>
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

type LinkDevicePhase = 'idle' | 'password' | 'code' | 'redeemed' | 'expired';

interface LinkDeviceMessage {
  text: string;
  tone: 'error' | 'info';
}

interface PairCreateOptions {
  /** Step-up proof from the password form; omitted on the first try. */
  password?: string;
  totp?: string;
  /** Just back from the IdP re-auth: never bounce to the IdP again. */
  fromResume?: boolean;
}

const PAIR_STATUS_POLL_MS = 2000;
const PAIR_DEFAULT_EXPIRES_IN = 120;

// Cross-device sign-in for the mobile app. /api/auth/pair/create mints a
// short-lived, single-use code for the active account; we show it as a QR
// (plus a copyable bulwarkmail:// link) that the app redeems against this
// webmail for a sign-in of its own. The payload carries only the webmail base
// URL and the code, never tokens or the password.
//
// Minting needs a fresh proof of identity, so the server answers
// `reauth_required` until the user has just re-authenticated: accounts that
// signed in through the identity provider go back there (prompt=login),
// password accounts confirm their password (and TOTP code) right here.
export function LinkDeviceSection() {
  const t = useTranslations('settings.security');
  const params = useParams();
  const locale = params.locale as string;
  const otpEnabled = useAccountSecurityStore((s) => s.otpEnabled);
  const { oauthEnabled } = useConfig();

  const [phase, setPhase] = useState<LinkDevicePhase>('idle');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<LinkDeviceMessage | null>(null);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpRequested, setTotpRequested] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [signInLink, setSignInLink] = useState('');
  const [statusId, setStatusId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);

  const fieldId = useId();
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const totpInputRef = useRef<HTMLInputElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  // False once unmounted, so late responses and timers leave state alone.
  const aliveRef = useRef(true);
  // Bumped by every create request and by cancel: a response that is no
  // longer the latest request is dropped.
  const requestRef = useRef(0);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showTotp = otpEnabled || totpRequested;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Count down from the server's expiry; at zero the code is useless, so the
  // QR gives way to the "expired" panel.
  useEffect(() => {
    if (phase !== 'code') return;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) setPhase('expired');
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, expiresAt]);

  // Watch the shown code: once the phone redeems it, swap the QR for a
  // confirmation; if the server forgot or expired it, offer a new one. A new
  // code (new statusId) or leaving the "code" phase restarts or stops this.
  useEffect(() => {
    if (phase !== 'code' || !statusId) return;
    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await apiFetch(`/api/auth/pair/status?id=${encodeURIComponent(statusId)}`, {
          credentials: 'include',
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const status = data && typeof data === 'object' ? (data as { status?: unknown }).status : undefined;
        if (status === 'redeemed') setPhase('redeemed');
        else if (status === 'expired' || status === 'unknown') setPhase('expired');
      } catch {
        /* transient network error: try again on the next tick */
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => { void poll(); }, PAIR_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, statusId]);

  const clearCredentials = useCallback(() => {
    setPassword('');
    setTotp('');
    setShowPassword(false);
    setTotpRequested(false);
  }, []);

  // Send the user to the IdP for a fresh login (prompt=login). On return the
  // callback page sets the pairing re-auth proof and bounces back here, where
  // the resume effect below calls create() again.
  const startReauth = useCallback(async () => {
    const prefix = getPathPrefix(locale);
    const redirectUri = `${window.location.origin}${prefix}/${locale}/auth/callback`;
    // The slot lets the server re-authenticate against this account's own
    // server entry (its IdP), read from the slot's server cookie.
    const slot = useAccountStore.getState().getActiveAccount()?.cookieSlot ?? 0;
    try {
      const res = await apiFetch('/api/auth/sso/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ redirect_uri: redirectUri, locale, purpose: 'reauth', slot }),
      });
      if (!res.ok) throw new Error(`sso/start answered ${res.status}`);
      const { authorize_url, state } = await res.json();
      if (typeof authorize_url !== 'string' || typeof state !== 'string') throw new Error('sso/start answered no URL');
      // The callback takes the re-auth route only for this state: a flag left
      // behind by an abandoned round trip must not capture a later login.
      try {
        sessionStorage.setItem('pair_reauth_resume', state);
      } catch { /* sessionStorage unavailable */ }
      window.location.href = authorize_url;
    } catch {
      if (aliveRef.current) setMessage({ text: t('link_device.error'), tone: 'error' });
    }
  }, [locale, t]);

  const create = useCallback(async ({ password: pw, totp: code, fromResume = false }: PairCreateOptions = {}) => {
    const request = ++requestRef.current;
    const isCurrent = () => aliveRef.current && request === requestRef.current;
    const fail = (text: string, tone: LinkDeviceMessage['tone'] = 'error') => setMessage({ text, tone });
    const backToIdle = (text: string) => {
      clearCredentials();
      setPhase('idle');
      fail(text);
    };

    setLoading(true);
    setMessage(null);
    try {
      // Pair the account whose session cookie the server reads: the active
      // account's slot.
      const account = useAccountStore.getState().getActiveAccount();
      const slot = account?.cookieSlot ?? 0;
      // The phone redeems the code against THIS webmail (where the pairing
      // record lives), so the link carries the webmail base (origin plus any
      // mount prefix), not the JMAP server URL. The JMAP server_url comes
      // back in the redeem response.
      const webmailBase = `${window.location.origin}${getPathPrefix()}`;
      // This webmail's own OAuth callback, built like startReauth's. The
      // server only uses it for servers that insist on a registered redirect
      // during the password step-up.
      const redirectUri = `${window.location.origin}${getPathPrefix(locale)}/${locale}/auth/callback`;
      const body: {
        slot: number;
        webmail_base: string;
        redirect_uri: string;
        password?: string;
        totp?: string;
      } = {
        slot,
        webmail_base: webmailBase,
        redirect_uri: redirectUri,
      };
      if (pw !== undefined) {
        body.password = pw;
        if (code) body.totp = code;
      }
      const res = await apiFetch('/api/auth/pair/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!isCurrent()) return;

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (!isCurrent()) return;
        const reason = errBody && typeof errBody.error === 'string' ? errBody.error : '';
        switch (reason) {
          case 'reauth_required':
            if (account?.providerSession === true) {
              // `fromResume` guards against a redirect loop: if we just came
              // back from the IdP and the server still wants a re-auth, say so
              // instead of bouncing to the IdP again.
              if (fromResume) fail(t('link_device.error'));
              else await startReauth();
              return;
            }
            setPhase('password');
            // A password we just sent was not enough: say so rather than
            // silently asking again.
            if (pw !== undefined) fail(t('link_device.error'));
            return;
          case 'invalid_credentials':
            setPhase('password');
            setPassword('');
            setTotp('');
            fail(t('link_device.error_wrong_password'));
            passwordInputRef.current?.focus();
            return;
          case 'totp_required':
            setPhase('password');
            setTotpRequested(true);
            setTotp('');
            // With a code already sent this is a failed attempt, and Stalwart
            // answers a wrong code exactly like a wrong password, so name both.
            if (code) fail(t('link_device.error_password_or_code'));
            else fail(t('link_device.totp_prompt'), 'info');
            // Not mounted yet on the first request; its autoFocus covers that.
            totpInputRef.current?.focus();
            return;
          case 'not_signed_in':
            backToIdle(t('link_device.error_not_signed_in'));
            return;
          case 'impersonation':
            backToIdle(t('link_device.error_impersonation'));
            return;
          case 'session_secret_required':
            backToIdle(t('link_device.error_session_secret'));
            return;
          case 'pairing_unavailable':
            backToIdle(t('link_device.error_pairing_unavailable'));
            return;
          case 'insecure_server':
            backToIdle(t('link_device.error_insecure_server'));
            return;
          case 'too_many_attempts':
            setTotp('');
            fail(t('link_device.error_too_many_attempts'));
            return;
          case 'server_unreachable':
            setTotp('');
            fail(t('link_device.error_server_unreachable'));
            return;
          default:
            // Includes `invalid_request`.
            fail(t('link_device.error'));
            return;
        }
      }

      const data = await res.json();
      const pairingCode = typeof data?.pairing_code === 'string' ? data.pairing_code : '';
      if (!pairingCode) throw new Error('pair/create returned no pairing_code');
      const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0
        ? data.expires_in
        : PAIR_DEFAULT_EXPIRES_IN;
      const link = `bulwarkmail://pair?server=${encodeURIComponent(webmailBase)}&code=${encodeURIComponent(pairingCode)}`;
      const dataUrl = await QRCode.toDataURL(link, { width: 240, margin: 1 });
      if (!isCurrent()) return;

      clearCredentials();
      setQrDataUrl(dataUrl);
      setSignInLink(link);
      setStatusId(typeof data.status_id === 'string' && data.status_id ? data.status_id : null);
      setExpiresAt(Date.now() + expiresIn * 1000);
      setRemaining(expiresIn);
      setCopied(false);
      setPhase('code');
    } catch {
      if (isCurrent()) fail(t('link_device.error'));
    } finally {
      if (isCurrent()) {
        setLoading(false);
        // The resume is done only once a mounted section has shown its result.
        if (fromResume) {
          try { sessionStorage.removeItem('pair_reauth_done'); } catch { /* unavailable */ }
        }
      }
    }
  }, [t, locale, startReauth, clearCredentials]);

  // Auto-resume after returning from the IdP re-auth round-trip. Runs once on
  // mount; the ref keeps it off `create`'s identity. The flag stays until the
  // result is shown: the Security tab remounts this section while it probes
  // the server, and a response that lands on the unmounted one is dropped.
  const createRef = useRef(create);
  useEffect(() => {
    createRef.current = create;
  }, [create]);
  useEffect(() => {
    let resume = false;
    try {
      resume = sessionStorage.getItem('pair_reauth_done') === '1';
    } catch { /* sessionStorage unavailable */ }
    if (resume) void createRef.current({ fromResume: true });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || !password || (showTotp && !totp.trim())) return;
    void create({ password, totp: showTotp ? totp.trim() : undefined });
  };

  const handleCancel = () => {
    requestRef.current += 1; // drop an in-flight request
    clearCredentials();
    setLoading(false);
    setMessage(null);
    setPhase('idle');
  };

  const handleCopyLink = () => {
    if (!signInLink) return;
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard) {
      // No clipboard API (e.g. plain http): select it for a manual copy.
      linkInputRef.current?.select();
      return;
    }
    clipboard.writeText(signInLink).then(() => {
      if (!aliveRef.current) return;
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        if (aliveRef.current) setCopied(false);
      }, 2000);
    }).catch(() => {
      linkInputRef.current?.select();
    });
  };

  const messageNode = message && (
    message.tone === 'error' ? (
      <p role="alert" className="text-xs text-destructive">{message.text}</p>
    ) : (
      <p role="status" className="text-xs text-muted-foreground">{message.text}</p>
    )
  );

  const announcement =
    phase === 'redeemed' ? t('link_device.success_title')
      : phase === 'expired' ? t('link_device.expired')
        : '';

  return (
    <div className="space-y-3">
      <p className="sr-only" aria-live="polite">{announcement}</p>
      <div className="flex items-center gap-2">
        <QrCode className="w-4 h-4 text-muted-foreground" />
        <h4 className="text-sm font-medium text-foreground">{t('link_device.title')}</h4>
      </div>
      <p className="text-xs text-muted-foreground">{t('link_device.description')}</p>

      {phase === 'password' && (
        <form onSubmit={handleSubmit} className="p-3 bg-muted/70 dark:bg-muted/40 rounded-md space-y-3">
          <p className="text-xs text-muted-foreground">{t('link_device.password_prompt')}</p>
          <div>
            <label htmlFor={`${fieldId}-password`} className="text-xs text-muted-foreground mb-1 block">
              {t('password.current')}
            </label>
            <div className="relative">
              <Input
                id={`${fieldId}-password`}
                ref={passwordInputRef}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
                className="pe-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t('link_device.hide_password') : t('link_device.show_password')}
                className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          {showTotp && (
            <div>
              <label htmlFor={`${fieldId}-totp`} className="text-xs text-muted-foreground mb-1 block">
                {t('totp.verification_code')}
              </label>
              <Input
                id={`${fieldId}-totp`}
                ref={totpInputRef}
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                required
                autoFocus={totpRequested}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
              />
            </div>
          )}
          {messageNode}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={loading || !password || (showTotp && !totp.trim())}>
              {loading ? <Loader2 className="w-4 h-4 me-1 animate-spin" /> : null}
              {t('link_device.continue')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={handleCancel}>
              {t('app_passwords.cancel')}
            </Button>
          </div>
          {/* Sessions from before `providerSession` was recorded land here even
              when they came through the identity provider, and an SSO-only
              account has no password to type. */}
          {oauthEnabled && (
            <button
              type="button"
              onClick={() => void startReauth()}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t('link_device.use_sso')}
            </button>
          )}
        </form>
      )}

      {phase === 'code' && qrDataUrl && (
        <div className="p-3 bg-muted/70 dark:bg-muted/40 rounded-md space-y-3">
          <div className="flex justify-center">
            <img src={qrDataUrl} alt={t('link_device.qr_alt')} className="rounded bg-white p-2" />
          </div>
          <p className="text-xs text-muted-foreground text-center">{t('link_device.instructions')}</p>
          <div className="space-y-1.5">
            <label htmlFor={`${fieldId}-link`} className="text-xs text-muted-foreground block">
              {t('link_device.link_label')}
            </label>
            <input
              id={`${fieldId}-link`}
              ref={linkInputRef}
              type="text"
              readOnly
              dir="ltr"
              value={signInLink}
              onFocus={(e) => e.currentTarget.select()}
              className="py-2 px-3 block w-full bg-background border border-border rounded-md text-xs font-mono text-foreground focus:border-ring focus:ring-ring"
            />
            <Button type="button" variant="outline" size="sm" onClick={handleCopyLink}>
              {copied ? <Check className="w-3 h-3 me-1" /> : <Copy className="w-3 h-3 me-1" />}
              <span aria-live="polite">{copied ? t('link_device.copied') : t('link_device.copy_link')}</span>
            </Button>
            <p className="text-[11px] text-muted-foreground">{t('link_device.copy_hint')}</p>
          </div>
          <p className="text-[11px] text-muted-foreground text-center">
            {t('link_device.expires_in', { seconds: remaining })}
          </p>
        </div>
      )}

      {phase === 'redeemed' && (
        <div className="p-3 bg-muted/70 dark:bg-muted/40 rounded-md flex flex-col items-center text-center gap-2">
          <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">{t('link_device.success_title')}</p>
          <p className="text-xs text-muted-foreground">{t('link_device.success_body')}</p>
          <Button variant="outline" size="sm" onClick={() => void create()} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 me-1 animate-spin" /> : <Plus className="w-3 h-3 me-1" />}
            {t('link_device.link_another')}
          </Button>
        </div>
      )}

      {phase === 'expired' && (
        <div className="p-3 bg-muted/70 dark:bg-muted/40 rounded-md flex flex-col items-center text-center gap-2">
          <p className="text-sm text-foreground">{t('link_device.expired')}</p>
          <Button variant="outline" size="sm" onClick={() => void create()} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 me-1 animate-spin" /> : <RefreshCw className="w-3 h-3 me-1" />}
            {t('link_device.regenerate')}
          </Button>
        </div>
      )}

      {phase !== 'password' && messageNode}

      {phase === 'idle' && (
        <Button variant="outline" size="sm" onClick={() => void create()} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 me-1 animate-spin" /> : <QrCode className="w-3 h-3 me-1" />}
          {t('link_device.generate')}
        </Button>
      )}

      {phase === 'code' && (
        <Button variant="ghost" size="sm" onClick={() => void create()} disabled={loading}>
          {loading ? <Loader2 className="w-3 h-3 me-1 animate-spin" /> : <RefreshCw className="w-3 h-3 me-1" />}
          {t('link_device.regenerate')}
        </Button>
      )}
    </div>
  );
}

export function AccountSecuritySettings() {
  const t = useTranslations('settings.security');
  const { isStalwart, isProbing, probe, fetchAll, fetchAuthInfo, fetchPublicKeys, fetchCryptoInfo } = useAccountSecurityStore();
  const { isAuthenticated, authMode, client } = useAuthStore();
  // OAuth and access-token sign-ins hold no password to change, and mail
  // apps need an app password instead.
  const withoutPassword = authMode === 'oauth' || authMode === 'token';

  // Wait for `client` before probing. On reload the persisted `isAuthenticated`
  // flips true before the async OAuth reconnect sets `client`; probing in that
  // window reads a null client, decides the server isn't Stalwart, and caches
  // that wrong verdict. Gating on `client` (which is set only after connect()
  // populates the session capabilities) makes the probe run with real data.
  useEffect(() => {
    if (isAuthenticated && client && isStalwart === null) {
      probe().then((detected) => {
        if (detected) {
          if (withoutPassword) {
            fetchAuthInfo();
            fetchPublicKeys();
            fetchCryptoInfo();
          } else {
            fetchAll();
          }
        }
      });
    }
  }, [isAuthenticated, client, isStalwart, probe, fetchAll, fetchAuthInfo, withoutPassword, fetchPublicKeys, fetchCryptoInfo]);

  // Until the probe has a verdict, show the spinner instead of guessing a
  // layout: switching layouts remounts every section below, which threw away
  // a pairing QR that was already on screen.
  if (isProbing || (isStalwart === null && isAuthenticated)) {
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
    // Even when Stalwart account-management isn't exposed (common for OAuth
    // sessions, whose tokens may lack the management capability), linking
    // the mobile app still works for every sign-in method: it runs through
    // this webmail's own /api/auth/pair routes, not `urn:stalwart:jmap`. So
    // show the linker above the "not available" note (except in Lite, which
    // has no server routes).
    // Use t.raw (not t) because the message is hand-injected HTML; passing it
    // through t() makes next-intl try to parse the <a> tag and throw
    // INVALID_TAG.
    return (
      <SettingsSection title={t('title')} description={t('description')}>
        {!IS_LITE ? (
          <div className="space-y-6">
            <LinkDeviceSection />
            <div className="border-t border-border" />
            <div className="text-sm text-muted-foreground" dangerouslySetInnerHTML={{ __html: sanitizeI18nHtml(t.raw('not_available')) }} />
          </div>
        ) : (
          <div className="text-sm text-muted-foreground py-4" dangerouslySetInnerHTML={{ __html: sanitizeI18nHtml(t.raw('not_available')) }} />
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <div className="space-y-6">
        {!withoutPassword && (
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

        <div className="border-t border-border" />
        <ApiKeysSection />

        {!IS_LITE && (
          <>
            <div className="border-t border-border" />
            <LinkDeviceSection />
          </>
        )}

        {withoutPassword && (
          <>
            <div className="border-t border-border" />
            <EmailClientSection />
          </>
        )}
            <div className="border-t border-border" />
            <div>
              
              <PublicKeysSection />
            </div>
      </div>
    </SettingsSection>
  );
}