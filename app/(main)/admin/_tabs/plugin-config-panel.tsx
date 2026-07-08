'use client';

import { useEffect, useState } from 'react';
import { Puzzle, ArrowLeft, Loader2, Eye, EyeOff } from 'lucide-react';
import { apiFetch } from '@/lib/browser-navigation';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';

interface ConfigField {
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: { label: string; value: string }[];
}

interface PluginConfig {
  [key: string]: unknown;
}

interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  type: string;
  permissions: string[];
  enabled: boolean;
  configSchema?: Record<string, ConfigField>;
}

interface Props {
  pluginId: string;
  onBack: () => void;
}

export function PluginConfigPanel({ pluginId, onBack }: Props) {
  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [config, setConfig] = useState<PluginConfig>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revealSecrets, setRevealSecrets] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoading(true);
      try {
        const [pluginsRes, configRes] = await Promise.all([
          apiFetch('/api/admin/plugins'),
          apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`),
        ]);
        if (cancelled) return;

        if (pluginsRes.ok) {
          const plugins: PluginInfo[] = await pluginsRes.json();
          setPlugin(plugins.find(p => p.id === pluginId) || null);
        }

        if (configRes.ok) {
          setConfig(await configRes.json());
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchData();
    return () => { cancelled = true; };
  }, [pluginId]);

  useEffect(() => {
    if (!plugin?.configSchema) return;
    const initial: Record<string, string> = {};
    for (const [key, field] of Object.entries(plugin.configSchema)) {
      const stored = config[key];
      if (stored !== undefined && stored !== null) {
        initial[key] = String(stored);
      } else if (field.default !== undefined) {
        initial[key] = String(field.default);
      } else {
        initial[key] = '';
      }
    }
    setFormValues(initial);
  }, [plugin, config]);

  async function handleSaveAll() {
    if (!plugin?.configSchema) return;
    setSaving(true);
    setMessage(null);

    for (const [key, field] of Object.entries(plugin.configSchema)) {
      if (field.required && !formValues[key]?.trim()) {
        setMessage({ type: 'error', text: `"${field.label}" is required` });
        setSaving(false);
        return;
      }
    }

    try {
      let hasError = false;
      for (const [key, field] of Object.entries(plugin.configSchema)) {
        const newVal = formValues[key] ?? '';
        const oldVal = config[key] !== undefined ? String(config[key]) : '';

        if (newVal === oldVal) continue;
        if (field.type === 'secret' && !newVal && config[key]) continue;

        let value: unknown = newVal;
        if (field.type === 'boolean') value = newVal === 'true';
        else if (field.type === 'number') value = Number(newVal);

        if (!newVal && !field.required) {
          const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
          });
          if (res.ok) {
            setConfig(prev => { const next = { ...prev }; delete next[key]; return next; });
          } else {
            hasError = true;
          }
          continue;
        }

        const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
        if (res.ok) {
          setConfig(prev => ({ ...prev, [key]: value }));
        } else {
          hasError = true;
        }
      }

      setMessage(hasError
        ? { type: 'error', text: 'Some settings failed to save' }
        : { type: 'success', text: 'Configuration saved' }
      );
    } catch {
      setMessage({ type: 'error', text: 'Failed to save configuration' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin me-2" />
        Loading...
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Plugins
        </button>
        <p className="text-sm text-destructive">Plugin not found: {pluginId}</p>
      </div>
    );
  }

  const schema = plugin.configSchema;
  const hasSchema = schema && Object.keys(schema).length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          aria-label="Back to Plugins"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <Puzzle className="w-5 h-5" />
            {plugin.name} Configuration
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            v{plugin.version} by {plugin.author}
          </p>
        </div>
      </div>

      {message && (
        <div className={`text-sm rounded-md px-3 py-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      {hasSchema ? (
        <div className="border border-border rounded-lg">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <h2 className="text-sm font-medium text-foreground">Settings</h2>
          </div>
          <div className="p-4 space-y-5">
            {Object.entries(schema).map(([key, field]) => (
              <div key={key}>
                <label className="text-sm font-medium text-foreground block mb-1">
                  {field.label}
                  {field.required && <span className="text-destructive ms-0.5">*</span>}
                </label>
                {field.description && (
                  <p className="text-xs text-muted-foreground mb-1.5">{field.description}</p>
                )}

                {field.type === 'boolean' ? (
                  <select
                    value={formValues[key] ?? String(field.default ?? 'false')}
                    onChange={(e) => setFormValues(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                ) : field.type === 'select' && field.options ? (
                  <select
                    value={formValues[key] ?? ''}
                    onChange={(e) => setFormValues(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">- Select -</option>
                    {field.options.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : field.type === 'secret' ? (
                  <div className="relative">
                    <input
                      type={revealSecrets[key] ? 'text' : 'password'}
                      value={formValues[key] ?? ''}
                      onChange={(e) => setFormValues(prev => ({ ...prev, [key]: e.target.value }))}
                      placeholder={config[key] ? '••••••••  (unchanged)' : (field.placeholder || '')}
                      className="w-full h-9 px-3 pe-10 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setRevealSecrets(prev => ({ ...prev, [key]: !prev[key] }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
                      aria-label={revealSecrets[key] ? 'Hide' : 'Show'}
                    >
                      {revealSecrets[key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                ) : (
                  <input
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={formValues[key] ?? ''}
                    onChange={(e) => setFormValues(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={field.placeholder || ''}
                    className="w-full h-9 px-3 rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                )}
              </div>
            ))}

            <button
              onClick={handleSaveAll}
              disabled={saving}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-all shadow-sm"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Save Configuration
            </button>
          </div>
        </div>
      ) : (
        <div className="border border-border rounded-lg p-8 text-center">
          <p className="text-sm text-muted-foreground">This plugin does not declare any configuration settings.</p>
        </div>
      )}

      <PluginAdminSection pluginId={pluginId} />
    </div>
  );
}

/**
 * Renders the plugin's own `admin-plugin-page` slot, if the plugin offers
 * one. Sandboxed plugins ship a React component under `slots['admin-plugin-page']`
 * and the host gives it a dedicated iframe inside the admin panel.
 */
function PluginAdminSection({ pluginId }: { pluginId: string }) {
  const offers = usePluginSlotOffers('admin-plugin-page');
  const offer = offers.find((o) => o.pluginId === pluginId);
  if (!offer) return null;
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Plugin admin panel
      </div>
      <PluginIframeSlot pluginId={pluginId} slot="admin-plugin-page" />
    </div>
  );
}
