'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/browser-navigation';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { SettingsSection, SectionNav } from '@/components/settings/settings-section';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { withEdit } from '@/lib/admin/edits';
import { useAdminFeedback } from '@/components/admin/feedback';
import { ConfigTextItem, ConfigNote } from '@/components/admin/config-items';

interface ConfigEntry {
  value?: unknown;
  source: 'admin' | 'env' | 'default';
}

interface ErrorEntry {
  fingerprint: string;
  name: string;
  code?: string;
  version: string;
  runtime: 'browser' | 'server';
  count: number;
  frames: Array<{ path: string; line?: number; column?: number }>;
}

interface MonitoringState {
  collecting: boolean;
  day: string;
  errorsToday: { total: number; top: ErrorEntry[] };
  metrics?: { enabled: boolean };
  tracing?: { configured: boolean; active: boolean; endpointHost: string | null };
}

const PAGE = adminPageDef('monitoring');
const KEYS = ['errorReportingDsn', 'errorReportingSampleRate', 'errorReportingEnvironment'] as const;
const DOCS = 'https://bulwarkmail.org/docs/deployment/monitoring';

export function MonitoringPage() {
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [state, setState] = useState<MonitoringState | null>(null);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const setMessage = useAdminFeedback();

  const load = useCallback(async () => {
    try {
      const [configRes, stateRes] = await Promise.all([apiFetch('/api/admin/config'), apiFetch('/api/admin/monitoring')]);
      if (configRes.ok) setConfig(await configRes.json());
      if (stateRes.ok) setState(await stateRes.json());
      if (!configRes.ok || !stateRes.ok) throw new Error();
    } catch {
      setMessage({ type: 'error', text: 'Could not load the settings' });
    }
    setLoading(false);
  }, [setMessage]);

  useEffect(() => { void load(); }, [load]);

  function handleChange(key: string, value: unknown) {
    setEdits((prev) => withEdit(prev, key, value, config[key]?.value));
    setMessage(null);
  }

  function currentValue(key: string): string {
    const value = key in edits ? edits[key] : config[key]?.value;
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  }

  async function handleSave() {
    if (Object.keys(edits).length === 0) return;
    setSaving(true);
    setMessage(null);
    const res = await apiFetch('/api/admin/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edits),
    });
    if (res.ok) {
      setMessage({ type: 'success', text: 'Saved. Browsers pick it up on their next page load.' });
      setEdits({});
      await load();
    } else {
      const data = await res.json().catch(() => ({}));
      setMessage({ type: 'error', text: data.error || 'Failed to save' });
    }
    setSaving(false);
  }

  async function handleRevert(key: string) {
    const res = await apiFetch('/api/admin/config', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await load();
    }
  }

  const hasEdits = KEYS.some((key) => key in edits);
  useAdminUnsavedChanges('monitoring', hasEdits);

  if (loading) {
    return (
      <div>
        <AdminPageHeader title={PAGE.label} description={PAGE.description} />
        <AdminBodySkeleton status="Loading" />
      </div>
    );
  }

  const today = state?.errorsToday;

  return (
    <div>
      <AdminPageHeader title={PAGE.label} description={PAGE.description} />
      <div className="space-y-10">
        <SectionNav />

        <SettingsSection id="errors" title="Error reporting">
          <ConfigNote>
            Send errors from browsers and from this server to your own error tracker: Bugsink, GlitchTip or
            Sentry. Off while the address is empty. Message text, addresses, file names, tokens and URLs are
            removed before anything is sent. <a className="underline" href={DOCS} target="_blank" rel="noreferrer">What is sent</a>
          </ConfigNote>
          <ConfigTextItem label="Error reporting address (DSN)" configKey="errorReportingDsn" value={currentValue('errorReportingDsn')} source={config.errorReportingDsn?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://<key>@errors.example.com/1" wide />
          <ConfigTextItem label="Sample rate" configKey="errorReportingSampleRate" value={currentValue('errorReportingSampleRate')} source={config.errorReportingSampleRate?.source} onChange={handleChange} onRevert={handleRevert} placeholder="1" />
          <ConfigTextItem label="Environment" configKey="errorReportingEnvironment" value={currentValue('errorReportingEnvironment')} source={config.errorReportingEnvironment?.source} onChange={handleChange} onRevert={handleRevert} placeholder="production" />
        </SettingsSection>

        <SettingsSection id="errors-today" title="Errors today">
          {!state?.collecting ? (
            <ConfigNote>
              Not counting errors. Counting starts when an error reporting address is set, the metrics
              endpoint is on, or error counts are sent with the usage stats.
            </ConfigNote>
          ) : !today || today.total === 0 ? (
            <p className="text-sm text-muted-foreground">No errors so far today (UTC).</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{today.total} errors today (UTC), most frequent first.</p>
              <ul className="divide-y divide-border rounded-md border border-border text-sm">
                {today.top.map((entry) => (
                  <li key={entry.fingerprint} className="flex items-start justify-between gap-4 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium">{entry.name}{entry.code ? `: ${entry.code}` : ''}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {entry.frames[0] ? `${entry.frames[0].path}:${entry.frames[0].line ?? ''}:${entry.frames[0].column ?? ''}` : 'no stack'}
                        {' · '}{entry.runtime}{' · '}{entry.version}
                      </div>
                    </div>
                    <span className="shrink-0 tabular-nums">{entry.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </SettingsSection>

        <SettingsSection id="metrics" title="Metrics">
          <p className="text-sm">
            {state?.metrics?.enabled
              ? <>On. Prometheus scrapes <code className="font-mono">/api/metrics</code> on each replica with the token as a bearer token.</>
              : <>Off. Set <code className="font-mono">METRICS_TOKEN</code> (or <code className="font-mono">METRICS_TOKEN_FILE</code>) in the environment to turn on <code className="font-mono">/api/metrics</code>.</>}
          </p>
          <ConfigNote>
            Requests per route group, sign-ins, calls to Stalwart and other services, browser errors, memory and
            event-loop lag. <a className="underline" href={`${DOCS}#metrics`} target="_blank" rel="noreferrer">Metric list and scrape config</a>
          </ConfigNote>
        </SettingsSection>

        <SettingsSection id="health" title="Health checks">
          <ul className="space-y-1 text-sm">
            <li><code className="font-mono">/api/health/live</code>: the process answers. For liveness probes and the Docker health check.</li>
            <li><code className="font-mono">/api/health/ready</code>: config loaded, data dirs writable, Stalwart reachable. For readiness probes.</li>
          </ul>
        </SettingsSection>

        <SettingsSection id="tracing" title="Tracing">
          <p className="text-sm">
            {state?.tracing?.active
              ? <>On. Spans go to <code className="font-mono">{state.tracing.endpointHost ?? 'the OTLP endpoint'}</code> over OTLP/HTTP.</>
              : state?.tracing?.configured
                ? <>Configured, but not running in this process. Restart Bulwark after setting the <code className="font-mono">OTEL_*</code> variables.</>
                : <>Off. Set <code className="font-mono">OTEL_EXPORTER_OTLP_ENDPOINT</code> (and the other standard <code className="font-mono">OTEL_*</code> variables you need) to send traces.</>}
          </p>
          <ConfigNote>
            Next&apos;s request spans plus spans for calls to Stalwart and other services. Stalwart gets the trace
            context, so its spans join the trace. URLs, user agents and addresses are removed from spans.{' '}
            <a className="underline" href={`${DOCS}#tracing`} target="_blank" rel="noreferrer">Setup</a>
          </ConfigNote>
        </SettingsSection>
      </div>

      <AdminSaveBar
        dirty={hasEdits}
        saving={saving}
        onSave={handleSave}
        onDiscard={() => setEdits({})}
        note="Browsers pick it up on their next page load"
      />
    </div>
  );
}
