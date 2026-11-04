'use client';

import { useEffect, useState } from 'react';
import { Loader2, Send, ExternalLink } from '@/components/icons';
import { SettingsSection, SettingItem, ToggleSwitch } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { EmptyState } from '@/components/admin/empty-state';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { useAdminFeedback } from '@/components/admin/feedback';
import { ConfigNote, inputClass } from '@/components/admin/config-items';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { apiFetch } from '@/lib/browser-navigation';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { cn } from '@/lib/utils';

interface TelemetryStatus {
  consent: 'pending' | 'on' | 'off';
  consentSource: 'no-third-party' | 'env' | 'file';
  /** 'on' sends them daily; 'instant' also sends today's as they change. */
  errorsConsent?: ErrorsMode;
  errorsConsentSource?: 'telemetry' | 'no-third-party' | 'env' | 'file';
  endpoint: string;
  defaultEndpoint: string;
  consentedAt: string | null;
  lastSentAt: string | null;
  nextScheduledAt: string | null;
  payloadPreview: Record<string, unknown>;
  errorsPreview?: unknown[];
  instantErrorsPreview?: unknown[];
  accountCounts: { total: number; active7d: number };
}

type ErrorsMode = 'on' | 'off' | 'instant';

const PAGE = adminPageDef('telemetry');

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

/** When the next heartbeat goes out; a time already past means it is due. */
function nextRun(iso: string | null): string {
  if (!iso) return '-';
  const at = new Date(iso);
  return at.getTime() <= Date.now() ? 'Due now' : at.toLocaleString();
}

export function TelemetryPage() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState('');
  const setMessage = useAdminFeedback();
  // The heartbeat switch waits for Save like the endpoint (one page, one
  // save bar).
  const [consentDraft, setConsentDraft] = useState<'on' | 'off' | null>(null);
  const [errorsDraft, setErrorsDraft] = useState<ErrorsMode | null>(null);

  const endpointDirty = status !== null && endpointDraft !== status.endpoint;
  const consentDirty = status !== null && consentDraft !== null && consentDraft !== status.consent;
  const errorsDirty = status !== null && errorsDraft !== null && errorsDraft !== (status.errorsConsent ?? 'off');
  const dirty = endpointDirty || consentDirty || errorsDirty;
  useAdminUnsavedChanges('telemetry', dirty);

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

  /** Sends one change; returns the error text, or null. */
  async function post(body: Record<string, unknown>): Promise<string | null> {
    const r = await apiFetch('/api/admin/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return j.error ?? 'failed';
  }

  async function save(): Promise<void> {
    setBusy('save');
    setMessage(null);
    try {
      const errors: string[] = [];
      if (consentDirty && consentDraft) {
        const error = await post({ action: 'set-consent', consent: consentDraft });
        if (error) errors.push(`Heartbeats: ${error}`);
      }
      // After the heartbeat switch: error counts need it on.
      if (errorsDirty && errorsDraft) {
        const error = await post({ action: 'set-errors-consent', consent: errorsDraft });
        if (error) errors.push(`Error counts: ${error}`);
      }
      if (endpointDirty) {
        const error = await post({ action: 'set-endpoint', endpoint: endpointDraft });
        if (error) errors.push(`Endpoint: ${error}`);
      }
      setConsentDraft(null);
      setErrorsDraft(null);
      setMessage(errors.length > 0
        ? { type: 'error', text: `Couldn't save: ${errors.join('; ')}` }
        : { type: 'success', text: 'Telemetry settings saved.' });
      await refresh();
    } finally { setBusy(null); }
  }

  async function sendNow(): Promise<void> {
    setBusy('send');
    setMessage(null);
    try {
      const r = await apiFetch('/api/admin/telemetry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'send-now' }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: number; error?: string };
      setMessage(j.ok
        ? { type: 'success', text: `sent (HTTP ${j.status ?? '?'})` }
        : { type: 'error', text: `failed: ${j.error ?? 'unknown'}` });
      await refresh();
    } finally { setBusy(null); }
  }

  const header = <AdminPageHeader title={PAGE.label} description={PAGE.description} />;

  if (!loading && !status) {
    return (
      <div>
        {header}
        <EmptyState
          title="Could not load the usage stats"
          action={<Button type="button" size="sm" onClick={() => void refresh()}>Retry</Button>}
        />
      </div>
    );
  }

  if (loading || !status) {
    return (
      <div>
        {header}
        <AdminBodySkeleton status="Loading" />
      </div>
    );
  }

  const noThirdParty = status.consentSource === 'no-third-party';
  const envOverridden = status.consentSource === 'env' || noThirdParty;
  const isOn = status.consent === 'on';
  const shownOn = (consentDraft ?? status.consent) === 'on';

  // Error counts follow the heartbeat switch as it is about to be saved.
  const errorsLocked = noThirdParty || status.errorsConsentSource === 'env' || !shownOn;
  const errorsMode: ErrorsMode = shownOn ? (errorsDraft ?? status.errorsConsent ?? 'off') : 'off';
  const errorsShownOn = errorsMode !== 'off';
  const errorsDescription = [
    'Adds how often each error happened yesterday, the error name and where in the code it happened. No message text, no URLs, no instance id goes to the error tracker.',
    !shownOn && 'Needs the heartbeat on.',
    status.errorsConsentSource === 'env' && 'Locked by the BULWARK_TELEMETRY_ERRORS env var.',
  ].filter(Boolean).join(' ');
  const instantDescription = [
    'Also sends today\'s counts within about a minute when an error is new or happens noticeably more often, so a broken release shows up the same day. The same fields as the daily counts; the collector learns roughly when errors happen.',
    !errorsShownOn && 'Needs error counts on.',
  ].filter(Boolean).join(' ');

  // The payload as it will be once the switches are saved.
  const previewPayload = errorsShownOn
    ? { ...status.payloadPreview, schema: '2', errors: status.errorsPreview ?? [] }
    : (({ errors: _omit, ...v1 }) => ({ ...v1, schema: '1' }))(status.payloadPreview as Record<string, unknown> & { errors?: unknown });

  const consentDescription = [
    status.consent === 'pending' && 'Initialising - no heartbeats sent yet.',
    status.consent === 'on' && status.endpoint && 'Heartbeats are enabled. Thanks for helping us improve!',
    status.consent === 'on' && !status.endpoint && 'Heartbeats are on, but none are sent because the collector URL is empty.',
    status.consent === 'off' && 'Heartbeats are off (default).',
    noThirdParty && 'Locked off: no third-party traffic is on (Users > Security).',
    envOverridden && !noThirdParty && 'Locked by the BULWARK_TELEMETRY env var.',
  ].filter(Boolean).join(' ');

  return (
    <div>
      {header}


      <div className="space-y-10">
        <ConfigNote>
          Bulwark can send one anonymous heartbeat per day so we can see how many instances are
          running, on what platforms, and which features they use. It&apos;s <strong>off by
          default</strong>; one click below enables it and helps us make the product better. No
          email addresses, no hostnames, no IPs are sent.{' '}
          <a
            href="https://bulwarkmail.org/docs/legal/privacy/telemetry"
            target="_blank"
            rel="noreferrer"
            className="underline inline-flex items-center gap-1"
          >
            Full schema and policy <ExternalLink className="h-3 w-3" />
          </a>
        </ConfigNote>

        <SettingsSection id="status" title="Status">
          <SettingItem label="Send anonymous heartbeats" description={consentDescription}>
            <ToggleSwitch
              checked={shownOn}
              disabled={busy === 'save' || envOverridden}
              onChange={(checked) => {
                setConsentDraft(checked ? 'on' : 'off');
                if (!checked) setErrorsDraft('off');
                setMessage(null);
              }}
            />
          </SettingItem>
          <SettingItem label="Also send anonymous error counts" description={errorsDescription}>
            <ToggleSwitch
              checked={errorsShownOn}
              disabled={busy === 'save' || errorsLocked}
              onChange={(checked) => { setErrorsDraft(checked ? 'on' : 'off'); setMessage(null); }}
            />
          </SettingItem>
          <SettingItem label="Send error counts right away" description={instantDescription}>
            <ToggleSwitch
              checked={errorsMode === 'instant'}
              disabled={busy === 'save' || errorsLocked || !errorsShownOn}
              onChange={(checked) => { setErrorsDraft(checked ? 'instant' : 'on'); setMessage(null); }}
            />
          </SettingItem>
          <SettingItem label="Last sent">
            <span className="text-sm text-foreground">{timeAgo(status.lastSentAt)}</span>
          </SettingItem>
          {/* Only a running schedule has a next send and a consent date; with
              heartbeats off they were stale ("Next scheduled: 7 hours ago"). */}
          {isOn && (
            <>
              <SettingItem label="Next scheduled">
                <span className="text-sm text-foreground">{nextRun(status.nextScheduledAt)}</span>
              </SettingItem>
              <SettingItem label="Consented at">
                <span className="text-sm text-foreground">{status.consentedAt ? new Date(status.consentedAt).toLocaleString() : '-'}</span>
              </SettingItem>
            </>
          )}
        </SettingsSection>

        <SettingsSection
          id="accounts"
          title="Account activity"
          description="Unique accounts that have logged in over the last 90 days. Identities are stored as a per-instance HMAC, never as plaintext usernames. These are the numbers reported in the heartbeat as bucketed ranges."
        >
          <SettingItem label="Total (90 days)">
            <span className="text-sm font-mono text-foreground">{status.accountCounts?.total ?? 0}</span>
          </SettingItem>
          <SettingItem label="Active (7 days)">
            <span className="text-sm font-mono text-foreground">{status.accountCounts?.active7d ?? 0}</span>
          </SettingItem>
        </SettingsSection>

        <SettingsSection
          id="endpoint"
          title="Endpoint"
          description={`Where heartbeats are sent. The project's collector is ${status.defaultEndpoint}. Point at your own collector (open source at bulwarkmail/dashboard), or clear this field to stop sending.`}
        >
          <SettingItem label="Collector URL">
            <input
              type="url"
              value={endpointDraft}
              onChange={(e) => { setEndpointDraft(e.target.value); setMessage(null); }}
              placeholder="Empty: no heartbeats are sent"
              aria-label="Collector URL"
              autoComplete="off"
              spellCheck={false}
              className={cn(inputClass, 'w-full sm:w-80')}
            />
          </SettingItem>
        </SettingsSection>

        <SettingsSection
          id="payload"
          title="Payload preview"
          description="Exactly what the next heartbeat would send from this install, right now."
        >
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={busy === 'send' || !isOn}
              onClick={() => void sendNow()}
            >
              {busy === 'send' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Send now
            </Button>
          </div>
          <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-96">
            {JSON.stringify(previewPayload, null, 2)}
          </pre>
          {errorsMode === 'instant' && (
            <>
              <p className="text-sm text-muted-foreground">
                Sent right away: today&apos;s error counts as they would go out now. Each minute only
                the errors that are new or reached a higher count range are sent.
              </p>
              <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-96">
                {JSON.stringify({
                  schema: '1',
                  instance_id: status.payloadPreview.instance_id,
                  day: new Date().toISOString().slice(0, 10),
                  errors: status.instantErrorsPreview ?? [],
                }, null, 2)}
              </pre>
            </>
          )}
        </SettingsSection>
      </div>

      <AdminSaveBar
        dirty={dirty}
        saving={busy === 'save'}
        onSave={() => void save()}
        onDiscard={() => { setEndpointDraft(status.endpoint); setConsentDraft(null); setErrorsDraft(null); }}
        saveLabel="Save"
      />
    </div>
  );
}
