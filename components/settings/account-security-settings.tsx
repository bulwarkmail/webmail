'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import * as OTPAuth from 'otpauth';
import { Shield, Key, Smartphone, Lock, Trash2, Plus, Eye, EyeOff, Copy, Check, Loader2, Monitor, Terminal, QrCode } from 'lucide-react';
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
          disabled={isSaving || !currentPassword || !newPassword || !confirmPassword}
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
          {setupError && <p className="text-xs text-destructive">{setupError}</p>}
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" onClick={handleDisable} disabled={isSaving || !password}>
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

// Cross-device QR login. A signed-in (OAuth/SSO) session mints a short-lived
// pairing code via /api/auth/pair/create; we render it as a QR that the mobile
// app scans to sign in without re-typing credentials. The QR payload carries
// only the server URL and the one-time code — never tokens.
function LinkDeviceSection() {
  const t = useTranslations('settings.security');
  const params = useParams();
  const locale = params.locale as string;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);

  // Tick the countdown down to zero, then drop the (now useless) QR so the
  // user is nudged to generate a fresh one.
  useEffect(() => {
    if (remaining <= 0) {
      setQrDataUrl(null);
      return;
    }
    const timer = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  // Send the user to the IdP for a fresh login (prompt=login). On return the
  // callback page sets the pairing re-auth proof and bounces back here, where
  // the resume effect below re-runs generate().
  const startReauth = useCallback(async () => {
    try {
      sessionStorage.setItem('pair_reauth_resume', '1');
    } catch { /* sessionStorage unavailable */ }
    const prefix = getPathPrefix(locale);
    const redirectUri = `${window.location.origin}${prefix}/${locale}/auth/callback`;
    const res = await apiFetch('/api/auth/sso/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ redirect_uri: redirectUri, locale, purpose: 'reauth' }),
    });
    if (!res.ok) {
      setError(t('link_device.error'));
      return;
    }
    const { authorize_url } = await res.json();
    window.location.href = authorize_url;
  }, [locale, t]);

  // `fromResume` guards against a redirect loop: if we just completed re-auth
  // and pair/create still demands it, surface an error instead of bouncing to
  // the IdP again.
  const generate = useCallback(async (fromResume = false) => {
    setLoading(true);
    setError(null);
    try {
      // Pair the account whose session cookie we'll actually refresh — the
      // active account's slot.
      const slot = useAccountStore.getState().getActiveAccount()?.cookieSlot ?? 0;
      const res = await apiFetch('/api/auth/pair/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slot }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        if (res.status === 401 && errBody?.error === 'reauth_required' && !fromResume) {
          await startReauth();
          return;
        }
        setError(t('link_device.error'));
        return;
      }
      const data = await res.json();
      const code = data.pairing_code as string;
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 120;
      // The phone redeems the code against THIS webmail (where the pairing
      // record lives), so the QR carries the webmail base — origin plus any
      // mount prefix — not the JMAP server URL. The JMAP server_url comes back
      // in the redeem response.
      const webmailBase = `${window.location.origin}${getPathPrefix()}`;
      const payload = `bulwarkmail://pair?server=${encodeURIComponent(webmailBase)}&code=${encodeURIComponent(code)}`;
      const dataUrl = await QRCode.toDataURL(payload, { width: 240, margin: 1 });
      setQrDataUrl(dataUrl);
      setRemaining(expiresIn);
      setHasGenerated(true);
    } catch {
      setError(t('link_device.error'));
    } finally {
      setLoading(false);
    }
  }, [t, startReauth]);

  // Auto-resume after returning from the step-up re-auth round-trip.
  useEffect(() => {
    let resume = false;
    try {
      resume = sessionStorage.getItem('pair_reauth_done') === '1';
      if (resume) sessionStorage.removeItem('pair_reauth_done');
    } catch { /* sessionStorage unavailable */ }
    if (resume) void generate(true);
  }, [generate]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <QrCode className="w-4 h-4 text-muted-foreground" />
        <h4 className="text-sm font-medium text-foreground">{t('link_device.title')}</h4>
      </div>
      <p className="text-xs text-muted-foreground">{t('link_device.description')}</p>

      {qrDataUrl && remaining > 0 && (
        <div className="p-3 bg-muted/70 dark:bg-muted/40 rounded-md space-y-2">
          <div className="flex justify-center">
            <img src={qrDataUrl} alt="Pairing QR code" className="rounded bg-white p-2" />
          </div>
          <p className="text-xs text-muted-foreground text-center">{t('link_device.instructions')}</p>
          <p className="text-[11px] text-muted-foreground text-center">
            {t('link_device.expires_in', { seconds: remaining })}
          </p>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <Button variant="outline" size="sm" onClick={() => void generate()} disabled={loading}>
        {loading ? (
          <Loader2 className="w-3 h-3 me-1 animate-spin" />
        ) : (
          <QrCode className="w-3 h-3 me-1" />
        )}
        {hasGenerated ? t('link_device.regenerate') : t('link_device.generate')}
      </Button>
    </div>
  );
}

export function AccountSecuritySettings() {
  const t = useTranslations('settings.security');
  const { isStalwart, isProbing, probe, fetchAll, fetchAuthInfo } = useAccountSecurityStore();
  const { isAuthenticated, authMode, client } = useAuthStore();
  const isOAuth = authMode === 'oauth';

  // Wait for `client` before probing. On reload the persisted `isAuthenticated`
  // flips true before the async OAuth reconnect sets `client`; probing in that
  // window reads a null client, decides the server isn't Stalwart, and caches
  // that wrong verdict. Gating on `client` (which is set only after connect()
  // populates the session capabilities) makes the probe run with real data.
  useEffect(() => {
    if (isAuthenticated && client && isStalwart === null) {
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
  }, [isAuthenticated, client, isStalwart, probe, fetchAll, fetchAuthInfo, isOAuth]);

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
    // Even when Stalwart account-management isn't exposed (common for OAuth
    // sessions, whose tokens may lack the management capability), the
    // cross-device mobile pairing still works — it only needs the OAuth
    // refresh-token cookie, not `urn:stalwart:jmap`. So surface the QR linker
    // for OAuth sessions and show the "not available" note for the rest.
    // Use t.raw (not t) because the message is hand-injected HTML; passing it
    // through t() makes next-intl try to parse the <a> tag and throw
    // INVALID_TAG.
    return (
      <SettingsSection title={t('title')} description={t('description')}>
        {isOAuth ? (
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

        <div className="border-t border-border" />
        <ApiKeysSection />

        {isOAuth && (
          <>
            <div className="border-t border-border" />
            <EmailClientSection />
            <div className="border-t border-border" />
            <LinkDeviceSection />
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
