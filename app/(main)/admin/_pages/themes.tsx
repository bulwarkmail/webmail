'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Loader2, SwatchBook, Lock, Store, Power, PowerOff } from '@/components/icons';
import type { ColorMode, SettingsPolicy, ThemePolicy } from '@/lib/admin/types';
import { DEFAULT_POLICY, DEFAULT_THEME_POLICY } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';
import { adminPath, adminPageDef } from '@/lib/admin/admin-nav';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { BUILTIN_THEMES } from '@/lib/builtin-themes';
import { SettingsSection, SettingItem, ToggleSwitch } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminButtonLink } from '@/components/admin/button-link';
import { AdminList, AdminListRow } from '@/components/admin/list';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { Badge } from '@/components/admin/badge';
import { EmptyState } from '@/components/admin/empty-state';
import { useAdminFeedback } from '@/components/admin/feedback';
import { inputClass } from '@/components/admin/config-items';
import { cn } from '@/lib/utils';
import { ExtensionIcon } from '@/components/admin/extension-icon';
import { useExtensionIcons } from './use-extension-icons';
import type { ExtensionEntry } from './extension-detail';

// Derive from the single source of truth so newly added built-in themes show
// up here automatically (was previously a hardcoded subset — see #496).
const BUILTIN_THEME_OPTIONS = BUILTIN_THEMES.map(t => ({ id: t.id, name: t.name }));

const PAGE = adminPageDef('themes');

/** Policy as the page edits it: the theme policy is always fully merged. */
function withThemeDefaults(data: SettingsPolicy): SettingsPolicy {
  return {
    ...data,
    themePolicy: { ...DEFAULT_THEME_POLICY, ...(data.themePolicy || {}) },
  };
}

export function ThemesPage() {
  const [themes, setThemes] = useState<ExtensionEntry[]>([]);
  const iconFor = useExtensionIcons();
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const setMessage = useAdminFeedback();
  // On/off per theme waits for Save, like the policy switches below.
  const [enabledDraft, setEnabledDraft] = useState<Record<string, boolean>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [policy, setPolicy] = useState<SettingsPolicy>(() => withThemeDefaults({ ...DEFAULT_POLICY }));
  const [savedPolicy, setSavedPolicy] = useState<SettingsPolicy>(() => withThemeDefaults({ ...DEFAULT_POLICY }));
  const [savingPolicy, setSavingPolicy] = useState(false);
  // The version of the policy this page loaded (see the policy page).
  const policyETag = useRef<string | null>(null);

  const fetchThemes = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/themes');
      if (res.ok) setThemes(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPolicy = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/policy');
      if (res.ok) {
        const data = withThemeDefaults(await res.json());
        policyETag.current = res.headers.get('ETag');
        setPolicy(data);
        setSavedPolicy(data);
      }
    } catch { /* the defaults stay */ }
  }, []);

  useEffect(() => { fetchThemes(); fetchPolicy(); }, [fetchThemes, fetchPolicy]);

  const policyDirty =
    JSON.stringify(policy.themePolicy) !== JSON.stringify(savedPolicy.themePolicy) ||
    JSON.stringify(policy.features) !== JSON.stringify(savedPolicy.features);
  const isOn = (t: ExtensionEntry) => enabledDraft[t.id] ?? t.enabled;
  const switched = themes.filter((t) => isOn(t) !== t.enabled);
  const dirty = policyDirty || switched.length > 0;
  useAdminUnsavedChanges('themes', dirty);

  // policy.features.userThemesEnabled stays in saved policies untouched: users
  // have no way to upload a theme, so it has no switch here.
  function setFeature(key: 'themesEnabled', value: boolean) {
    setPolicy(prev => ({ ...prev, features: { ...prev.features, [key]: value } }));
    setMessage(null);
  }

  function toggleBuiltinTheme(themeId: string) {
    setPolicy(prev => {
      const disabled = prev.themePolicy?.disabledBuiltinThemes || [];
      const isDisabled = disabled.includes(themeId);
      return {
        ...prev,
        themePolicy: {
          ...DEFAULT_THEME_POLICY,
          ...prev.themePolicy,
          disabledBuiltinThemes: isDisabled
            ? disabled.filter((id: string) => id !== themeId)
            : [...disabled, themeId],
        },
      };
    });
    setMessage(null);
  }

  function toggleAdminTheme(themeId: string) {
    setPolicy(prev => {
      const disabled = prev.themePolicy?.disabledThemes || [];
      const isDisabled = disabled.includes(themeId);
      return {
        ...prev,
        themePolicy: {
          ...DEFAULT_THEME_POLICY,
          ...prev.themePolicy,
          disabledThemes: isDisabled
            ? disabled.filter((id: string) => id !== themeId)
            : [...disabled, themeId],
        },
      };
    });
    setMessage(null);
  }

  function setDefaultTheme(themeId: string | null) {
    setPolicy(prev => ({
      ...prev,
      themePolicy: {
        ...DEFAULT_THEME_POLICY,
        ...prev.themePolicy,
        defaultThemeId: themeId,
      },
    }));
    setMessage(null);
  }

  function setColorModePolicy(patch: Partial<Pick<ThemePolicy, 'defaultColorMode' | 'lockColorMode'>>) {
    setPolicy(prev => ({
      ...prev,
      themePolicy: {
        ...DEFAULT_THEME_POLICY,
        ...prev.themePolicy,
        ...patch,
      },
    }));
    setMessage(null);
  }

  /** Stores the policy; returns the error text, or null. */
  async function savePolicy(): Promise<string | null> {
    try {
      const res = await apiFetch('/api/admin/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(policyETag.current ? { 'If-Match': policyETag.current } : {}) },
        body: JSON.stringify(policy),
      });
      if (res.ok) {
        policyETag.current = res.headers.get('ETag');
        // The server sanitises; continue from what it stored.
        const stored = ((await res.json().catch(() => null)) as { policy?: SettingsPolicy } | null)?.policy;
        if (stored) {
          setPolicy(withThemeDefaults(stored));
          setSavedPolicy(withThemeDefaults(stored));
        } else {
          setSavedPolicy(policy);
        }
        return null;
      }
      const data = await res.json().catch(() => ({}));
      return data.error || 'Could not save the theme policy';
    } catch {
      return 'Could not save the theme policy';
    }
  }

  async function save() {
    setSavingPolicy(true);
    setMessage(null);
    const errors: string[] = [];
    for (const t of switched) {
      const error = await setEnabled(t.id, isOn(t));
      if (error) errors.push(`${t.name}: ${error}`);
    }
    setEnabledDraft({});
    if (policyDirty) {
      const error = await savePolicy();
      if (error) errors.push(error);
    }
    setSavingPolicy(false);
    setMessage(errors.length > 0
      ? { type: 'error', text: `Couldn't save everything. ${errors.join('; ')}` }
      : { type: 'success', text: 'Themes saved. Users see the change on their next login.' });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await apiFetch('/api/admin/themes', { method: 'POST', body: formData });
      const data = await res.json();
      if (res.ok) {
        const warnings = data.warnings?.length ? ` (${data.warnings.length} warning${data.warnings.length === 1 ? '' : 's'})` : '';
        setMessage({ type: 'success', text: `"${data.theme.name}" installed${warnings}` });
        await fetchThemes();
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

  /** Turns one theme on or off on the server; returns the error text, or null. */
  async function setEnabled(id: string, enabled: boolean): Promise<string | null> {
    const res = await apiFetch('/api/admin/themes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
    if (res.ok) {
      setThemes(prev => prev.map(t => (t.id === id ? { ...t, enabled } : t)));
      return null;
    }
    const data = await res.json().catch(() => ({}));
    return data.error || 'Could not change the theme';
  }

  function setAll(enabled: boolean) {
    setEnabledDraft(Object.fromEntries(themes.map((t) => [t.id, enabled])));
    setMessage(null);
  }

  const enabledCount = themes.filter(isOn).length;
  const themesEnabled = policy.features.themesEnabled ?? true;
  const lockColorMode = policy.themePolicy?.lockColorMode === true;
  const disabledBuiltin = policy.themePolicy?.disabledBuiltinThemes || [];
  const disabledInstalled = policy.themePolicy?.disabledThemes || [];

  return (
    <div>
      <AdminPageHeader
        title={PAGE.label}
        description={PAGE.description}
        actions={(
          <>
            <AdminButtonLink href={adminPath('marketplace')}>
              <Store className="h-4 w-4" />
              Marketplace
            </AdminButtonLink>
            <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload theme
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip"
                onChange={handleUpload}
                disabled={uploading}
                className="sr-only"
              />
            </label>
          </>
        )}
      />


      <div className="space-y-10">
        <SettingsSection
          id="installed"
          title="Installed themes"
          description={loading || themes.length === 0 ? undefined : `${enabledCount} of ${themes.length} enabled. The switch turns a theme on or off for everyone.`}
        >
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="me-2 h-4 w-4 animate-spin" /> Loading
            </div>
          ) : themes.length === 0 ? (
            <EmptyState
              icon={SwatchBook}
              title="No themes installed"
              hint="Install one from the marketplace or upload a theme ZIP."
              action={<AdminButtonLink href={adminPath('marketplace')}><Store className="h-4 w-4" /> Browse the marketplace</AdminButtonLink>}
            />
          ) : (
            <>
              {themes.length > 1 && (
                <div className="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="xs" className="gap-1.5 text-xs" disabled={savingPolicy || enabledCount === themes.length} onClick={() => setAll(true)}>
                    <Power className="h-3.5 w-3.5" /> Enable all
                  </Button>
                  <Button variant="ghost" size="xs" className="gap-1.5 text-xs" disabled={savingPolicy || enabledCount === 0} onClick={() => setAll(false)}>
                    <PowerOff className="h-3.5 w-3.5" /> Disable all
                  </Button>
                </div>
              )}
              <AdminList>
                {themes.map(theme => (
                  <AdminListRow
                    key={theme.id}
                    data-testid={`admin-theme-${theme.id}`}
                    href={adminPath('themes', theme.id)}
                    icon={<ExtensionIcon url={iconFor(theme)} fallback={SwatchBook} />}
                    title={theme.name}
                    titleExtra={(
                      <>
                        <span className="text-xs text-muted-foreground">v{theme.version}</span>
                        {!theme.enabled && <Badge>Off</Badge>}
                        {theme.forceEnabled && <Badge tone="warning" icon={<Lock className="h-3 w-3" />}>Forced on</Badge>}
                      </>
                    )}
                    description={theme.description}
                    meta={(
                      <>
                        by {theme.author || 'unknown'}
                        {theme.variants && theme.variants.length > 0 && <> &middot; {theme.variants.join(', ')}</>}
                        {theme.source?.kind === 'marketplace' && <> &middot; Marketplace</>}
                      </>
                    )}
                    control={(
                      <ToggleSwitch
                        checked={isOn(theme)}
                        disabled={savingPolicy}
                        onChange={(checked) => { setMessage(null); setEnabledDraft((prev) => ({ ...prev, [theme.id]: checked })); }}
                        ariaLabel={`${theme.name} enabled`}
                      />
                    )}
                  />
                ))}
              </AdminList>
            </>
          )}
        </SettingsSection>

        <SettingsSection id="policy" title="Theme policy" description="Control theme availability and defaults for users.">
          <SettingItem label="Themes" description="Allow users to select and apply themes">
            <ToggleSwitch checked={themesEnabled} onChange={(v) => setFeature('themesEnabled', v)} />
          </SettingItem>
          <SettingItem label="Default theme" description="Theme applied when users have not chosen one">
            <select
              value={policy.themePolicy?.defaultThemeId || ''}
              onChange={(e) => setDefaultTheme(e.target.value || null)}
              aria-label="Default theme"
              className={cn(inputClass, 'w-full pe-8 cursor-pointer sm:w-auto')}
            >
              <option value="">System default</option>
              <optgroup label="Built-in">
                {BUILTIN_THEME_OPTIONS
                  .filter(t => !disabledBuiltin.includes(t.id))
                  .map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
              </optgroup>
              {themes.length > 0 && (
                <optgroup label="Installed">
                  {themes
                    .filter(t => !disabledInstalled.includes(t.id))
                    .map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                </optgroup>
              )}
            </select>
          </SettingItem>
          <SettingItem label="Default colour mode" description="Light, dark or system for users who have not picked one">
            <select
              value={policy.themePolicy?.defaultColorMode || 'system'}
              onChange={(e) => setColorModePolicy({ defaultColorMode: e.target.value === 'system' ? null : e.target.value as ColorMode })}
              aria-label="Default colour mode"
              className={cn(inputClass, 'w-full pe-8 cursor-pointer sm:w-auto')}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </SettingItem>
          <SettingItem label="Lock colour mode" description="Everyone gets the default colour mode and cannot switch it in settings, on the login page or in the command palette">
            <ToggleSwitch checked={lockColorMode} onChange={(v) => setColorModePolicy({ lockColorMode: v })} />
          </SettingItem>
        </SettingsSection>

        <SettingsSection id="offered" title="Offered to users" description="Themes users can pick. Turn one off to hide it from the picker.">
          {BUILTIN_THEME_OPTIONS.map(theme => (
            <SettingItem key={theme.id} label={theme.name}>
              <ToggleSwitch checked={!disabledBuiltin.includes(theme.id)} onChange={() => toggleBuiltinTheme(theme.id)} />
            </SettingItem>
          ))}
          {themes.length > 0 && (
            <>
              <p className="mt-2 text-xs font-semibold text-muted-foreground">Installed</p>
              {themes.map(theme => (
                <SettingItem key={theme.id} label={theme.name}>
                  <ToggleSwitch checked={!disabledInstalled.includes(theme.id)} onChange={() => toggleAdminTheme(theme.id)} />
                </SettingItem>
              ))}
            </>
          )}
        </SettingsSection>
      </div>

      <AdminSaveBar
        dirty={dirty}
        saving={savingPolicy}
        onSave={() => void save()}
        onDiscard={() => { setPolicy(savedPolicy); setEnabledDraft({}); }}
        saveLabel="Save"
        note="Users see the change on their next login"
      />
    </div>
  );
}
