'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, AlertTriangle, AlertCircle, Server, ShieldCheck, KeyRound, FileText, Palette, Lock, ShieldAlert } from 'lucide-react';
import { apiFetch, getPathPrefix, withBasePath } from '@/lib/browser-navigation';

type State = 'bootstrap' | 'configured' | 'env-managed';

interface StatusResponse {
  state: State;
  authenticated: boolean;
  readOnly: boolean;
  partialConfig: Record<string, unknown> | null;
}

interface JmapServerRow {
  id: string;
  label: string;
  url: string;
  /** comma-separated, parsed before save */
  domains: string;
}

interface WizardConfig {
  // Server
  appName: string;
  jmapServerUrl: string;
  stalwartFeaturesEnabled: boolean;
  jmapServers: JmapServerRow[];
  jmapServerAutoPickByDomain: boolean;
  // Auth
  oauthEnabled: boolean;
  oauthOnly: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthIssuerUrl: string;
  // Security
  sessionSecret: string;
  settingsSyncEnabled: boolean;
  telemetryEnabled: boolean;
  // Logging
  logFormat: 'text' | 'json';
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  // Branding
  faviconUrl: string;
  appLogoLightUrl: string;
  appLogoDarkUrl: string;
  loginLogoLightUrl: string;
  loginLogoDarkUrl: string;
  loginCompanyName: string;
  loginImprintUrl: string;
  loginPrivacyPolicyUrl: string;
  loginWebsiteUrl: string;
}

const EMPTY_CONFIG: WizardConfig = {
  appName: 'Bulwark Webmail',
  jmapServerUrl: '',
  stalwartFeaturesEnabled: true,
  jmapServers: [],
  jmapServerAutoPickByDomain: false,
  oauthEnabled: false,
  oauthOnly: false,
  oauthClientId: '',
  oauthClientSecret: '',
  oauthIssuerUrl: '',
  sessionSecret: '',
  settingsSyncEnabled: true,
  telemetryEnabled: false,
  logFormat: 'text',
  logLevel: 'info',
  faviconUrl: '',
  appLogoLightUrl: '',
  appLogoDarkUrl: '',
  loginLogoLightUrl: '',
  loginLogoDarkUrl: '',
  loginCompanyName: '',
  loginImprintUrl: '',
  loginPrivacyPolicyUrl: '',
  loginWebsiteUrl: '',
};

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'server', label: 'Server' },
  { id: 'auth', label: 'Auth' },
  { id: 'security', label: 'Security' },
  { id: 'logging', label: 'Logging' },
  { id: 'branding', label: 'Branding' },
  { id: 'review', label: 'Review' },
] as const;

export default function SetupWizardPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [bootstrapping, setBootstrapping] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<State>('bootstrap');
  const [authenticated, setAuthenticated] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [config, setConfig] = useState<WizardConfig>(EMPTY_CONFIG);
  const [stepIndex, setStepIndex] = useState(0);
  const [completed, setCompleted] = useState(false);
  // Resolved in a post-mount effect, not at render, so the server-rendered
  // HTML (where window is absent) matches the client's first paint and
  // doesn't trip a hydration mismatch.
  const [insecureContext, setInsecureContext] = useState(false);
  const [insecureAcknowledged, setInsecureAcknowledged] = useState(false);
  useEffect(() => {
    setInsecureContext(detectInsecureContext());
  }, []);

  // ─── Initial status load ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/setup/status', { cache: 'no-store' });
        const data = (await res.json()) as StatusResponse;
        if (cancelled) return;

        setState(data.state);
        setReadOnly(data.readOnly);

        if (data.state === 'configured' || data.state === 'env-managed') {
          // Wizard not active - bounce to login. Middleware will 404 us
          // before we get here in practice, but defensive.
          router.replace('/');
          return;
        }

        setAuthenticated(data.authenticated);
        if (data.partialConfig) {
          setConfig((prev) => mergePartial(prev, data.partialConfig!));
          // If auth is OK and we already have a JMAP URL persisted, jump
          // ahead to the next unfilled step.
          if (data.authenticated && data.partialConfig.jmapServerUrl) {
            setStepIndex(2);
          } else if (data.authenticated) {
            setStepIndex(1);
          }
        }
      } catch (e) {
        if (!cancelled) setError(humanError(e));
      } finally {
        if (!cancelled) setBootstrapping(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // ─── Token submit (welcome step) ────────────────────────────────────────
  async function submitToken(token: string) {
    setError(null);
    const res = await apiFetch('/api/setup/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Token rejected (HTTP ${res.status})`);
    }
    setAuthenticated(true);
    setStepIndex(1);
  }

  // ─── Step persistence ───────────────────────────────────────────────────
  async function saveStep(step: string, values: Record<string, unknown>) {
    const res = await apiFetch('/api/setup/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step, values }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Step save failed (HTTP ${res.status})`);
    }
  }

  // ─── Render shell ───────────────────────────────────────────────────────
  if (insecureContext && !insecureAcknowledged) {
    return <InsecureContextScreen onContinue={() => setInsecureAcknowledged(true)} />;
  }

  if (bootstrapping) {
    return <CenteredCard><p className="text-muted-foreground">Loading…</p></CenteredCard>;
  }

  if (completed) {
    return <CompletedScreen />;
  }

  if (state !== 'bootstrap') {
    return <AlreadyConfiguredScreen />;
  }

  if (readOnly) {
    return (
      <CenteredCard>
        <h1 className="text-lg font-semibold">Configuration is read-only</h1>
        <p className="text-sm text-muted-foreground mt-2">
          The config volume is mounted read-only or <code className="font-mono text-xs">ADMIN_CONFIG_READONLY</code> is set.
          Remount it read-write or unset that variable, then restart the container.
        </p>
      </CenteredCard>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-2xl">
        <Header />
        <ProgressBar stepIndex={stepIndex} />

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

          {!authenticated ? (
            <WelcomeStep
              tokenFromUrl={searchParams.get('token') ?? ''}
              onSubmit={async (t) => {
                try {
                  await submitToken(t);
                } catch (e) {
                  setError(humanError(e));
                }
              }}
            />
          ) : (
            <StepContent
              stepIndex={stepIndex}
              config={config}
              setConfig={setConfig}
              onNext={async (step, values) => {
                try {
                  await saveStep(step, values);
                  setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
                } catch (e) {
                  const msg = humanError(e);
                  setError(msg);
                  // Session expired mid-flow - kick the user back to the
                  // welcome step so they can re-enter the token without
                  // having to refresh.
                  if (/wizard session required/i.test(msg)) {
                    setAuthenticated(false);
                    setStepIndex(0);
                  }
                }
              }}
              onBack={() => setStepIndex((i) => Math.max(i - 1, 1))}
              onFinish={() => {
                setCompleted(true);
                // Hard navigation after a beat - gives the user a moment
                // to see the success screen and works around any router
                // edge cases that swallow client-side replaces after the
                // setupComplete flag flips.
                setTimeout(() => {
                  window.location.assign(`${getPathPrefix()}/admin/login`);
                }, 1500);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Layout helpers ───────────────────────────────────────────────────────

function Header() {
  return (
    <div className="text-center mb-6">
      <h1 className="text-2xl font-semibold">Bulwark Webmail Setup</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Configure your webmail instance from the browser.
      </p>
    </div>
  );
}

function ProgressBar({ stepIndex }: { stepIndex: number }) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-1.5 text-xs">
        {STEPS.map((step, i) => (
          <div key={step.id} className="flex-1">
            <div
              className={
                'h-1 rounded-full transition-colors ' +
                (i < stepIndex
                  ? 'bg-primary'
                  : i === stepIndex
                    ? 'bg-primary/60'
                    : 'bg-muted')
              }
            />
            <div
              className={
                'mt-1.5 text-center ' +
                (i === stepIndex
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground')
              }
            >
              {step.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompletedScreen() {
  return (
    <CenteredCard>
      <div className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-primary"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold">You&apos;re all set!</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Bulwark Webmail is configured and ready to use.
        </p>
      </div>
      <div className="mt-6 space-y-2">
        <a
          href={`${getPathPrefix()}/admin/login`}
          className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
        >
          Sign in to admin dashboard
        </a>
        <a
          href={`${getPathPrefix()}/`}
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          Open webmail login
        </a>
      </div>
      <p className="text-xs text-muted-foreground text-center mt-4">
        Taking you to the admin dashboard…
      </p>
    </CenteredCard>
  );
}

function InsecureContextScreen({ onContinue }: { onContinue: () => void }) {
  const httpsUrl =
    typeof window !== 'undefined'
      ? `https://${window.location.host}${window.location.pathname}${window.location.search}`
      : '';
  return (
    <CenteredCard>
      <div className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-warning/15 text-warning flex items-center justify-center mb-4">
          <ShieldAlert className="h-6 w-6" />
        </div>
        <h1 className="text-xl font-semibold">You&apos;re running setup over plain HTTP</h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          The setup token and admin password you enter here will travel in cleartext.
          Please use HTTPS if at all possible - terminate TLS on the container or a reverse proxy in front of it.
        </p>
      </div>
      <div className="mt-6 space-y-2">
        {httpsUrl && (
          <a
            href={httpsUrl}
            className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
          >
            Try HTTPS
          </a>
        )}
        <button
          type="button"
          onClick={onContinue}
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          Continue over HTTP
        </button>
      </div>
    </CenteredCard>
  );
}

function AlreadyConfiguredScreen() {
  return (
    <CenteredCard>
      <div className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-6 w-6 text-primary"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold">Setup is already complete</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Bulwark Webmail is configured. Sign in to continue.
        </p>
      </div>
      <div className="mt-6 space-y-2">
        <a
          href={`${getPathPrefix()}/admin/login`}
          className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
        >
          Sign in to admin dashboard
        </a>
        <a
          href={`${getPathPrefix()}/`}
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          Open webmail login
        </a>
      </div>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="bg-card border border-border rounded-lg p-6 shadow-sm max-w-md w-full">
        {children}
      </div>
    </div>
  );
}

function ErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="mb-4 p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3">
      <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
        <AlertCircle className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0 self-center">
        <p className="text-sm text-destructive leading-relaxed">{friendlyError(error)}</p>
      </div>
      <button
        onClick={onDismiss}
        className="self-center text-xs text-muted-foreground hover:text-foreground underline shrink-0"
        type="button"
      >
        dismiss
      </button>
    </div>
  );
}

/**
 * Translate raw API error strings into user-facing copy. Matches the friendly
 * tone of the JMAP probe cards.
 */
function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('invalid or expired token')) {
    return "That setup token isn't valid anymore. Restart the container to get a fresh one from the logs.";
  }
  if (lower.includes('wizard session required')) {
    return 'Your wizard session expired. Paste the setup token again to continue.';
  }
  if (lower.includes('token required')) {
    return 'Paste the setup token printed in the container logs to continue.';
  }
  if (lower.includes('setup is not active')) {
    return 'Setup has already finished. Reload to sign in.';
  }
  return raw;
}

// ─── Welcome / token step ────────────────────────────────────────────────

function WelcomeStep({ tokenFromUrl, onSubmit }: { tokenFromUrl: string; onSubmit: (t: string) => Promise<void> }) {
  const [token, setToken] = useState(tokenFromUrl);
  const [submitting, setSubmitting] = useState(false);

  // Auto-submit if token came in via URL.
  useEffect(() => {
    if (tokenFromUrl && !submitting) {
      setSubmitting(true);
      onSubmit(tokenFromUrl).finally(() => setSubmitting(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenFromUrl]);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(token.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <h2 className="text-lg font-semibold">Welcome</h2>
      <p className="text-sm text-muted-foreground">
        Paste the setup token printed in the container logs to continue. The token expires after 1 hour.
      </p>
      <Field label="Setup token">
        <Input value={token} onChange={(v) => setToken(v)} autoFocus required placeholder="32-byte hex token" />
      </Field>
      <PrimaryButton type="submit" disabled={submitting || !token.trim()}>
        {submitting ? 'Verifying…' : 'Continue'}
      </PrimaryButton>
    </form>
  );
}

// ─── Step router ─────────────────────────────────────────────────────────

interface StepProps {
  stepIndex: number;
  config: WizardConfig;
  setConfig: React.Dispatch<React.SetStateAction<WizardConfig>>;
  onNext: (step: string, values: Record<string, unknown>) => Promise<void>;
  onBack: () => void;
  onFinish: () => void;
}

function StepContent({ stepIndex, config, setConfig, onNext, onBack, onFinish }: StepProps) {
  switch (stepIndex) {
    case 1:
      return <ServerStep config={config} setConfig={setConfig} onNext={onNext} />;
    case 2:
      return <AuthStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 3:
      return <SecurityStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 4:
      return <LoggingStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 5:
      return <BrandingStep config={config} setConfig={setConfig} onNext={onNext} onBack={onBack} />;
    case 6:
      return <ReviewStep config={config} onBack={onBack} onFinish={onFinish} />;
    default:
      return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
}

// ─── Server step ─────────────────────────────────────────────────────────

type ProbeStatus = 'jmap_detected' | 'reachable_no_jmap' | 'unreachable' | 'invalid_url';

function ServerStep({ config, setConfig, onNext }: Pick<StepProps, 'config' | 'setConfig' | 'onNext'>) {
  const [submitting, setSubmitting] = useState(false);
  const [probe, setProbe] = useState<{ status: ProbeStatus; message: string; url: string } | null>(null);
  const [probing, setProbing] = useState(false);
  // When the server is reachable but isn't a JMAP endpoint, the wizard
  // shows a "looks wrong, are you sure?" inline confirmation. The flag
  // resets every time the URL changes.
  const [confirmedNonJmap, setConfirmedNonJmap] = useState(false);

  async function testJmap(): Promise<{ status: ProbeStatus; message: string; url: string } | null> {
    setProbe(null);
    setProbing(true);
    setConfirmedNonJmap(false);
    try {
      const res = await apiFetch('/api/setup/test-jmap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: config.jmapServerUrl }),
      });
      const data = await res.json();
      let entry: { status: ProbeStatus; message: string; url: string };
      if (data.status === 'jmap_detected') {
        entry = { status: 'jmap_detected', message: 'Connected - this looks like a JMAP server.', url: config.jmapServerUrl };
      } else if (data.status === 'reachable_no_jmap') {
        entry = { status: 'reachable_no_jmap', message: "We reached the server, but it doesn't look like a JMAP endpoint.", url: config.jmapServerUrl };
      } else if (data.status === 'invalid_url') {
        entry = { status: 'invalid_url', message: data.message ?? 'That URL is not valid. Make sure it starts with http:// or https://.', url: config.jmapServerUrl };
      } else {
        entry = { status: 'unreachable', message: data.message ?? "Couldn't connect to that address. Double-check the URL and that the server is online.", url: config.jmapServerUrl };
      }
      setProbe(entry);
      return entry;
    } catch (e) {
      const entry = { status: 'unreachable' as ProbeStatus, message: humanError(e), url: config.jmapServerUrl };
      setProbe(entry);
      return entry;
    } finally {
      setProbing(false);
    }
  }

  const [showAdditional, setShowAdditional] = useState(config.jmapServers.length > 0);

  function updateRow(index: number, patch: Partial<JmapServerRow>) {
    setConfig({
      ...config,
      jmapServers: config.jmapServers.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });
  }

  function addRow() {
    setConfig({
      ...config,
      jmapServers: [...config.jmapServers, { id: '', label: '', url: '', domains: '' }],
    });
    setShowAdditional(true);
  }

  function removeRow(index: number) {
    setConfig({
      ...config,
      jmapServers: config.jmapServers.filter((_, i) => i !== index),
    });
  }

  // Validate the multi-server rows: each must have a unique id matching the
  // schema, a usable URL, and no collision with the primary server.
  const rowErrors: string[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < config.jmapServers.length; i++) {
    const r = config.jmapServers[i];
    const id = r.id.trim();
    if (!id) {
      rowErrors.push(`Server #${i + 1}: id is required`);
    } else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      rowErrors.push(`Server #${i + 1}: id must be alphanumeric (with - or _), starting with a letter or digit`);
    } else if (seenIds.has(id)) {
      rowErrors.push(`Server #${i + 1}: id "${id}" is duplicated`);
    } else {
      seenIds.add(id);
    }
    const url = r.url.trim();
    if (!url) {
      rowErrors.push(`Server #${i + 1}: url is required`);
    } else if (!/^https?:\/\//i.test(url)) {
      rowErrors.push(`Server #${i + 1}: url must start with http:// or https://`);
    }
  }
  const hasRowErrors = rowErrors.length > 0;

  async function handle(e: FormEvent) {
    e.preventDefault();
    if (hasRowErrors) return;
    setSubmitting(true);
    try {
      // Auto-probe the URL on Next so the operator can't accidentally
      // skip past a wrong URL. If the URL changed since the last probe,
      // re-run; otherwise reuse the cached result.
      let result = probe && probe.url === config.jmapServerUrl ? probe : null;
      if (!result) {
        result = await testJmap();
      }
      if (!result) return;

      // Hard-fail on these - no "are you sure" since they can't be right.
      if (result.status === 'invalid_url' || result.status === 'unreachable') {
        return;
      }

      // Soft warning: server responded but it's not a JMAP endpoint at the
      // standard paths. Could be legitimate (reverse proxy routing) so we
      // ask for explicit confirmation rather than blocking.
      if (result.status === 'reachable_no_jmap' && !confirmedNonJmap) {
        return;
      }

      await onNext('server', {
        appName: config.appName,
        jmapServerUrl: config.jmapServerUrl,
        stalwartFeaturesEnabled: config.stalwartFeaturesEnabled,
        // The API route runs parseJmapServers on this; we pre-canonicalize
        // here so the round-trip is clean.
        jmapServers: rowsToCanonical(config.jmapServers),
        jmapServerAutoPickByDomain: config.jmapServerAutoPickByDomain,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Server" subtitle="Where your mail lives." />
      <Field label="Application name">
        <Input value={config.appName} onChange={(v) => setConfig({ ...config, appName: v })} required />
      </Field>
      <Field label="JMAP server URL" hint="The default server users connect to. Example: https://mail.example.com">
        <div className="flex gap-2">
          <Input
            value={config.jmapServerUrl}
            onChange={(v) => {
              setConfig({ ...config, jmapServerUrl: v });
              // Any URL change invalidates the previous probe result.
              if (probe && probe.url !== v) {
                setProbe(null);
                setConfirmedNonJmap(false);
              }
            }}
            required
            placeholder="https://"
            type="url"
          />
          <button
            type="button"
            onClick={() => { void testJmap(); }}
            disabled={!config.jmapServerUrl || probing}
            className="px-3 py-2 text-sm border border-border rounded-md hover:bg-muted disabled:opacity-50"
          >
            {probing ? 'Testing…' : 'Test'}
          </button>
        </div>
        {isInsecureHttpUrl(config.jmapServerUrl) && (
          <div className="mt-2 p-3 rounded-xl border border-warning/20 bg-warning/5 flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center flex-shrink-0 shadow-sm">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0 self-center">
              <p className="text-sm font-medium text-foreground leading-relaxed">
                This URL uses plain HTTP.
              </p>
              <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
                Passwords and email contents will travel unencrypted between users and your server. Use <code className="font-mono text-xs">https://</code> in production - terminate TLS on the mail server or a reverse proxy in front of it.
              </p>
            </div>
          </div>
        )}
        {isPrivateOrLocalHostUrl(config.jmapServerUrl) && (
          <div className="mt-2 p-3 rounded-xl border border-warning/20 bg-warning/5 flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center flex-shrink-0 shadow-sm">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0 self-center">
              <p className="text-sm font-medium text-foreground leading-relaxed">
                This URL only resolves locally.
              </p>
              <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
                Mail is fetched directly from the user&apos;s browser, so the JMAP URL must be reachable from anywhere users sign in - not just this machine or LAN. Use a public hostname (e.g. <code className="font-mono text-xs">https://mail.example.com</code>) in production.
              </p>
            </div>
          </div>
        )}
        {probe && probe.url === config.jmapServerUrl && (
          probe.status === 'jmap_detected' ? (
            <div className="mt-2 p-3 rounded-xl border border-success/20 bg-success/5 flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-success/15 text-success flex items-center justify-center flex-shrink-0 shadow-sm">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0 self-center">
                <p className="text-sm text-foreground leading-relaxed">{probe.message}</p>
              </div>
            </div>
          ) : probe.status === 'reachable_no_jmap' ? (
            <div className="mt-2 p-3 rounded-xl border border-warning/20 bg-warning/5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center flex-shrink-0 shadow-sm">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0 self-center">
                  <p className="text-sm font-medium text-foreground leading-relaxed">{probe.message}</p>
                  <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                    This can happen when a reverse proxy routes JMAP separately on the same domain. Otherwise, it usually means the URL is wrong.
                  </p>
                </div>
              </div>
              <label className="mt-3 ms-[3.25rem] flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmedNonJmap}
                  onChange={(e) => setConfirmedNonJmap(e.target.checked)}
                  className="h-4 w-4"
                />
                <span className="text-sm text-foreground">I&apos;m sure this is the right URL - continue anyway.</span>
              </label>
            </div>
          ) : (
            <div className="mt-2 p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
                <AlertCircle className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0 self-center">
                <p className="text-sm text-destructive leading-relaxed">{probe.message}</p>
              </div>
            </div>
          )
        )}
      </Field>

      {/* Additional servers (optional) */}
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-medium">Additional JMAP servers</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Optional. Surface multiple servers in the login dropdown - useful for hosts running several Stalwart instances.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdditional((v) => !v)}
            className="text-xs underline text-muted-foreground hover:text-foreground shrink-0"
          >
            {showAdditional ? 'Hide' : config.jmapServers.length > 0 ? `Show (${config.jmapServers.length})` : 'Add'}
          </button>
        </div>

        {showAdditional && (
          <div className="mt-3 space-y-3">
            {config.jmapServers.map((row, i) => (
              <div key={i} className="rounded-md border border-border bg-background p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Server #{i + 1}</span>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="text-xs text-destructive hover:underline"
                  >
                    Remove
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="ID" hint="Unique slug, e.g. eu-1">
                    <Input value={row.id} onChange={(v) => updateRow(i, { id: v })} placeholder="eu-1" required />
                  </Field>
                  <Field label="Label" hint="Shown to users">
                    <Input value={row.label} onChange={(v) => updateRow(i, { label: v })} placeholder="Europe (primary)" />
                  </Field>
                </div>
                <Field label="URL">
                  <Input value={row.url} onChange={(v) => updateRow(i, { url: v })} placeholder="https://" type="url" required />
                </Field>
                <Field label="Domains" hint="Comma-separated. Used to auto-pick this server by email domain at login.">
                  <Input value={row.domains} onChange={(v) => updateRow(i, { domains: v })} placeholder="example.com, mail.example.com" />
                </Field>
              </div>
            ))}

            <button
              type="button"
              onClick={addRow}
              className="w-full px-3 py-2 text-sm border border-dashed border-border rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              + Add server
            </button>

            {config.jmapServers.length > 0 && (
              <Toggle
                checked={config.jmapServerAutoPickByDomain}
                onChange={(v) => setConfig({ ...config, jmapServerAutoPickByDomain: v })}
                label="Auto-pick server by email domain"
                hint="When a user types their email, automatically select the matching server from the list above."
              />
            )}

            {hasRowErrors && (
              <ul className="text-xs text-destructive list-disc ps-5 space-y-0.5">
                {rowErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Toggle
        checked={config.stalwartFeaturesEnabled}
        onChange={(v) => setConfig({ ...config, stalwartFeaturesEnabled: v })}
        label="Enable Stalwart-specific features"
        hint="Adds password change and Sieve filter management. Safe to enable on non-Stalwart servers."
      />

      <Footer>
        <PrimaryButton
          type="submit"
          disabled={
            submitting ||
            !config.jmapServerUrl ||
            hasRowErrors ||
            // Once probed, gate the button on the result so the user gets a
            // visual signal rather than a silent no-op when clicking Next.
            (probe?.url === config.jmapServerUrl &&
              ((probe.status === 'reachable_no_jmap' && !confirmedNonJmap) ||
                probe.status === 'invalid_url' ||
                probe.status === 'unreachable'))
          }
        >
          {submitting ? 'Saving…' : probing ? 'Testing…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Auth step ───────────────────────────────────────────────────────────

function AuthStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const values: Partial<WizardConfig> = { oauthEnabled: config.oauthEnabled };
      if (config.oauthEnabled) {
        values.oauthOnly = config.oauthOnly;
        values.oauthClientId = config.oauthClientId;
        values.oauthIssuerUrl = config.oauthIssuerUrl;
        if (config.oauthClientSecret) {
          values.oauthClientSecret = config.oauthClientSecret;
        }
      }
      await onNext('auth', values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Authentication" subtitle="Basic auth is always available. OAuth/OIDC is optional." />
      <Toggle
        checked={config.oauthEnabled}
        onChange={(v) => setConfig({ ...config, oauthEnabled: v })}
        label="Enable OAuth2 / OpenID Connect"
      />
      {config.oauthEnabled && (
        <>
          <Toggle
            checked={config.oauthOnly}
            onChange={(v) => setConfig({ ...config, oauthOnly: v })}
            label="OAuth-only mode (hide password form)"
          />
          <Field label="OAuth Client ID">
            <Input value={config.oauthClientId} onChange={(v) => setConfig({ ...config, oauthClientId: v })} required />
          </Field>
          <Field label="OAuth Client Secret" hint="Leave blank for public clients using PKCE only.">
            <Input
              value={config.oauthClientSecret}
              onChange={(v) => setConfig({ ...config, oauthClientSecret: v })}
              type="password"
              placeholder="paste secret"
            />
          </Field>
          <Field label="OAuth Issuer URL" hint="For external IdPs (Keycloak, Authentik, Entra ID, etc.).">
            <Input value={config.oauthIssuerUrl} onChange={(v) => setConfig({ ...config, oauthIssuerUrl: v })} type="url" />
          </Field>
        </>
      )}
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Security step ───────────────────────────────────────────────────────

function generateSessionSecret(): string {
  // 32 random bytes, base64-encoded - same shape as `openssl rand -base64 32`.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function SecurityStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [customize, setCustomize] = useState(false);

  // Auto-generate on first render so the operator doesn't have to click a
  // button for the recommended path. They can still regenerate or paste
  // their own via the "Customize" toggle.
  useEffect(() => {
    if (!config.sessionSecret) {
      setConfig((prev) => ({ ...prev, sessionSecret: generateSessionSecret() }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // telemetryConsent is persisted to the telemetry state file by the API,
      // not to admin config - see app/api/setup/step/route.ts.
      const values: Record<string, unknown> = {
        settingsSyncEnabled: config.settingsSyncEnabled,
        telemetryConsent: config.telemetryEnabled ? 'on' : 'off',
      };
      if (config.sessionSecret) values.sessionSecret = config.sessionSecret;
      await onNext('security', values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader
        title="Security & Sessions"
        subtitle='Session secret unlocks "Remember me" and settings sync.'
      />

      <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Session secret generated</span>
          <button
            type="button"
            onClick={() => setCustomize((v) => !v)}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            {customize ? 'Hide' : 'Customize'}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          A 32-byte secret was created for you. You only need to change this if you have a specific reason.
        </p>
      </div>

      {customize && (
        <Field label="Session secret" hint="Paste your own value or click regenerate.">
          <div className="flex gap-2">
            <Input
              value={config.sessionSecret}
              onChange={(v) => setConfig({ ...config, sessionSecret: v })}
              type={reveal ? 'text' : 'password'}
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className="px-3 py-2 text-sm border border-border rounded-md hover:bg-muted"
            >
              {reveal ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              onClick={() => setConfig({ ...config, sessionSecret: generateSessionSecret() })}
              className="px-3 py-2 text-sm border border-border rounded-md hover:bg-muted"
            >
              Regenerate
            </button>
          </div>
        </Field>
      )}

      <Toggle
        checked={config.settingsSyncEnabled}
        onChange={(v) => setConfig({ ...config, settingsSyncEnabled: v })}
        label="Sync user settings across devices"
        hint="Stores user preferences server-side, encrypted with the session secret."
        disabled={!config.sessionSecret}
      />

      <div className="rounded-md border border-border bg-muted/20 p-3">
        <Toggle
          checked={config.telemetryEnabled}
          onChange={(v) => setConfig({ ...config, telemetryEnabled: v })}
          label="Send anonymous usage stats to help improve Bulwark"
          hint="Off by default. One anonymous heartbeat per day with version, platform, and which features are enabled - never email addresses, hostnames, or IPs. You can change this anytime in admin settings."
        />
      </div>
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Logging step ────────────────────────────────────────────────────────

function LoggingStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);
  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onNext('logging', { logFormat: config.logFormat, logLevel: config.logLevel });
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader title="Logging" subtitle="Format and verbosity for the application logs." />
      <Field label="Format">
        <Select
          value={config.logFormat}
          onChange={(v) => setConfig({ ...config, logFormat: v as 'text' | 'json' })}
          options={[
            { value: 'text', label: 'text - colored, human-readable' },
            { value: 'json', label: 'json - structured, for log aggregation' },
          ]}
        />
      </Field>
      <Field label="Level">
        <Select
          value={config.logLevel}
          onChange={(v) => setConfig({ ...config, logLevel: v as WizardConfig['logLevel'] })}
          options={[
            { value: 'error', label: 'error' },
            { value: 'warn', label: 'warn' },
            { value: 'info', label: 'info (recommended)' },
            { value: 'debug', label: 'debug' },
          ]}
        />
      </Field>
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Branding step ───────────────────────────────────────────────────────

type BrandingSlot =
  | 'faviconUrl'
  | 'appLogoLightUrl'
  | 'appLogoDarkUrl'
  | 'loginLogoLightUrl'
  | 'loginLogoDarkUrl';

function BrandingStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const [submitting, setSubmitting] = useState(false);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Only send fields with a value. Empty strings would create an admin
      // override that shadows the system default and suppress the bundled
      // Bulwark logo on the login page.
      const allFields = {
        faviconUrl: config.faviconUrl,
        appLogoLightUrl: config.appLogoLightUrl,
        appLogoDarkUrl: config.appLogoDarkUrl,
        loginLogoLightUrl: config.loginLogoLightUrl,
        loginLogoDarkUrl: config.loginLogoDarkUrl,
        loginCompanyName: config.loginCompanyName,
        loginImprintUrl: config.loginImprintUrl,
        loginPrivacyPolicyUrl: config.loginPrivacyPolicyUrl,
        loginWebsiteUrl: config.loginWebsiteUrl,
      };
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(allFields)) {
        if (v.trim() !== '') values[k] = v.trim();
      }
      await onNext('branding', values);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-4">
      <StepHeader
        title="Branding"
        subtitle="All fields optional. Upload a file or paste a URL - defaults are used for anything you skip."
      />
      <Field label="Company / organization name">
        <Input value={config.loginCompanyName} onChange={(v) => setConfig({ ...config, loginCompanyName: v })} />
      </Field>

      <div className="space-y-2">
        <BrandingAsset
          label="Favicon"
          hint="Browser tab icon. SVG recommended."
          slot="faviconUrl"
          value={config.faviconUrl}
          onChange={(v) => setConfig({ ...config, faviconUrl: v })}
        />
        <BrandingAsset
          label="Login logo (light mode)"
          hint="Shown on the sign-in page, light backgrounds."
          slot="loginLogoLightUrl"
          value={config.loginLogoLightUrl}
          onChange={(v) => setConfig({ ...config, loginLogoLightUrl: v })}
        />
        <BrandingAsset
          label="Login logo (dark mode)"
          hint="Shown on the sign-in page, dark backgrounds."
          slot="loginLogoDarkUrl"
          value={config.loginLogoDarkUrl}
          onChange={(v) => setConfig({ ...config, loginLogoDarkUrl: v })}
          previewBg="dark"
        />
        <BrandingAsset
          label="Sidebar logo (light mode)"
          hint="Shown after sign-in. Leave blank for none."
          slot="appLogoLightUrl"
          value={config.appLogoLightUrl}
          onChange={(v) => setConfig({ ...config, appLogoLightUrl: v })}
        />
        <BrandingAsset
          label="Sidebar logo (dark mode)"
          hint="Dark mode variant of the sidebar logo."
          slot="appLogoDarkUrl"
          value={config.appLogoDarkUrl}
          onChange={(v) => setConfig({ ...config, appLogoDarkUrl: v })}
          previewBg="dark"
        />
      </div>

      <Field label="Website URL">
        <Input value={config.loginWebsiteUrl} onChange={(v) => setConfig({ ...config, loginWebsiteUrl: v })} type="url" />
      </Field>
      <Field label="Imprint URL">
        <Input value={config.loginImprintUrl} onChange={(v) => setConfig({ ...config, loginImprintUrl: v })} type="url" />
      </Field>
      <Field label="Privacy policy URL">
        <Input value={config.loginPrivacyPolicyUrl} onChange={(v) => setConfig({ ...config, loginPrivacyPolicyUrl: v })} type="url" />
      </Field>
      <Footer>
        <SecondaryButton onClick={onBack}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Next'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

/**
 * One branding asset slot: shows a thumbnail preview if a value is set,
 * a file picker (uploads to /api/setup/branding), and a URL field for
 * operators who'd rather paste a link. Upload and URL are mutually
 * compatible - the URL field always reflects the persisted value.
 */
function BrandingAsset({
  label,
  hint,
  slot,
  value,
  onChange,
  previewBg = 'light',
}: {
  label: string;
  hint?: string;
  slot: BrandingSlot;
  value: string;
  onChange: (v: string) => void;
  previewBg?: 'light' | 'dark';
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showUrlField, setShowUrlField] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    setUploadError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('slot', slot);
      const res = await apiFetch('/api/setup/branding', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data?.error ?? `Upload failed (HTTP ${res.status})`);
        return;
      }
      onChange(data.url);
    } catch (e) {
      setUploadError(humanError(e));
    } finally {
      setUploading(false);
    }
  }

  async function clearAsset() {
    setUploadError(null);
    try {
      await apiFetch('/api/setup/branding', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      }).catch(() => null);
    } finally {
      onChange('');
    }
  }

  const previewClasses =
    'shrink-0 w-16 h-16 rounded-md border border-border flex items-center justify-center overflow-hidden transition-colors ' +
    (previewBg === 'dark' ? 'bg-zinc-900' : 'bg-muted/40') +
    (dragOver ? ' ring-2 ring-primary border-primary' : '');

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3">
      <div className="flex items-center gap-3">
        <label
          className={previewClasses + (uploading ? ' opacity-50' : ' cursor-pointer hover:border-foreground/30')}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void handleFile(f);
          }}
        >
          <input
            type="file"
            accept="image/svg+xml,image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon"
            disabled={uploading}
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          {value ? (
            <img src={withBasePath(value)} alt="" className="max-w-full max-h-full object-contain" />
          ) : (
            <span className="text-[10px] text-muted-foreground text-center px-1">click or drop</span>
          )}
        </label>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm font-medium truncate">{label}</div>
            {value && (
              <button
                type="button"
                onClick={clearAsset}
                className="text-xs text-muted-foreground hover:text-destructive shrink-0"
              >
                Remove
              </button>
            )}
          </div>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
          <div className="mt-1.5 flex items-center gap-2 text-xs">
            {uploading ? (
              <span className="text-muted-foreground">Uploading…</span>
            ) : value ? (
              <span className="text-muted-foreground truncate">
                {value.startsWith('/api/') ? 'Uploaded file' : value}
              </span>
            ) : (
              <span className="text-muted-foreground">SVG, PNG, JPEG, WebP or ICO · max 2 MB</span>
            )}
            <button
              type="button"
              onClick={() => setShowUrlField((v) => !v)}
              className="text-muted-foreground hover:text-foreground underline shrink-0"
            >
              {showUrlField ? 'Hide URL' : 'Use URL'}
            </button>
          </div>
        </div>
      </div>

      {showUrlField && (
        <div className="mt-3 ps-[4.75rem]">
          <Input
            value={value}
            onChange={onChange}
            placeholder="https://… or /branding/file.svg"
          />
        </div>
      )}

      {uploadError && (
        <p className="mt-2 ps-[4.75rem] text-xs text-destructive">{uploadError}</p>
      )}
    </div>
  );
}

// ─── Review / finish step ─────────────────────────────────────────────────

function ReviewStep({ config, onBack, onFinish }: { config: WizardConfig; onBack: () => void; onFinish: () => void }) {
  const [adminPassword, setAdminPassword] = useState('');
  const [adminConfirm, setAdminConfirm] = useState('');
  const [lockConfig, setLockConfig] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (adminPassword.length < 8) {
      setLocalError('Admin password must be at least 8 characters.');
      return;
    }
    if (adminPassword !== adminConfirm) {
      setLocalError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/setup/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminPassword, lockConfig }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLocalError(data.error ?? `Finish failed (HTTP ${res.status})`);
        return;
      }
      onFinish();
    } catch (e) {
      setLocalError(humanError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const passwordsMatch = adminConfirm.length > 0 && adminPassword === adminConfirm;
  const passwordTooShort = adminPassword.length > 0 && adminPassword.length < 8;
  const canSubmit =
    !submitting &&
    adminPassword.length >= 8 &&
    passwordsMatch;

  return (
    <form onSubmit={handle} className="space-y-5">
      <StepHeader title="Almost done" subtitle="Review your settings, choose an admin password, and apply." />

      {/* Summary card with grouped sections */}
      <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
        <SummaryGroup icon={<Server className="w-4 h-4" />} title="Server">
          <SummaryRow label="App name" value={config.appName} />
          <SummaryRow label="JMAP server" value={config.jmapServerUrl} mono />
          {config.jmapServers.length > 0 && (
            <SummaryRow
              label="Additional servers"
              value={`${config.jmapServers.length} configured${config.jmapServerAutoPickByDomain ? ' · auto-pick by domain' : ''}`}
            />
          )}
          <SummaryRow label="Stalwart features" value={config.stalwartFeaturesEnabled ? 'On' : 'Off'} />
        </SummaryGroup>

        <SummaryGroup icon={<ShieldCheck className="w-4 h-4" />} title="Authentication">
          <SummaryRow
            label="Method"
            value={
              config.oauthEnabled
                ? config.oauthOnly
                  ? 'OAuth only'
                  : 'Password + OAuth'
                : 'Password only'
            }
          />
          {config.oauthEnabled && config.oauthClientId && (
            <SummaryRow label="OAuth client ID" value={config.oauthClientId} mono />
          )}
        </SummaryGroup>

        <SummaryGroup icon={<KeyRound className="w-4 h-4" />} title="Security">
          <SummaryRow label="Session secret" value={config.sessionSecret ? 'Configured' : 'Not set'} />
          <SummaryRow label="Remember me" value={config.sessionSecret ? 'Available' : 'Disabled'} />
          <SummaryRow
            label="Settings sync"
            value={
              config.sessionSecret && config.settingsSyncEnabled
                ? 'On'
                : config.settingsSyncEnabled
                  ? 'Requires session secret'
                  : 'Off'
            }
          />
          <SummaryRow label="Anonymous telemetry" value={config.telemetryEnabled ? 'On' : 'Off'} />
        </SummaryGroup>

        <SummaryGroup icon={<FileText className="w-4 h-4" />} title="Logging">
          <SummaryRow label="Format" value={config.logFormat} />
          <SummaryRow label="Level" value={config.logLevel} />
        </SummaryGroup>

        <SummaryGroup icon={<Palette className="w-4 h-4" />} title="Branding">
          <SummaryRow
            label="Customizations"
            value={hasAnyBranding(config) ? 'Custom assets configured' : 'Using defaults'}
          />
          {config.loginCompanyName && (
            <SummaryRow label="Company name" value={config.loginCompanyName} />
          )}
        </SummaryGroup>
      </div>

      {/* Admin password card */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Lock className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Choose an admin password</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              You&apos;ll use this to sign in at <code className="font-mono">/admin</code>. Minimum 8 characters.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">New password</label>
            <Input value={adminPassword} onChange={setAdminPassword} type="password" required />
            {passwordTooShort && (
              <p className="text-xs text-warning mt-1">At least 8 characters.</p>
            )}
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Confirm</label>
            <Input value={adminConfirm} onChange={setAdminConfirm} type="password" required />
            {adminConfirm.length > 0 && !passwordsMatch && (
              <p className="text-xs text-destructive mt-1">Passwords don&apos;t match.</p>
            )}
            {passwordsMatch && adminPassword.length >= 8 && (
              <p className="text-xs text-success mt-1">Looks good.</p>
            )}
          </div>
        </div>
      </div>

      {/* Advanced */}
      <details className="rounded-lg border border-border bg-card/50 p-3 group">
        <summary className="text-sm font-medium cursor-pointer flex items-center justify-between list-none [&::-webkit-details-marker]:hidden">
          <span>Advanced</span>
          <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
          <span className="text-xs text-muted-foreground hidden group-open:inline">Hide</span>
        </summary>
        <div className="mt-3 pt-3 border-t border-border">
          <Toggle
            checked={lockConfig}
            onChange={setLockConfig}
            label="Lock configuration after setup"
            hint="Drops a marker file. After this finishes, remount the config volume read-only and the app will refuse further config writes. Audit logs and login state stay writable in the state volume."
          />
        </div>
      </details>

      {localError && (
        <div className="p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
            <AlertCircle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0 self-center">
            <p className="text-sm text-destructive leading-relaxed">{localError}</p>
          </div>
        </div>
      )}

      <Footer>
        <SecondaryButton onClick={onBack} disabled={submitting}>Back</SecondaryButton>
        <PrimaryButton type="submit" disabled={!canSubmit}>
          {submitting ? 'Applying…' : 'Apply & Finish'}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

function SummaryGroup({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="bg-card/50">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/40">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
      </div>
      <div className="px-3 py-2 space-y-1.5">{children}</div>
    </div>
  );
}

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-baseline gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={'text-foreground text-end truncate min-w-0 ' + (mono ? 'font-mono text-xs' : '')}>
        {value || <span className="text-muted-foreground italic">-</span>}
      </span>
    </div>
  );
}

// ─── Atoms ────────────────────────────────────────────────────────────────

function StepHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border-b border-border pb-3 mb-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}

function Input({
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={'flex items-start gap-3 cursor-pointer ' + (disabled ? 'opacity-50 cursor-not-allowed' : '')}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
    </label>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 pt-3 border-t border-border mt-4">{children}</div>;
}

function PrimaryButton({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mergePartial(prev: WizardConfig, partial: Record<string, unknown>): WizardConfig {
  const next: WizardConfig = { ...prev };
  for (const key of Object.keys(prev) as (keyof WizardConfig)[]) {
    const incoming = partial[key];
    if (incoming === undefined) continue;
    if (key === 'jmapServers') {
      // Server stores canonical shape; wizard form uses csv domains string.
      next.jmapServers = canonicalToRows(incoming);
      continue;
    }
    if (typeof incoming === typeof prev[key] || prev[key] === '' || prev[key] === false) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[key] = incoming;
    }
  }
  return next;
}

function canonicalToRows(value: unknown): JmapServerRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): JmapServerRow | null => {
      if (!item || typeof item !== 'object') return null;
      const e = item as Record<string, unknown>;
      const id = typeof e.id === 'string' ? e.id : '';
      const label = typeof e.label === 'string' ? e.label : '';
      const url = typeof e.url === 'string' ? e.url : '';
      const domains = Array.isArray(e.domains)
        ? (e.domains as unknown[])
            .filter((d): d is string => typeof d === 'string')
            .join(', ')
        : '';
      if (!id || !url) return null;
      return { id, label, url, domains };
    })
    .filter((r): r is JmapServerRow => r !== null);
}

function rowsToCanonical(rows: JmapServerRow[]) {
  return rows
    .map((r) => {
      const id = r.id.trim();
      const url = r.url.trim();
      if (!id || !url) return null;
      const domains = r.domains
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      return {
        id,
        label: r.label.trim() || id,
        url,
        ...(domains.length > 0 ? { domains } : {}),
      };
    })
    .filter((e): e is { id: string; label: string; url: string; domains?: string[] } => e !== null);
}

function hasAnyBranding(c: WizardConfig): boolean {
  return Boolean(
    c.loginCompanyName ||
      c.faviconUrl ||
      c.appLogoLightUrl ||
      c.appLogoDarkUrl ||
      c.loginLogoLightUrl ||
      c.loginLogoDarkUrl ||
      c.loginWebsiteUrl ||
      c.loginImprintUrl ||
      c.loginPrivacyPolicyUrl,
  );
}

function isInsecureHttpUrl(url: string): boolean {
  return /^http:\/\//i.test(url.trim());
}

/**
 * The JMAP URL is called directly from the user's browser. A URL that only
 * resolves on the operator's machine or LAN (localhost, RFC1918, .local mDNS)
 * works during setup but breaks for any real user. Surface a soft warning
 * so the operator catches this before going live.
 */
function isPrivateOrLocalHostUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  let host: string;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip IPv6 brackets, if any.
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // IPv4 literal: only flag the well-known private/loopback/link-local ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function detectInsecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol !== 'http:') return false;
  // Browsers treat localhost/loopback as "potentially trustworthy" and accept
  // Secure cookies even without TLS, so the wizard still works there. In dev
  // we still want to render the warning so we can preview it without spinning
  // up a non-loopback host.
  const host = window.location.hostname;
  const isLoopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLoopback && process.env.NODE_ENV !== 'development') {
    return false;
  }
  return true;
}

function humanError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return 'Unknown error';
}
