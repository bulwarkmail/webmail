'use client';

import { useEffect, useRef, useState } from 'react';
import { Save, Loader2, RotateCcw, ImageIcon, Upload, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/browser-navigation';

interface ConfigEntry {
  value: unknown;
  source: 'admin' | 'env' | 'default';
}

const IMAGE_FIELDS = [
  { key: 'faviconUrl', label: 'Favicon', accept: '.svg,.png,.ico,.webp' },
  { key: 'appLogoLightUrl', label: 'App Logo (Light Mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'appLogoDarkUrl', label: 'App Logo (Dark Mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'loginLogoLightUrl', label: 'Login Logo (Light Mode)', accept: '.svg,.png,.jpg,.webp' },
  { key: 'loginLogoDarkUrl', label: 'Login Logo (Dark Mode)', accept: '.svg,.png,.jpg,.webp' },
];

const TEXT_FIELDS = [
  { key: 'loginCompanyName', label: 'Company Name' },
  { key: 'loginImprintUrl', label: 'Imprint URL' },
  { key: 'loginPrivacyPolicyUrl', label: 'Privacy Policy URL' },
  { key: 'loginWebsiteUrl', label: 'Company Website URL' },
];

export default function AdminBrandingPage() {
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    fetchConfig();
  }, []);

  async function fetchConfig() {
    setLoading(true);
    const res = await apiFetch('/api/admin/config');
    if (res.ok) setConfig(await res.json());
    setLoading(false);
  }

  function handleChange(key: string, value: string) {
    setEdits(prev => ({ ...prev, [key]: value }));
    setMessage(null);
  }

  function currentValue(key: string): string {
    if (key in edits) return edits[key] as string;
    return (config[key]?.value as string) ?? '';
  }

  async function handleSave() {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    setMessage(null);

    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits),
    });

    if (res.ok) {
      setMessage({ type: 'success', text: 'Branding updated. Changes visible on next page load.' });
      setEdits({});
      await fetchConfig();
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Failed to save' });
    }
    setSaving(false);
  }

  async function handleUpload(slot: string, file: File) {
    setUploading(slot);
    setMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('slot', slot);

    const res = await apiFetch('/api/admin/branding', {
      method: 'POST',
      body: formData,
    });

    if (res.ok) {
      const data = await res.json();
      setMessage({ type: 'success', text: `Uploaded ${file.name} successfully.` });
      // Remove any pending URL edit for this slot since upload sets it
      setEdits(prev => {
        const next = { ...prev };
        delete next[slot];
        return next;
      });
      // Update config to reflect the uploaded URL
      setConfig(prev => ({
        ...prev,
        [slot]: { value: data.url, source: 'admin' },
      }));
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Upload failed' });
    }
    setUploading(null);
  }

  async function handleDeleteUpload(slot: string) {
    setMessage(null);

    const res = await apiFetch('/api/admin/branding', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot }),
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

  const isUploadedFile = (key: string): boolean => {
    const val = currentValue(key);
    return val.startsWith('/api/admin/branding/');
  };

  const hasEdits = Object.keys(edits).length > 0;

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
                  {config[field.key]?.source === 'admin' && (
                    <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                      {isUploadedFile(field.key) ? 'uploaded' : 'admin'}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <input
                    type="text"
                    value={currentValue(field.key)}
                    onChange={(e) => handleChange(field.key, e.target.value)}
                    placeholder="Enter URL or upload a file"
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
                    disabled={uploading === field.key}
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-input bg-background text-sm text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                    title="Upload file"
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
                  {config[field.key]?.source === 'admin' && !isUploadedFile(field.key) && (
                    <button onClick={() => handleRevert(field.key)} className="text-muted-foreground hover:text-foreground" title="Revert to default">
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              {/* Preview */}
              {currentValue(field.key) && (
                <div className="mt-2 flex items-center gap-2">
                  <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
                  <div className="h-8 w-auto bg-muted rounded flex items-center justify-center px-2">
                    <img
                      src={currentValue(field.key)}
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
          <h2 className="text-sm font-medium text-foreground">Company Information</h2>
        </div>
        <div className="divide-y divide-border">
          {TEXT_FIELDS.map(field => (
            <div key={field.key} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex items-center gap-2 min-w-0">
                <label className="text-sm text-foreground">{field.label}</label>
                {config[field.key]?.source === 'admin' && (
                  <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/10 text-primary">admin</span>
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
                {config[field.key]?.source === 'admin' && (
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
