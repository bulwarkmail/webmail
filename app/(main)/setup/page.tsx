'use client';

import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Check, CheckCircle2, AlertTriangle, AlertCircle, Server, ShieldCheck, KeyRound, FileText, Palette, Lock, ShieldAlert } from '@/components/icons';
import { apiFetch, getPathPrefix, withBasePath } from '@/lib/browser-navigation';
import { takeSetupTokenFromUrl } from '@/lib/setup/url-token';
import { SetupSkeleton } from '@/components/boot-skeleton/setup-skeleton';
import { SETUP_STEPS } from '@/lib/setup/steps';

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

// The wizard follows the browser's language, like the login page; the
// labels are setup.steps.<id>.
const STEPS = SETUP_STEPS;

type SetupT = ReturnType<typeof useTranslations<'setup'>>;

/** Literal values in the texts (a variable, a URL, a path) as inline code, for t.rich. */
const code = (chunks: ReactNode) => <code className="font-mono text-xs text-foreground">{chunks}</code>;

export default function SetupWizardPage() {
  const t = useTranslations('setup');
  // For the one-time status load: a language switch must not rerun it.
  const tRef = useRef(t);
  tRef.current = t;
  const router = useRouter();
  const [tokenFromUrl, setTokenFromUrl] = useState('');

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
    setTokenFromUrl(takeSetupTokenFromUrl(window.location, window.history));
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
        if (!cancelled) setError(humanError(e, tRef.current));
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
      throw new Error(data.error ?? t('errors.token_rejected', { status: res.status }));
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
      throw new Error(data.error ?? t('errors.step_failed', { status: res.status }));
    }
  }

  // ─── Render shell ───────────────────────────────────────────────────────
  if (insecureContext && !insecureAcknowledged) {
    return <InsecureContextScreen onContinue={() => setInsecureAcknowledged(true)} />;
  }

  // The server HTML, and every visit until the status answers: the wizard's
  // frame with the welcome step, where a fresh install starts.
  if (bootstrapping) {
    return (
      <SetupSkeleton
        label={t('loading')}
        strings={{
          title: t('title'),
          subtitle: t('subtitle'),
          steps: STEPS.map((step) => t(`steps.${step.id}`)),
          welcomeTitle: t('welcome.title'),
          welcomeBody: t('welcome.body'),
          tokenLabel: t('welcome.token_label'),
          tokenPlaceholder: t('welcome.token_placeholder'),
          continueLabel: t('welcome.continue'),
        }}
      />
    );
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
        <h1 className="text-lg font-semibold">{t('read_only.title')}</h1>
        <p className="text-sm text-muted-foreground mt-2">
          {t.rich('read_only.body', { variable: 'ADMIN_CONFIG_READONLY', code })}
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
              tokenFromUrl={tokenFromUrl}
              onSubmit={async (token) => {
                try {
                  await submitToken(token);
                } catch (e) {
                  setError(humanError(e, t));
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
                  const msg = humanError(e, t);
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
  const t = useTranslations('setup');
  return (
    <div className="text-center mb-6">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground mt-1">
        {t('subtitle')}
      </p>
    </div>
  );
}

function ProgressBar({ stepIndex }: { stepIndex: number }) {
  const t = useTranslations('setup');
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
              {t(`steps.${step.id}`)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompletedScreen() {
  const t = useTranslations('setup');
  return (
    <CenteredCard>
      <div className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Check className="h-6 w-6 text-primary" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold">{t('done.title')}</h1>
        <p className="text-sm text-muted-foreground mt-2">
          {t('done.body', { appName: 'Bulwark Webmail' })}
        </p>
      </div>
      <div className="mt-6 space-y-2">
        <a
          href={`${getPathPrefix()}/admin/login`}
          className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
        >
          {t('done.admin_sign_in')}
        </a>
        <a
          href={`${getPathPrefix()}/`}
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          {t('done.webmail_login')}
        </a>
      </div>
      <p className="text-xs text-muted-foreground text-center mt-4">
        {t('done.redirecting')}
      </p>
    </CenteredCard>
  );
}

function InsecureContextScreen({ onContinue }: { onContinue: () => void }) {
  const t = useTranslations('setup');
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
        <h1 className="text-xl font-semibold">{t('insecure.title')}</h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {t('insecure.body')}
        </p>
      </div>
      <div className="mt-6 space-y-2">
        {httpsUrl && (
          <a
            href={httpsUrl}
            className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
          >
            {t('insecure.try_https')}
          </a>
        )}
        <button
          type="button"
          onClick={onContinue}
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          {t('insecure.continue_http')}
        </button>
      </div>
    </CenteredCard>
  );
}

function AlreadyConfiguredScreen() {
  const t = useTranslations('setup');
  return (
    <CenteredCard>
      <div className="text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
          <Check className="h-6 w-6 text-primary" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold">{t('already.title')}</h1>
        <p className="text-sm text-muted-foreground mt-2">
          {t('already.body', { appName: 'Bulwark Webmail' })}
        </p>
      </div>
      <div className="mt-6 space-y-2">
        <a
          href={`${getPathPrefix()}/admin/login`}
          className="block w-full rounded-md bg-primary text-primary-foreground text-center px-4 py-2.5 text-sm font-medium hover:bg-primary/90"
        >
          {t('done.admin_sign_in')}
        </a>
        <a
          href={`${getPathPrefix()}/`}
          className="block w-full rounded-md border border-border text-center px-4 py-2.5 text-sm font-medium hover:bg-muted"
        >
          {t('done.webmail_login')}
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
  const t = useTranslations('setup');
  return (
    <div className="mb-4 p-3 rounded-xl border border-destructive/20 bg-destructive/5 flex items-start gap-3">
      <div className="w-10 h-10 rounded-full bg-destructive/15 text-destructive flex items-center justify-center flex-shrink-0 shadow-sm">
        <AlertCircle className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0 self-center">
        <p className="text-sm text-destructive leading-relaxed">{friendlyError(error, t)}</p>
      </div>
      <button
        onClick={onDismiss}
        className="self-center text-xs text-muted-foreground hover:text-foreground underline shrink-0"
        type="button"
      >
        {t('dismiss')}
      </button>
    </div>
  );
}

/**
 * Translate raw API error strings into user-facing copy. Matches the friendly
 * tone of the JMAP probe cards.
 */
function friendlyError(raw: string, t: SetupT): string {
  const lower = raw.toLowerCase();
  if (lower.includes('invalid or expired token')) return t('errors.token_expired');
  if (lower.includes('wizard session required')) return t('errors.session_expired');
  if (lower.includes('token required')) return t('errors.token_required');
  if (lower.includes('setup is not active')) return t('errors.already_finished');
  return raw;
}

// ─── Welcome / token step ────────────────────────────────────────────────

function WelcomeStep({ tokenFromUrl, onSubmit }: { tokenFromUrl: string; onSubmit: (t: string) => Promise<void> }) {
  const t = useTranslations('setup');
  const [token, setToken] = useState(tokenFromUrl);
  const [submitting, setSubmitting] = useState(false);

  // Auto-submit if token came in via URL.
  useEffect(() => {
    if (tokenFromUrl && !submitting) {
      setToken(tokenFromUrl);
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
      <h2 className="text-lg font-semibold">{t('welcome.title')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('welcome.body')}
      </p>
      <Field label={t('welcome.token_label')}>
        <Input value={token} onChange={(v) => setToken(v)} autoFocus required placeholder={t('welcome.token_placeholder')} />
      </Field>
      <PrimaryButton type="submit" disabled={submitting || !token.trim()}>
        {submitting ? t('welcome.verifying') : t('welcome.continue')}
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
  const t = useTranslations('setup');
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
      return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  }
}

// ─── Server step ─────────────────────────────────────────────────────────

type ProbeStatus = 'jmap_detected' | 'reachable_no_jmap' | 'unreachable' | 'invalid_url';

function ServerStep({ config, setConfig, onNext }: Pick<StepProps, 'config' | 'setConfig' | 'onNext'>) {
  const t = useTranslations('setup');
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
        entry = { status: 'jmap_detected', message: t('server.probe_ok'), url: config.jmapServerUrl };
      } else if (data.status === 'reachable_no_jmap') {
        entry = { status: 'reachable_no_jmap', message: t('server.probe_not_jmap'), url: config.jmapServerUrl };
      } else if (data.status === 'invalid_url') {
        entry = { status: 'invalid_url', message: data.message ?? t('server.probe_invalid'), url: config.jmapServerUrl };
      } else {
        entry = { status: 'unreachable', message: data.message ?? t('server.probe_unreachable'), url: config.jmapServerUrl };
      }
      setProbe(entry);
      return entry;
    } catch (e) {
      const entry = { status: 'unreachable' as ProbeStatus, message: humanError(e, t), url: config.jmapServerUrl };
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
      rowErrors.push(t('server.row_id_required', { index: i + 1 }));
    } else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
      rowErrors.push(t('server.row_id_invalid', { index: i + 1 }));
    } else if (seenIds.has(id)) {
      rowErrors.push(t('server.row_id_duplicate', { index: i + 1, id }));
    } else {
      seenIds.add(id);
    }
    const url = r.url.trim();
    if (!url) {
      rowErrors.push(t('server.row_url_required', { index: i + 1 }));
    } else if (!/^https?:\/\//i.test(url)) {
      rowErrors.push(t('server.row_url_scheme', { index: i + 1 }));
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
      <StepHeader title={t('server.title')} subtitle={t('server.subtitle')} />
      <Field label={t('server.app_name')}>
        <Input value={config.appName} onChange={(v) => setConfig({ ...config, appName: v })} required />
      </Field>
      <Field label={t('server.url_label')} hint={t('server.url_hint')}>
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
            {probing ? t('server.testing') : t('server.test')}
          </button>
        </div>
        {isInsecureHttpUrl(config.jmapServerUrl) && (
          <div className="mt-2 p-3 rounded-xl border border-warning/20 bg-warning/5 flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-warning/15 text-warning flex items-center justify-center flex-shrink-0 shadow-sm">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0 self-center">
              <p className="text-sm font-medium text-foreground leading-relaxed">
                {t('server.http_title')}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
                {t.rich('server.http_body', { https: 'https://', code })}
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
                {t('server.local_title')}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5 leading-relaxed">
                {t.rich('server.local_body', { example: 'https://mail.example.com', code })}
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
                    {t('server.not_jmap_hint')}
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
                <span className="text-sm text-foreground">{t('server.not_jmap_confirm')}</span>
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
            <div className="text-sm font-medium">{t('server.additional_title')}</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('server.additional_hint')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdditional((v) => !v)}
            className="text-xs underline text-muted-foreground hover:text-foreground shrink-0"
          >
            {showAdditional ? t('hide') : config.jmapServers.length > 0 ? t('server.additional_show', { count: config.jmapServers.length }) : t('server.add')}
          </button>
        </div>

        {showAdditional && (
          <div className="mt-3 space-y-3">
            {config.jmapServers.map((row, i) => (
              <div key={i} className="rounded-md border border-border bg-background p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">{t('server.row_title', { index: i + 1 })}</span>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="text-xs text-destructive hover:underline"
                  >
                    {t('remove')}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('server.id_label')} hint={t('server.id_hint')}>
                    <Input value={row.id} onChange={(v) => updateRow(i, { id: v })} placeholder="eu-1" required />
                  </Field>
                  <Field label={t('server.label_label')} hint={t('server.label_hint')}>
                    <Input value={row.label} onChange={(v) => updateRow(i, { label: v })} placeholder="Europe (primary)" />
                  </Field>
                </div>
                <Field label={t('server.row_url')}>
                  <Input value={row.url} onChange={(v) => updateRow(i, { url: v })} placeholder="https://" type="url" required />
                </Field>
                <Field label={t('server.domains_label')} hint={t('server.domains_hint')}>
                  <Input value={row.domains} onChange={(v) => updateRow(i, { domains: v })} placeholder="example.com, mail.example.com" />
                </Field>
              </div>
            ))}

            <button
              type="button"
              onClick={addRow}
              className="w-full px-3 py-2 text-sm border border-dashed border-border rounded-md hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              + {t('server.add_server')}
            </button>

            {config.jmapServers.length > 0 && (
              <Toggle
                checked={config.jmapServerAutoPickByDomain}
                onChange={(v) => setConfig({ ...config, jmapServerAutoPickByDomain: v })}
                label={t('server.auto_pick')}
                hint={t('server.auto_pick_hint')}
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
        label={t('server.stalwart')}
        hint={t('server.stalwart_hint')}
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
          {submitting ? t('saving') : probing ? t('server.testing') : t('next')}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Auth step ───────────────────────────────────────────────────────────

function AuthStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const t = useTranslations('setup');
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
      <StepHeader title={t('auth.title')} subtitle={t('auth.subtitle')} />
      <Toggle
        checked={config.oauthEnabled}
        onChange={(v) => setConfig({ ...config, oauthEnabled: v })}
        label={t('auth.oauth')}
      />
      {config.oauthEnabled && (
        <>
          <Toggle
            checked={config.oauthOnly}
            onChange={(v) => setConfig({ ...config, oauthOnly: v })}
            label={t('auth.oauth_only')}
          />
          <Field label={t('auth.client_id')}>
            <Input value={config.oauthClientId} onChange={(v) => setConfig({ ...config, oauthClientId: v })} required />
          </Field>
          <Field label={t('auth.client_secret')} hint={t('auth.client_secret_hint')}>
            <Input
              value={config.oauthClientSecret}
              onChange={(v) => setConfig({ ...config, oauthClientSecret: v })}
              type="password"
              placeholder={t('auth.client_secret_placeholder')}
            />
          </Field>
          <Field label={t('auth.issuer')} hint={t('auth.issuer_hint')}>
            <Input value={config.oauthIssuerUrl} onChange={(v) => setConfig({ ...config, oauthIssuerUrl: v })} type="url" />
          </Field>
        </>
      )}
      <Footer>
        <SecondaryButton onClick={onBack}>{t('back')}</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? t('saving') : t('next')}
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
  const t = useTranslations('setup');
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
        title={t('security.title')}
        subtitle={t('security.subtitle')}
      />

      <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{t('security.generated')}</span>
          <button
            type="button"
            onClick={() => setCustomize((v) => !v)}
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            {customize ? t('hide') : t('security.customize')}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t('security.generated_hint')}
        </p>
      </div>

      {customize && (
        <Field label={t('security.secret_label')} hint={t('security.secret_hint')}>
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
              {reveal ? t('hide') : t('show')}
            </button>
            <button
              type="button"
              onClick={() => setConfig({ ...config, sessionSecret: generateSessionSecret() })}
              className="px-3 py-2 text-sm border border-border rounded-md hover:bg-muted"
            >
              {t('security.regenerate')}
            </button>
          </div>
        </Field>
      )}

      <Toggle
        checked={config.settingsSyncEnabled}
        onChange={(v) => setConfig({ ...config, settingsSyncEnabled: v })}
        label={t('security.sync')}
        hint={t('security.sync_hint')}
        disabled={!config.sessionSecret}
      />

      <div className="rounded-md border border-border bg-muted/20 p-3">
        <Toggle
          checked={config.telemetryEnabled}
          onChange={(v) => setConfig({ ...config, telemetryEnabled: v })}
          label={t('security.telemetry')}
          hint={t('security.telemetry_hint')}
        />
      </div>
      <Footer>
        <SecondaryButton onClick={onBack}>{t('back')}</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? t('saving') : t('next')}
        </PrimaryButton>
      </Footer>
    </form>
  );
}

// ─── Logging step ────────────────────────────────────────────────────────

function LoggingStep({ config, setConfig, onNext, onBack }: Pick<StepProps, 'config' | 'setConfig' | 'onNext' | 'onBack'>) {
  const t = useTranslations('setup');
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
      <StepHeader title={t('logging.title')} subtitle={t('logging.subtitle')} />
      <Field label={t('logging.format')}>
        <Select
          value={config.logFormat}
          onChange={(v) => setConfig({ ...config, logFormat: v as 'text' | 'json' })}
          options={[
            { value: 'text', label: t('logging.format_text') },
            { value: 'json', label: t('logging.format_json') },
          ]}
        />
      </Field>
      <Field label={t('logging.level')}>
        <Select
          value={config.logLevel}
          onChange={(v) => setConfig({ ...config, logLevel: v as WizardConfig['logLevel'] })}
          options={[
            { value: 'error', label: 'error' },
            { value: 'warn', label: 'warn' },
            { value: 'info', label: t('logging.level_info') },
            { value: 'debug', label: 'debug' },
          ]}
        />
      </Field>
      <Footer>
        <SecondaryButton onClick={onBack}>{t('back')}</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? t('saving') : t('next')}
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
  const t = useTranslations('setup');
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
        title={t('branding.title')}
        subtitle={t('branding.subtitle')}
      />
      <Field label={t('branding.company')}>
        <Input value={config.loginCompanyName} onChange={(v) => setConfig({ ...config, loginCompanyName: v })} />
      </Field>

      <div className="space-y-2">
        <BrandingAsset
          label={t('branding.favicon')}
          hint={t('branding.favicon_hint')}
          slot="faviconUrl"
          value={config.faviconUrl}
          onChange={(v) => setConfig({ ...config, faviconUrl: v })}
        />
        <BrandingAsset
          label={t('branding.login_light')}
          hint={t('branding.login_light_hint')}
          slot="loginLogoLightUrl"
          value={config.loginLogoLightUrl}
          onChange={(v) => setConfig({ ...config, loginLogoLightUrl: v })}
        />
        <BrandingAsset
          label={t('branding.login_dark')}
          hint={t('branding.login_dark_hint')}
          slot="loginLogoDarkUrl"
          value={config.loginLogoDarkUrl}
          onChange={(v) => setConfig({ ...config, loginLogoDarkUrl: v })}
          previewBg="dark"
        />
        <BrandingAsset
          label={t('branding.sidebar_light')}
          hint={t('branding.sidebar_light_hint')}
          slot="appLogoLightUrl"
          value={config.appLogoLightUrl}
          onChange={(v) => setConfig({ ...config, appLogoLightUrl: v })}
        />
        <BrandingAsset
          label={t('branding.sidebar_dark')}
          hint={t('branding.sidebar_dark_hint')}
          slot="appLogoDarkUrl"
          value={config.appLogoDarkUrl}
          onChange={(v) => setConfig({ ...config, appLogoDarkUrl: v })}
          previewBg="dark"
        />
      </div>

      <Field label={t('branding.website')}>
        <Input value={config.loginWebsiteUrl} onChange={(v) => setConfig({ ...config, loginWebsiteUrl: v })} type="url" />
      </Field>
      <Field label={t('branding.imprint')}>
        <Input value={config.loginImprintUrl} onChange={(v) => setConfig({ ...config, loginImprintUrl: v })} type="url" />
      </Field>
      <Field label={t('branding.privacy')}>
        <Input value={config.loginPrivacyPolicyUrl} onChange={(v) => setConfig({ ...config, loginPrivacyPolicyUrl: v })} type="url" />
      </Field>
      <Footer>
        <SecondaryButton onClick={onBack}>{t('back')}</SecondaryButton>
        <PrimaryButton type="submit" disabled={submitting}>
          {submitting ? t('saving') : t('next')}
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
  const t = useTranslations('setup');
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
        setUploadError(data?.error ?? t('errors.upload_failed', { status: res.status }));
        return;
      }
      onChange(data.url);
    } catch (e) {
      setUploadError(humanError(e, t));
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
            aria-label={label}
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
            <span className="text-[0.625rem] text-muted-foreground text-center px-1">{t('branding.drop')}</span>
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
                {t('remove')}
              </button>
            )}
          </div>
          {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
          <div className="mt-1.5 flex items-center gap-2 text-xs">
            {uploading ? (
              <span className="text-muted-foreground">{t('branding.uploading')}</span>
            ) : value ? (
              <span className="text-muted-foreground truncate">
                {value.startsWith('/api/') ? t('branding.uploaded') : value}
              </span>
            ) : (
              <span className="text-muted-foreground">{t('branding.formats')}</span>
            )}
            <button
              type="button"
              onClick={() => setShowUrlField((v) => !v)}
              className="text-muted-foreground hover:text-foreground underline shrink-0"
            >
              {showUrlField ? t('branding.hide_url') : t('branding.use_url')}
            </button>
          </div>
        </div>
      </div>

      {showUrlField && (
        <div className="mt-3 ps-[4.75rem]">
          <Input
            value={value}
            onChange={onChange}
            placeholder={t('branding.url_placeholder')}
            aria-label={label}
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
  const t = useTranslations('setup');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminConfirm, setAdminConfirm] = useState('');
  const passwordFieldId = useId();
  const [lockConfig, setLockConfig] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (adminPassword.length < 8) {
      setLocalError(t('review.too_short'));
      return;
    }
    if (adminPassword !== adminConfirm) {
      setLocalError(t('review.mismatch'));
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
        setLocalError(data.error ?? t('errors.finish_failed', { status: res.status }));
        return;
      }
      onFinish();
    } catch (e) {
      setLocalError(humanError(e, t));
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
      <StepHeader title={t('review.title')} subtitle={t('review.subtitle')} />

      {/* Summary card with grouped sections */}
      <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
        <SummaryGroup icon={<Server className="w-4 h-4" />} title={t('review.server')}>
          <SummaryRow label={t('review.app_name')} value={config.appName} />
          <SummaryRow label={t('review.jmap_server')} value={config.jmapServerUrl} mono />
          {config.jmapServers.length > 0 && (
            <SummaryRow
              label={t('review.additional')}
              value={t(config.jmapServerAutoPickByDomain ? 'review.additional_auto_pick' : 'review.additional_count', { count: config.jmapServers.length })}
            />
          )}
          <SummaryRow label={t('review.stalwart')} value={config.stalwartFeaturesEnabled ? t('on') : t('off')} />
        </SummaryGroup>

        <SummaryGroup icon={<ShieldCheck className="w-4 h-4" />} title={t('review.auth')}>
          <SummaryRow
            label={t('review.method')}
            value={
              config.oauthEnabled
                ? config.oauthOnly
                  ? t('review.oauth_only')
                  : t('review.password_oauth')
                : t('review.password_only')
            }
          />
          {config.oauthEnabled && config.oauthClientId && (
            <SummaryRow label={t('review.client_id')} value={config.oauthClientId} mono />
          )}
        </SummaryGroup>

        <SummaryGroup icon={<KeyRound className="w-4 h-4" />} title={t('review.security')}>
          <SummaryRow label={t('review.secret')} value={config.sessionSecret ? t('review.configured') : t('review.not_set')} />
          <SummaryRow label={t('review.remember_me')} value={config.sessionSecret ? t('review.available') : t('review.disabled')} />
          <SummaryRow
            label={t('review.sync')}
            value={
              config.sessionSecret && config.settingsSyncEnabled
                ? t('on')
                : config.settingsSyncEnabled
                  ? t('review.needs_secret')
                  : t('off')
            }
          />
          <SummaryRow label={t('review.telemetry')} value={config.telemetryEnabled ? t('on') : t('off')} />
        </SummaryGroup>

        <SummaryGroup icon={<FileText className="w-4 h-4" />} title={t('review.logging')}>
          <SummaryRow label={t('review.format')} value={config.logFormat} />
          <SummaryRow label={t('review.level')} value={config.logLevel} />
        </SummaryGroup>

        <SummaryGroup icon={<Palette className="w-4 h-4" />} title={t('review.branding')}>
          <SummaryRow
            label={t('review.customizations')}
            value={hasAnyBranding(config) ? t('review.custom_assets') : t('review.defaults')}
          />
          {config.loginCompanyName && (
            <SummaryRow label={t('review.company')} value={config.loginCompanyName} />
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
            <div className="text-sm font-medium">{t('review.password_title')}</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t.rich('review.password_hint', { path: '/admin', code })}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${passwordFieldId}-new`} className="block text-xs text-muted-foreground mb-1">{t('review.new_password')}</label>
            <Input id={`${passwordFieldId}-new`} value={adminPassword} onChange={setAdminPassword} type="password" required />
            {passwordTooShort && (
              <p className="text-xs text-warning mt-1">{t('review.too_short')}</p>
            )}
          </div>
          <div>
            <label htmlFor={`${passwordFieldId}-confirm`} className="block text-xs text-muted-foreground mb-1">{t('review.confirm')}</label>
            <Input id={`${passwordFieldId}-confirm`} value={adminConfirm} onChange={setAdminConfirm} type="password" required />
            {adminConfirm.length > 0 && !passwordsMatch && (
              <p className="text-xs text-destructive mt-1">{t('review.mismatch')}</p>
            )}
            {passwordsMatch && adminPassword.length >= 8 && (
              <p className="text-xs text-success mt-1">{t('review.looks_good')}</p>
            )}
          </div>
        </div>
      </div>

      {/* Advanced */}
      <details className="rounded-lg border border-border bg-card/50 p-3 group">
        <summary className="text-sm font-medium cursor-pointer flex items-center justify-between list-none [&::-webkit-details-marker]:hidden">
          <span>{t('review.advanced')}</span>
          <span className="text-xs text-muted-foreground group-open:hidden">{t('show')}</span>
          <span className="text-xs text-muted-foreground hidden group-open:inline">{t('hide')}</span>
        </summary>
        <div className="mt-3 pt-3 border-t border-border">
          <Toggle
            checked={lockConfig}
            onChange={setLockConfig}
            label={t('review.lock')}
            hint={t('review.lock_hint')}
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
        <SecondaryButton onClick={onBack} disabled={submitting}>{t('back')}</SecondaryButton>
        <PrimaryButton type="submit" disabled={!canSubmit}>
          {submitting ? t('review.applying') : t('review.finish')}
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
        <span className="text-xs font-semibold text-muted-foreground">{title}</span>
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

// The Field's label points at the Input or Select inside it, and its hint
// is read with that control.
const FieldContext = createContext<{ id: string; hintId?: string } | null>(null);

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1">{label}</label>
      <FieldContext.Provider value={{ id, hintId }}>{children}</FieldContext.Provider>
      {hint && <p id={hintId} className="text-xs text-muted-foreground mt-1">{hint}</p>}
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
  id,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  id?: string;
  'aria-label'?: string;
}) {
  const field = useContext(FieldContext);
  return (
    <input
      id={id ?? field?.id}
      aria-label={ariaLabel}
      aria-describedby={field?.hintId}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      required={required}
      autoFocus={autoFocus}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-hidden"
    />
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const field = useContext(FieldContext);
  return (
    <select
      id={field?.id}
      aria-describedby={field?.hintId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-hidden"
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

function humanError(e: unknown, t: SetupT): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return t('unknown_error');
}
