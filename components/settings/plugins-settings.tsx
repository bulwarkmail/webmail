'use client';

import { useState, useRef, useEffect } from 'react';
import { usePluginStore } from '@/stores/plugin-store';
import { usePolicyStore } from '@/stores/policy-store';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import { cn } from '@/lib/utils';
import { Upload, Trash2, AlertTriangle, Puzzle, Lock, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/stores/toast-store';
import type { InstalledPlugin, PluginStatus, SettingFieldSchema } from '@/lib/plugin-types';

const STATUS_COLORS: Record<PluginStatus, string> = {
  installed: 'bg-muted text-muted-foreground',
  enabled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  running: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  disabled: 'bg-muted text-muted-foreground',
  error: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

export function PluginsSettings() {
  const { plugins, installPlugin, uninstallPlugin, enablePlugin, disablePlugin, updatePluginSettings, initializePlugins, initialized } = usePluginStore();
  const { isFeatureEnabled, isPluginForceEnabled, isPluginApproved, fetchPolicy, loaded } = usePolicyStore();
  const [isUploading, setIsUploading] = useState(false);
  const [expandedPlugin, setExpandedPlugin] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) {
      fetchPolicy();
    }
    initializePlugins();
  }, [fetchPolicy, initializePlugins, loaded]);

  if (!isFeatureEnabled('pluginsEnabled')) {
    return null;
  }

  const pluginUploadsEnabled = isFeatureEnabled('pluginsUploadEnabled');

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!pluginUploadsEnabled) {
      toast.info('Plugin uploads are disabled by your administrator');
      return;
    }

    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const result = await installPlugin(file);
      if (result.success) {
        toast.success('Plugin installed');
        if (result.warnings?.length) {
          toast.warning('Plugin warnings', { message: result.warnings.join('\n') });
        }
      } else {
        toast.error('Plugin installation failed', { message: result.error });
      }
    } catch (err) {
      toast.error('Plugin installation failed', { message: err instanceof Error ? err.message : 'Unknown error' });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleToggle = async (plugin: InstalledPlugin) => {
    if (!initialized) return;

    const isForceEnabled = plugin.forceEnabled || isPluginForceEnabled(plugin.id);
    if (isForceEnabled) {
      toast.info(`Plugin "${plugin.name}" is forced by admin and cannot be disabled`);
      return;
    }

    const requireApproval = isFeatureEnabled('requirePluginApproval');
    const isApproved = plugin.adminApproved || plugin.managed || isPluginApproved(plugin.id);
    if (!plugin.enabled && requireApproval && !isApproved) {
      toast.info(`Plugin "${plugin.name}" requires admin approval before it can be enabled`);
      return;
    }

    if (plugin.enabled) {
      disablePlugin(plugin.id);
      toast.info(`Plugin "${plugin.name}" disabled`);
    } else {
      await enablePlugin(plugin.id);
      toast.success(`Plugin "${plugin.name}" enabled`);
    }
  };

  const handleUninstall = (plugin: InstalledPlugin) => {
    if (!initialized) return;

    const isForceEnabled = plugin.forceEnabled || isPluginForceEnabled(plugin.id);
    if (isForceEnabled) {
      toast.info(`Plugin "${plugin.name}" is forced by admin and cannot be uninstalled`);
      return;
    }

    uninstallPlugin(plugin.id);
    toast.success(`Plugin "${plugin.name}" removed`);
  };

  return (
    <SettingsSection title="Plugins" description="Manage installed plugins. Upload plugin .zip files to add new functionality." experimental experimentalDescription="Plugins is an experimental feature. The plugin API is not yet stable and may change between releases, which could break existing plugins. Plugins run in a sandboxed environment but have access to your data within the application. Only install plugins from sources you trust.">
      {/* Plugin List */}
      {plugins.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Puzzle className="w-12 h-12 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No plugins installed</p>
          <p className="text-xs text-muted-foreground/70">Upload a plugin .zip file to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {plugins.map(plugin => {
            const requireApproval = isFeatureEnabled('requirePluginApproval');
            const isApproved = plugin.adminApproved || plugin.managed || isPluginApproved(plugin.id);
            const needsApproval = requireApproval && !isApproved;
            return (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              isExpanded={expandedPlugin === plugin.id}
              isForceEnabled={plugin.forceEnabled || isPluginForceEnabled(plugin.id)}
              isManaged={Boolean(plugin.managed)}
              needsApproval={needsApproval}
              controlsDisabled={!initialized}
              onToggleExpand={() => setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)}
              onToggle={() => handleToggle(plugin)}
              onUninstall={() => handleUninstall(plugin)}
              onUpdateSettings={(settings) => updatePluginSettings(plugin.id, settings)}
            />
            );
          })}
        </div>
      )}

      {!initialized && plugins.length > 0 && (
        <p className="text-xs text-muted-foreground">Syncing plugin policy and managed state...</p>
      )}

      {/* Upload */}
      {pluginUploadsEnabled ? (
        <SettingItem label="Upload Plugin" description="Install a new plugin from a .zip file">
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={handleUpload}
            className="hidden"
            aria-label="Upload plugin file"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            <Upload className="w-4 h-4 mr-1.5" />
            {isUploading ? 'Installing...' : 'Upload .zip'}
          </Button>
        </SettingItem>
      ) : (
        <SettingItem label="Upload Plugin" description="Install a new plugin from a .zip file">
          <span className="text-xs text-muted-foreground">Disabled by administrator policy</span>
        </SettingItem>
      )}
    </SettingsSection>
  );
}

// ─── Plugin Card ─────────────────────────────────────────────

interface PluginCardProps {
  plugin: InstalledPlugin;
  isExpanded: boolean;
  isForceEnabled: boolean;
  isManaged: boolean;
  needsApproval: boolean;
  controlsDisabled: boolean;
  onToggleExpand: () => void;
  onToggle: () => void;
  onUninstall: () => void;
  onUpdateSettings: (settings: Record<string, unknown>) => void;
}

function PluginCard({ plugin, isExpanded, isForceEnabled, isManaged, needsApproval, controlsDisabled, onToggleExpand, onToggle, onUninstall, onUpdateSettings }: PluginCardProps) {
  return (
    <div className={cn(
      'rounded-lg border transition-colors',
      plugin.status === 'error' ? 'border-destructive/40' : 'border-border',
    )}>
      {/* Header */}
      <div className="flex items-center gap-3 p-3">
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggleExpand}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">{plugin.name}</span>
            <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full font-medium', STATUS_COLORS[plugin.status])}>
              {plugin.status}
            </span>
            {isForceEnabled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 flex items-center gap-0.5">
                <Lock className="w-2.5 h-2.5" /> Forced
              </span>
            )}
            {isManaged && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400 flex items-center gap-0.5">
                <Server className="w-2.5 h-2.5" /> Managed
              </span>
            )}
            {needsApproval && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400">
                Awaiting approval
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-muted-foreground">{plugin.author}</span>
            <span className="text-xs text-muted-foreground/50">v{plugin.version}</span>
            <span className="text-xs text-muted-foreground/50">{plugin.type}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <ToggleSwitch checked={plugin.enabled} onChange={onToggle} disabled={controlsDisabled || isForceEnabled || needsApproval} />
        </div>
      </div>

      {/* Expanded Details */}
      {isExpanded && (
        <div className="border-t border-border p-3 space-y-3">
          {isForceEnabled && (
            <p className="text-xs text-amber-600 dark:text-amber-400">This plugin is forced by an administrator and cannot be disabled or uninstalled.</p>
          )}

          {needsApproval && (
            <p className="text-xs text-orange-600 dark:text-orange-400">This plugin is awaiting admin approval and cannot be enabled until an administrator approves it.</p>
          )}

          {/* Description */}
          {plugin.description && (
            <p className="text-xs text-muted-foreground">{plugin.description}</p>
          )}

          {/* Error */}
          {plugin.error && (
            <div className="flex items-start gap-2 p-2 rounded bg-destructive/10 text-destructive text-xs">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>{plugin.error}</span>
            </div>
          )}

          {/* Permissions */}
          {plugin.permissions.length > 0 && (
            <div>
              <span className="text-xs font-medium text-foreground">Permissions:</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {plugin.permissions.map(perm => (
                  <span key={perm} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {perm}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Settings (auto-generated from schema) */}
          {plugin.settingsSchema && Object.keys(plugin.settingsSchema).length > 0 && (
            <div className="space-y-2">
              <span className="text-xs font-medium text-foreground">Settings:</span>
              {Object.entries(plugin.settingsSchema).map(([key, schema]) => (
                <PluginSettingField
                  key={key}
                  fieldKey={key}
                  schema={schema}
                  value={plugin.settings[key] ?? schema.default}
                  onChange={(value) => onUpdateSettings({ [key]: value })}
                />
              ))}
            </div>
          )}

          {/* Uninstall */}
          <div className="flex justify-end pt-2 border-t border-border">
            <Button variant="destructive" size="sm" onClick={onUninstall} disabled={controlsDisabled || isForceEnabled}>
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Uninstall
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Auto-generated Setting Field ────────────────────────────

interface PluginSettingFieldProps {
  fieldKey: string;
  schema: SettingFieldSchema;
  value: unknown;
  onChange: (value: unknown) => void;
}

function PluginSettingField({ schema, value, onChange }: PluginSettingFieldProps) {
  switch (schema.type) {
    case 'boolean':
      return (
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-foreground">{schema.label}</span>
            {schema.description && <p className="text-[10px] text-muted-foreground">{schema.description}</p>}
          </div>
          <ToggleSwitch checked={value as boolean} onChange={(v) => onChange(v)} />
        </div>
      );

    case 'select':
      return (
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-foreground">{schema.label}</span>
            {schema.description && <p className="text-[10px] text-muted-foreground">{schema.description}</p>}
          </div>
          <select
            value={String(value)}
            onChange={(e) => onChange(e.target.value)}
            className="text-xs bg-background border border-border rounded px-2 py-1 text-foreground"
          >
            {schema.options?.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      );

    case 'string':
      return (
        <div>
          <span className="text-xs text-foreground">{schema.label}</span>
          {schema.description && <p className="text-[10px] text-muted-foreground">{schema.description}</p>}
          <input
            type="text"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="mt-1 w-full text-xs bg-background border border-border rounded px-2 py-1 text-foreground"
          />
        </div>
      );

    case 'number':
      return (
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs text-foreground">{schema.label}</span>
            {schema.description && <p className="text-[10px] text-muted-foreground">{schema.description}</p>}
          </div>
          <input
            type="number"
            value={Number(value ?? schema.default ?? 0)}
            min={schema.min}
            max={schema.max}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-20 text-xs bg-background border border-border rounded px-2 py-1 text-foreground"
          />
        </div>
      );

    default:
      return null;
  }
}
