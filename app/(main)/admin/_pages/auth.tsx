'use client';

import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from '@/components/icons';
import { apiFetch } from '@/lib/browser-navigation';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { DEFAULT_OAUTH_SCOPES } from '@/lib/oauth/scopes';
import { SettingsSection, SettingItem, SectionNav } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { withEdit } from '@/lib/admin/edits';
import { useAdminFeedback } from '@/components/admin/feedback';
import { ConfigTextItem, ConfigToggleItem, ConfigSelectItem, inputClass } from '@/components/admin/config-items';
import { cn } from '@/lib/utils';

interface ConfigEntry {
  // Sensitive keys (sessionSecret, oauthClientSecret) come back with
  // `value` omitted and `hasValue` set instead - the server never echoes
  // the raw secret to the client.
  value?: unknown;
  source: 'admin' | 'env' | 'default';
  hasValue?: boolean;
}

const PAGE = adminPageDef('auth');

export function AuthPage() {
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const setMessage = useAdminFeedback();
  const [configReadOnly, setConfigReadOnly] = useState(false);

  // The setup runs as the mail account signed in to this webmail. Asked again
  // on focus, since the admin signs in from another tab and comes back.
  const [setupSignIn, setSetupSignIn] = useState<{ signedIn: boolean; username?: string } | null>(null);

  useEffect(() => {
    fetchConfig();
    apiFetch('/api/setup/status')
      .then(res => (res.ok ? res.json() : null))
      .then(data => setConfigReadOnly(data?.readOnly === true))
      .catch(() => {});
    const checkSignIn = () => {
      apiFetch('/api/admin/oauth/setup')
        .then(res => (res.ok ? res.json() : null))
        .then(data => { if (data) setSetupSignIn(data); })
        .catch(() => {});
    };
    checkSignIn();
    window.addEventListener('focus', checkSignIn);
    return () => window.removeEventListener('focus', checkSignIn);
  }, []);

  async function fetchConfig() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/config');
      if (!res.ok) throw new Error();
      setConfig(await res.json());
    } catch {
      setMessage({ type: 'error', text: 'Could not load the settings' });
    }
    setLoading(false);
  }

  function handleChange(key: string, value: unknown) {
    setEdits(prev => withEdit(prev, key, value, config[key]?.value));
    setMessage(null);
  }

  function currentValue(key: string): unknown {
    if (key in edits) return edits[key];
    return config[key]?.value;
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
      setMessage({ type: 'success', text: 'Authentication settings saved.' });
      setEdits({});
      await fetchConfig();
    } else {
      const data = await res.json();
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
      setEdits(prev => { const next = { ...prev }; delete next[key]; return next; });
      await fetchConfig();
    }
  }

  const [setupRunning, setSetupRunning] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupOrigin, setSetupOrigin] = useState('');
  const [setupIssuer, setSetupIssuer] = useState('');
  const [setupOauthOnly, setSetupOauthOnly] = useState(false);

  function openSetupDialog() {
    if (typeof window === 'undefined') return;
    const origin = window.location.origin;
    const jmapUrl = (currentValue('jmapServerUrl') as string | undefined)?.replace(/\/+$/, '') || '';
    setSetupOrigin(origin);
    setSetupIssuer(jmapUrl || origin);
    setSetupOauthOnly(currentValue('oauthOnly') === true);
    setSetupOpen(true);
  }

  async function handleAutoSetup() {
    setSetupRunning(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin/oauth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: setupOrigin.trim().replace(/\/+$/, ''),
          issuerUrl: setupIssuer.trim().replace(/\/+$/, ''),
          oauthOnly: setupOauthOnly,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const mobile = data.mobileClient === 'created' || data.mobileClient === 'updated'
          ? ` Bulwark Mobile client ${data.mobileClient} (${data.mobileClientId}, ${data.mobileRedirectUri}).`
          : data.mobileClient === 'failed'
            ? ` Stalwart refused the Bulwark Mobile client (${data.mobileClientId}); the app registers its own instead, without access to account settings.`
            : '';
        setMessage({
          type: 'success',
          text: `OAuth client ${data.action} on Stalwart (${data.issuerUrl}). ${data.redirectUriCount} redirect URI(s) registered for ${data.origin}.${mobile}`,
        });
        setEdits({});
        setSetupOpen(false);
        await fetchConfig();
      } else {
        const detail = data.detail ? ` (${typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail).slice(0, 200)})` : '';
        setMessage({ type: 'error', text: (data.error || 'Setup failed') + detail });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Setup failed' });
    } finally {
      setSetupRunning(false);
    }
  }

  const setupOriginValid = /^https?:\/\/[^/]+$/.test(setupOrigin.trim().replace(/\/+$/, ''));
  const setupIssuerValid = /^https?:\/\/[^/]+$/.test(setupIssuer.trim().replace(/\/+$/, ''));

  const hasEdits = Object.keys(edits).length > 0;

  useAdminUnsavedChanges('auth', hasEdits);

  if (loading) {
    return (
      <div>
        <AdminPageHeader title={PAGE.label} description={PAGE.description} />
        <AdminBodySkeleton status="Loading" />
      </div>
    );
  }

  return (
    <div>
      <AdminPageHeader title={PAGE.label} description={PAGE.description} />

      {/* The shared dialog: focus moved in and given back, Tab kept inside,
          Escape and an outside click close it unless setup is running. */}
      <Dialog
        isOpen={setupOpen}
        onClose={() => { if (!setupRunning) setSetupOpen(false); }}
        preventOutsideClose={setupRunning}
        showClose={!setupRunning}
        title="Auto-configure OAuth"
        description="Verify the URLs below before continuing. The webmail and Stalwart can live on different domains."
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={() => setSetupOpen(false)} disabled={setupRunning}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={handleAutoSetup}
              disabled={setupRunning || !setupOriginValid || !setupIssuerValid}
            >
              {setupRunning ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Sparkles className="w-4 h-4" aria-hidden="true" />}
              {setupRunning ? 'Configuring…' : 'Configure'}
            </Button>
          </>
        }
      >
        <div className="mt-4 space-y-4 [overflow-wrap:anywhere]">
          <div>
            <label htmlFor="setup-origin" className="block text-xs font-medium text-foreground mb-1">
              Webmail origin
            </label>
            <input
              id="setup-origin"
              type="url"
              value={setupOrigin}
              onChange={(e) => setSetupOrigin(e.target.value)}
              disabled={setupRunning}
              placeholder="https://webmail.example.com"
              className={cn(inputClass, 'w-full')}
            />
            <p className="text-[0.6875rem] text-muted-foreground mt-1">
              Used to register redirect URIs (one per locale: <code>{setupOrigin.trim().replace(/\/+$/, '') || 'https://…'}/&lt;locale&gt;/auth/callback</code>) on Stalwart.
            </p>
            {!setupOriginValid && setupOrigin.length > 0 && (
              <p className="text-[0.6875rem] text-destructive mt-1">Must be like https://host with no path.</p>
            )}
          </div>
          <div>
            <label htmlFor="setup-issuer" className="block text-xs font-medium text-foreground mb-1">
              Stalwart issuer URL
            </label>
            <input
              id="setup-issuer"
              type="url"
              value={setupIssuer}
              onChange={(e) => setSetupIssuer(e.target.value)}
              disabled={setupRunning}
              placeholder="https://mail.example.com"
              className={cn(inputClass, 'w-full')}
            />
            <p className="text-[0.6875rem] text-muted-foreground mt-1">
              Where Stalwart serves <code>/.well-known/oauth-authorization-server</code>. Saved as <code>OAUTH_ISSUER_URL</code>. Pre-filled from your JMAP server URL.
            </p>
            {!setupIssuerValid && setupIssuer.length > 0 && (
              <p className="text-[0.6875rem] text-destructive mt-1">Must be like https://host with no path.</p>
            )}
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-foreground select-none cursor-pointer">
            <input
              type="checkbox"
              checked={setupOauthOnly}
              onChange={(e) => setSetupOauthOnly(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-input"
              disabled={setupRunning}
            />
            Also enable “OAuth only” (hide password login)
          </label>
          <p className="text-[0.6875rem] text-muted-foreground">
            On Stalwart 1.0 this also registers a client for Bulwark Mobile: <code>bulwark-mobile</code>, no secret, redirect URI <code>org.bulwarkmail.mobile:/auth/callback</code>.
          </p>
        </div>
      </Dialog>

      <div className="space-y-10">
        <SectionNav />

        <SettingsSection id="oauth" title="OAuth / OpenID Connect" term="oauth">
          <SettingItem
            label="Set up with Stalwart"
            description="Registers an OAuth client on the connected Stalwart server, generates a client secret, and saves the settings here. Requires your Stalwart account to have admin permissions."
          >
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <Button type="button" size="sm" className="gap-2" onClick={openSetupDialog} disabled={setupRunning || configReadOnly || setupSignIn?.signedIn === false}>
                {setupRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {setupRunning ? 'Configuring…' : 'Set up with Stalwart'}
              </Button>
              {configReadOnly && (
                <p className="text-xs text-destructive">
                  Not available while the configuration is read-only (ADMIN_CONFIG_READONLY).
                </p>
              )}
              {!configReadOnly && setupSignIn?.signedIn === false && (
                <p className="max-w-xs text-xs text-muted-foreground sm:text-end">
                  Only works while you are signed in to{' '}
                  <a href="/" target="_blank" rel="noopener" className="text-primary hover:underline">this webmail</a>
                  {' '}with a Stalwart admin account in this browser. A login to the Stalwart web admin does not count.
                </p>
              )}
              {!configReadOnly && setupSignIn?.signedIn && setupSignIn.username && (
                <p className="text-xs text-muted-foreground">Runs as {setupSignIn.username}</p>
              )}
            </div>
          </SettingItem>
          <ConfigToggleItem label="Enabled" configKey="oauthEnabled" value={currentValue('oauthEnabled') as boolean} source={config.oauthEnabled?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="OAuth only" description="Hide password login form when enabled" configKey="oauthOnly" value={currentValue('oauthOnly') as boolean} source={config.oauthOnly?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Password fallback" description={'With OAuth only: show a "Sign in with a password" link under the SSO button and allow password sign-in. For SSO deployments whose accounts also have local passwords.'} configKey="oauthPasswordFallbackEnabled" value={currentValue('oauthPasswordFallbackEnabled') as boolean} source={config.oauthPasswordFallbackEnabled?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigTextItem label="Client ID" configKey="oauthClientId" value={currentValue('oauthClientId') as string} source={config.oauthClientId?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigTextItem label="Client secret" configKey="oauthClientSecret" value={currentValue('oauthClientSecret') as string} source={config.oauthClientSecret?.source} onChange={handleChange} onRevert={handleRevert} type="password" placeholder={config.oauthClientSecret?.hasValue ? '••••••••  (saved - type to replace)' : undefined} />
          <ConfigTextItem label="Issuer URL" configKey="oauthIssuerUrl" value={currentValue('oauthIssuerUrl') as string} source={config.oauthIssuerUrl?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://auth.example.com" wide />
          <ConfigToggleItem label="Allow private endpoints" description="Permit discovered endpoints on other hosts to resolve to RFC-1918 / loopback addresses. Endpoints on the issuer's own host are always allowed, so split-DNS setups rarely need this." configKey="oauthAllowPrivateEndpoints" value={currentValue('oauthAllowPrivateEndpoints') as boolean} source={config.oauthAllowPrivateEndpoints?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigTextItem label="Scopes" description={`Space-separated scopes that replace the defaults (${DEFAULT_OAUTH_SCOPES}). Leave blank to use them. offline_access is not requested by default; add it here or under Extra Scopes if your provider only issues refresh tokens for it, or sessions end when the access token expires.`} configKey="oauthScopes" value={currentValue('oauthScopes') as string} source={config.oauthScopes?.source} onChange={handleChange} onRevert={handleRevert} placeholder={DEFAULT_OAUTH_SCOPES} wide />
          <ConfigTextItem label="Extra scopes" description={`Additional space-separated scopes appended to the defaults (${DEFAULT_OAUTH_SCOPES}). Ignored when OAuth Scopes is set.`} configKey="oauthExtraScopes" value={currentValue('oauthExtraScopes') as string} source={config.oauthExtraScopes?.source} onChange={handleChange} onRevert={handleRevert} placeholder="urn:ietf:params:oauth:..." wide />
          <ConfigTextItem label="Resource" description="RFC 8707 resource indicator sent with the authorization request, for providers that issue access tokens per API (Pocket ID, for example). The token's audience is then this resource, usually the mail server's URL. Must be an absolute URI without a fragment. Not sent when signing in to a server entry with its own provider." configKey="oauthResource" value={currentValue('oauthResource') as string} source={config.oauthResource?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://mail.example.com" wide />
        </SettingsSection>

        <SettingsSection id="sso" title="Single sign-on">
          <ConfigToggleItem label="Auto SSO" description="Automatically redirect to SSO provider on load" configKey="autoSsoEnabled" value={currentValue('autoSsoEnabled') as boolean} source={config.autoSsoEnabled?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="End provider session on sign-out" description="Signing out of an SSO account also signs out of the identity provider, when it advertises an end_session_endpoint or a logout URL is set below. Turn off if the provider is shared with apps that should stay signed in." configKey="oauthEndSession" value={currentValue('oauthEndSession') as boolean} source={config.oauthEndSession?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Revoke tokens on sign-out" description="Signing out asks the identity provider to revoke Bulwark's refresh token. On Stalwart 1.0 this also removes Bulwark from the user's connected applications, so the next sign-in asks for consent again. Turn off to keep the consent; the token then stays valid at the provider until it expires." configKey="oauthRevokeOnSignOut" value={currentValue('oauthRevokeOnSignOut') as boolean} source={config.oauthRevokeOnSignOut?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigTextItem label="Provider logout URL" description="For providers whose discovery has no end_session_endpoint, such as Stalwart. Used instead of the discovered endpoint when set, with the same parameters. Must be https. Applies to the global OAuth settings; servers in the server list set their own." configKey="oauthEndSessionUrl" value={currentValue('oauthEndSessionUrl') as string} source={config.oauthEndSessionUrl?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://auth.example.com/logout" wide />
          <ConfigTextItem label="Post-logout redirect URI" description="Where the provider sends users after signing them out. Register it with the provider as a post-logout redirect URI first, or it will refuse the logout. Leave blank to stay on the provider's signed-out page." configKey="oauthPostLogoutRedirectUri" value={currentValue('oauthPostLogoutRedirectUri') as string} source={config.oauthPostLogoutRedirectUri?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://mail.example.com/en/login" wide />
        </SettingsSection>

        <SettingsSection id="admin-access" title="Admin access">
          <ConfigSelectItem
            label="Stalwart admin accounts"
            description="What a Stalwart admin account grants in this dashboard. “Automatic” signs Stalwart admins in without the admin password; “Password required” keeps the shield but asks for the admin password; “Off” ignores Stalwart admin status entirely. The last two need an admin password to be configured."
            configKey="stalwartAdminAccess"
            value={currentValue('stalwartAdminAccess') as string}
            source={config.stalwartAdminAccess?.source}
            options={[
              { value: 'auto', label: 'Automatic (no password)' },
              { value: 'password', label: 'Password required' },
              { value: 'off', label: 'Off (separate admins)' },
            ]}
            onChange={handleChange}
            onRevert={handleRevert}
          />
        </SettingsSection>

        <SettingsSection id="session" title="Session and security">
          <ConfigSelectItem label="Cookie SameSite" description="When the browser sends the sign-in cookies with requests from other sites. Lax suits most setups; None is needed when Bulwark is embedded in another site, and Strict blocks links into Bulwark from elsewhere." configKey="cookieSameSite" value={currentValue('cookieSameSite') as string} source={config.cookieSameSite?.source} options={['lax', 'strict', 'none']} onChange={handleChange} onRevert={handleRevert} />
          <ConfigTextItem label="Allowed frame ancestors" configKey="allowedFrameAncestors" value={currentValue('allowedFrameAncestors') as string} source={config.allowedFrameAncestors?.source} onChange={handleChange} onRevert={handleRevert} placeholder="'none' or https://..." wide />
          <ConfigTextItem label="Parent origin" description="For embedded mode communication" configKey="parentOrigin" value={currentValue('parentOrigin') as string} source={config.parentOrigin?.source} onChange={handleChange} onRevert={handleRevert} />
        </SettingsSection>
      </div>

      <AdminSaveBar
        dirty={hasEdits}
        saving={saving}
        onSave={handleSave}
        onDiscard={() => setEdits({})}
        note="Takes effect on the next page load"
      />
    </div>
  );
}
