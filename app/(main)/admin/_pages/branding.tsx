'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, ImageIcon, Upload, Trash2, Plus, X } from '@/components/icons';
import { apiFetch, withBasePath } from '@/lib/browser-navigation';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import {
  BRANDING_OVERRIDE_KEYS,
  parseDomainBranding,
  type BrandingOverrideKey,
  type DomainBrandingEntry,
} from '@/lib/admin/domain-branding';
import { SettingsSection, SettingItem, SectionNav } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { withEdit } from '@/lib/admin/edits';
import { Badge } from '@/components/admin/badge';
import { useAdminFeedback } from '@/components/admin/feedback';
import { inputClass, RevertButton } from '@/components/admin/config-items';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { useAdminUnsavedStore } from '@/stores/admin-unsaved-store';
import { cssUrl, MAX_BLUR, MAX_DIM, usableBackgroundUrl } from '@/lib/login-backdrop';

interface ConfigEntry {
  value?: unknown;
  source: 'admin' | 'env' | 'default';
  hasValue?: boolean;
}

const IMAGE_FIELDS = [
  { key: 'faviconUrl', label: 'Favicon', accept: '.svg,.png,.ico,.webp' },
  { key: 'appLogoLightUrl', label: 'App logo (light mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'appLogoDarkUrl', label: 'App logo (dark mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'loginLogoLightUrl', label: 'Login logo (light mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'loginLogoDarkUrl', label: 'Login logo (dark mode)', accept: '.svg,.png,.jpg,.webp' },
] as const;

const TEXT_FIELDS = [
  { key: 'loginCompanyName', label: 'Company name' },
  { key: 'loginImprintUrl', label: 'Imprint URL' },
  { key: 'loginPrivacyPolicyUrl', label: 'Privacy policy URL' },
  { key: 'loginWebsiteUrl', label: 'Company website URL' },
  { key: 'loginUsernamePlaceholder', label: 'Login email placeholder', placeholder: 'user@company.example' },
] as const;

// Accessibility and help links (OP-01): the app shows them on the login
// page, in the settings sidebar and in the account menu (lib/help-links.ts).
const HELP_FIELDS = [
  { key: 'accessibilityStatementUrl', label: 'Accessibility statement URL', placeholder: 'https://...' },
  { key: 'accessibilityFeedbackUrl', label: 'Report a barrier (URL or email)', placeholder: 'https://... or barriers@example.com' },
  { key: 'helpUrl', label: 'Help URL', placeholder: 'https://...' },
  { key: 'easyReadUrl', label: 'Easy Read (Leichte Sprache) URL', placeholder: 'https://...' },
  { key: 'signLanguageUrl', label: 'Sign language (DGS) URL', placeholder: 'https://...' },
] as const;

const LOGIN_BACKGROUND_FIELDS = [
  { key: 'loginBackgroundLightUrl', label: 'Background (light mode)', accept: '.jpg,.jpeg,.png,.webp,.svg' },
  { key: 'loginBackgroundDarkUrl', label: 'Background (dark mode)', accept: '.jpg,.jpeg,.png,.webp,.svg' },
] as const;

const LOGIN_BACKGROUND_SLIDERS = [
  { key: 'loginBackgroundDim', label: 'Darken background', description: 'Tones a bright or busy picture down so the form and the links under it stand out.', max: MAX_DIM, step: 5, unit: '%' },
  { key: 'loginBackgroundBlur', label: 'Blur background', description: 'Softens the picture behind the form.', max: MAX_BLUR, step: 1, unit: 'px' },
] as const;

const PWA_IMAGE_FIELDS = [
  { key: 'pwaIconUrl', label: 'Icon', accept: '.svg,.png,.jpg,.webp' },
  { key: 'pwaScreenshotMobileUrl', label: 'Screenshot (mobile)', accept: '.png,.jpg,.webp' },
  { key: 'pwaScreenshotDesktopUrl', label: 'Screenshot (desktop)', accept: '.png,.jpg,.webp' },
] as const;

const PWA_TEXT_FIELDS = [
  { key: 'appShortName', label: 'Short name', placeholder: 'Shown on home screen (max ~12 chars)' },
  { key: 'appDescription', label: 'Description', placeholder: 'App description for install prompts' },
] as const;

const PWA_COLOR_FIELDS = [
  { key: 'pwaThemeColor', label: 'Theme colour', defaultValue: '#ffffff' },
  { key: 'pwaBackgroundColor', label: 'Background colour', defaultValue: '#ffffff' },
] as const;

// Accepts exact hosts and one-level wildcards (e.g. *.example.com).
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
// Tighter rule for uploads: wildcards can only point to externally-hosted
// URLs, since we'd have no concrete subdomain to serve a file from.
const EXACT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const PAGE = adminPageDef('branding');

const chipClass = (selected: boolean) => cn(
  'h-8 px-3 rounded-md text-sm font-medium transition-colors',
  selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground hover:bg-accent hover:text-accent-foreground',
);

export function BrandingPage() {
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const setMessage = useAdminFeedback();
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  const [newHostInput, setNewHostInput] = useState('');
  const [newHostError, setNewHostError] = useState<string | null>(null);

  useEffect(() => {
    fetchConfig();
  }, []);

  const domainEntries = useMemo<DomainBrandingEntry[]>(
    () => parseDomainBranding(config['domainBranding']?.value),
    [config],
  );

  // Drop selection if the host disappeared from the config (e.g. concurrent edit).
  useEffect(() => {
    if (selectedHost && !domainEntries.some(e => e.host === selectedHost)) {
      setSelectedHost(null);
      setEdits({});
    }
  }, [domainEntries, selectedHost]);

  async function fetchConfig() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/config');
      if (!res.ok) throw new Error();
      setConfig(await res.json());
    } catch {
      setMessage({ type: 'error', text: 'Could not load the settings' });
    }
    setLoading(false);
  }

  function selectedEntry(): DomainBrandingEntry | null {
    if (!selectedHost) return null;
    return domainEntries.find(e => e.host === selectedHost) ?? null;
  }

  function handleChange(key: string, value: string) {
    const saved = selectedHost
      ? selectedEntry()?.[key as BrandingOverrideKey]
      : config[key]?.value;
    setEdits(prev => withEdit(prev, key, value, saved));
    setMessage(null);
  }

  function currentValue(key: string): string {
    if (key in edits) return edits[key];
    if (selectedHost) {
      const entry = selectedEntry();
      return (entry?.[key as BrandingOverrideKey] as string | undefined) ?? '';
    }
    return (config[key]?.value as string) ?? '';
  }

  /** What the page shows for a key in this scope: the domain's value, else the default's. */
  function effectiveValue(key: string): string {
    const own = currentValue(key);
    if (own || !selectedHost) return own;
    const fallback = config[key]?.value;
    return typeof fallback === 'string' ? fallback : '';
  }

  function isOverriddenInScope(key: string): boolean {
    if (selectedHost) {
      const entry = selectedEntry();
      const v = entry?.[key as BrandingOverrideKey];
      return typeof v === 'string' && v.length > 0;
    }
    return config[key]?.source === 'admin';
  }

  const isUploadedFile = (key: string): boolean => {
    const val = currentValue(key);
    return val.startsWith('/api/admin/branding/');
  };

  function buildUpdatedDomainBranding(merge: Record<string, string>): DomainBrandingEntry[] {
    if (!selectedHost) return domainEntries;
    const next = domainEntries.slice();
    const idx = next.findIndex(e => e.host === selectedHost);
    const base: DomainBrandingEntry =
      idx === -1 ? { host: selectedHost } : { ...next[idx] };
    const writable = base as unknown as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(merge)) {
      if (!(BRANDING_OVERRIDE_KEYS as readonly string[]).includes(key)) continue;
      if (typeof value === 'string' && value.length > 0) {
        writable[key] = value;
      } else {
        delete writable[key];
      }
    }
    if (idx === -1) next.push(base);
    else next[idx] = base;
    return next;
  }

  async function handleSave() {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    setMessage(null);

    const payload = selectedHost
      ? { domainBranding: buildUpdatedDomainBranding(edits) }
      : edits;

    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      setMessage({
        type: 'success',
        text: selectedHost
          ? `Branding for ${selectedHost} updated. Changes visible on next page load.`
          : 'Branding updated. Changes visible on next page load.',
      });
      setEdits({});
      await fetchConfig();
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Failed to save' });
    }
    setSaving(false);
  }

  async function handleUpload(slot: string, file: File) {
    if (selectedHost && !EXACT_HOST_RE.test(selectedHost)) {
      setMessage({
        type: 'error',
        text: 'Wildcard hosts cannot upload files. Enter a URL instead.',
      });
      return;
    }
    setUploading(slot);
    setMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('slot', slot);
    if (selectedHost) formData.append('host', selectedHost);

    const res = await apiFetch('/api/admin/branding', {
      method: 'POST',
      body: formData,
    });

    if (res.ok) {
      const data = await res.json();
      setMessage({ type: 'success', text: `${file.name} uploaded` });
      setEdits(prev => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      // Refresh from server so domainBranding entries reflect the upload.
      await fetchConfig();
      void data;
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Upload failed' });
    }
    setUploading(null);
  }

  async function handleDeleteUpload(slot: string) {
    setMessage(null);

    const body: { slot: string; host?: string } = { slot };
    if (selectedHost) body.host = selectedHost;

    const res = await apiFetch('/api/admin/branding', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setMessage({ type: 'success', text: 'Uploaded file removed. Reverted to default.' });
      setEdits(prev => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      await fetchConfig();
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Failed to remove' });
    }
  }

  async function handleRevert(key: string) {
    if (selectedHost) {
      // Domain scope: drop the field from the entry and PATCH the array.
      const updated = buildUpdatedDomainBranding({ [key]: '' });
      const res = await apiFetch('/api/admin/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domainBranding: updated }),
      });
      if (res.ok) {
        setEdits(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        await fetchConfig();
      }
      return;
    }
    // Default scope: revert via DELETE /api/admin/config
    const res = await apiFetch('/api/admin/config', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      setEdits(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await fetchConfig();
    }
  }

  async function handleAddDomain() {
    const host = newHostInput.trim().toLowerCase().replace(/\.+$/, '');
    if (!host) {
      setNewHostError('Enter a hostname');
      return;
    }
    if (!HOST_RE.test(host)) {
      setNewHostError('Invalid hostname. Use foo.example.com or *.example.com');
      return;
    }
    if (domainEntries.some(e => e.host === host)) {
      setNewHostError('A branding entry for this host already exists');
      return;
    }
    setNewHostError(null);

    const next: DomainBrandingEntry[] = [...domainEntries, { host }];
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domainBranding: next }),
    });
    if (res.ok) {
      setNewHostInput('');
      setAddingHost(false);
      setSelectedHost(host);
      setEdits({});
      await fetchConfig();
    } else {
      const data = await res.json();
      setNewHostError(data.error || 'Failed to add domain');
    }
  }

  async function handleDeleteDomain() {
    if (!selectedHost) return;
    const ok = await confirm({
      title: `Remove the branding for ${selectedHost}?`,
      message: 'The settings for this domain are removed. Files uploaded for it stay on disk.',
      confirmText: 'Remove',
      cancelText: 'Cancel',
      variant: 'destructive',
    });
    if (!ok) return;
    const next = domainEntries.filter(e => e.host !== selectedHost);
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domainBranding: next }),
    });
    if (res.ok) {
      setSelectedHost(null);
      setEdits({});
      await fetchConfig();
      setMessage({ type: 'success', text: `Removed branding entry for ${selectedHost}.` });
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Failed to remove domain' });
    }
  }

  // Another domain's settings replace the form: the page's own leave prompt
  // asks first when this one holds edits.
  function handleScopeChange(host: string | null) {
    requestLeave(() => {
      setSelectedHost(host);
      setEdits({});
      setMessage(null);
    }, 'branding');
  }

  const hasEdits = Object.keys(edits).length > 0;
  const wildcardScope = !!selectedHost && !EXACT_HOST_RE.test(selectedHost);

  useAdminUnsavedChanges('branding', hasEdits);
  const requestLeave = useAdminUnsavedStore((s) => s.requestLeave);
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();

  if (loading) {
    return (
      <div>
        <AdminPageHeader title={PAGE.label} description={PAGE.description} />
        <AdminBodySkeleton status="Loading" />
      </div>
    );
  }

  /** The badge next to a field that is set in the scope being edited. */
  const overrideBadge = (key: string) => (
    isOverriddenInScope(key)
      ? <Badge tone="accent">{isUploadedFile(key) ? 'uploaded' : selectedHost ? 'domain' : 'admin'}</Badge>
      : null
  );

  const imageRow = (field: { key: string; label: string; accept: string }) => (
    <ImageItem
      key={field.key}
      label={field.label}
      previewOn={field.key.endsWith('DarkUrl') ? 'dark' : field.key.endsWith('LightUrl') ? 'light' : undefined}
      accept={field.accept}
      value={currentValue(field.key)}
      badge={overrideBadge(field.key)}
      // Files upload to the default scope and to exact hosts; a wildcard has
      // no single host to serve them from (the scope line says so).
      placeholder={wildcardScope ? 'Enter URL' : 'Enter URL or upload a file'}
      uploading={uploading === field.key}
      uploadDisabled={wildcardScope}
      uploaded={isUploadedFile(field.key)}
      overridden={isOverriddenInScope(field.key)}
      onChange={(value) => handleChange(field.key, value)}
      onUpload={(file) => handleUpload(field.key, file)}
      onDeleteUpload={() => handleDeleteUpload(field.key)}
      onRevert={() => handleRevert(field.key)}
    />
  );

  const textRow = (field: { key: string; label: string }, placeholder: string) => (
    <SettingItem key={field.key} label={field.label}>
      <div className="flex w-full items-center gap-1.5 sm:w-auto">
        {overrideBadge(field.key)}
        <input
          type="text"
          value={currentValue(field.key)}
          onChange={(e) => handleChange(field.key, e.target.value)}
          placeholder={placeholder}
          title={placeholder}
          aria-label={field.label}
          autoComplete="off"
          spellCheck={false}
          className={cn(inputClass, 'w-full min-w-0 sm:w-72')}
        />
        {isOverriddenInScope(field.key) && <RevertButton onClick={() => handleRevert(field.key)} />}
      </div>
    </SettingItem>
  );

  return (
    <div>
      <AdminPageHeader title={PAGE.label} description={PAGE.description} />

      <ConfirmDialog {...confirmProps} />

      <div className="space-y-10">
        <SectionNav />

        <SettingsSection id="scope" title="Scope">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => handleScopeChange(null)} aria-pressed={selectedHost === null} className={chipClass(selectedHost === null)}>
              Default
            </button>
            {domainEntries.map(entry => (
              <button
                key={entry.host}
                type="button"
                onClick={() => handleScopeChange(entry.host)}
                aria-pressed={selectedHost === entry.host}
                className={chipClass(selectedHost === entry.host)}
              >
                {entry.host}
              </button>
            ))}
            {!addingHost && (
              <button
                type="button"
                onClick={() => { setAddingHost(true); setNewHostError(null); }}
                className="inline-flex items-center gap-1 h-8 px-3 rounded-md border border-dashed border-input text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add domain
              </button>
            )}
          </div>
          {addingHost && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                autoFocus
                value={newHostInput}
                onChange={(e) => { setNewHostInput(e.target.value); setNewHostError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAddDomain(); }}
                placeholder="mail.example.com or *.example.com"
                aria-label="Hostname"
                autoComplete="off"
                spellCheck={false}
                className={cn(inputClass, 'w-64')}
              />
              <Button type="button" size="sm" onClick={handleAddDomain}>
                Add
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setAddingHost(false); setNewHostInput(''); setNewHostError(null); }}>
                Cancel
              </Button>
              {newHostError && <span className="text-xs text-destructive">{newHostError}</span>}
            </div>
          )}
          {selectedHost ? (
            <div className="flex items-center justify-between gap-3 text-xs">
              <p className="text-muted-foreground">
                Editing overrides for <span className="font-mono text-foreground">{selectedHost}</span>.
                Unset fields fall back to the Default values.
                {wildcardScope && ' Uploads are disabled for wildcard hosts; enter a URL instead.'}
              </p>
              <button
                type="button"
                onClick={handleDeleteDomain}
                className="inline-flex items-center gap-1 text-destructive hover:underline whitespace-nowrap"
              >
                <X className="w-3.5 h-3.5" />
                Remove domain
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Editing the Default branding. Add a domain to override branding when the webmail is served on a specific hostname.
            </p>
          )}
        </SettingsSection>

        <SettingsSection id="images" title="Images and logos" description="Upload a file or enter a URL. Supported formats: SVG, PNG, JPEG, WebP, ICO (max 2 MB)">
          {IMAGE_FIELDS.map(imageRow)}
        </SettingsSection>

        <SettingsSection
          id="login-page"
          title="Login page"
          description="The layout of the sign-in page and the picture behind it. Backgrounds can be JPEG, PNG, WebP or SVG up to 5 MB; without a dark-mode picture, dark mode uses the light one."
        >
          <SettingItem label="Layout" description="Centered puts the form in a card over the background. Split puts it in a panel at the side and lets the background fill the rest of the screen, on screens 1024 px and wider; it is meant for use with a background picture.">
            <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto">
              {overrideBadge('loginLayout')}
              {(selectedHost ? ['', 'centered', 'split'] : ['centered', 'split']).map((layout) => {
                const current = currentValue('loginLayout') || (selectedHost ? '' : 'centered');
                return (
                  <button
                    key={layout || 'inherit'}
                    type="button"
                    aria-pressed={current === layout}
                    onClick={() => handleChange('loginLayout', layout)}
                    className={chipClass(current === layout)}
                  >
                    {layout === '' ? 'Same as default' : layout === 'split' ? 'Split' : 'Centered'}
                  </button>
                );
              })}
              {isOverriddenInScope('loginLayout') && <RevertButton onClick={() => handleRevert('loginLayout')} />}
            </div>
          </SettingItem>
          {LOGIN_BACKGROUND_FIELDS.map(imageRow)}
          {LOGIN_BACKGROUND_SLIDERS.map(field => {
            const value = effectiveValue(field.key);
            const number = Math.min(Number.parseInt(value, 10) || 0, field.max);
            return (
              <SettingItem key={field.key} label={field.label} description={field.description}>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  {overrideBadge(field.key)}
                  <input
                    type="range"
                    min={0}
                    max={field.max}
                    step={field.step}
                    value={number}
                    onChange={(e) => handleChange(field.key, e.target.value === '0' && selectedHost === null ? '' : e.target.value)}
                    aria-label={field.label}
                    aria-valuetext={`${number} ${field.unit}`}
                    className="w-full accent-primary sm:w-48"
                  />
                  <span className="w-12 shrink-0 text-end text-sm tabular-nums text-muted-foreground">{number} {field.unit}</span>
                  {isOverriddenInScope(field.key) && <RevertButton onClick={() => handleRevert(field.key)} />}
                </div>
              </SettingItem>
            );
          })}
          <LoginBackdropPreview
            layout={effectiveValue('loginLayout') === 'split' ? 'split' : 'centered'}
            lightUrl={effectiveValue('loginBackgroundLightUrl')}
            darkUrl={effectiveValue('loginBackgroundDarkUrl')}
            dim={Number.parseInt(effectiveValue('loginBackgroundDim'), 10) || 0}
            blur={Number.parseInt(effectiveValue('loginBackgroundBlur'), 10) || 0}
          />
        </SettingsSection>

        <SettingsSection id="pwa" title="Progressive web app" description="Shown when users install the webmail to their home screen. Leave fields blank to fall back to the favicon and app name.">
          {PWA_IMAGE_FIELDS.map(imageRow)}
          {PWA_TEXT_FIELDS.map(field => textRow(field, field.placeholder))}
          {PWA_COLOR_FIELDS.map(field => {
            const value = currentValue(field.key) || field.defaultValue;
            return (
              <SettingItem key={field.key} label={field.label}>
                <div className="flex w-full items-center gap-1.5 sm:w-auto">
                  {overrideBadge(field.key)}
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : field.defaultValue}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    aria-label={`${field.label} picker`}
                    className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-background p-0.5"
                    title="Pick a color"
                  />
                  <input
                    type="text"
                    value={currentValue(field.key)}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    placeholder={field.defaultValue}
                    aria-label={field.label}
                    autoComplete="off"
                    spellCheck={false}
                    className={cn(inputClass, 'w-full min-w-0 font-mono sm:w-32')}
                  />
                  {isOverriddenInScope(field.key) && <RevertButton onClick={() => handleRevert(field.key)} />}
                </div>
              </SettingItem>
            );
          })}
        </SettingsSection>

        <SettingsSection id="company" title="Company information">
          {TEXT_FIELDS.map(field => textRow(field, 'placeholder' in field ? field.placeholder : field.key.includes('Url') ? 'https://...' : 'Enter value'))}
        </SettingsSection>

        <SettingsSection
          id="accessibility-links"
          title="Accessibility and help links"
          description="Shown on the login page, in the settings sidebar and in the account menu, in the same place on every page. Leave a field empty to hide its link. Only http and https links are used; the barrier report can also be an email address."
        >
          {HELP_FIELDS.map(field => textRow(field, field.placeholder))}
        </SettingsSection>
      </div>

      <AdminSaveBar
        dirty={hasEdits}
        saving={saving}
        onSave={handleSave}
        onDiscard={() => setEdits({})}
        note="Takes effect on the next page load"
      />
    </div>
  );
}

interface ImageItemProps {
  label: string;
  /** Shows the preview on the surface the logo is meant for, whatever the panel's own mode. */
  previewOn?: 'light' | 'dark';
  accept: string;
  value: string;
  badge: ReactNode;
  placeholder: string;
  uploading: boolean;
  uploadDisabled: boolean;
  uploaded: boolean;
  overridden: boolean;
  onChange: (value: string) => void;
  onUpload: (file: File) => void;
  onDeleteUpload: () => void;
  onRevert: () => void;
}

/** One image slot: a URL field, an upload button, and a preview of what is set. */
function ImageItem({ label, previewOn, accept, value, badge, placeholder, uploading, uploadDisabled, uploaded, overridden, onChange, onUpload, onDeleteUpload, onRevert }: ImageItemProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  return (
    <SettingItem label={label}>
      <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
        <div className="flex w-full items-center gap-1.5 sm:w-auto">
          {badge}
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            title={placeholder}
            aria-label={label}
            autoComplete="off"
            spellCheck={false}
            className={cn(inputClass, 'w-full min-w-0 sm:w-64')}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-9 shrink-0 px-0"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || uploadDisabled}
            title={uploadDisabled ? 'Uploads disabled for wildcard hosts' : 'Upload file'}
            aria-label={uploadDisabled ? 'Uploads disabled for wildcard hosts' : 'Upload file'}
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          </Button>
          {uploaded && (
            <button
              type="button"
              onClick={onDeleteUpload}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive transition-colors"
              title="Remove uploaded file"
              aria-label="Remove uploaded file"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          {overridden && !uploaded && <RevertButton onClick={onRevert} />}
        </div>
        {value && (
          <div className="flex items-center gap-2">
            <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
            <div className={cn(
              'h-8 w-auto rounded flex items-center justify-center px-2',
              previewOn === 'dark' ? 'bg-neutral-900' : previewOn === 'light' ? 'border border-border bg-white' : 'bg-muted',
            )}>
              {/* The key: a URL that failed while it was being typed hides the image, and the next one must show again. */}
              <img
                key={value}
                src={withBasePath(value)}
                alt={label}
                className="max-h-6 max-w-[200px] object-contain"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          </div>
        )}
      </div>
    </SettingItem>
  );
}

interface LoginBackdropPreviewProps {
  layout: 'centered' | 'split';
  lightUrl: string;
  darkUrl: string;
  dim: number;
  blur: number;
}

/**
 * The sign-in page in miniature, in light and dark mode, with the settings
 * above applied: what app/login.css draws, at a fifth of a laptop screen.
 */
function LoginBackdropPreview({ layout, lightUrl, darkUrl, dim, blur }: LoginBackdropPreviewProps) {
  const light = usableBackgroundUrl(lightUrl);
  const dark = usableBackgroundUrl(darkUrl) || light;
  return (
    <div className="flex flex-wrap gap-4 py-2" aria-label="Preview of the sign-in page">
      <PreviewScreen mode="light" layout={layout} url={light} dim={dim} blur={blur} />
      <PreviewScreen mode="dark" layout={layout} url={dark} dim={dim} blur={blur} />
    </div>
  );
}

const PREVIEW_COLORS = {
  light: { sidebar: '#f8fafc', card: '#ffffff', border: '#e2e8f0', bar: '#e2e8f0', primary: '#185aea' },
  dark: { sidebar: '#0a0a0a', card: '#141414', border: 'rgba(128,128,128,0.3)', bar: '#262626', primary: '#fafafa' },
} as const;

function PreviewScreen({ mode, layout, url, dim, blur }: { mode: 'light' | 'dark'; layout: 'centered' | 'split'; url: string; dim: number; blur: number }) {
  const c = PREVIEW_COLORS[mode];
  // A fifth of the size, so a fifth of the blur.
  const scaledBlur = blur / 5;
  const form = (
    <div className="flex w-full flex-col items-center gap-1.5">
      <span className="mb-1 h-4 w-4 rounded" style={{ background: c.bar }} />
      {[0, 1].map((i) => (
        <span key={i} className="block h-2.5 w-full rounded-sm border" style={{ borderColor: c.border, background: c.card }} />
      ))}
      <span className="mt-1 block h-2.5 w-full rounded-sm" style={{ background: c.primary }} />
    </div>
  );
  return (
    <figure className="m-0 flex flex-col gap-1.5">
      <div
        className="relative isolate h-[160px] w-[256px] overflow-hidden rounded-md border border-border"
        style={{ background: url ? c.sidebar : `linear-gradient(180deg, color-mix(in oklab, ${c.primary} 8%, ${c.sidebar}) 0%, ${c.sidebar} 65%)` }}
      >
        {url && (
          <>
            <div
              className="absolute -z-10"
              style={{
                inset: `${-2 * scaledBlur}px`,
                background: `${cssUrl(url.startsWith('/') ? withBasePath(url) : url)} center / cover no-repeat`,
                filter: `blur(${scaledBlur}px)`,
              }}
            />
            <div className="absolute inset-0 -z-10" style={{ background: `rgb(0 0 0 / ${dim / 100})` }} />
          </>
        )}
        {layout === 'split' ? (
          <div className="flex h-full w-[86px] items-center border-e px-3" style={{ background: mode === 'light' ? '#ffffff' : '#0a0a0a', borderColor: c.border }}>
            {form}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="w-[76px] rounded-sm border p-2.5 shadow-sm" style={{ background: c.card, borderColor: c.border }}>
              {form}
            </div>
          </div>
        )}
      </div>
      <figcaption className="text-xs text-muted-foreground">{mode === 'light' ? 'Light mode' : 'Dark mode'}</figcaption>
    </figure>
  );
}
