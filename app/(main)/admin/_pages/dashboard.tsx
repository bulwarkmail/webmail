'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle } from '@/components/icons';
import { SettingsSection, SettingItem } from '@/components/settings/settings-section';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminLink } from '@/components/admin/admin-link';
import { AdminList, AdminListRow } from '@/components/admin/list';
import { Badge } from '@/components/admin/badge';
import type { AuditEntry } from '@/lib/admin/types';
import { adminPageDef, adminPath } from '@/lib/admin/admin-nav';
import { apiFetch } from '@/lib/browser-navigation';
import type { UpdateStatus } from '@/lib/version-check/types';
import { cn } from '@/lib/utils';

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

interface VersionData {
  current: string;
  status: UpdateStatus | null;
}

interface InstancesData {
  mode: 'local' | 'redis';
  location: string;
  instances: number | null;
}

/** The storage line: which store, and how many instances share it (#1066). */
export function storageSummary(data: InstancesData | null): { value: string; description?: string } {
  if (!data) return { value: '-' };
  if (data.mode === 'local') return { value: 'Local files on this server' };
  const count = data.instances === null
    ? 'store unreachable'
    : `${data.instances} ${data.instances === 1 ? 'instance' : 'instances'} checked in during the last minute`;
  return { value: `Shared store, ${count}`, description: data.location };
}

const PAGE = adminPageDef('dashboard');

export function DashboardPage() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [recentActivity, setRecentActivity] = useState<AuditEntry[]>([]);
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [, setConfigSources] = useState<Record<string, { value?: unknown; source: string; hasValue?: boolean }> | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pluginCount, setPluginCount] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [themeCount, setThemeCount] = useState(0);
  const [accountCounts, setAccountCounts] = useState<{ total: number; active7d: number } | null>(null);
  const [version, setVersion] = useState<VersionData | null>(null);
  const [instances, setInstances] = useState<InstancesData | null>(null);

  useEffect(() => {
    fetchDashboardData();
  }, []);

  async function fetchDashboardData() {
    const [statusRes, auditRes, configRes, adminConfigRes, pluginRes, approvalsRes, themeRes, telemetryRes, versionRes, instancesRes] = await Promise.all([
      apiFetch('/api/admin/auth'),
      apiFetch('/api/admin/audit?limit=10'),
      apiFetch('/api/config'),
      apiFetch('/api/admin/config'),
      apiFetch('/api/admin/plugins').catch(() => null),
      apiFetch('/api/admin/plugin-approvals').catch(() => null),
      apiFetch('/api/admin/themes').catch(() => null),
      apiFetch('/api/admin/telemetry').catch(() => null),
      apiFetch('/api/admin/version').catch(() => null),
      apiFetch('/api/admin/instances').catch(() => null),
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
    if (approvalsRes?.ok) {
      const data = await approvalsRes.json();
      const entries: { status?: string }[] = Array.isArray(data?.entries) ? data.entries : [];
      setPendingApprovals(entries.filter((e) => e.status === 'pending').length);
    }
    if (themeRes?.ok) {
      const themes = await themeRes.json();
      setThemeCount(Array.isArray(themes) ? themes.length : 0);
    }
    if (telemetryRes?.ok) {
      const telemetry = await telemetryRes.json();
      if (telemetry.accountCounts && typeof telemetry.accountCounts.total === 'number') {
        setAccountCounts(telemetry.accountCounts);
      }
    }
    if (versionRes?.ok) {
      const data = await versionRes.json();
      if (typeof data?.current === 'string') setVersion({ current: data.current, status: data.status ?? null });
    }
    if (instancesRes?.ok) {
      const data = await instancesRes.json();
      if (data?.mode === 'local' || data?.mode === 'redis') setInstances(data);
    }

    const w: string[] = [];
    if (adminConfigRes.ok) {
      const sources = await adminConfigRes.json();
      setConfigSources(sources);
      const sessionSecret = sources?.sessionSecret;
      // Server redacts the raw value for sensitive keys; rely on hasValue,
      // which is false when unset or matching a known placeholder default.
      if (!sessionSecret?.hasValue) {
        w.push('SESSION_SECRET is not set or using a default value. Sessions are insecure.');
      }
      const adminPassword = sources?.adminPassword;
      if (adminPassword?.value && adminPassword.source === 'env') {
        w.push('ADMIN_PASSWORD is still set in environment variables. Remove it now that the hash is stored securely.');
      }
    }
    setWarnings(w);
  }

  const storage = storageSummary(instances);
  const jmapUrl = config?.jmapServerUrl || '-';
  const jmapHostname = jmapUrl !== '-' ? (() => { try { return new URL(jmapUrl).hostname; } catch { return jmapUrl; } })() : '-';

  const newer = version?.status?.latest && version.status.latest !== version.current ? version.status.latest : null;
  const severity = version?.status?.severity ?? 'none';
  const versionSub: { text?: string; tone: StatTone } = !version
    ? { tone: 'muted' }
    : newer
      ? { text: `v${newer} available`, tone: severity === 'security' || severity === 'deprecated' ? 'danger' : 'warning' }
      : { text: 'Up to date', tone: 'muted' };

  return (
    <div>
      <AdminPageHeader title={PAGE.label} description={PAGE.description} />

      <div className="space-y-10">
        {warnings.length > 0 && (
          <div className="space-y-3">
            {warnings.map((msg, i) => (
              <div key={i} className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning/10 p-4">
                <AlertTriangle className="w-5 h-5 text-warning mt-0.5 shrink-0" />
                <p className="text-sm text-warning">{msg}</p>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Accounts"
            value={accountCounts?.total ?? '-'}
            sub={accountCounts ? `${accountCounts.active7d} active this week` : undefined}
          />
          <StatTile
            label="Plugins"
            value={pluginCount}
            href={adminPath('plugins')}
            sub={pendingApprovals > 0 ? `${pendingApprovals} awaiting approval` : undefined}
            subTone="warning"
          />
          <StatTile label="Themes" value={themeCount} href={adminPath('themes')} />
          <StatTile
            label="Version"
            value={version?.current ?? '-'}
            href={adminPath('version')}
            sub={versionSub.text}
            subTone={versionSub.tone}
          />
        </div>

        <SettingsSection id="server" title="Server">
          <SettingItem label="Application">
            <span className="text-sm text-foreground">{config?.appName || '-'}</span>
          </SettingItem>
          <SettingItem label="Storage" description={storage.description}>
            <span className="text-sm text-foreground">{storage.value}</span>
          </SettingItem>
          <SettingItem label="JMAP server" description={jmapUrl !== '-' ? jmapUrl : undefined}>
            <span className="text-sm text-foreground">{jmapHostname}</span>
          </SettingItem>
          <SettingItem label="Last admin login">
            <span className="text-sm text-foreground">
              {status?.lastLogin ? new Date(status.lastLogin).toLocaleString() : 'Never'}
            </span>
          </SettingItem>
          <SettingItem label="Settings sync" description="Synchronize user settings across devices">
            <OnOff on={!!config?.settingsSyncEnabled} />
          </SettingItem>
          <SettingItem label="OAuth" description="OAuth authentication provider">
            <OnOff on={!!config?.oauthEnabled} />
          </SettingItem>
          <SettingItem label="Stalwart integration" description="Stalwart mail server features">
            <OnOff on={config?.stalwartFeaturesEnabled !== false} />
          </SettingItem>
        </SettingsSection>

        <SettingsSection id="activity" title="Recent activity">
          {recentActivity.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No activity recorded yet</p>
          ) : (
            <AdminList>
              {recentActivity.map((entry, i) => (
                <AdminListRow
                  key={i}
                  title={<code className="font-mono text-xs">{entry.action}</code>}
                  description={formatDetail(entry.detail) || undefined}
                  meta={<>{entry.ip} &middot; {new Date(entry.ts).toLocaleString()}</>}
                />
              ))}
            </AdminList>
          )}
          <AdminLink href={adminPath('logs')} className="inline-block text-sm font-medium text-primary hover:underline">
            All entries
          </AdminLink>
        </SettingsSection>
      </div>
    </div>
  );
}

type StatTone = 'muted' | 'warning' | 'danger';

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  subTone?: StatTone;
  /** Makes the tile a link to that admin page. */
  href?: string;
}

const SUB_TONE: Record<StatTone, string> = {
  muted: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-destructive',
};

function StatTile({ label, value, sub, subTone = 'muted', href }: StatTileProps) {
  const body = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold text-foreground">{value}</div>
      {sub && <div className={cn('mt-1 text-xs', SUB_TONE[subTone])}>{sub}</div>}
    </>
  );
  const className = 'block min-w-0 rounded-lg border border-border p-4';
  if (href) {
    return (
      <AdminLink href={href} className={cn(className, 'transition-colors hover:bg-muted/40')}>
        {body}
      </AdminLink>
    );
  }
  return <div className={className}>{body}</div>;
}

function OnOff({ on }: { on: boolean }) {
  return <Badge tone={on ? 'success' : 'muted'}>{on ? 'On' : 'Off'}</Badge>;
}

function formatDetail(detail: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) return '';
  if (detail.key) return `${detail.key}: ${detail.old} → ${detail.new}`;
  if (detail.reason) return String(detail.reason);
  if (detail.changes && Array.isArray(detail.changes)) return `${detail.changes.length} setting(s) changed`;
  return JSON.stringify(detail).slice(0, 80);
}
