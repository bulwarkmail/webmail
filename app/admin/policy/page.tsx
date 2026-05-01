'use client';

import { useEffect, useState } from 'react';
import { Save, Loader2, Lock } from 'lucide-react';
import type { SettingsPolicy, FeatureGates } from '@/lib/admin/types';
import { DEFAULT_FEATURE_GATES, DEFAULT_POLICY } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';

// Feature gates managed on their own admin pages (excluded from this list)
const EXCLUDED_FEATURE_GATES: (keyof FeatureGates)[] = ['pluginsEnabled', 'pluginsUploadEnabled', 'themesEnabled', 'userThemesEnabled'];

const FEATURE_GATE_LABELS: Partial<Record<keyof FeatureGates, { label: string; description: string }>> = {
  sidebarAppsEnabled: { label: 'Sidebar Apps', description: 'Allow custom web apps in navigation rail' },
  settingsExportEnabled: { label: 'Settings Export/Import', description: 'Allow users to export and import settings JSON' },
  customKeywordsEnabled: { label: 'Custom Keywords', description: 'Allow user-created labels and tags' },
  templatesEnabled: { label: 'Email Templates', description: 'Allow email template creation and library' },
  calendarTasksEnabled: { label: 'Calendar Tasks', description: 'Show task panel in calendar view' },
  contactsEnabled: { label: 'Contacts', description: 'Enable contacts/address book features' },
  smimeEnabled: { label: 'S/MIME', description: 'Enable certificate management and email signing' },
  externalContentEnabled: { label: 'External Content', description: 'Allow users to choose external content loading policy' },
  debugModeEnabled: { label: 'Debug Mode', description: 'Allow users to enable debug/diagnostic mode' },
  folderIconsEnabled: { label: 'Folder Icons', description: 'Allow custom folder icon picker' },
  hoverActionsConfigEnabled: { label: 'Hover Actions Config', description: 'Allow users to customize email hover actions' },
  filesEnabled: { label: 'Files (WebDAV)', description: 'Enable file storage via WebDAV. WARNING: Large uploads can cause Stalwart/RocksDB instability. Not recommended for production.' },
};

const RESTRICTABLE_SETTINGS = [
  { key: 'fontSize', label: 'Font Size', category: 'Appearance', type: 'enum', allowedValues: ['small', 'medium', 'large'] },
  { key: 'density', label: 'Density', category: 'Appearance', type: 'enum', allowedValues: ['compact', 'regular', 'spacious'] },
  { key: 'animationsEnabled', label: 'Animations', category: 'Appearance', type: 'boolean' },
  { key: 'markAsReadDelay', label: 'Mark as Read Delay', category: 'Email', type: 'number' },
  { key: 'deleteAction', label: 'Delete Action', category: 'Email', type: 'enum', allowedValues: ['trash', 'permanent'] },
  { key: 'showPreview', label: 'Show Preview', category: 'Email', type: 'boolean' },
  { key: 'mailLayout', label: 'Mail Layout', category: 'Email', type: 'enum', allowedValues: ['split', 'focus'] },
  { key: 'emailsPerPage', label: 'Emails Per Page', category: 'Email', type: 'number' },
  { key: 'externalContentPolicy', label: 'External Content Policy', category: 'Email', type: 'enum', allowedValues: ['allow', 'block', 'ask'] },
  { key: 'sendConfirmation', label: 'Send Confirmation', category: 'Composer', type: 'boolean' },
  { key: 'defaultReplyMode', label: 'Default Reply Mode', category: 'Composer', type: 'enum', allowedValues: ['reply', 'reply-all'] },
  { key: 'autoSelectReplyIdentity', label: 'Auto-select Reply Identity', category: 'Composer', type: 'boolean' },
  { key: 'plainTextMode', label: 'Plain Text Only', category: 'Composer', type: 'boolean' },
  { key: 'sessionTimeout', label: 'Session Timeout', category: 'Privacy', type: 'number' },
  { key: 'emailNotificationsEnabled', label: 'Email Notifications', category: 'Notifications', type: 'boolean' },
  { key: 'calendarNotificationsEnabled', label: 'Calendar Notifications', category: 'Notifications', type: 'boolean' },
  { key: 'debugMode', label: 'Debug Mode', category: 'Advanced', type: 'boolean' },
];

export default function AdminPolicyPage() {
  const [policy, setPolicy] = useState<SettingsPolicy>({ ...DEFAULT_POLICY });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => { fetchPolicy(); }, []);

  async function fetchPolicy() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/policy');
      if (res.ok) {
        const data = await res.json();
        setPolicy(data);
      }
    } finally {
      setLoading(false);
    }
  }

  function toggleFeature(key: keyof FeatureGates) {
    setPolicy(prev => ({
      ...prev,
      features: { ...prev.features, [key]: !prev.features[key] },
    }));
    setDirty(true);
    setMessage(null);
  }

  function toggleLocked(settingKey: string) {
    setPolicy(prev => {
      const existing = prev.restrictions[settingKey] || {};
      const newRestrictions = { ...prev.restrictions };
      if (existing.locked) {
        delete newRestrictions[settingKey];
      } else {
        newRestrictions[settingKey] = { ...existing, locked: true };
      }
      return { ...prev, restrictions: newRestrictions };
    });
    setDirty(true);
    setMessage(null);
  }

  function toggleHidden(settingKey: string) {
    setPolicy(prev => {
      const existing = prev.restrictions[settingKey] || {};
      const newRestrictions = { ...prev.restrictions };
      newRestrictions[settingKey] = { ...existing, hidden: !existing.hidden };
      if (!newRestrictions[settingKey].hidden && !newRestrictions[settingKey].locked) {
        delete newRestrictions[settingKey];
      }
      return { ...prev, restrictions: newRestrictions };
    });
    setDirty(true);
    setMessage(null);
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    const res = await apiFetch('/api/admin/policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    });

    if (res.ok) {
      setMessage({ type: 'success', text: 'Policy saved. Users will see changes on next login.' });
      setDirty(false);
    } else {
      const data = await res.json();
      setMessage({ type: 'error', text: data.error || 'Failed to save' });
    }
    setSaving(false);
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">Loading...</div>;
  }

  const categories = [...new Set(RESTRICTABLE_SETTINGS.map(s => s.category))];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">User Policy</h1>
          <p className="text-sm text-muted-foreground mt-1">Control which features and settings users can access</p>
        </div>
        {dirty && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-all shadow-sm"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save policy
          </button>
        )}
      </div>

      {message && (
        <div className={`text-sm rounded-md px-3 py-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      {/* Feature Gates */}
      <div className="border border-border rounded-lg">
        <div className="px-4 py-3 border-b border-border bg-muted/30">
          <h2 className="text-sm font-medium text-foreground">Feature Gates</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Toggle entire features on or off for all users. Plugin and theme gates are on their respective admin pages.</p>
        </div>
        <div className="divide-y divide-border">
          {(Object.keys(DEFAULT_FEATURE_GATES) as (keyof FeatureGates)[])
            .filter(key => !EXCLUDED_FEATURE_GATES.includes(key))
            .map(key => {
            const meta = FEATURE_GATE_LABELS[key];
            if (!meta) return null;
            const { label, description } = meta;
            const enabled = policy.features[key];
            return (
              <div key={key} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <span className="text-sm text-foreground">{label}</span>
                  <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                </div>
                <button onClick={() => toggleFeature(key)}
                  className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-muted-foreground/25 dark:bg-muted-foreground/50'}`}>
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Setting Restrictions */}
      {categories.map(category => (
        <div key={category} className="border border-border rounded-lg">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <h2 className="text-sm font-medium text-foreground">{category}</h2>
          </div>
          <div className="divide-y divide-border">
            {RESTRICTABLE_SETTINGS.filter(s => s.category === category).map(setting => {
              const restriction = policy.restrictions[setting.key] || {};
              return (
                <div key={setting.key} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <span className="text-sm text-foreground">{setting.label}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                      <input type="checkbox" checked={!!restriction.locked} onChange={() => toggleLocked(setting.key)}
                        className="rounded border-input" />
                      <Lock className="w-3 h-3" /> Lock
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                      <input type="checkbox" checked={!!restriction.hidden} onChange={() => toggleHidden(setting.key)}
                        className="rounded border-input" />
                      Hide
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
