'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, ArrowUp, ArrowDown } from '@/components/icons';
import { iconForName } from '@/components/icons';
import type { SettingsPolicy, FeatureGates, PushRelayOption, AdminSidebarApp } from '@/lib/admin/types';
import { DEFAULT_FEATURE_GATES, DEFAULT_POLICY } from '@/lib/admin/types';
import { apiFetch } from '@/lib/browser-navigation';
import { adminPageDef } from '@/lib/admin/admin-nav';
import { useAdminUnsavedChanges } from '@/stores/admin-unsaved-store';
import { DEFAULT_SIDEBAR_APP_ID_PREFIX, MAX_DEFAULT_SIDEBAR_APPS } from '@/lib/sidebar-apps';
import { generateUUID, cn } from '@/lib/utils';
import {
  DEFAULT_RELAY_BASE_URL,
  isValidRelayUrl,
  normalizeRelayUrl,
  resolveDefaultRelayUrl,
} from '@/lib/push-relays';
import { SettingsSection, SettingItem, ToggleSwitch, SectionNav } from '@/components/settings/settings-section';
import type { GlossaryId } from '@/components/ui/term';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminBodySkeleton } from '@/components/boot-skeleton/admin-skeleton';
import { AdminSaveBar } from '@/components/admin/save-bar';
import { Badge } from '@/components/admin/badge';
import { useAdminFeedback } from '@/components/admin/feedback';
import { inputClass } from '@/components/admin/config-items';
import { InheritLine, LockedSettingsSection, PolicyDefaultsSection, ScopePicker, useScopeId } from '@/components/admin/policy/user-settings-policy';
import { EVERYONE_SCOPE, featureAt, withFeatureAt } from '@/lib/admin/policy-settings';
import { GLOBAL_ONLY_FEATURES } from '@/lib/admin/policy-scopes';

// `allMailViewEnabled` is deprecated (folded into `crossAllViewEnabled`, normalized
// forward on policy load), so it is hidden from the admin UI.
const EXCLUDED_FEATURE_GATES: (keyof FeatureGates)[] = ['pluginsEnabled', 'pluginsUploadEnabled', 'themesEnabled', 'userThemesEnabled', 'allMailViewEnabled'];

const FEATURE_GATE_LABELS: Partial<Record<keyof FeatureGates, { label: string; description: string; term?: GlossaryId }>> = {
  sidebarAppsEnabled: { label: 'Sidebar apps', description: 'Let users add their own web apps and links to the sidebar.' },
  settingsExportEnabled: { label: 'Settings backup', description: 'Let users download a copy of their settings and restore it from a file.' },
  customKeywordsEnabled: { label: 'Own tags', description: 'Let users create their own tags for messages.' },
  templatesEnabled: { label: 'Email templates', description: 'Let users save messages as templates and use the template library.' },
  calendarEnabled: { label: 'Calendar', description: 'Show the calendar.' },
  calendarTasksEnabled: { label: 'Tasks', description: 'Show the task list in the calendar.' },
  contactsEnabled: { label: 'Contacts', description: 'Show contacts and address books.' },
  smimeEnabled: { label: 'S/MIME', description: 'Let users add certificates to sign and encrypt mail.', term: 'smime' },
  externalContentEnabled: { label: 'Choice of remote content', description: 'Let users choose whether pictures and other content from the web load in messages.' },
  debugModeEnabled: { label: 'Debug mode', description: 'Let users turn on extra logging when they report a problem.' },
  folderIconsEnabled: { label: 'Folder icons', description: 'Let users pick an icon for each folder.' },
  hoverActionsConfigEnabled: { label: 'Hover buttons', description: 'Let users choose which buttons show when they point at a message in the list.' },
  tabTitleSubjectEnabled: { label: 'Subject in the tab title', description: 'Show the open message\'s subject in the browser tab title. Browsers also keep the title in history and screen shares show it; turn this off when mailboxes hold confidential correspondence, and the tab shows the folder instead.' },
  filesEnabled: { label: 'Files', description: 'Show file storage (WebDAV).', term: 'webdav' },
  crossUnreadViewEnabled: { label: 'Unified mailbox: Unread', description: 'Offer an "Unread" entry in the sidebar that lists unread mail from the account and its shared folders, or from every account when Cross-account is on. Users turn it on in Settings > Appearance.' },
  crossStarredViewEnabled: { label: 'Unified mailbox: Starred', description: 'Offer a "Starred" entry in the sidebar that lists starred mail from the account and its shared folders, or from every account when Cross-account is on. Users turn it on in Settings > Appearance.' },
  crossAllViewEnabled: { label: 'Unified mailbox: All mail', description: 'Offer an "All mail" entry in the sidebar that lists all mail from the account and its shared folders, or from every account when Cross-account is on. Users turn it on in Settings > Appearance.' },
  unifiedCrossAccountEnabled: { label: 'Unified mailbox: Cross-account', description: 'Let the unified mailbox entries above list mail from every account a user is signed in to. Off keeps them to the account in view and its shared folders.' },
  accountArchiveEnabled: { label: 'Account list backup', description: 'Let users save their list of accounts (address, server, label, colour) on this server, encrypted in the browser with a password of their choice, and restore it on another device. Mailbox passwords are stored only when the Passwords option below is on. Archives live in SETTINGS_DATA_DIR/account-archives; requires SESSION_SECRET.' },
  accountArchivePasswordsEnabled: { label: 'Account list backup: passwords', description: 'With Account list backup on, offer to include the mailbox passwords of accounts signed in with a password, so a restore signs in to them by itself. They are encrypted in the browser with the backup password together with the list; the server never sees them in clear, but anyone who learns the backup password gets every mailbox in it. Accounts signed in with OAuth or a TOTP code are saved without.' },
  customFromEnabled: { label: 'Any sender address', description: 'Let users type any sender address in the composer instead of picking one of their identities, and let replies to a catch-all address on their domain send from that address. Turn this off when users may only send as their configured identities.' },
  archiveActionEnabled: { label: 'Archive', description: 'Offer "Archive" on messages: the toolbar button, the context menu and selection bar, the hover and swipe actions, the E shortcut and archiving after an export. Turn this off when mail is archived elsewhere, for example by a mail gateway; existing Archive folders stay as ordinary folders and Bulwark no longer creates one.' },
  tagsAboveSharedEnabled: { label: 'Tags above shared mailboxes', description: 'List the tags in the sidebar above the shared mailboxes instead of below them. Turn this on when users have many shared mailboxes and work with tags: expanded, the shared mailboxes push the tags out of sight.' },
  structuredMailEnabled: { label: 'Booking and parcel cards', description: 'Show a card above booking, shipping and order mails that carry schema.org markup (flights, trains, buses, hotels, rental cars, events, restaurants, parcels, orders), with copy buttons, links and "Add to calendar". Cards appear only for mail whose sender passed SPF or DKIM for the From domain, and nothing is added to a calendar without a click. Everything is read in the browser; no request goes to airlines or carriers. Turn this off if mail content should not be turned into calendar entries, or if you don\'t trust the Authentication-Results your mail server writes.' },
};

const PAGE = adminPageDef('policy');

const fieldLabelClass = 'mb-1 block text-[0.6875rem] font-medium text-muted-foreground';
const cardClass = 'rounded-md border border-border bg-muted/30 p-3';

/** Mirrors the sanitizer's URL rule so the admin sees the drop before saving. */
function isValidDefaultAppUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim());
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.host;
  } catch {
    return false;
  }
}

export function PolicyPage() {
  const [policy, setPolicy] = useState<SettingsPolicy>({ ...DEFAULT_POLICY });
  const [savedPolicy, setSavedPolicy] = useState<SettingsPolicy>({ ...DEFAULT_POLICY });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const setMessage = useAdminFeedback();
  const [dirty, setDirty] = useState(false);
  // The version of the policy this page loaded: a save based on an older
  // one is refused instead of undoing someone else's change.
  const policyETag = useRef<string | null>(null);

  useEffect(() => { fetchPolicy(); }, []);

  async function fetchPolicy() {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/policy');
      if (res.ok) {
        const data = await res.json();
        policyETag.current = res.headers.get('ETag');
        setPolicy(data);
        setSavedPolicy(data);
      }
    } finally {
      setLoading(false);
    }
  }

  const [scopeId, setScopeId] = useScopeId(policy);
  const scoped = scopeId !== EVERYONE_SCOPE;

  /** A feature at Everyone or the picked domain or group; undefined there means Everyone's again. */
  function setFeature(key: keyof FeatureGates, value: boolean | undefined) {
    setPolicy(prev => withFeatureAt(prev, scopeId, key, value));
    setDirty(true);
    setMessage(null);
  }

  function setPushRelayUrl(value: string) {
    setPolicy(prev => ({ ...prev, pushRelayUrl: value }));
    setDirty(true);
    setMessage(null);
  }

  function updatePushRelay(index: number, patch: Partial<PushRelayOption>) {
    setPolicy(prev => ({
      ...prev,
      pushRelays: (prev.pushRelays ?? []).map((relay, i) => (i === index ? { ...relay, ...patch } : relay)),
    }));
    setDirty(true);
    setMessage(null);
  }

  function addPushRelay() {
    setPolicy(prev => ({ ...prev, pushRelays: [...(prev.pushRelays ?? []), { label: '', url: '' }] }));
    setDirty(true);
    setMessage(null);
  }

  function removePushRelay(index: number) {
    setPolicy(prev => {
      const remaining = (prev.pushRelays ?? []).filter((_, i) => i !== index);
      const removedUrl = normalizeRelayUrl((prev.pushRelays ?? [])[index]?.url);
      // Dropping the relay users are defaulted to would leave a dangling
      // default, so fall back to the built-in one.
      const pushRelayUrl = normalizeRelayUrl(prev.pushRelayUrl) === removedUrl ? '' : prev.pushRelayUrl;
      return { ...prev, pushRelays: remaining, pushRelayUrl };
    });
    setDirty(true);
    setMessage(null);
  }

  function togglePushRelayLocked() {
    setPolicy(prev => ({ ...prev, pushRelayUrlLocked: !prev.pushRelayUrlLocked }));
    setDirty(true);
    setMessage(null);
  }

  function toggleDirectorySameDomain() {
    setPolicy(prev => ({ ...prev, directorySameDomainOnly: !prev.directorySameDomainOnly }));
    setDirty(true);
    setMessage(null);
  }

  function setDirectoryHiddenLocalparts(value: string) {
    // Kept as typed; saving trims, lowercases and drops the empty entries.
    setPolicy(prev => ({ ...prev, directoryHiddenLocalparts: value.split(',') }));
    setDirty(true);
    setMessage(null);
  }

  function updateDefaultApp(index: number, patch: Partial<AdminSidebarApp>) {
    setPolicy(prev => ({
      ...prev,
      defaultSidebarApps: (prev.defaultSidebarApps ?? []).map((app, i) => (i === index ? { ...app, ...patch } : app)),
    }));
    setDirty(true);
    setMessage(null);
  }

  function addDefaultApp() {
    setPolicy(prev => {
      const apps = prev.defaultSidebarApps ?? [];
      if (apps.length >= MAX_DEFAULT_SIDEBAR_APPS) return prev;
      return {
        ...prev,
        defaultSidebarApps: [
          ...apps,
          {
            id: `${DEFAULT_SIDEBAR_APP_ID_PREFIX}${generateUUID()}`,
            name: '',
            url: '',
            icon: 'Globe',
            openMode: 'tab' as const,
            showOnMobile: false,
          },
        ],
      };
    });
    setDirty(true);
    setMessage(null);
  }

  function removeDefaultApp(index: number) {
    setPolicy(prev => ({
      ...prev,
      defaultSidebarApps: (prev.defaultSidebarApps ?? []).filter((_, i) => i !== index),
    }));
    setDirty(true);
    setMessage(null);
  }

  /** Rail order follows this list, so admins need to be able to reorder it. */
  function moveDefaultApp(index: number, delta: number) {
    setPolicy(prev => {
      const apps = [...(prev.defaultSidebarApps ?? [])];
      const target = index + delta;
      if (target < 0 || target >= apps.length) return prev;
      [apps[index], apps[target]] = [apps[target], apps[index]];
      return { ...prev, defaultSidebarApps: apps };
    });
    setDirty(true);
    setMessage(null);
  }

  /** Locks and defaults, for Everyone or a scope (components/admin/policy). */
  function changePolicy(change: (prev: SettingsPolicy) => SettingsPolicy) {
    setPolicy(change);
    setDirty(true);
    setMessage(null);
  }

  function discard() {
    setPolicy(savedPolicy);
    setDirty(false);
    setMessage(null);
  }

  async function handleSave() {
    setSaving(true);
    setMessage(null);

    try {
      const res = await apiFetch('/api/admin/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(policyETag.current ? { 'If-Match': policyETag.current } : {}) },
        body: JSON.stringify(policy),
      });

      if (res.ok) {
        policyETag.current = res.headers.get('ETag');
        // The server sanitises; continue from what it stored.
        const stored = ((await res.json().catch(() => null)) as { policy?: SettingsPolicy } | null)?.policy;
        if (stored) {
          setPolicy(stored);
          setSavedPolicy(stored);
        } else {
          setSavedPolicy(policy);
        }
        setMessage({ type: 'success', text: 'Saved. Users get the change within 15 minutes.' });
        setDirty(false);
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error || 'Could not save the policy' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Could not save the policy' });
    } finally {
      setSaving(false);
    }
  }

  useAdminUnsavedChanges('policy', dirty);

  const defaultRelayUrl = resolveDefaultRelayUrl(policy);
  const defaultSidebarApps = policy.defaultSidebarApps ?? [];

  return (
    <div>
      <AdminPageHeader title={PAGE.label} description={PAGE.description} />


      {loading ? (
        <AdminBodySkeleton status="Loading" />
      ) : (
        <div className="space-y-10">
          <SectionNav />

          <SettingsSection
            id="features"
            title="Features"
            description="Turn whole features on or off for users. Plugins and themes have their own pages."
          >
            <ScopePicker policy={policy} scopeId={scopeId} onPick={setScopeId} />
            {(Object.keys(DEFAULT_FEATURE_GATES) as (keyof FeatureGates)[])
              .filter(key => !EXCLUDED_FEATURE_GATES.includes(key))
              .map(key => {
                const meta = FEATURE_GATE_LABELS[key];
                if (!meta) return null;
                const { label, description, term } = meta;
                // The server checks these itself and can't tell users apart there.
                const globalOnly = GLOBAL_ONLY_FEATURES.has(key);
                const at = featureAt(policy, globalOnly ? EVERYONE_SCOPE : scopeId, key);
                return (
                  <SettingItem key={key} label={label} description={description} term={term}>
                    <ToggleSwitch
                      checked={at.value}
                      disabled={scoped && globalOnly}
                      onChange={(v) => setFeature(key, v)}
                    />
                    {scoped && globalOnly ? (
                      <p className="mt-1 text-xs text-muted-foreground">Applies to everyone</p>
                    ) : (
                      <InheritLine
                        scoped={scoped}
                        own={at.own}
                        everyone={at.everyone ? 'On' : 'Off'}
                        onReset={() => setFeature(key, undefined)}
                      />
                    )}
                  </SettingItem>
                );
              })}
          </SettingsSection>

          <SettingsSection
            id="push-relays"
            title="Push relays"
            description="Relays users can pick from in notification settings. The built-in Bulwark relay is always offered; add your own here. Users choose from this list - they cannot enter a URL. Applies to everyone."
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm font-medium text-foreground">Relays</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Mark one as the default. Relays without a valid URL are not offered to users.
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 text-xs" onClick={addPushRelay}>
                <Plus className="h-3.5 w-3.5" />
                Add relay
              </Button>
            </div>

            <div className={cardClass}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-foreground">Bulwark relay</span>
                    <Badge>built-in</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{DEFAULT_RELAY_BASE_URL}</p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="radio"
                    name="default-push-relay"
                    checked={defaultRelayUrl === normalizeRelayUrl(DEFAULT_RELAY_BASE_URL)}
                    onChange={() => setPushRelayUrl('')}
                    className="border-input"
                  />
                  Default
                </label>
              </div>
            </div>

            {(policy.pushRelays ?? []).map((relay, index) => (
              <div key={index} className={cn(cardClass, 'space-y-2')}>
                <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-4">
                    <label className={fieldLabelClass}>Name</label>
                    <input
                      aria-label="Name"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={relay.label}
                      onChange={(e) => updatePushRelay(index, { label: e.target.value })}
                      placeholder="Company relay"
                      className={cn(inputClass, 'w-full')}
                    />
                  </div>
                  <div className="sm:col-span-8">
                    <label className={fieldLabelClass}>Relay URL</label>
                    <div className="flex items-center gap-2">
                      <input
                        aria-label="Relay URL"
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        value={relay.url}
                        onChange={(e) => updatePushRelay(index, { url: e.target.value })}
                        placeholder="https://notifications.relay.example.com"
                        className={cn(inputClass, 'w-full')}
                      />
                      <button
                        type="button"
                        onClick={() => removePushRelay(index)}
                        className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                        title="Remove relay"
                        aria-label="Remove relay"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
                <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="radio"
                    name="default-push-relay"
                    checked={isValidRelayUrl(relay.url) && defaultRelayUrl === normalizeRelayUrl(relay.url)}
                    disabled={!isValidRelayUrl(relay.url)}
                    onChange={() => setPushRelayUrl(normalizeRelayUrl(relay.url))}
                    className="border-input disabled:opacity-40"
                  />
                  Default
                </label>
              </div>
            ))}

            <SettingItem label="Pin users to the default relay" description="Lock the relay choice: users cannot pick another relay in their notification settings.">
              <ToggleSwitch checked={!!policy.pushRelayUrlLocked} onChange={togglePushRelayLocked} />
            </SettingItem>
          </SettingsSection>

          <SettingsSection
            id="recipient-directory"
            title="Recipient directory"
            description="Which server accounts people see in Bulwark: the contacts directory, recipient suggestions, sharing, delegation and free/busy. Stalwart itself still lists every account to a client that asks for them."
          >
            <SettingItem label="Own domains only" description="Show only accounts in the domains of the signed-in account's addresses, aliases included.">
              <ToggleSwitch checked={!!policy.directorySameDomainOnly} onChange={toggleDirectorySameDomain} />
            </SettingItem>
            <SettingItem label="Hidden accounts" description="Account names before the @, separated by commas, hidden from everyone. For function accounts such as noreply.">
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={(policy.directoryHiddenLocalparts ?? []).join(',')}
                onChange={(e) => setDirectoryHiddenLocalparts(e.target.value)}
                placeholder="noreply, spam"
                aria-label="Hidden accounts"
                className={cn(inputClass, 'w-64')}
              />
            </SettingItem>
          </SettingsSection>

          <SettingsSection
            id="sidebar-apps"
            title="Default sidebar apps"
            description="Apps every user gets in the navigation rail without configuring anything. They appear above the user's own apps and cannot be edited or removed by users. Independent of the Sidebar apps feature above, which only covers apps users add themselves. Applies to everyone."
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <span className="text-sm font-medium text-foreground">Apps</span>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Entries without a name or a valid http(s) URL are dropped when saving. Inline apps
                  are framed inside the webmail, so the target must allow being embedded.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 text-xs"
                onClick={addDefaultApp}
                disabled={defaultSidebarApps.length >= MAX_DEFAULT_SIDEBAR_APPS}
              >
                <Plus className="h-3.5 w-3.5" />
                Add app
              </Button>
            </div>

            {defaultSidebarApps.length === 0 && (
              <p className="py-2 text-xs text-muted-foreground">
                No default apps. Users only see the apps they add themselves.
              </p>
            )}

            {defaultSidebarApps.map((app, index) => {
              const AppIcon = iconForName(app.icon);
              const urlInvalid = app.url.trim().length > 0 && !isValidDefaultAppUrl(app.url);
              return (
                <div key={app.id} className={cn(cardClass, 'space-y-2')}>
                  <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-4">
                      <label className={fieldLabelClass}>Name</label>
                      <input
                        aria-label="Name"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={50}
                        value={app.name}
                        onChange={(e) => updateDefaultApp(index, { name: e.target.value })}
                        placeholder="Intranet"
                        className={cn(inputClass, 'w-full')}
                      />
                    </div>
                    <div className="sm:col-span-5">
                      <label className={fieldLabelClass}>URL</label>
                      <input
                        aria-label="URL"
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={2048}
                        value={app.url}
                        onChange={(e) => updateDefaultApp(index, { url: e.target.value })}
                        placeholder="https://intranet.example.com"
                        className={cn(inputClass, 'w-full', urlInvalid && 'border-destructive')}
                      />
                      {urlInvalid && (
                        <p className="mt-1 text-[0.6875rem] text-destructive">Enter a valid http or https URL</p>
                      )}
                    </div>
                    <div className="sm:col-span-3">
                      <label className={fieldLabelClass}>
                        Icon (
                        <a href="https://tabler.io/icons" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">Tabler</a>
                        )
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          aria-label="Icon"
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={64}
                          value={app.icon}
                          onChange={(e) => updateDefaultApp(index, { icon: e.target.value })}
                          placeholder="world"
                          className={cn(inputClass, 'w-full')}
                        />
                        <span
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground"
                          title={AppIcon ? app.icon : 'Unknown icon - falls back to Globe'}
                        >
                          {AppIcon ? <AppIcon className="h-4 w-4" /> : <span className="text-[0.625rem]">?</span>}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center gap-3">
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="radio"
                          name={`default-app-mode-${app.id}`}
                          checked={app.openMode !== 'inline'}
                          onChange={() => updateDefaultApp(index, { openMode: 'tab' })}
                          className="border-input"
                        />
                        New tab
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="radio"
                          name={`default-app-mode-${app.id}`}
                          checked={app.openMode === 'inline'}
                          onChange={() => updateDefaultApp(index, { openMode: 'inline' })}
                          className="border-input"
                        />
                        Inline
                      </label>
                    </div>
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={app.showOnMobile}
                        onChange={() => updateDefaultApp(index, { showOnMobile: !app.showOnMobile })}
                        className="rounded border-input"
                      />
                      Show on mobile
                    </label>
                    <div className="ms-auto flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveDefaultApp(index, -1)}
                        disabled={index === 0}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        title="Move up"
                        aria-label="Move up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveDefaultApp(index, 1)}
                        disabled={index === defaultSidebarApps.length - 1}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        title="Move down"
                        aria-label="Move down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeDefaultApp(index)}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                        title="Remove app"
                        aria-label="Remove app"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </SettingsSection>

          <LockedSettingsSection policy={policy} onChange={changePolicy} />

          <PolicyDefaultsSection policy={policy} onChange={changePolicy} />
        </div>
      )}

      <AdminSaveBar
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onDiscard={discard}
        saveLabel="Save policy"
        note="Users get the change within 15 minutes"
      />
    </div>
  );
}
