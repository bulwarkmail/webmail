'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Save, Loader2, RotateCcw, ImageIcon, Upload, Trash2, Globe, Plus, X } from '@/components/icons';
import { apiFetch, withBasePath } from '@/lib/browser-navigation';
import {
  BRANDING_OVERRIDE_KEYS,
  parseDomainBranding,
  type BrandingOverrideKey,
  type DomainBrandingEntry,
} from '@/lib/admin/domain-branding';

interface ConfigEntry {
  value?: unknown;
  source: 'admin' | 'env' | 'default';
  hasValue?: boolean;
}

const IMAGE_FIELDS = [
  { key: 'faviconUrl', label: 'Favicon', accept: '.svg,.png,.ico,.webp' },
  { key: 'appLogoLightUrl', label: 'App Logo (Light Mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'appLogoDarkUrl', label: 'App Logo (Dark Mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'loginLogoLightUrl', label: 'Login Logo (Light Mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'loginLogoDarkUrl', label: 'Login Logo (Dark Mode)', accept: '.svg,.png,.jpg,.webp' },
] as const;

const TEXT_FIELDS = [
  { key: 'loginCompanyName', label: 'Company Name' },
  { key: 'loginImprintUrl', label: 'Imprint URL' },
  { key: 'loginPrivacyPolicyUrl', label: 'Privacy Policy URL' },
  { key: 'loginWebsiteUrl', label: 'Company Website URL' },
] as const;

const PWA_IMAGE_FIELDS = [
  { key: 'pwaIconUrl', label: 'PWA Icon', accept: '.svg,.png,.jpg,.webp' },
  { key: 'pwaScreenshotMobileUrl', label: 'PWA Screenshot (Mobile)', accept: '.png,.jpg,.webp' },
  { key: 'pwaScreenshotDesktopUrl', label: 'PWA Screenshot (Desktop)', accept: '.png,.jpg,.webp' },
] as const;

const PWA_TEXT_FIELDS = [
  { key: 'appShortName', label: 'Short Name', placeholder: 'Shown on home screen (max ~12 chars)' },
  { key: 'appDescription', label: 'Description', placeholder: 'App description for install prompts' },
] as const;

const PWA_COLOR_FIELDS = [
  { key: 'pwaThemeColor', label: 'Theme Color', defaultValue: '#ffffff' },
  { key: 'pwaBackgroundColor', label: 'Background Color', defaultValue: '#ffffff' },
] as const;

// Accepts exact hosts and one-level wildcards (e.g. *.example.com).
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
// Tighter rule for uploads: wildcards can only point to externally-hosted
// URLs, since we'd have no concrete subdomain to serve a file from.
const EXACT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export function BrandingTab() {
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [addingHost, setAddingHost] = useState(false);
  const [newHostInput, setNewHostInput] = useState('');
  const [newHostError, setNewHostError] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

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
    const res = await apiFetch('/api/admin/config');
    if (res.ok) setConfig(await res.json());
    setLoading(false);
  }

  function selectedEntry(): DomainBrandingEntry | null {
    if (!selectedHost) return null;
    return domainEntries.find(e => e.host === selectedHost) ?? null;
  }

  function handleChange(key: string, value: string) {
    setEdits(prev => ({ ...prev, [key]: value }));
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
      setMessage({ type: 'success', text: `Uploaded ${file.name} successfully.` });
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
    if (!confirm(`Remove branding entry for ${selectedHost}? Uploaded files for this domain will be left behind on disk.`)) {
      return;
    }
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

  function handleScopeChange(host: string | null) {
    if (Object.keys(edits).length > 0 && !confirm('Discard unsaved changes?')) return;
    setSelectedHost(host);
    setEdits({});
    setMessage(null);
  }

  const hasEdits = Object.keys(edits).length > 0;
  const wildcardScope = !!selectedHost && !EXACT_HOST_RE.test(selectedHost);

  if (loading) {
    return <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">Branding</h1>
          <p className="text-sm text-muted-foreground mt-1">Customize logos, favicon, and company information</p>
        </div>
        {hasEdits && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-all shadow-sm"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save changes
          </button>
        )}
      </div>

      {/* Scope picker */}
      <div className="border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
          <Globe className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Scope</h2>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleScopeChange(null)}
              className={`h-8 px-3 rounded-md text-sm font-medium transition-colors ${
                selectedHost === null
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground hover:bg-muted/70'
              }`}
            >
              Default
            </button>
            {domainEntries.map(entry => (
              <button
                key={entry.host}
                type="button"
                onClick={() => handleScopeChange(entry.host)}
                className={`h-8 px-3 rounded-md text-sm font-medium transition-colors ${
                  selectedHost === entry.host
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground hover:bg-muted/70'
                }`}
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
                className="h-8 w-64 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="button"
                onClick={handleAddDomain}
                className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => { setAddingHost(false); setNewHostInput(''); setNewHostError(null); }}
                className="h-8 px-2.5 rounded-md text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
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
        </div>
      </div>

      {message && (
        <div className={`text-sm rounded-md px-3 py-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      <div className="border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <h2 className="text-sm font-medium text-foreground">Images & Logos</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Upload a file or enter a URL. Supported formats: SVG, PNG, JPEG, WebP, ICO (max 2 MB)</p>
        </div>
        <div className="divide-y divide-border">
          {IMAGE_FIELDS.map(field => (
            <div key={field.key} className="px-4 py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-sm text-foreground">{field.label}</label>
                  {isOverriddenInScope(field.key) && (
                    <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      {isUploadedFile(field.key) ? 'uploaded' : selectedHost ? 'domain' : 'admin'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input
                    type="text"
                    value={currentValue(field.key)}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    placeholder={selectedHost ? 'Enter URL (uploads only for default scope)' : 'Enter URL or upload a file'}
                    className="h-8 w-full sm:w-64 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <input
                    ref={el => { fileInputRefs.current[field.key] = el; }}
                    type="file"
                    accept={field.accept}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleUpload(field.key, file);
                      e.target.value = '';
                    }}
                  />
                  <button
                    onClick={() => fileInputRefs.current[field.key]?.click()}
                    disabled={uploading === field.key || wildcardScope}
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-input bg-background text-sm text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                    title={wildcardScope ? 'Uploads disabled for wildcard hosts' : 'Upload file'}
                  >
                    {uploading === field.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  </button>
                  {isUploadedFile(field.key) && (
                    <button
                      onClick={() => handleDeleteUpload(field.key)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      title="Remove uploaded file"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isOverriddenInScope(field.key) && !isUploadedFile(field.key) && (
                    <button onClick={() => handleRevert(field.key)} className="text-muted-foreground hover:text-foreground" title="Revert to default">
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {currentValue(field.key) && (
                <div className="mt-2 flex items-center gap-2">
                  <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
                  <div className="h-8 w-auto bg-muted rounded flex items-center justify-center px-2">
                    <img
                      src={withBasePath(currentValue(field.key))}
                      alt={field.label}
                      className="max-h-6 max-w-[200px] object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <h2 className="text-sm font-medium text-foreground">Progressive Web App</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Shown when users install the webmail to their home screen. Leave fields blank to fall back to the favicon and app name.</p>
        </div>
        <div className="divide-y divide-border">
          {PWA_IMAGE_FIELDS.map(field => (
            <div key={field.key} className="px-4 py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-sm text-foreground">{field.label}</label>
                  {isOverriddenInScope(field.key) && (
                    <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      {isUploadedFile(field.key) ? 'uploaded' : selectedHost ? 'domain' : 'admin'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input
                    type="text"
                    value={currentValue(field.key)}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    placeholder={selectedHost ? 'Enter URL (uploads only for default scope)' : 'Enter URL or upload a file'}
                    className="h-8 w-full sm:w-64 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <input
                    ref={el => { fileInputRefs.current[field.key] = el; }}
                    type="file"
                    accept={field.accept}
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleUpload(field.key, file);
                      e.target.value = '';
                    }}
                  />
                  <button
                    onClick={() => fileInputRefs.current[field.key]?.click()}
                    disabled={uploading === field.key || wildcardScope}
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-input bg-background text-sm text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                    title={wildcardScope ? 'Uploads disabled for wildcard hosts' : 'Upload file'}
                  >
                    {uploading === field.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  </button>
                  {isUploadedFile(field.key) && (
                    <button
                      onClick={() => handleDeleteUpload(field.key)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      title="Remove uploaded file"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {isOverriddenInScope(field.key) && !isUploadedFile(field.key) && (
                    <button onClick={() => handleRevert(field.key)} className="text-muted-foreground hover:text-foreground" title="Revert to default">
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {currentValue(field.key) && (
                <div className="mt-2 flex items-center gap-2">
                  <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
                  <div className="h-8 w-auto bg-muted rounded flex items-center justify-center px-2">
                    <img
                      src={withBasePath(currentValue(field.key))}
                      alt={field.label}
                      className="max-h-6 max-w-[200px] object-contain"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
          {PWA_TEXT_FIELDS.map(field => (
            <div key={field.key} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <label className="text-sm text-foreground">{field.label}</label>
                {isOverriddenInScope(field.key) && (
                  <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    {selectedHost ? 'domain' : 'admin'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <input
                  type="text"
                  value={currentValue(field.key)}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="h-8 w-full sm:w-72 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {isOverriddenInScope(field.key) && (
                  <button onClick={() => handleRevert(field.key)} className="text-muted-foreground hover:text-foreground" title="Revert to default">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
          {PWA_COLOR_FIELDS.map(field => {
            const value = currentValue(field.key) || field.defaultValue;
            return (
              <div key={field.key} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-sm text-foreground">{field.label}</label>
                  {isOverriddenInScope(field.key) && (
                    <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      {selectedHost ? 'domain' : 'admin'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input
                    type="color"
                    value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : field.defaultValue}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    className="h-8 w-10 cursor-pointer rounded-md border border-input bg-background p-0.5"
                    title="Pick a color"
                  />
                  <input
                    type="text"
                    value={currentValue(field.key)}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    placeholder={field.defaultValue}
                    className="h-8 w-full sm:w-32 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm font-mono text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {isOverriddenInScope(field.key) && (
                    <button onClick={() => handleRevert(field.key)} className="text-muted-foreground hover:text-foreground" title="Revert to default">
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <h2 className="text-sm font-medium text-foreground">Company Information</h2>
        </div>
        <div className="divide-y divide-border">
          {TEXT_FIELDS.map(field => (
            <div key={field.key} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <label className="text-sm text-foreground">{field.label}</label>
                {isOverriddenInScope(field.key) && (
                  <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    {selectedHost ? 'domain' : 'admin'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <input
                  type="text"
                  value={currentValue(field.key)}
                  onChange={(e) => handleChange(field.key, e.target.value)}
                  placeholder={field.key.includes('Url') ? 'https://...' : 'Enter value'}
                  className="h-8 w-full sm:w-72 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {isOverriddenInScope(field.key) && (
                  <button onClick={() => handleRevert(field.key)} className="text-muted-foreground hover:text-foreground" title="Revert to default">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
