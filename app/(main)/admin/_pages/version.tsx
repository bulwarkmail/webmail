'use client';

import { useEffect, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ShieldAlert,
  ExternalLink,
} from '@/components/icons';
import { SettingsSection, SettingItem } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { Badge, type BadgeTone } from '@/components/admin/badge';
import { useAdminFeedback } from '@/components/admin/feedback';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { apiFetch } from '@/lib/browser-navigation';
import type { UpdateStatus, UpdateSeverity } from '@/lib/version-check/types';

interface VersionAdminStatus {
  current: string;
  build: string;
  endpoint: string;
  defaultEndpoint: string;
  disabledByEnv: boolean;
  disabledByNoThirdPartyTraffic?: boolean;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  nextScheduledAt: string | null;
  status: UpdateStatus | null;
}

const PAGE = adminPageDef('version');

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

function severityChip(severity: UpdateSeverity): { label: string; tone: BadgeTone; Icon: typeof CheckCircle2 } {
  switch (severity) {
    case 'security':
      return { label: 'Security update', tone: 'danger', Icon: ShieldAlert };
    case 'deprecated':
      return { label: 'Deprecated', tone: 'danger', Icon: ShieldAlert };
    case 'normal':
      return { label: 'Update available', tone: 'warning', Icon: AlertTriangle };
    case 'unknown':
      return { label: 'Unknown', tone: 'muted', Icon: AlertTriangle };
    case 'none':
    default:
      return { label: 'Up to date', tone: 'success', Icon: CheckCircle2 };
  }
}

export function VersionPage() {
  const [data, setData] = useState<VersionAdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const setMessage = useAdminFeedback();

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
    setMessage(null);
    try {
      const r = await apiFetch('/api/admin/version', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'check-now' }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setMessage(j.ok
        ? { type: 'success', text: 'Update check completed.' }
        : { type: 'error', text: `Failed: ${j.error ?? 'unknown'}` });
      await refresh();
    } finally {
      setChecking(false);
    }
  }

  const header = (
    <AdminPageHeader
      title={PAGE.label}
      description={PAGE.description}
      actions={(
        <Button type="button" size="sm" className="gap-2" disabled={checking || loading} onClick={() => void checkNow()}>
          {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Check now
        </Button>
      )}
    />
  );

  if (loading || !data) {
    return (
      <div>
        {header}
        <AdminBodySkeleton status="Loading" />
      </div>
    );
  }

  const status = data.status;
  const chip = severityChip(status?.severity ?? 'none');
  const ChipIcon = chip.Icon;
  const releaseUrl = status?.url ?? null;
  const newer = status?.latest && status.latest !== data.current ? status.latest : null;

  return (
    <div>
      {header}


      <div className="space-y-10">
        <SettingsSection id="status" title="Status">
          <SettingItem label="Severity">
            <Badge tone={chip.tone} icon={<ChipIcon className="h-3 w-3" />}>{chip.label}</Badge>
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

        <SettingsSection id="schedule" title="Schedule" description="Hourly polling with ±5 minute jitter.">
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

        <SettingsSection
          id="source"
          title="Source"
          description="Hourly check against the Bulwark version server. Severity is decided server-side and disable with BULWARK_UPDATE_CHECK=off."
        >
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
          {data.disabledByNoThirdPartyTraffic && (
            <SettingItem label="Off: no third-party traffic" description="NO_THIRD_PARTY_TRAFFIC is on, so this server never asks the version endpoint. See Organisation > Security.">
              <span className="text-sm font-medium text-amber-600 dark:text-amber-400">Yes</span>
            </SettingItem>
          )}
        </SettingsSection>
      </div>
    </div>
  );
}
