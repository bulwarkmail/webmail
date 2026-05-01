'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Upload, Trash2, Power, PowerOff, AlertTriangle, Loader2, Package, Save, Shield, Lock, LockOpen, Settings } from 'lucide-react';
import type { SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';

interface PluginEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: string;
  enabled: boolean;
  forceEnabled?: boolean;
  permissions: string[];
  installedAt: string;
  updatedAt: string;
}

export default function AdminPluginsPage() {
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [policy, setPolicy] = useState<SettingsPolicy>({ ...DEFAULT_POLICY });
  const [policyDirty, setPolicyDirty] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);

  useEffect(() => { fetchPlugins(); fetchPolicy(); }, []);

  async function fetchPolicy() {
    try {
      const res = await apiFetch('/api/admin/policy');
      if (res.ok) {
        const data = await res.json();
        setPolicy(data);
      }
    } catch { /* ignore */ }
  }

  function togglePluginsEnabled() {
    setPolicy(prev => ({
      ...prev,
      features: { ...prev.features, pluginsEnabled: !prev.features.pluginsEnabled },
    }));
    setPolicyDirty(true);
    setMessage(null);
  }

  function togglePluginsUploadEnabled() {
    setPolicy(prev => ({
      ...prev,
      features: { ...prev.features, pluginsUploadEnabled: !prev.features.pluginsUploadEnabled },
    }));
    setPolicyDirty(true);
    setMessage(null);
  }

  function toggleRequirePluginApproval() {
    setPolicy(prev => ({
      ...prev,
      features: { ...prev.features, requirePluginApproval: !prev.features.requirePluginApproval },
    }));
    setPolicyDirty(true);
    setMessage(null);
  }

  async function handleSavePolicy() {
    setSavingPolicy(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Plugin policy saved. Users will see changes on next login.' });
        setPolicyDirty(false);
      } else {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || 'Failed to save policy' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Failed to save policy' });
    } finally {
      setSavingPolicy(false);
    }
  }

  async function fetchPlugins() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/plugins');
      if (res.ok) setPlugins(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setMessage(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await apiFetch('/api/admin/plugins', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (res.ok) {
        const warnings = data.warnings?.length ? ` (${data.warnings.length} warning(s))` : '';
        setMessage({ type: 'success', text: `Plugin "${data.plugin.name}" installed${warnings}` });
        await fetchPlugins();
      } else {
        setMessage({ type: 'error', text: data.error || 'Upload failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Upload failed' });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function togglePlugin(id: string, enabled: boolean) {
    setMessage(null);
    const res = await apiFetch('/api/admin/plugins', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });

    if (res.ok) {
      setPlugins(prev => prev.map(p => p.id === id ? { ...p, enabled } : p));
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Update failed' });
    }
  }

  async function toggleForceEnabled(id: string, forceEnabled: boolean) {
    setMessage(null);
    // If force-enabling, also ensure the plugin is enabled
    const body: Record<string, unknown> = { id, forceEnabled };
    if (forceEnabled) body.enabled = true;

    const res = await apiFetch('/api/admin/plugins', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      setPlugins(prev => prev.map(p => p.id === id ? { ...p, forceEnabled, ...(forceEnabled ? { enabled: true } : {}) } : p));
      // Also update policy
      setPolicy(prev => {
        const current = prev.forceEnabledPlugins || [];
        return {
          ...prev,
          forceEnabledPlugins: forceEnabled
            ? [...current.filter(pid => pid !== id), id]
            : current.filter(pid => pid !== id),
        };
      });
      setPolicyDirty(true);
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Update failed' });
    }
  }

  async function forceEnableAll() {
    setMessage(null);
    const disabled = plugins.filter(p => !p.enabled);
    if (disabled.length === 0) {
      setMessage({ type: 'success', text: 'All plugins are already enabled' });
      return;
    }
    let failed = 0;
    for (const p of disabled) {
      const res = await apiFetch('/api/admin/plugins', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id, enabled: true }),
      });
      if (!res.ok) failed++;
    }
    setPlugins(prev => prev.map(p => failed === 0 ? { ...p, enabled: true } : p));
    if (failed === 0) {
      await fetchPlugins();
      setMessage({ type: 'success', text: `All ${disabled.length} plugin(s) enabled` });
    } else {
      await fetchPlugins();
      setMessage({ type: 'error', text: `${failed} plugin(s) failed to enable` });
    }
  }

  async function forceDisableAll() {
    setMessage(null);
    const enabled = plugins.filter(p => p.enabled);
    if (enabled.length === 0) {
      setMessage({ type: 'success', text: 'All plugins are already disabled' });
      return;
    }
    let failed = 0;
    for (const p of enabled) {
      const res = await apiFetch('/api/admin/plugins', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id, enabled: false }),
      });
      if (!res.ok) failed++;
    }
    if (failed === 0) {
      await fetchPlugins();
      setMessage({ type: 'success', text: `All ${enabled.length} plugin(s) disabled` });
    } else {
      await fetchPlugins();
      setMessage({ type: 'error', text: `${failed} plugin(s) failed to disable` });
    }
  }

  async function deletePlugin(id: string, name: string) {
    if (!confirm(`Remove plugin "${name}"? This cannot be undone.`)) return;

    setMessage(null);
    const res = await apiFetch('/api/admin/plugins', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });

    if (res.ok) {
      setPlugins(prev => prev.filter(p => p.id !== id));
      setMessage({ type: 'success', text: `Plugin "${name}" removed` });
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Delete failed' });
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">Loading...</div>;
  }

  const pluginsEnabled = policy.features.pluginsEnabled ?? true;
  const pluginsUploadEnabled = policy.features.pluginsUploadEnabled ?? true;
  const requirePluginApproval = policy.features.requirePluginApproval ?? true;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">Plugins</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage plugins and plugin policy for all users</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {policyDirty && (
            <button
              onClick={handleSavePolicy}
              disabled={savingPolicy}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-all shadow-sm"
            >
              {savingPolicy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Policy
            </button>
          )}
          <label className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 cursor-pointer transition-all shadow-sm">
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload Plugin
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              onChange={handleUpload}
              disabled={uploading}
              className="sr-only"
            />
          </label>
        </div>
      </div>

      {message && (
        <div className={`text-sm rounded-md px-3 py-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      {/* Plugin Policy */}
      <div className="border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">Plugin Policy</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">Control plugin availability for users</p>
        </div>
        <div className="divide-y divide-border">
          <div className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <span className="text-sm text-foreground">Plugins Enabled</span>
              <p className="text-xs text-muted-foreground mt-0.5">Allow the plugin system to load and run plugins for users</p>
            </div>
            <button onClick={togglePluginsEnabled}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${pluginsEnabled ? 'bg-primary' : 'bg-muted-foreground/25 dark:bg-muted-foreground/50'}`}>
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${pluginsEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
            </button>
          </div>

          <div className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <span className="text-sm text-foreground">User Plugin Uploads</span>
              <p className="text-xs text-muted-foreground mt-0.5">Allow users to upload plugin ZIP files in Settings</p>
            </div>
            <button onClick={togglePluginsUploadEnabled}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${pluginsUploadEnabled ? 'bg-primary' : 'bg-muted-foreground/25 dark:bg-muted-foreground/50'}`}>
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${pluginsUploadEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
            </button>
          </div>

          <div className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div>
              <span className="text-sm text-foreground">Require Admin Approval</span>
              <p className="text-xs text-muted-foreground mt-0.5">User-uploaded plugins must be approved by an admin before they can be enabled</p>
            </div>
            <button onClick={toggleRequirePluginApproval}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${requirePluginApproval ? 'bg-primary' : 'bg-muted-foreground/25 dark:bg-muted-foreground/50'}`}>
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${requirePluginApproval ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
            </button>
          </div>

          {/* Force enable / disable all */}
          {plugins.length > 0 && (
            <div className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div>
                <span className="text-sm text-foreground">Force Enable / Disable All</span>
                <p className="text-xs text-muted-foreground mt-0.5">Bulk toggle all deployed plugins at once</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={forceEnableAll}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 transition-colors"
                >
                  <Power className="w-3.5 h-3.5" />
                  Enable All
                </button>
                <button
                  onClick={forceDisableAll}
                  className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-muted text-muted-foreground text-xs font-medium hover:bg-accent hover:text-foreground transition-colors"
                >
                  <PowerOff className="w-3.5 h-3.5" />
                  Disable All
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Deployed Plugins */}
      <div className="border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">Deployed Plugins</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">Admin-uploaded plugins for all users</p>
        </div>
        {plugins.length === 0 ? (
          <div className="p-12 text-center">
            <Package className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No plugins installed</p>
            <p className="text-xs text-muted-foreground mt-1">Upload a plugin ZIP file to get started</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {plugins.map(plugin => (
              <div key={plugin.id} className="px-4 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium text-foreground">{plugin.name}</span>
                    <span className="text-xs text-muted-foreground">v{plugin.version}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${plugin.enabled ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
                      {plugin.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    {plugin.forceEnabled && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 flex items-center gap-1">
                        <Lock className="w-3 h-3" /> Forced
                      </span>
                    )}
                  </div>
                {plugin.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{plugin.description}</p>
                )}
                <div className="text-xs text-muted-foreground mt-1">
                  by {plugin.author} &middot; {plugin.type} &middot; installed {new Date(plugin.installedAt).toLocaleDateString()}
                </div>
                {plugin.permissions.length > 0 && (
                  <div className="flex items-center gap-1 mt-1">
                    <AlertTriangle className="w-3 h-3 text-warning" />
                    <span className="text-xs text-warning">
                      Permissions: {plugin.permissions.join(', ')}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Link
                  href={`/admin/plugins/${plugin.id}`}
                  title="Configure"
                  className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Settings className="w-4 h-4" />
                </Link>
                <button
                  onClick={() => toggleForceEnabled(plugin.id, !plugin.forceEnabled)}
                  title={plugin.forceEnabled ? 'Remove force-enable (users can disable)' : 'Force enable (users cannot disable)'}
                  className={`p-2 rounded-md transition-colors ${plugin.forceEnabled ? 'bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:hover:bg-amber-950/50' : 'hover:bg-accent text-muted-foreground hover:text-foreground'}`}
                >
                  {plugin.forceEnabled ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => togglePlugin(plugin.id, !plugin.enabled)}
                  title={plugin.enabled ? 'Disable' : 'Enable'}
                  className="p-2 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Power className="w-4 h-4" />
                </button>
                <button
                  onClick={() => deletePlugin(plugin.id, plugin.name)}
                  title="Remove"
                  className="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          </div>
        )}
      </div>
    </div>
  );
}
