'use client';

import { useEffect, useState } from 'react';
import { Loader2, Send, Save, CheckCircle2, XCircle, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/browser-navigation';

interface TelemetryStatus {
  consent: 'pending' | 'on' | 'off';
  consentSource: 'env' | 'file';
  endpoint: string;
  defaultEndpoint: string;
  consentedAt: string | null;
  lastSentAt: string | null;
  nextScheduledAt: string | null;
  payloadPreview: Record<string, unknown>;
  accountCounts: { total: number; active7d: number };
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
  const days = Math.floor(h / 24);
  return `${days} days ago`;
}

export default function AdminTelemetryPage() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState('');
  const [sendResult, setSendResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const r = await apiFetch('/api/admin/telemetry');
      if (!r.ok) throw new Error('failed to load');
      const data = (await r.json()) as TelemetryStatus;
      setStatus(data);
      setEndpointDraft(data.endpoint);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function setConsent(consent: 'on' | 'off'): Promise<void> {
    setBusy('consent');
    try {
      const r = await apiFetch('/api/admin/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set-consent', consent }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        alert(j.error ?? 'failed');
      }
      await refresh();
    } finally { setBusy(null); }
  }

  async function saveEndpoint(): Promise<void> {
    setBusy('endpoint');
    try {
      const r = await apiFetch('/api/admin/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set-endpoint', endpoint: endpointDraft }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        alert(j.error ?? 'failed');
      }
      await refresh();
    } finally { setBusy(null); }
  }

  async function sendNow(): Promise<void> {
    setBusy('send');
    setSendResult(null);
    try {
      const r = await apiFetch('/api/admin/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send-now' }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: number; error?: string };
      setSendResult({
        ok: !!j.ok,
        msg: j.ok ? `sent (HTTP ${j.status ?? '?'})` : `failed: ${j.error ?? 'unknown'}`,
      });
      await refresh();
    } finally { setBusy(null); }
  }

  if (loading || !status) {
    return (
      <div className="p-8 flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> loading…
      </div>
    );
  }

  const envOverridden = status.consentSource === 'env';
  const isOn = status.consent === 'on';

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Anonymous Usage Stats</h1>
        <p className="text-sm text-muted-foreground">
          Bulwark sends one anonymous heartbeat per day so we can see how many instances are
          running, on what platforms, and which features they use. <strong>Enabled by default</strong>;
          one click below disables it. No email addresses, no hostnames, no IPs are sent.{' '}
          <a
            href="https://bulwarkmail.org/docs/legal/privacy/telemetry"
            target="_blank"
            rel="noreferrer"
            className="underline inline-flex items-center gap-1"
          >
            Full schema and policy <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      </header>

      <section className="rounded-lg border p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium">Status</div>
            <div className="text-sm text-muted-foreground">
              {status.consent === 'pending' && 'Initialising - no heartbeats sent yet.'}
              {status.consent === 'on' && 'Heartbeats are enabled (default).'}
              {status.consent === 'off' && 'Heartbeats are off.'}
              {envOverridden && (
                <> Locked by <code>BULWARK_TELEMETRY</code> env var.</>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy === 'consent' || envOverridden || isOn}
              onClick={() => void setConsent('on')}
              className="px-3 py-1.5 rounded-md border bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              Enable
            </button>
            <button
              type="button"
              disabled={busy === 'consent' || envOverridden || status.consent === 'off'}
              onClick={() => void setConsent('off')}
              className="px-3 py-1.5 rounded-md border hover:bg-accent disabled:opacity-50"
            >
              Disable
            </button>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-2 text-sm pt-2 border-t">
          <dt className="text-muted-foreground">Last sent</dt>
          <dd>{timeAgo(status.lastSentAt)}</dd>
          <dt className="text-muted-foreground">Next scheduled</dt>
          <dd>{timeAgo(status.nextScheduledAt)}</dd>
          <dt className="text-muted-foreground">Consented at</dt>
          <dd>{status.consentedAt ? new Date(status.consentedAt).toLocaleString() : '-'}</dd>
        </dl>
      </section>

      <section className="rounded-lg border p-4 space-y-2">
        <div className="font-medium">Account activity</div>
        <p className="text-sm text-muted-foreground">
          Unique accounts that have logged in over the last 90 days. Identities are stored as a
          per-instance HMAC, never as plaintext usernames. These are the numbers reported in the
          heartbeat as bucketed ranges.
        </p>
        <dl className="grid grid-cols-2 gap-2 text-sm pt-1">
          <dt className="text-muted-foreground">Total (90d)</dt>
          <dd className="font-mono">{status.accountCounts?.total ?? 0}</dd>
          <dt className="text-muted-foreground">Active (7d)</dt>
          <dd className="font-mono">{status.accountCounts?.active7d ?? 0}</dd>
        </dl>
      </section>

      <section className="rounded-lg border p-4 space-y-3">
        <div className="font-medium">Endpoint</div>
        <p className="text-sm text-muted-foreground">
          Where heartbeats are sent. Defaults to the project's collector. Point at your own collector
          (open source at <code>bulwarkmail/dashboard</code>) or clear this field to disable sending.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="url"
            value={endpointDraft}
            onChange={(e) => setEndpointDraft(e.target.value)}
            placeholder={status.defaultEndpoint}
            className="flex-1 min-w-0 px-3 py-1.5 rounded-md border bg-background"
          />
          <button
            type="button"
            disabled={busy === 'endpoint' || endpointDraft === status.endpoint}
            onClick={() => void saveEndpoint()}
            className="shrink-0 px-3 py-1.5 rounded-md border bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center justify-center gap-1"
          >
            <Save className="h-4 w-4" /> Save
          </button>
        </div>
      </section>

      <section className="rounded-lg border p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <div className="font-medium">Payload preview</div>
            <div className="text-sm text-muted-foreground">
              Exactly what the next heartbeat would send from this install, right now.
            </div>
          </div>
          <button
            type="button"
            disabled={busy === 'send' || !isOn}
            onClick={() => void sendNow()}
            className="shrink-0 px-3 py-1.5 rounded-md border bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Send className="h-4 w-4" /> Send now
          </button>
        </div>
        {sendResult && (
          <div
            className={`text-sm flex items-center gap-2 ${
              sendResult.ok ? 'text-emerald-600' : 'text-red-600'
            }`}
          >
            {sendResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {sendResult.msg}
          </div>
        )}
        <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-96">
          {JSON.stringify(status.payloadPreview, null, 2)}
        </pre>
      </section>
    </div>
  );
}
