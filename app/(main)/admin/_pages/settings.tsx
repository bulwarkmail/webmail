'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/browser-navigation';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { SettingsSection, SectionNav } from '@/components/settings/settings-section';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { withEdit } from '@/lib/admin/edits';
import { useAdminFeedback } from '@/components/admin/feedback';
import { ConfigTextItem, ConfigToggleItem, ConfigSelectItem, ConfigNote } from '@/components/admin/config-items';
import { JmapServersSection } from './_jmap-servers-section';
import { Term } from '@/components/ui/term';
import type { JmapServerEntry } from '@/lib/admin/jmap-servers';

interface ConfigEntry {
  value?: unknown;
  source: 'admin' | 'env' | 'default';
  hasValue?: boolean;
}

const PAGE = adminPageDef('settings');

export function SettingsPage() {
  const [config, setConfig] = useState<Record<string, ConfigEntry>>({});
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const setMessage = useAdminFeedback();

  useEffect(() => {
    fetchConfig();
  }, []);

  // Only the first load shows the skeleton: swapping the page out after a
  // save would throw away the scroll position.
  async function fetchConfig() {
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
      setMessage({ type: 'success', text: 'Settings saved. Changes take effect on next page load.' });
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
      setEdits(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      await fetchConfig();
      setMessage({ type: 'success', text: `${key} reverted to default` });
    }
  }

  const hasEdits = Object.keys(edits).length > 0;

  useAdminUnsavedChanges('settings', hasEdits);

  if (loading) {
    return (
      <div>
        <AdminPageHeader title={PAGE.label} description={PAGE.description} />
        <AdminBodySkeleton status="Loading" />
      </div>
    );
  }

  const jmapServers = currentValue('jmapServers');

  return (
    <div>
      <AdminPageHeader title={PAGE.label} description={PAGE.description} />


      <div className="space-y-10">
        <SectionNav />

        <SettingsSection id="general" title="General">
          <ConfigTextItem label="Application name" configKey="appName" value={currentValue('appName') as string} source={config.appName?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigTextItem label="JMAP server URL" term="jmap" configKey="jmapServerUrl" value={currentValue('jmapServerUrl') as string} source={config.jmapServerUrl?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://mail.example.com" wide />
          <ConfigToggleItem label="Allow custom JMAP endpoint" description="Show a JMAP server URL field on the login form, allowing users to connect to any JMAP server" configKey="allowCustomJmapEndpoint" value={currentValue('allowCustomJmapEndpoint') as boolean} source={config.allowCustomJmapEndpoint?.source} onChange={handleChange} onRevert={handleRevert} />
          {!!currentValue('allowCustomJmapEndpoint') && (
            <ConfigNote tone="warning">
              <strong><Term id="cors">CORS</Term> warning:</strong> External JMAP servers must include this domain in their CORS <code className="text-[0.6875rem] bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 rounded">Access-Control-Allow-Origin</code> header, or requests from the browser will be blocked.
            </ConfigNote>
          )}
          <ConfigToggleItem label="Stalwart features" description="Enable Stalwart Mail Server-specific features" configKey="stalwartFeaturesEnabled" value={currentValue('stalwartFeaturesEnabled') as boolean} source={config.stalwartFeaturesEnabled?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Demo mode" description="Enable demo mode with sample data" configKey="demoMode" value={currentValue('demoMode') as boolean} source={config.demoMode?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Search engine indexing" description="Allow search engines to index this webmail. Off (the default) sends noindex/nofollow in the page head, recommended for private deployments." configKey="searchEngineIndexing" value={currentValue('searchEngineIndexing') as boolean} source={config.searchEngineIndexing?.source} onChange={handleChange} onRevert={handleRevert} />
        </SettingsSection>

        <SettingsSection id="login" title="Login page">
          <ConfigToggleItem label="Desktop app: sign in with the browser" description="Lets the desktop app sign in through this login page in the user's browser, so their password manager works there. Turn off on a terminal server or any computer several people use at once: another user there can send a link that asks for someone's sign-in. The app's own form keeps working." configKey="desktopBrowserSignIn" value={currentValue('desktopBrowserSignIn') as boolean} source={config.desktopBrowserSignIn?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Show version" description="Show the webmail version in the login page footer. Turn off to keep the exact version hidden from visitors who are not signed in." configKey="loginShowVersion" value={currentValue('loginShowVersion') as boolean} source={config.loginShowVersion?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Show 2FA code option" term="two_factor" description="Show the &quot;I have a 2FA code&quot; toggle on the login form. Turn off when two-factor authentication is handled by an external identity provider. Accounts that require a code still get the field." configKey="loginShowTotp" value={currentValue('loginShowTotp') as boolean} source={config.loginShowTotp?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Show access token sign-in" term="access_token" description="Offer signing in with an access token instead of a password. For JMAP servers that authenticate API tokens as Bearer tokens, such as Fastmail, which accepts no passwords over JMAP." configKey="loginShowTokenLogin" value={currentValue('loginShowTokenLogin') as boolean} source={config.loginShowTokenLogin?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Show remember me" description="Let people choose whether to stay signed in. Off (the default) remembers every sign-in. Either way this needs SESSION_SECRET to be set." configKey="loginShowRememberMe" value={currentValue('loginShowRememberMe') as boolean} source={config.loginShowRememberMe?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Keep unticked sign-ins until the browser closes" description="With the remember me box shown, a sign-in made with it unticked survives reloads and new tabs and ends when the browser closes. Off (the default) ends it at the next reload. Needs SESSION_SECRET." configKey="browserSessionSignIn" value={currentValue('browserSessionSignIn') as boolean} source={config.browserSessionSignIn?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Show heading" description="Show the application name below the login logo" configKey="loginShowHeading" value={currentValue('loginShowHeading') as boolean} source={config.loginShowHeading?.source} onChange={handleChange} onRevert={handleRevert} />
          <ConfigToggleItem label="Show subtitle" description="Show the subtitle below the login heading" configKey="loginShowSubtitle" value={currentValue('loginShowSubtitle') as boolean} source={config.loginShowSubtitle?.source} onChange={handleChange} onRevert={handleRevert} />
        </SettingsSection>

        <SettingsSection id="servers" title="JMAP servers">
          <ConfigToggleItem
            label="Auto-pick server by email domain"
            description="When users type their email, automatically select the matching server from the list below."
            configKey="jmapServerAutoPickByDomain"
            value={currentValue('jmapServerAutoPickByDomain') as boolean}
            source={config.jmapServerAutoPickByDomain?.source}
            onChange={handleChange}
            onRevert={handleRevert}
          />
          <JmapServersSection
            value={(jmapServers as JmapServerEntry[]) ?? []}
            source={config.jmapServers?.source}
            onChange={(next) => handleChange('jmapServers', next)}
            onRevert={() => handleRevert('jmapServers')}
          />
          {Array.isArray(jmapServers) && (jmapServers as JmapServerEntry[]).length > 0 && (
            <ConfigNote tone="warning">
              <strong>CORS warning:</strong> Each JMAP server must allow this webmail&apos;s origin in its <code className="text-[0.6875rem] bg-amber-100 dark:bg-amber-900/50 px-1 py-0.5 rounded">Access-Control-Allow-Origin</code> header, or browser requests will be blocked.
            </ConfigNote>
          )}
        </SettingsSection>

        <SettingsSection id="wopi" title="Document editing">
          <ConfigTextItem label="WOPI client URL" configKey="wopiClientUrl" value={currentValue('wopiClientUrl') as string} source={config.wopiClientUrl?.source} onChange={handleChange} onRevert={handleRevert} placeholder="https://office.example.com" wide />
          <ConfigTextItem label="WOPI host URL override" configKey="wopiHostUrl" value={currentValue('wopiHostUrl') as string} source={config.wopiHostUrl?.source} onChange={handleChange} onRevert={handleRevert} placeholder="http://webmail:3000" wide />
          <ConfigTextItem label="New file formats" configKey="wopiNewFileFormats" value={currentValue('wopiNewFileFormats') as string} source={config.wopiNewFileFormats?.source} onChange={handleChange} onRevert={handleRevert} placeholder="Every format the editor can edit" wide />
          <ConfigTextItem label="Template directory" configKey="wopiTemplateDir" value={currentValue('wopiTemplateDir') as string} source={config.wopiTemplateDir?.source} onChange={handleChange} onRevert={handleRevert} placeholder="/data/templates" wide />
          <ConfigNote>
            Point the client URL at a WOPI-compatible office suite (Collabora Online, OnlyOffice, EuroOffice, …) to let users edit documents in Files. The client URL may be an internal address: the browser loads the editor from the address its discovery advertises. The host override is only needed when the editor reaches this webmail under a different address than the browser does (e.g. Docker networks); give the address alone, the webmail&apos;s base path is added to it. The editor must also allow this webmail as a WOPI host.
          </ConfigNote>
          <ConfigNote>
            &quot;New file&quot; in Files offers .txt plus every format the editor can edit that a blank template exists for: .docx, .xlsx, .pptx, .odt, .ods, .odp and .pdf are built in. List extensions separated by commas (e.g. <code className="text-[0.6875rem] bg-muted px-1 py-0.5 rounded">docx,xlsx,pptx</code>) to offer only those. A file named <code className="text-[0.6875rem] bg-muted px-1 py-0.5 rounded">new.&lt;ext&gt;</code> in the template directory on this server replaces the built-in blank file for that format or adds a format, so ONLYOFFICE&apos;s <code className="text-[0.6875rem] bg-muted px-1 py-0.5 rounded">document-templates/new/&lt;locale&gt;</code> folder works as one.
          </ConfigNote>
        </SettingsSection>

        <SettingsSection id="bimi" title="Brand logos">
          <ConfigToggleItem label="Require a mark certificate" description="Senders that publish a BIMI record and enforce DMARC get their logo as the sender icon. Off shows a logo that only the sender's DNS record backs, as Yahoo does. On shows only logos backed by a Verified Mark or Common Mark Certificate, as Gmail and Apple Mail do, so a lookalike domain can't put up someone else's logo." configKey="bimiRequireCertificate" value={currentValue('bimiRequireCertificate') as boolean} source={config.bimiRequireCertificate?.source} onChange={handleChange} onRevert={handleRevert} />
        </SettingsSection>

        <SettingsSection id="logging" title="Logging">
          <ConfigSelectItem label="Format" configKey="logFormat" value={currentValue('logFormat') as string} source={config.logFormat?.source} options={['text', 'json']} onChange={handleChange} onRevert={handleRevert} />
          <ConfigSelectItem label="Level" configKey="logLevel" value={currentValue('logLevel') as string} source={config.logLevel?.source} options={['error', 'warn', 'info', 'debug']} onChange={handleChange} onRevert={handleRevert} />
        </SettingsSection>

        <SettingsSection id="sync" title="Settings sync">
          <ConfigToggleItem label="Enabled" description="Requires SESSION_SECRET to be set" configKey="settingsSyncEnabled" value={currentValue('settingsSyncEnabled') as boolean} source={config.settingsSyncEnabled?.source} onChange={handleChange} onRevert={handleRevert} />
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
