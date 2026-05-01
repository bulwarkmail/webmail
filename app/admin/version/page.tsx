'use client';

import { useEffect, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  ExternalLink,
} from 'lucide-react';
import { SettingsSection, SettingItem } from '@/components/settings/settings-section';
import { apiFetch } from '@/lib/browser-navigation';
import type { UpdateStatus, UpdateSeverity } from '@/lib/version-check/types';

interface VersionAdminStatus {
  current: string;
  build: string;
  endpoint: string;
  defaultEndpoint: string;
  disabledByEnv: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextScheduledAt: string | null;
  status: UpdateStatus | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 0) return new Date(iso).toLocaleString();
  const m = Math.floor(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.floor(h / 24)} days ago`;
}

function severityChip(severity: UpdateSeverity) {
  switch (severity) {
    case 'security':
      return {
        label: 'Security update',
        className: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30',
        Icon: ShieldAlert,
      };
    case 'deprecated':
      return {
        label: 'Deprecated',
        className: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30',
        Icon: ShieldAlert,
      };
    case 'normal':
      return {
        label: 'Update available',
        className: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
        Icon: AlertTriangle,
      };
    case 'unknown':
      return {
        label: 'Unknown',
        className: 'bg-muted text-muted-foreground border-border',
        Icon: AlertTriangle,
      };
    case 'none':
    default:
      return {
        label: 'Up to date',
        className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
        Icon: CheckCircle2,
      };
  }
}

export default function AdminVersionPage() {
  const [data, setData] = useState<VersionAdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await apiFetch('/api/admin/version');
      if (!r.ok) throw new Error('failed to load');
      setData((await r.json()) as VersionAdminStatus);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function checkNow(): Promise<void> {
    setChecking(true);
    setCheckResult(null);
    try {
      const r = await apiFetch('/api/admin/version', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'check-now' }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setCheckResult({
        ok: !!j.ok,
        msg: j.ok ? 'Update check completed.' : `Failed: ${j.error ?? 'unknown'}`,
      });
      await refresh();
    } finally {
      setChecking(false);
    }
  }

  if (loading || !data) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> loading…
      </div>
    );
  }

  const status = data.status;
  const chip = severityChip(status?.severity ?? 'none');
  const ChipIcon = chip.Icon;
  const releaseUrl = status?.url ?? null;
  const newer = status?.latest && status.latest !== data.current ? status.latest : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-foreground">Version</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Hourly check against the Bulwark version server. Severity is decided server-side and
            disable with <code>BULWARK_UPDATE_CHECK=off</code>.
          </p>
        </div>
        <button
          type="button"
          disabled={checking}
          onClick={() => void checkNow()}
          className="inline-flex items-center gap-2 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-all shadow-sm"
        >
          {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Check now
        </button>
      </div>

      {checkResult && (
        <div
          className={`text-sm rounded-md px-3 py-2 ${
            checkResult.ok
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
              : 'bg-destructive/10 text-destructive'
          }`}
        >
          {checkResult.msg}
        </div>
      )}

      <SettingsSection title="Status">
        <SettingItem label="Severity">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${chip.className}`}
          >
            <ChipIcon className="h-3 w-3" />
            {chip.label}
          </span>
        </SettingItem>
        <SettingItem label="Running" description={data.build !== 'unknown' ? `Build ${data.build}` : undefined}>
          <span className="text-sm font-mono text-foreground">{data.current}</span>
        </SettingItem>
        {newer && (
          <SettingItem label="Latest release">
            {releaseUrl ? (
              <a
                href={releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm font-mono text-foreground hover:underline"
              >
                {newer} <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="text-sm font-mono text-foreground">{newer}</span>
            )}
          </SettingItem>
        )}
        {status?.advisory && (
          <SettingItem label="Advisory">
            <span className="text-sm font-mono text-red-600 dark:text-red-400">{status.advisory}</span>
          </SettingItem>
        )}
      </SettingsSection>

      <SettingsSection title="Schedule" description="Hourly polling with ±5 minute jitter.">
        <SettingItem label="Last checked">
          <span className="text-sm text-foreground">{timeAgo(data.lastCheckedAt)}</span>
        </SettingItem>
        <SettingItem label="Last success">
          <span className="text-sm text-foreground">{timeAgo(data.lastSuccessAt)}</span>
        </SettingItem>
        <SettingItem label="Next scheduled">
          <span className="text-sm text-foreground">{timeAgo(data.nextScheduledAt)}</span>
        </SettingItem>
        {status?.checkedAt && (
          <SettingItem label="Server timestamp" description="When the server last refreshed its release list.">
            <span className="text-sm text-foreground">{new Date(status.checkedAt).toLocaleString()}</span>
          </SettingItem>
        )}
      </SettingsSection>

      <SettingsSection title="Source">
        <SettingItem
          label="Endpoint"
          description={data.endpoint === data.defaultEndpoint ? 'Default endpoint.' : `Default: ${data.defaultEndpoint}`}
        >
          <a
            href={data.endpoint}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-foreground hover:underline break-all"
          >
            {data.endpoint} <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
        </SettingItem>
        <SettingItem label="Disabled by env" description="Set BULWARK_UPDATE_CHECK=off to disable.">
          <span className={`text-sm font-medium ${data.disabledByEnv ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
            {data.disabledByEnv ? 'Yes' : 'No'}
          </span>
        </SettingItem>
      </SettingsSection>
    </div>
  );
}
