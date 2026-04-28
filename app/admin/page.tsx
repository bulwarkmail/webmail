'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { SettingsSection, SettingItem, ToggleSwitch } from '@/components/settings/settings-section';
import type { AuditEntry } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';

interface AdminStatus {
  enabled: boolean;
  authenticated: boolean;
  lastLogin: string | null;
  passwordChangedAt: string | null;
}

interface ConfigData {
  appName?: string;
  jmapServerUrl?: string;
  settingsSyncEnabled?: boolean;
  stalwartFeaturesEnabled?: boolean;
  oauthEnabled?: boolean;
  devMode?: boolean;
}

export default function AdminDashboardPage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [recentActivity, setRecentActivity] = useState<AuditEntry[]>([]);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [, setConfigSources] = useState<Record<string, { value: unknown; source: string }> | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pluginCount, setPluginCount] = useState(0);
  const [themeCount, setThemeCount] = useState(0);
  const [policyRuleCount, setPolicyRuleCount] = useState(0);
  const [accountCounts, setAccountCounts] = useState<{ total: number; active7d: number } | null>(null);
  const [jmapHealth, setJmapHealth] = useState<'unknown' | 'ok' | 'error'>('unknown');

  useEffect(() => {
    fetchDashboardData();
  }, []);

  async function fetchDashboardData() {
    const [statusRes, auditRes, configRes, adminConfigRes, pluginRes, themeRes, policyRes, telemetryRes] = await Promise.all([
      apiFetch('/api/admin/auth'),
      apiFetch('/api/admin/audit?limit=10'),
      apiFetch('/api/config'),
      apiFetch('/api/admin/config'),
      apiFetch('/api/admin/plugins').catch(() => null),
      apiFetch('/api/admin/themes').catch(() => null),
      apiFetch('/api/admin/policy').catch(() => null),
      apiFetch('/api/admin/telemetry').catch(() => null),
    ]);

    if (statusRes.ok) setStatus(await statusRes.json());
    if (auditRes.ok) {
      const data = await auditRes.json();
      setRecentActivity(data.entries || []);
    }
    let configData: ConfigData | null = null;
    if (configRes.ok) {
      configData = await configRes.json();
      setConfig(configData);
    }

    if (pluginRes?.ok) {
      const plugins = await pluginRes.json();
      setPluginCount(Array.isArray(plugins) ? plugins.length : 0);
    }
    if (themeRes?.ok) {
      const themes = await themeRes.json();
      setThemeCount(Array.isArray(themes) ? themes.length : 0);
    }
    if (policyRes?.ok) {
      const policy = await policyRes.json();
      const restrictionCount = policy.restrictions ? Object.keys(policy.restrictions).length : 0;
      const disabledGates = policy.features ? Object.values(policy.features).filter((v: unknown) => !v).length : 0;
      setPolicyRuleCount(restrictionCount + disabledGates);
    }
    if (telemetryRes?.ok) {
      const telemetry = await telemetryRes.json();
      if (telemetry.accountCounts && typeof telemetry.accountCounts.total === 'number') {
        setAccountCounts(telemetry.accountCounts);
      }
    }

    if (configData?.jmapServerUrl) {
      try {
        const jmapRes = await apiFetch('/api/config');
        setJmapHealth(jmapRes.ok ? 'ok' : 'error');
      } catch {
        setJmapHealth('error');
      }
    }

    const w: string[] = [];
    if (adminConfigRes.ok) {
      const sources = await adminConfigRes.json();
      setConfigSources(sources);
      const sessionSecret = sources?.sessionSecret;
      if (!sessionSecret?.value || sessionSecret.value === 'your-secret-key-here') {
        w.push('SESSION_SECRET is not set or using a default value. Sessions are insecure.');
      }
      const adminPassword = sources?.adminPassword;
      if (adminPassword?.value && adminPassword.source === 'env') {
        w.push('ADMIN_PASSWORD is still set in environment variables. Remove it now that the hash is stored securely.');
      }
    }
    setWarnings(w);
  }

  const jmapUrl = config?.jmapServerUrl || '-';
  const jmapHostname = jmapUrl !== '-' ? (() => { try { return new URL(jmapUrl).hostname; } catch { return jmapUrl; } })() : '-';

  return (
    <div className="max-w-3xl space-y-8">
      {/* Warnings */}
      {warnings.map((msg, i) => (
        <div key={i} className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/10 p-4">
          <AlertTriangle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
          <p className="text-sm text-warning">{msg}</p>
        </div>
      ))}

      {status && !status.lastLogin && (
        <div className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/10 p-4">
          <AlertTriangle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-warning">First login detected</p>
            <p className="text-sm text-warning/80 mt-0.5">
              Remember to remove ADMIN_PASSWORD from your .env file now that the hash is stored securely.
            </p>
          </div>
        </div>
      )}

      {/* Server Info */}
      <SettingsSection title="Server" description="Application and connection details">
        <SettingItem label="Application">
          <span className="text-sm text-foreground">{config?.appName || '-'}</span>
        </SettingItem>
        <SettingItem label="JMAP Server" description={jmapUrl !== '-' ? jmapUrl : undefined}>
          <span className="text-sm text-foreground">{jmapHostname}</span>
        </SettingItem>
        <SettingItem label="JMAP Connection">
          <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${
            jmapHealth === 'ok' ? 'text-green-600 dark:text-green-400' : jmapHealth === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'
          }`}>
            <span className={`w-2 h-2 rounded-full ${
              jmapHealth === 'ok' ? 'bg-green-500' : jmapHealth === 'error' ? 'bg-red-500' : 'bg-muted-foreground/40'
            }`} />
            {jmapHealth === 'ok' ? 'Connected' : jmapHealth === 'error' ? 'Error' : 'Unknown'}
          </span>
        </SettingItem>
        <SettingItem label="Last Login">
          <span className="text-sm text-foreground">
            {status?.lastLogin ? new Date(status.lastLogin).toLocaleString() : 'Never'}
          </span>
        </SettingItem>
      </SettingsSection>

      {/* Features */}
      <SettingsSection title="Features" description="Enabled integrations and modules">
        <SettingItem label="Admin Panel" description="Administrative access to server configuration">
          <ToggleSwitch checked={!!status?.enabled} onChange={() => {}} disabled />
        </SettingItem>
        <SettingItem label="Settings Sync" description="Synchronize user settings across devices">
          <ToggleSwitch checked={!!config?.settingsSyncEnabled} onChange={() => {}} disabled />
        </SettingItem>
        <SettingItem label="OAuth" description="OAuth authentication provider">
          <ToggleSwitch checked={!!config?.oauthEnabled} onChange={() => {}} disabled />
        </SettingItem>
        <SettingItem label="Stalwart Integration" description="Stalwart mail server features">
          <ToggleSwitch checked={config?.stalwartFeaturesEnabled !== false} onChange={() => {}} disabled />
        </SettingItem>
      </SettingsSection>

      {/* Accounts */}
      <SettingsSection title="Accounts" description="Unique logins recorded over the last 90 days">
        <SettingItem label="Total accounts" description="Distinct identities seen in the retention window">
          <span className="text-sm text-foreground">{accountCounts?.total ?? '-'}</span>
        </SettingItem>
        <SettingItem label="Active in last 7 days" description="Identities with a login in the past week">
          <span className="text-sm text-foreground">{accountCounts?.active7d ?? '-'}</span>
        </SettingItem>
      </SettingsSection>

      {/* Extensions */}
      <SettingsSection title="Extensions" description="Installed plugins, themes, and policy rules">
        <SettingItem label="Plugins">
          <span className="text-sm text-foreground">{pluginCount}</span>
        </SettingItem>
        <SettingItem label="Themes">
          <span className="text-sm text-foreground">{themeCount}</span>
        </SettingItem>
        <SettingItem label="Policy Rules">
          <span className="text-sm text-foreground">{policyRuleCount}</span>
        </SettingItem>
      </SettingsSection>

      {/* Recent Activity */}
      <SettingsSection title="Recent Activity" description="Latest administrative actions">
        {recentActivity.length === 0 ? (
          <div className="py-4 text-sm text-muted-foreground">
            No activity recorded yet
          </div>
        ) : (
          recentActivity.map((entry, i) => (
            <SettingItem
              key={i}
              label={entry.action}
              description={formatDetail(entry.detail) || undefined}
            >
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{entry.ip}</span>
                <span>{new Date(entry.ts).toLocaleString()}</span>
              </div>
            </SettingItem>
          ))
        )}
      </SettingsSection>
    </div>
  );
}

function formatDetail(detail: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) return '';
  if (detail.key) return `${detail.key}: ${detail.old} → ${detail.new}`;
  if (detail.reason) return String(detail.reason);
  if (detail.changes && Array.isArray(detail.changes)) return `${detail.changes.length} setting(s) changed`;
  return JSON.stringify(detail).slice(0, 80);
}
