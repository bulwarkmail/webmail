'use client';

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Puzzle, SwatchBook, Loader2, Eye, EyeOff, Lock, RotateCcw, Trash2, Shield, ShieldAlert, Store, Upload } from '@/components/icons';
import { apiFetch } from '@/lib/browser-navigation';
import { adminPath } from '@/lib/admin/admin-nav';
import { HIGH_RISK_PERMISSIONS } from '@/lib/plugin-sandbox/permission-text';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { navigateAdmin } from '@/hooks/use-admin-navigation';
import { usePluginSlotOffers } from '@/hooks/use-plugin-slot-offers';
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { SettingsSection, SettingItem, ToggleSwitch, Select } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminLink } from '@/components/admin/admin-link';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { Badge } from '@/components/admin/badge';
import { useAdminFeedback } from '@/components/admin/feedback';
import { inputClass } from '@/components/admin/config-items';
import { ExtensionIcon } from '@/components/admin/extension-icon';
import { cn } from '@/lib/utils';
import { useExtensionIcons } from './use-extension-icons';
import { pluginTypeLabel } from './plugin-type-label';
import { useTranslations } from 'next-intl';
import { permissionKey } from '@/lib/plugin-sandbox/permission-text';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { ChangelogNotes } from '@/components/admin/changelog';
import { rollbackVersion, withdrawnNote } from './marketplace';

export interface ConfigField {
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: { label: string; value: string }[];
  /** A string that takes several lines (instructions, templates): a full-width text box. */
  multiline?: boolean;
}

/** A plugin or theme as /api/admin/plugins and /api/admin/themes list it. */
export interface ExtensionEntry {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** Plugins: hook, ui-extension, ... */
  type?: string;
  /** Themes: the colour modes it ships. */
  variants?: string[];
  enabled: boolean;
  forceEnabled?: boolean;
  /** Plugins: users get it off until they turn it on. */
  defaultOff?: boolean;
  permissions?: string[];
  installedAt: string;
  updatedAt: string;
  source?: { kind: 'marketplace'; slug: string; directoryUrl: string } | { kind: 'upload' };
  /** Versions kept on this server for a rollback, most recently replaced first. */
  previousVersions?: string[];
  /** The installed version's changelog, kept from a marketplace install. */
  changelog?: string;
  /** The changelogs of the kept versions that have one, by version. */
  previousChangelogs?: Record<string, string>;
  /** Kept versions the directory had withdrawn when they were installed, or may have ('unknown'). */
  previousWithdrawn?: Record<string, { reason: string | null } | 'unknown'>;
  /** Loaded from the dev plugins directory rather than installed. */
  dev?: boolean;
  configSchema?: Record<string, ConfigField>;
}

type Kind = 'plugin' | 'theme';

/**
 * A permission in the words users see when they're asked (the consent
 * dialog's catalogue), with its id small beside it for those who know it.
 */
function PermissionText({ perm }: { perm: string }) {
  const t = useTranslations('plugins.permissions');
  return (
    <span className="min-w-0 flex-1">
      <span className="text-sm text-foreground">{t(`${permissionKey(perm)}.title`)}</span>{' '}
      <code className="font-mono text-[0.6875rem] text-muted-foreground">{perm}</code>
    </span>
  );
}

/** What users get from an installed plugin, as one choice (PATCH: forceEnabled + defaultOff). */
export type PluginUserMode = 'default-on' | 'always' | 'default-off';

export const PLUGIN_USER_MODES: ReadonlyArray<{ value: PluginUserMode; label: string; description: string }> = [
  {
    value: 'default-on',
    label: 'On for everyone, users can turn it off',
    description: 'Every user gets it turned on. Anyone can turn it off for their own account in Settings > Add-ons.',
  },
  {
    value: 'always',
    label: 'On for everyone, always',
    description: 'Every user gets it turned on and can\'t turn it off.',
  },
  {
    value: 'default-off',
    label: 'Off until users turn it on',
    description: 'Users see it in Settings > Add-ons, turned off, and can turn it on for their own account.',
  },
];

export function pluginUserMode(entry: { forceEnabled?: boolean; defaultOff?: boolean }): PluginUserMode {
  if (entry.forceEnabled) return 'always';
  return entry.defaultOff ? 'default-off' : 'default-on';
}

const KIND_LABEL: Record<Kind, { one: string; many: string; endpoint: string }> = {
  plugin: { one: 'plugin', many: 'Plugins', endpoint: '/api/admin/plugins' },
  theme: { one: 'theme', many: 'Themes', endpoint: '/api/admin/themes' },
};

interface Props {
  kind: Kind;
  id: string;
}

/**
 * One installed plugin or theme: its settings first, then whether users
 * can turn it off, what it may do, and the versions kept for a rollback.
 */
export function ExtensionDetailPage({ kind, id }: Props) {
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();
  const words = KIND_LABEL[kind];
  const listHref = adminPath(kind === 'plugin' ? 'plugins' : 'themes');
  const [entry, setEntry] = useState<ExtensionEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [revealSecrets, setRevealSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const setMessage = useAdminFeedback();
  const iconFor = useExtensionIcons();

  const load = useCallback(async () => {
    const [listRes, configRes] = await Promise.all([
      apiFetch(words.endpoint),
      kind === 'plugin' ? apiFetch(`/api/admin/plugins/${encodeURIComponent(id)}/config`) : Promise.resolve(null),
    ]);
    if (listRes.ok) {
      const entries: ExtensionEntry[] = await listRes.json();
      setEntry(entries.find((e) => e.id === id) ?? null);
    }
    if (configRes?.ok) setConfig(await configRes.json());
  }, [id, kind, words.endpoint]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  const schema = entry?.configSchema;
  const hasSchema = !!schema && Object.keys(schema).length > 0;

  const savedValues = useMemo(() => {
    const initial: Record<string, string> = {};
    if (!schema) return initial;
    for (const [key, field] of Object.entries(schema)) {
      const stored = config[key];
      if (stored !== undefined && stored !== null) initial[key] = String(stored);
      else if (field.default !== undefined) initial[key] = String(field.default);
      else initial[key] = '';
    }
    return initial;
  }, [schema, config]);

  useEffect(() => {
    if (!schema) return;
    setFormValues(savedValues);
  }, [schema, savedValues]);

  const dirty = Object.keys(savedValues).some((key) => (formValues[key] ?? '') !== savedValues[key]);
  // On/off and what users get wait for Save like the settings below.
  const [availabilityDraft, setAvailabilityDraft] = useState<{ enabled?: boolean; forceEnabled?: boolean; defaultOff?: boolean }>({});
  const shownForced = availabilityDraft.forceEnabled ?? !!entry?.forceEnabled;
  const shownDefaultOff = availabilityDraft.defaultOff ?? !!entry?.defaultOff;
  const shownMode = pluginUserMode({ forceEnabled: shownForced, defaultOff: shownDefaultOff });
  const shownEnabled = shownForced || (availabilityDraft.enabled ?? !!entry?.enabled);
  const availabilityDirty = !!entry && (
    shownEnabled !== entry.enabled
    || shownForced !== !!entry.forceEnabled
    || (kind === 'plugin' && shownDefaultOff !== !!entry.defaultOff)
  );
  useAdminUnsavedChanges(`${kind}-config`, dirty || availabilityDirty);

  async function saveConfig() {
    if (!schema) return;
    for (const [key, field] of Object.entries(schema)) {
      if (field.required && !formValues[key]?.trim()) {
        setMessage({ type: 'error', text: `"${field.label}" is required` });
        return;
      }
    }
    setSaving(true);
    setMessage(null);
    try {
      let firstError: string | null = null;
      let failed = false;
      const noteError = async (res: Response) => {
        failed = true;
        if (firstError) return;
        const data = await res.json().catch(() => null);
        if (typeof data?.error === 'string') firstError = data.error;
      };
      const endpoint = `/api/admin/plugins/${encodeURIComponent(id)}/config`;
      for (const [key, field] of Object.entries(schema)) {
        const newVal = formValues[key] ?? '';
        const oldVal = config[key] !== undefined ? String(config[key]) : '';
        if (newVal === oldVal) continue;
        if (field.type === 'secret' && !newVal && config[key]) continue;

        if (!newVal && !field.required) {
          const res = await apiFetch(endpoint, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
          });
          if (res.ok) setConfig((prev) => { const next = { ...prev }; delete next[key]; return next; });
          else await noteError(res);
          continue;
        }

        let value: unknown = newVal;
        if (field.type === 'boolean') value = newVal === 'true';
        else if (field.type === 'number') value = Number(newVal);
        const res = await apiFetch(endpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
        if (res.ok) setConfig((prev) => ({ ...prev, [key]: value }));
        else await noteError(res);
      }
      setMessage(failed
        ? { type: 'error', text: firstError ?? 'Some settings could not be saved' }
        : { type: 'success', text: 'Settings saved' });
    } catch {
      setMessage({ type: 'error', text: 'Could not save the settings' });
    } finally {
      setSaving(false);
    }
  }

  async function patch(body: Record<string, unknown>, what: string): Promise<boolean> {
    setBusy(what);
    setMessage(null);
    try {
      const res = await apiFetch(words.endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      });
      if (res.ok) return true;
      const data = await res.json().catch(() => ({}));
      setMessage({ type: 'error', text: data.error || `Could not change the ${words.one}` });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function saveAvailability(): Promise<boolean> {
    if (!entry) return true;
    const body: Record<string, unknown> = {};
    if (shownForced !== !!entry.forceEnabled) body.forceEnabled = shownForced;
    if (kind === 'plugin' && shownDefaultOff !== !!entry.defaultOff) body.defaultOff = shownDefaultOff;
    if (shownEnabled !== entry.enabled) body.enabled = shownEnabled;
    const ok = await patch(body, 'availability');
    if (ok) setEntry((prev) => (prev ? { ...prev, enabled: shownEnabled, forceEnabled: shownForced, ...(kind === 'plugin' ? { defaultOff: shownDefaultOff } : {}) } : prev));
    setAvailabilityDraft({});
    return ok;
  }

  async function save() {
    if (availabilityDirty && !(await saveAvailability())) return;
    if (dirty) await saveConfig();
    else setMessage({ type: 'success', text: 'Saved' });
  }

  async function rollback(version: string) {
    if (!entry) return;
    const ok = await confirm({
      title: `Roll back to v${version}?`,
      message: `"${entry.name}" v${version} replaces v${entry.version}. The copy kept on this server is used.`
        + (entry.changelog ? ` What v${entry.version} changed, listed under Versions, is undone.` : '')
        + withdrawnNote(version, entry.previousWithdrawn?.[version]),
      confirmText: 'Roll back',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    setBusy(`rollback:${version}`);
    setMessage(null);
    try {
      const result = await rollbackVersion({ kind, id, name: entry.name, version }, confirm);
      if (result.ok) {
        setMessage({ type: 'success', text: `"${entry.name}" rolled back to v${version}` });
        await load();
      } else {
        setMessage({ type: 'error', text: result.error });
      }
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!entry) return;
    const ok = await confirm({
      title: `Remove "${entry.name}"?`,
      message: 'It is removed for every user, with the versions kept on this server. This cannot be undone.',
      confirmText: 'Remove',
      cancelText: 'Cancel',
      variant: 'destructive',
    });
    if (!ok) return;
    setBusy('remove');
    setMessage(null);
    const res = await apiFetch(words.endpoint, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      navigateAdmin(listHref);
      return;
    }
    const data = await res.json().catch(() => ({}));
    setMessage({ type: 'error', text: data.error || 'Could not remove it' });
    setBusy(null);
  }

  const back = { href: listHref, label: words.many };
  const Icon = kind === 'plugin' ? Puzzle : SwatchBook;

  if (loading && !entry) {
    return (
      <div>
        <AdminPageHeader back={back} title={<span className="text-muted-foreground">Loading</span>} />
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="me-2 h-4 w-4 animate-spin" /> Loading
        </div>
      </div>
    );
  }

  if (!entry) {
    return (
      <div>
        <AdminPageHeader back={back} title={`${words.one[0].toUpperCase()}${words.one.slice(1)} not found`} description={<>Nothing is installed under the id <code className="font-mono text-xs">{id}</code>.</>} />
      </div>
    );
  }

  const perms = [...new Set(entry.permissions ?? [])]
    .sort((a, b) => Number(HIGH_RISK_PERMISSIONS.has(b)) - Number(HIGH_RISK_PERMISSIONS.has(a)));
  const previous = entry.previousVersions ?? [];

  return (
    <div>
      <AdminPageHeader
        back={back}
        leading={(
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
            <ExtensionIcon url={iconFor(entry)} fallback={Icon} className={iconFor(entry) ? 'h-full w-full object-cover' : 'h-5 w-5'} />
          </div>
        )}
        title={(
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {entry.name}
            <span className="text-sm font-normal text-muted-foreground">v{entry.version}</span>
            {entry.forceEnabled && <Badge tone="warning" icon={<Lock className="h-3 w-3" />}>Always on</Badge>}
            {entry.dev && <Badge tone="info" title="Loaded from the dev plugins directory">Dev</Badge>}
          </span>
        )}
        description={(
          <>
            by {entry.author || 'unknown'}
            {entry.type && <> &middot; {kind === 'plugin' ? pluginTypeLabel(entry.type) : entry.type}</>}
            {entry.variants && entry.variants.length > 0 && <> &middot; {entry.variants.join(', ')}</>}
            {entry.installedAt && <> &middot; installed {new Date(entry.installedAt).toLocaleDateString()}</>}
          </>
        )}
        actions={(
          <>
            <label className="flex h-9 items-center gap-2.5 rounded-md border border-input bg-background px-3 text-sm">
              <span className={cn('font-medium', shownEnabled ? 'text-foreground' : 'text-muted-foreground')}>{shownEnabled ? 'On' : 'Off'}</span>
              <ToggleSwitch
                checked={shownEnabled}
                disabled={busy === 'availability' || shownForced}
                onChange={(v) => { setMessage(null); setAvailabilityDraft((prev) => ({ ...prev, enabled: v })); }}
                ariaLabel={`${entry.name} enabled`}
              />
            </label>
            <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" disabled={busy === 'remove'} onClick={() => void remove()}>
              {busy === 'remove' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Remove
            </Button>
          </>
        )}
      />

      {entry.description && <p className="-mt-2 mb-6 text-sm text-foreground">{entry.description}</p>}

      <ConfirmDialog {...confirmProps} />

      <div className="space-y-10">
        <SettingsSection id="availability" title="Availability" description={`Whether users get this ${words.one} and whether they can turn it off.`}>
          {kind === 'plugin' ? (
            <SettingItem
              label="For users"
              description={shownEnabled
                ? PLUGIN_USER_MODES.find((m) => m.value === shownMode)!.description
                : 'The plugin is off for everyone. Turn it on at the top of this page first.'}
            >
              <Select
                value={shownMode}
                disabled={busy === 'availability'}
                options={PLUGIN_USER_MODES.map(({ value, label }) => ({ value, label }))}
                onChange={(value) => {
                  setMessage(null);
                  setAvailabilityDraft((prev) => ({ ...prev, forceEnabled: value === 'always', defaultOff: value === 'default-off' }));
                }}
              />
            </SettingItem>
          ) : (
            <SettingItem
              label="Always on for everyone"
              description="Users can't deactivate it. Turning this on also enables the theme."
            >
              <ToggleSwitch
                checked={shownForced}
                disabled={busy === 'availability'}
                onChange={(v) => { setMessage(null); setAvailabilityDraft((prev) => ({ ...prev, forceEnabled: v })); }}
              />
            </SettingItem>
          )}
          <SettingItem label="Source" description={entry.source?.kind === 'marketplace' ? 'Installed from the extension directory; updates show up in the marketplace.' : 'Installed from an uploaded ZIP.'}>
            {entry.source?.kind === 'marketplace' ? (
              <AdminLink href={adminPath('marketplace', entry.source.slug)} className="inline-flex items-center gap-1.5 text-sm text-foreground hover:underline">
                <Store className="h-4 w-4 text-muted-foreground" /> Open in marketplace
              </AdminLink>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"><Upload className="h-4 w-4" /> Upload</span>
            )}
          </SettingItem>
        </SettingsSection>

        {kind === 'plugin' && (
          <SettingsSection id="permissions" title="Permissions" description={perms.length === 0 ? 'This plugin asks for no permissions.' : 'What the plugin may do in each user\'s mailbox. High-risk ones first.'}>
            {perms.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {perms.map((perm) => {
                  const risky = HIGH_RISK_PERMISSIONS.has(perm);
                  return (
                    <li key={perm} className="flex items-center gap-2.5 px-3 py-2 text-sm">
                      {risky
                        ? <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-label="High risk" />
                        : <Shield className="h-4 w-4 shrink-0 text-muted-foreground/60" />}
                      <PermissionText perm={perm} />
                      {risky && <Badge tone="warning">High risk</Badge>}
                    </li>
                  );
                })}
              </ul>
            )}
          </SettingsSection>
        )}

        <SettingsSection id="versions" title="Versions" description={previous.length === 0 ? 'No earlier version is kept on this server.' : 'Earlier versions kept on this server can be put back without the directory.'}>
          <VersionRow label="Installed" changelog={entry.changelog} notesLabel={`What's new in v${entry.version}`}>
            <span className="font-mono text-sm text-foreground">v{entry.version}</span>
          </VersionRow>
          {previous.map((version) => (
            <VersionRow key={version} label={`v${version}`} description="Kept on this server" changelog={entry.previousChangelogs?.[version]} notesLabel="Changelog">
              <Button variant="outline" size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void rollback(version)}>
                {busy === `rollback:${version}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                Roll back
              </Button>
            </VersionRow>
          ))}
        </SettingsSection>

        {kind === 'plugin' && <PluginAdminSection pluginId={id} />}

        {/* The plugin's own settings come last: they are the long part. */}
        {kind === 'plugin' && hasSchema && schema && (
          <SettingsSection id="settings" title="Settings" description="What this plugin reads from the server. Saved for every user.">
            {Object.entries(schema).map(([key, field]) => field.type === 'string' && field.multiline ? (
              <MultilineConfigItem
                key={key}
                field={field}
                value={formValues[key] ?? ''}
                onChange={(v) => setFormValues((prev) => ({ ...prev, [key]: v }))}
              />
            ) : (
              <SettingItem
                key={key}
                label={field.required ? `${field.label} *` : field.label}
                description={field.description}
              >
                <ConfigFieldControl
                  field={field}
                  value={formValues[key] ?? ''}
                  stored={config[key] !== undefined && config[key] !== null && config[key] !== ''}
                  revealed={!!revealSecrets[key]}
                  onReveal={() => setRevealSecrets((prev) => ({ ...prev, [key]: !prev[key] }))}
                  onChange={(v) => setFormValues((prev) => ({ ...prev, [key]: v }))}
                />
              </SettingItem>
            ))}
          </SettingsSection>
        )}
      </div>

      <AdminSaveBar
        dirty={dirty || availabilityDirty}
        saving={saving || busy === 'availability'}
        onSave={() => void save()}
        onDiscard={() => { setFormValues(savedValues); setAvailabilityDraft({}); }}
        saveLabel="Save"
      />
    </div>
  );
}

/** A row of the Versions section: like a SettingItem, with the version's changelog under its label. */
function VersionRow({ label, description, changelog, notesLabel, children }: {
  label: string;
  description?: string;
  changelog?: string;
  notesLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1 sm:pe-4">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        {changelog && (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">{notesLabel}</summary>
            <ChangelogNotes markdown={changelog} className="mt-2" />
          </details>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function ConfigFieldControl({ field, value, stored, revealed, onReveal, onChange }: {
  field: ConfigField;
  value: string;
  stored: boolean;
  revealed: boolean;
  onReveal: () => void;
  onChange: (value: string) => void;
}) {
  const width = 'w-full sm:w-64';
  if (field.type === 'boolean') {
    return (
      <ToggleSwitch checked={(value || String(field.default ?? 'false')) === 'true'} onChange={(v) => onChange(v ? 'true' : 'false')} />
    );
  }
  if (field.type === 'select' && field.options) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={field.label} className={cn(inputClass, width, 'cursor-pointer')}>
        <option value="">Choose</option>
        {field.options.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
    );
  }
  if (field.type === 'secret') {
    return (
      <div className={cn('relative', width)}>
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={stored ? 'Saved. Type to replace' : field.placeholder || ''}
          aria-label={field.label}
          autoComplete="off"
          className={cn(inputClass, 'w-full pe-9 font-mono')}
        />
        <button
          type="button"
          onClick={onReveal}
          className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          aria-label={revealed ? 'Hide' : 'Show'}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  }
  return (
    <input
      type={field.type === 'number' ? 'number' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.placeholder || ''}
      aria-label={field.label}
      autoComplete="off"
      className={cn(inputClass, width)}
    />
  );
}

/**
 * A setting that takes several lines: label and description on top, a
 * full-width text box under them, as wide as the section.
 */
function MultilineConfigItem({ field, value, onChange }: {
  field: ConfigField;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div data-search-label={field.label} className="py-3 border-b border-border last:border-0">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {field.required ? `${field.label} *` : field.label}
      </label>
      {field.description && <p id={`${id}-desc`} className="text-xs text-muted-foreground mt-1">{field.description}</p>}
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder || ''}
        aria-describedby={field.description ? `${id}-desc` : undefined}
        rows={5}
        className={cn(inputClass, 'mt-2 block h-auto min-h-24 w-full resize-y py-2 leading-relaxed')}
      />
    </div>
  );
}

/**
 * The plugin's own `admin-plugin-page` slot, if it offers one. Sandboxed
 * plugins ship a React component under `slots['admin-plugin-page']` and the
 * host gives it an iframe here.
 */
function PluginAdminSection({ pluginId }: { pluginId: string }) {
  const offers = usePluginSlotOffers('admin-plugin-page');
  const offer = offers.find((o) => o.pluginId === pluginId);
  if (!offer) return null;
  return (
    <SettingsSection id="plugin-panel" title="Plugin panel" description="Provided by the plugin itself.">
      <div className="overflow-hidden rounded-lg border border-border">
        <PluginIframeSlot pluginId={pluginId} slot="admin-plugin-page" />
      </div>
    </SettingsSection>
  );
}
