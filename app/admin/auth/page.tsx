'use client';

import { useEffect, useState } from 'react';
import { Save, Loader2, RotateCcw } from 'lucide-react';
import { apiPath } from "@/lib/api-path";

interface ConfigEntry {
  value: unknown;
  source: 'admin' | 'env' | 'default';
}

export default function AdminAuthPage() {
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => { fetchConfig(); }, []);

  async function fetchConfig() {
    setLoading(true);
    const res = await fetch(apiPath('/api/admin/config'));
    if (res.ok) setConfig(await res.json());
    setLoading(false);
  }

  function handleChange(key: string, value: unknown) {
    setEdits(prev => ({ ...prev, [key]: value }));
    setMessage(null);
  }

  function currentValue(key: string): unknown {
    if (key in edits) return edits[key];
    return config[key]?.value;
  }

  async function handleSave() {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    setMessage(null);

    const res = await fetch(apiPath('/api/admin/config'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits),
    });

    if (res.ok) {
      setMessage({ type: 'success', text: 'Authentication settings saved.' });
      setEdits({});
      await fetchConfig();
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Failed to save' });
    }
    setSaving(false);
  }

  async function handleRevert(key: string) {
    const res = await fetch(apiPath('/api/admin/config'), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      setEdits(prev => { const next = { ...prev }; delete next[key]; return next; });
      await fetchConfig();
    }
  }

  const hasEdits = Object.keys(edits).length > 0;

  if (loading) {
    return <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Authentication</h1>
          <p className="text-sm text-muted-foreground mt-1">OAuth, SSO, and session configuration</p>
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

      {/* OAuth */}
      <Section title="OAuth / OpenID Connect">
        <Toggle label="OAuth Enabled" configKey="oauthEnabled" value={currentValue('oauthEnabled') as boolean} source={config.oauthEnabled?.source} onChange={handleChange} onRevert={handleRevert} />
        <Toggle label="OAuth Only" description="Hide password login form when enabled" configKey="oauthOnly" value={currentValue('oauthOnly') as boolean} source={config.oauthOnly?.source} onChange={handleChange} onRevert={handleRevert} />
        <Text label="OAuth Client ID" configKey="oauthClientId" value={currentValue('oauthClientId') as string} source={config.oauthClientId?.source} onChange={handleChange} onRevert={handleRevert} />
        <Text label="OAuth Client Secret" configKey="oauthClientSecret" value={currentValue('oauthClientSecret') as string} source={config.oauthClientSecret?.source} onChange={handleChange} onRevert={handleRevert} type="password" />
        <Text label="OAuth Issuer URL" configKey="oauthIssuerUrl" value={currentValue('oauthIssuerUrl') as string} source={config.oauthIssuerUrl?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://auth.example.com" />
      </Section>

      {/* SSO */}
      <Section title="Single Sign-On">
        <Toggle label="Auto SSO" description="Automatically redirect to SSO provider on load" configKey="autoSsoEnabled" value={currentValue('autoSsoEnabled') as boolean} source={config.autoSsoEnabled?.source} onChange={handleChange} onRevert={handleRevert} />
      </Section>

      {/* Session & Security */}
      <Section title="Session & Security">
        <Select label="Cookie SameSite" configKey="cookieSameSite" value={currentValue('cookieSameSite') as string} source={config.cookieSameSite?.source} options={['lax', 'strict', 'none']} onChange={handleChange} onRevert={handleRevert} />
        <Text label="Allowed Frame Ancestors" configKey="allowedFrameAncestors" value={currentValue('allowedFrameAncestors') as string} source={config.allowedFrameAncestors?.source} onChange={handleChange} onRevert={handleRevert} placeholder="'none' or https://..." />
        <Text label="Parent Origin" description="For embedded mode communication" configKey="parentOrigin" value={currentValue('parentOrigin') as string} source={config.parentOrigin?.source} onChange={handleChange} onRevert={handleRevert} />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg">
      <div className="px-4 py-3 border-b border-border bg-muted/30">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

function SourceBadge({ source }: { source?: string }) {
  if (!source || source === 'default') return null;
  return (
    <span className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${source === 'admin' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
      {source}
    </span>
  );
}

function Text({ label, description, configKey, value, source, onChange, onRevert, placeholder, type = 'text' }: {
  label: string; description?: string; configKey: string; value: string; source?: string;
  onChange: (k: string, v: unknown) => void; onRevert: (k: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground">{label}</span>
          <SourceBadge source={source} />
        </div>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="flex items-center gap-2">
        <input type={type} value={value ?? ''} onChange={(e) => onChange(configKey, e.target.value)} placeholder={placeholder}
          className="h-8 w-64 rounded-md border border-input bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        {source === 'admin' && (
          <button onClick={() => onRevert(configKey)} className="text-muted-foreground hover:text-foreground" title="Revert"><RotateCcw className="w-3.5 h-3.5" /></button>
        )}
      </div>
    </div>
  );
}

function Toggle({ label, description, configKey, value, source, onChange, onRevert }: {
  label: string; description?: string; configKey: string; value: boolean; source?: string;
  onChange: (k: string, v: unknown) => void; onRevert: (k: string) => void;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground">{label}</span>
          <SourceBadge source={source} />
        </div>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => onChange(configKey, !value)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? 'bg-primary' : 'bg-muted-foreground/25 dark:bg-muted-foreground/50'}`}>
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${value ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
        </button>
        {source === 'admin' && (
          <button onClick={() => onRevert(configKey)} className="text-muted-foreground hover:text-foreground" title="Revert"><RotateCcw className="w-3.5 h-3.5" /></button>
        )}
      </div>
    </div>
  );
}

function Select({ label, configKey, value, source, options, onChange, onRevert }: {
  label: string; configKey: string; value: string; source?: string; options: string[];
  onChange: (k: string, v: unknown) => void; onRevert: (k: string) => void;
}) {
  return (
    <div className="px-4 py-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-foreground">{label}</span>
        <SourceBadge source={source} />
      </div>
      <div className="flex items-center gap-2">
        <select value={value ?? ''} onChange={(e) => onChange(configKey, e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        {source === 'admin' && (
          <button onClick={() => onRevert(configKey)} className="text-muted-foreground hover:text-foreground" title="Revert"><RotateCcw className="w-3.5 h-3.5" /></button>
        )}
      </div>
    </div>
  );
}
