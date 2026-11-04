'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ArrowUpCircle,
  Download,
  Loader2,
  Puzzle,
  SwatchBook,
  Star,
  Trash2,
  Check,
  Settings as SettingsIcon,
  ExternalLink,
  Shield,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  FileCode,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Ban,
  Info,
  Eye,
} from '@/components/icons';
import { apiFetch } from '@/lib/browser-navigation';
import { compareVersions, isVersionSatisfied } from '@/lib/version-compare';
import type { MarketplaceListing } from '@/lib/admin/marketplace-directory';
import { adminPath } from '@/lib/admin/admin-nav';
import { declaredPermissions, HIGH_RISK_PERMISSIONS } from '@/lib/plugin-sandbox/permission-text';
import { cn } from '@/lib/utils';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminLink } from '@/components/admin/admin-link';
import { AdminButtonLink } from '@/components/admin/button-link';
import { Badge } from '@/components/admin/badge';
import { ScreenshotGallery } from '@/components/admin/screenshot-gallery';
import { useAdminFeedback } from '@/components/admin/feedback';
import { installVersion } from './marketplace';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { scrollBehavior } from '@/lib/reduced-motion';
import { ChangelogBadges, ChangelogEntries, ChangelogNotes, type ChangelogFlags } from '@/components/admin/changelog';
import { versionsBetween } from '@/lib/admin/changelog-range';

const CURRENT_APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';

interface VersionRow {
  version: string;
  channel: 'stable' | 'beta';
  publishedAt: string | null;
  minAppVersion: string | null;
  maxAppVersion: string | null;
  permissions: string[];
  size: number;
  sha256: string;
  yanked: { at: string; reason: string | null } | null;
  changelog: string | null;
  notes: ChangelogFlags | null;
  downloads: number;
  signed: boolean;
  commit: string | null;
}

interface Advisory {
  id: string;
  affected: string;
  fixedIn: string | null;
  severity: string;
  summary: string;
  details: string | null;
  withdrawn: boolean;
}

interface HistoryEntry {
  version: string;
  savedAt: string;
  contentHash: string;
}

interface PreviewData {
  extension: MarketplaceListing & {
    longDescription: string | null;
    newestVersion: string | null;
    newestMinAppVersion: string | null;
    versions: VersionRow[];
    screenshots: Array<{ url: string; altText: string | null }>;
    themePreviews: Array<{ variant: 'light' | 'dark'; url: string | null; colors: Record<string, string> | null }>;
    advisories: Advisory[];
    permissionDetails: Array<{ id: string; title: string; body: string; highRisk: boolean }>;
    source: { host: string; repo: string | null; subpath: string | null };
    createdAt: string | null;
    updatedAt: string | null;
  };
  preview: { version: string; channel: 'stable' | 'beta'; yanked: VersionRow['yanked']; minAppVersion: string | null; maxAppVersion: string | null } | null;
  requestedVersionMissing: string | null;
  bundle: {
    manifest: Record<string, unknown> | null;
    /** What this version asks for that the installed one doesn't. */
    addedPermissions?: string[];
    source: { name: string; content: string; truncated: boolean } | null;
    size: number;
    error: string | null;
    signature: { status: 'verified' | 'unsigned' | 'invalid'; keyId?: string; reason?: string } | null;
  };
  installed: boolean;
  installedVersion: string | null;
  installedSource: { kind: 'marketplace' | 'upload' } | null;
  history: HistoryEntry[];
  channel: 'stable' | 'beta';
  appVersion: string | null;
  directoryUrl: string;
}

const RISKY_PERMISSIONS = new Set([
  'mail:write',
  'mail:delete',
  'storage:write',
  'network',
  'admin',
]);

/** Whether this Bulwark can run a version, given what the directory says it needs. */
function fits(v: { minAppVersion: string | null; maxAppVersion: string | null }): boolean {
  if (!isVersionSatisfied(CURRENT_APP_VERSION, v.minAppVersion)) return false;
  if (v.maxAppVersion && compareVersions(CURRENT_APP_VERSION, v.maxAppVersion) > 0) return false;
  return true;
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');
const fmtSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`);

const BACK = { href: adminPath('marketplace'), label: 'Marketplace' };

const thClass = 'px-4 py-2 text-start text-xs font-medium text-muted-foreground';
const tdClass = 'px-4 py-2 align-top';
const smallButtonClass = 'h-8 gap-1 text-xs';

export function MarketplaceDetailPage({ slug }: { slug: string }) {
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();
  const pageRef = useRef<HTMLDivElement>(null);

  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const setMessage = useAdminFeedback();
  const [showSource, setShowSource] = useState(false);
  const [showManifest, setShowManifest] = useState(false);
  // The version being previewed, from the install link (?version=) or a row
  // the admin picked. Read from the address bar, like the connector does.
  const [selected, setSelected] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setSelected(new URLSearchParams(window.location.search).get('version'));
  }, []);

  const fetchPreview = useCallback(async (version: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const query = version ? `?version=${encodeURIComponent(version)}` : '';
      const res = await apiFetch(`/api/admin/marketplace/${encodeURIComponent(slug)}${query}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Failed to load preview');
        return;
      }
      setData(await res.json());
    } catch {
      setError('Failed to connect to extension directory');
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    if (selected === undefined) return;
    fetchPreview(selected);
  }, [fetchPreview, selected]);

  function pick(version: string | null) {
    const url = new URL(window.location.href);
    if (version) url.searchParams.set('version', version);
    else url.searchParams.delete('version');
    window.history.replaceState(null, '', url.toString());
    setSelected(version);
    setMessage(null);
    // What a pick changes is at the top: the notices and the install button.
    // From a row of the versions table it would all happen out of sight.
    pageRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  }

  async function handleInstall(version: string) {
    if (!data) return;
    const isUpdate = data.installed;
    setBusy(`install:${version}`);
    setMessage(null);
    const result = await installVersion({ slug: data.extension.slug, version, type: data.extension.type }, confirm);
    setBusy(null);
    if (!result.ok) {
      setMessage({ type: 'error', text: result.error });
      return;
    }
    const warnings = result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : '';
    const signed = result.signature === 'verified' ? ', signed by the directory' : '';
    setMessage({
      type: 'success',
      text: isUpdate
        ? `"${data.extension.name}" is now v${version}${signed}${warnings}`
        : `"${data.extension.name}" installed (v${version})${signed}${warnings}`,
    });
    fetchPreview(selected ?? null);
  }

  async function handleRollback(version: string) {
    if (!data) return;
    const ok = await confirm({
      title: `Roll back to v${version}?`,
      message: `"${data.extension.name}" v${version} replaces v${data.installedVersion}. The copy kept on this server is used; the directory is not asked.`,
      confirmText: 'Roll back',
      cancelText: 'Cancel',
    });
    if (!ok) return;
    setBusy(`rollback:${version}`);
    setMessage(null);
    try {
      const res = await apiFetch(`/api/admin/extensions/${data.extension.type}/${encodeURIComponent(data.extension.slug)}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage({ type: 'success', text: `"${data.extension.name}" rolled back to v${version}` });
        fetchPreview(selected ?? null);
      } else {
        setMessage({ type: 'error', text: body.error || 'Rollback failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Rollback failed - network error' });
    } finally {
      setBusy(null);
    }
  }

  async function handleUninstall() {
    if (!data) return;
    const ok = await confirm({
      title: `Remove "${data.extension.name}"?`,
      message: 'The versions kept on this server are removed too. This cannot be undone.',
      confirmText: 'Remove',
      cancelText: 'Cancel',
      variant: 'destructive',
    });
    if (!ok) return;

    setUninstalling(true);
    setMessage(null);
    try {
      const endpoint = data.extension.type === 'theme'
        ? '/api/admin/themes'
        : '/api/admin/plugins';
      const res = await apiFetch(endpoint, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.extension.slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage({ type: 'success', text: `"${data.extension.name}" removed` });
        fetchPreview(selected ?? null);
      } else {
        setMessage({ type: 'error', text: body.error || 'Uninstall failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Uninstall failed - network error' });
    } finally {
      setUninstalling(false);
    }
  }

  if (loading && !data) {
    return (
      <div>
        <AdminPageHeader back={BACK} title={<span className="text-muted-foreground">Loading</span>} />
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="me-2 h-4 w-4 animate-spin" /> Loading
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <AdminPageHeader
          back={BACK}
          title={error ? 'Could not load the extension' : 'Extension not found'}
          description={error ?? <>Nothing in the directory is listed under <code className="font-mono text-xs">{slug}</code>.</>}
        />
      </div>
    );
  }

  const ext = data.extension;
  const bundle = data.bundle;
  const preview = data.preview;
  const isPlugin = ext.type === 'plugin';
  // Optional permissions are granted like the others, so they count here too.
  const manifestPerms = bundle.manifest ? declaredPermissions(bundle.manifest) : (preview && ext.versions.find((v) => v.version === preview.version)?.permissions) || ext.permissions || [];
  const permissionText = new Map(ext.permissionDetails.map((p) => [p.id, p]));
  const addedPermissions = new Set(bundle.addedPermissions ?? []);
  const frameOrigins = (bundle.manifest?.frameOrigins as string[] | undefined) || [];
  const settingsSchema = bundle.manifest?.settingsSchema as Record<string, { type: string; label: string; description?: string; default?: unknown }> | undefined;

  const previewFits = preview ? fits(preview) : false;
  const previewIsInstalled = !!preview && data.installed && data.installedVersion === preview.version;
  const previewDirection = preview && data.installed && data.installedVersion
    ? compareVersions(preview.version, data.installedVersion)
    : 0;
  const installedRow = data.installedVersion ? ext.versions.find((v) => v.version === data.installedVersion) ?? null : null;
  // The notes for the previewed version: everything an update to it brings,
  // or everything going back to it undoes, or just its own.
  const comparing = !!preview && data.installed && !!data.installedVersion && !previewIsInstalled;
  const changeRows = !preview ? []
    : comparing ? versionsBetween(ext.versions, data.installedVersion!, preview.version, data.channel)
      : ext.versions.filter((v) => v.version === preview.version);
  const changesTitle = !comparing ? `Changelog of v${preview?.version}`
    : previewDirection > 0 ? `What's new since v${data.installedVersion}`
      : `What going back to v${preview!.version} undoes`;
  const suspended = ext.status === 'suspended';
  const historyVersions = new Set(data.history.map((h) => h.version));
  const canInstallPreview = !!preview && !bundle.error && previewFits && !suspended && bundle.signature?.status !== 'invalid';

  // Versions no longer in the directory's list but still kept here.
  const extraHistory = data.history.filter((h) => !ext.versions.some((v) => v.version === h.version));

  const installLabel = !preview
    ? 'Install'
    : previewIsInstalled
      ? `Reinstall v${preview.version}`
      : !data.installed
        ? `Install v${preview.version}`
        : previewDirection > 0
          ? `Update to v${preview.version}`
          : `Install v${preview.version} (older)`;

  const updateAvailable = data.installed && !!ext.latest && !!data.installedVersion && compareVersions(ext.latest.version, data.installedVersion) > 0;

  return (
    <div ref={pageRef}>
      <AdminPageHeader
        back={BACK}
        leading={(
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
            {ext.iconUrl ? (
              <img src={ext.iconUrl} alt="" className="h-11 w-11 object-cover" loading="lazy" />
            ) : isPlugin ? (
              <Puzzle className="h-5 w-5" />
            ) : (
              <SwatchBook className="h-5 w-5" />
            )}
          </div>
        )}
        title={(
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words">{ext.name}</span>
            {ext.featured && <Star className="h-4 w-4 shrink-0 fill-warning text-warning" />}
            {data.installed && (
              <Badge tone="success" icon={<Check className="h-3 w-3" />}>Installed v{data.installedVersion}</Badge>
            )}
            {updateAvailable && (
              <button type="button" onClick={() => pick(ext.latest!.version)} title={`Preview v${ext.latest!.version}`} className="rounded hover:underline">
                <Badge tone="info" icon={<ArrowUpCircle className="h-3 w-3" />}>v{ext.latest!.version} available</Badge>
              </button>
            )}
            {ext.deprecated && <Badge>Deprecated</Badge>}
            {suspended && <Badge tone="danger" icon={<Ban className="h-3 w-3" />}>Suspended</Badge>}
          </span>
        )}
        description={(
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={isPlugin ? 'info' : 'accent'}>{isPlugin ? (ext.pluginType || 'plugin') : 'theme'}</Badge>
            {ext.author && (
              <span className="inline-flex items-center gap-1">
                by {ext.author.displayName}
                {ext.author.verified && <ShieldCheck className="h-3.5 w-3.5" aria-label="verified author" />}
              </span>
            )}
            {ext.license && <span>{ext.license}</span>}
            <span className="inline-flex items-center gap-1">
              <Download className="h-3 w-3" />
              {ext.totalDownloads.toLocaleString()}
            </span>
            {ext.rating.count > 0 && (
              <span className="inline-flex items-center gap-1" title={`${ext.rating.average} out of 5 from ${ext.rating.count} rating${ext.rating.count === 1 ? '' : 's'}`}>
                <Star className="h-3 w-3 fill-current" />
                {ext.rating.average.toFixed(1)} ({ext.rating.count})
              </span>
            )}
          </span>
        )}
        actions={(
          <>
            {preview && (
              <Button
                size="sm"
                variant={previewIsInstalled ? 'outline' : 'default'}
                className={cn('gap-1.5', previewDirection > 0 && !previewIsInstalled && 'bg-blue-600 text-white hover:bg-blue-700')}
                onClick={() => handleInstall(preview.version)}
                disabled={!!busy || !canInstallPreview}
                title={!previewFits
                  ? `v${preview.version} needs Bulwark ${preview.minAppVersion ?? 'any'}${preview.maxAppVersion ? ` to ${preview.maxAppVersion}` : ' or later'}. You are running v${CURRENT_APP_VERSION}.`
                  : preview.yanked ? 'This version was withdrawn by its publisher; you will be asked to confirm.' : undefined}
              >
                {busy === `install:${preview.version}` ? <Loader2 className="h-4 w-4 animate-spin" /> : previewDirection > 0 ? <ArrowUpCircle className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                {installLabel}
              </Button>
            )}
            {data.installed && (
              <>
                <AdminButtonLink href={isPlugin ? adminPath('plugins', ext.slug) : adminPath('themes', ext.slug)}>
                  <SettingsIcon className="h-4 w-4" />
                  Manage
                </AdminButtonLink>
                <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={handleUninstall} disabled={uninstalling}>
                  {uninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Uninstall
                </Button>
              </>
            )}
            <AdminButtonLink external href={ext.directoryUrl} target="_blank" rel="noopener noreferrer" title="Open this extension's page in the directory">
              <ExternalLink className="h-4 w-4" />
              Directory
            </AdminButtonLink>
          </>
        )}
      />

      {ext.bannerUrl && (
        <div className="mb-6 overflow-hidden rounded-lg border border-border bg-muted">
          <img
            src={ext.bannerUrl}
            alt=""
            className="block w-full max-h-64 object-cover"
            loading="lazy"
          />
        </div>
      )}

      <ConfirmDialog {...confirmProps} />

      <div className="mb-6 space-y-3 empty:hidden">
        {data.requestedVersionMissing && (
          <Notice tone="warning" title={`The link asked for v${data.requestedVersionMissing}, which the directory no longer offers`}>
            Showing v{preview?.version} instead.
          </Notice>
        )}
        {suspended && (
          <Notice tone="danger" title="This extension was suspended by the directory">
            It cannot be installed. {data.installed ? 'Consider removing it.' : ''}
          </Notice>
        )}
        {ext.deprecated && (
          <Notice tone="info" title="This extension is deprecated">
            {ext.deprecated.message || 'Its publisher no longer maintains it.'}
            {ext.deprecated.replacement && <> Use <AdminLink href={adminPath('marketplace', ext.deprecated.replacement)} className="underline">{ext.deprecated.replacement}</AdminLink> instead.</>}
          </Notice>
        )}
        {ext.advisories.filter((a) => !a.withdrawn).map((a) => (
          <Notice key={a.id} tone="danger" title={`Security advisory ${a.id} (${a.severity})`}>
            {a.summary} Affects {a.affected}{a.fixedIn ? `; fixed in v${a.fixedIn}` : '; no fixed version yet'}.
            {installedRow && data.installedVersion && a.fixedIn && compareVersions(data.installedVersion, a.fixedIn) < 0 && (
              <> <b>Your installed v{data.installedVersion} is affected.</b></>
            )}
          </Notice>
        ))}
        {installedRow?.yanked && (
          <Notice tone="warning" title={`The installed v${installedRow.version} was withdrawn by its publisher`}>
            {installedRow.yanked.reason || 'No reason was given.'} Pick another version below.
          </Notice>
        )}
        {preview?.yanked && !previewIsInstalled && (
          <Notice tone="warning" title={`v${preview.version} was withdrawn by its publisher`}>
            {preview.yanked.reason || 'No reason was given.'} It can still be installed, but you will be asked to confirm.
          </Notice>
        )}
        {preview && !previewFits && (
          <Notice tone="warning" title={preview.maxAppVersion && compareVersions(CURRENT_APP_VERSION, preview.maxAppVersion) > 0 ? 'This version is for an older Bulwark' : 'Update Bulwark to install this version'}>
            v{preview.version} needs Bulwark {preview.minAppVersion ?? 'any version'}{preview.maxAppVersion ? ` up to ${preview.maxAppVersion}` : ' or later'}. You are running v{CURRENT_APP_VERSION}.
            {!preview.yanked && ext.latest && ext.latest.version !== preview.version && (
              <> <button type="button" className="underline" onClick={() => pick(ext.latest!.version)}>v{ext.latest.version}</button> runs here.</>
            )}
          </Notice>
        )}
        {!ext.latest && !preview && (
          <Notice tone="warning" title="No version runs on this Bulwark">
            {ext.newestVersion ? `The newest, v${ext.newestVersion}, needs Bulwark ${ext.newestMinAppVersion ?? 'a newer version'}.` : 'Nothing has been published yet.'}
          </Notice>
        )}
        {bundle.error && (
          <Notice tone="warning" title="Could not preview bundle">{bundle.error}</Notice>
        )}
        {bundle.signature?.status === 'invalid' && (
          <Notice tone="danger" title="The directory's signature on this bundle does not check out">
            {bundle.signature.reason}. It will not be installed.
          </Notice>
        )}
      </div>

      <div className="space-y-10">
        <SettingsSection id="about" title="About">
          <div className="space-y-3">
            <p className="text-sm text-foreground">{ext.description}</p>
            {ext.longDescription && ext.longDescription !== ext.description && (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{ext.longDescription}</p>
            )}
            {ext.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {ext.tags.map(tag => <Badge key={tag}>{tag}</Badge>)}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
              {preview && <span>Previewing v{preview.version}{preview.channel === 'beta' ? ' (beta)' : ''}</span>}
              {bundle.size > 0 && <span>Bundle: {fmtSize(bundle.size)}</span>}
              {bundle.signature?.status === 'verified' && (
                <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400" title={`Signed by the directory, key ${bundle.signature.keyId}`}>
                  <ShieldCheck className="h-3 w-3" /> Signed by the directory
                </span>
              )}
              {bundle.signature?.status === 'unsigned' && (
                <span className="inline-flex items-center gap-1" title="No directory root key is configured, so the signature is not checked">
                  <Info className="h-3 w-3" /> Signature not checked
                </span>
              )}
              {ext.source.repo && (
                <a
                  href={`https://${ext.source.host}/${ext.source.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                  {ext.source.host === 'github.com' ? '' : `${ext.source.host}/`}{ext.source.repo}
                </a>
              )}
            </div>
          </div>
        </SettingsSection>

        {ext.screenshots.length > 0 && (
          <SettingsSection id="screenshots" title="Screenshots">
            <ScreenshotGallery images={ext.screenshots} name={ext.name} />
          </SettingsSection>
        )}

        {changeRows.some((r) => r.changelog) && (
          <SettingsSection id="changes" title={changesTitle}>
            <ChangelogEntries entries={changeRows.map((r) => ({ version: r.version, publishedAt: r.publishedAt, changelog: r.changelog, notes: r.notes ?? undefined }))} />
          </SettingsSection>
        )}

        <SettingsSection
          id="versions"
          title="Versions"
          description="Every published version. Versions this server still has a copy of can be put back without the directory."
        >
          {/* relative: the header's sr-only text is absolute, and only a positioned scroller clips it. Left free, it widens a phone's layout viewport and every dialog goes with it. */}
          <div className="relative overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className={thClass}>Version</th>
                  <th className={thClass}>Released</th>
                  <th className={thClass}>Needs Bulwark</th>
                  <th className={thClass}>Size</th>
                  <th className={thClass}>Status</th>
                  <th className={cn(thClass, 'text-end')}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {ext.versions.map((v) => {
                  const isInstalled = data.installed && data.installedVersion === v.version;
                  const isPreview = preview?.version === v.version;
                  const kept = historyVersions.has(v.version);
                  const runs = fits(v);
                  const key = `install:${v.version}`;
                  return (
                    <tr key={v.version} className={isPreview ? 'bg-muted/40' : undefined}>
                      <td className={tdClass}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="font-mono text-xs text-foreground">v{v.version}</code>
                          {v.channel === 'beta' && <Badge tone="info">beta</Badge>}
                          {v.signed && <ShieldCheck className="h-3 w-3 text-muted-foreground" aria-label="signed" />}
                          <ChangelogBadges flags={v.notes ?? undefined} />
                        </div>
                        {v.changelog && (
                          <details className="mt-1 max-w-md">
                            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Changelog</summary>
                            <ChangelogNotes markdown={v.changelog} className="mt-1.5" />
                          </details>
                        )}
                      </td>
                      <td className={cn(tdClass, 'whitespace-nowrap text-xs text-muted-foreground')}>{fmtDate(v.publishedAt)}</td>
                      <td className={cn(tdClass, 'whitespace-nowrap text-xs text-muted-foreground')}>
                        {v.minAppVersion ?? 'any'}{v.maxAppVersion ? ` to ${v.maxAppVersion}` : v.minAppVersion ? '+' : ''}
                      </td>
                      <td className={cn(tdClass, 'whitespace-nowrap text-xs text-muted-foreground')}>{fmtSize(v.size)}</td>
                      <td className={cn(tdClass, 'text-xs')}>
                        <div className="flex flex-col items-start gap-1">
                          {isInstalled && <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><Check className="h-3 w-3" /> Installed</span>}
                          {v.yanked && <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-300" title={v.yanked.reason ?? undefined}><AlertTriangle className="h-3 w-3" /> Withdrawn</span>}
                          {!runs && <span className="text-muted-foreground">Not for v{CURRENT_APP_VERSION}</span>}
                          {kept && !isInstalled && <span className="inline-flex items-center gap-1 text-muted-foreground"><RotateCcw className="h-3 w-3" /> Kept here</span>}
                        </div>
                      </td>
                      <td className={tdClass}>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {!isPreview && (
                            <Button variant="ghost" size="sm" className={cn(smallButtonClass, 'text-muted-foreground hover:text-foreground')} onClick={() => pick(v.version)} title="Preview this version">
                              <Eye className="h-3 w-3" /> Preview
                            </Button>
                          )}
                          {kept && !isInstalled && data.installed && (
                            <Button variant="outline" size="sm" className={smallButtonClass} onClick={() => handleRollback(v.version)} disabled={!!busy}>
                              {busy === `rollback:${v.version}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                              Roll back
                            </Button>
                          )}
                          {!isInstalled && !kept && runs && !suspended && (
                            <Button
                              variant="outline"
                              size="sm"
                              className={smallButtonClass}
                              onClick={() => handleInstall(v.version)}
                              disabled={!!busy}
                              title={v.yanked ? 'Withdrawn; you will be asked to confirm' : undefined}
                            >
                              {busy === key ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                              {v.yanked ? 'Install anyway' : 'Install'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {extraHistory.map((h) => (
                  <tr key={`kept-${h.version}`}>
                    <td className={tdClass}>
                      <code className="font-mono text-xs text-foreground">v{h.version}</code>
                      <p className="mt-0.5 text-xs text-muted-foreground">No longer in the directory</p>
                    </td>
                    <td className={cn(tdClass, 'whitespace-nowrap text-xs text-muted-foreground')}>replaced {fmtDate(h.savedAt)}</td>
                    <td className={cn(tdClass, 'text-xs text-muted-foreground')}>–</td>
                    <td className={cn(tdClass, 'text-xs text-muted-foreground')}>–</td>
                    <td className={cn(tdClass, 'text-xs')}>
                      <span className="inline-flex items-center gap-1 text-muted-foreground"><RotateCcw className="h-3 w-3" /> Kept here</span>
                    </td>
                    <td className={tdClass}>
                      <div className="flex justify-end">
                        {data.installed && (
                          <Button variant="outline" size="sm" className={smallButtonClass} onClick={() => handleRollback(h.version)} disabled={!!busy}>
                            {busy === `rollback:${h.version}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                            Roll back
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {ext.versions.length === 0 && extraHistory.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">No versions published.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </SettingsSection>

        {!isPlugin && ext.themePreviews.length > 0 && (
          <SettingsSection id="theme-preview" title="Theme preview">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {ext.themePreviews.map(preview => (
                preview.url
                  ? (
                    <figure key={preview.variant} className="overflow-hidden rounded-md border border-border">
                      <img src={preview.url} alt={`${ext.name} in ${preview.variant} mode`} className="block w-full bg-muted" loading="lazy" />
                      <figcaption className="border-t border-border bg-muted/30 px-3 py-2 text-xs font-medium capitalize text-muted-foreground">{preview.variant}</figcaption>
                    </figure>
                  )
                  : <ThemeColorSwatch key={preview.variant} preview={preview} />
              ))}
            </div>
          </SettingsSection>
        )}

        {isPlugin && (
          <SettingsSection
            id="permissions"
            title="Permissions"
            description={manifestPerms.length === 0
              ? 'This plugin requests no permissions.'
              : `What ${ext.name}${preview ? ` ${preview.version}` : ''} may do in each user's mailbox.`}
          >
            {manifestPerms.length > 0 && (
              <ul className="space-y-1.5">
                {manifestPerms.map(perm => {
                  const text = permissionText.get(perm);
                  const risky = text?.highRisk || RISKY_PERMISSIONS.has(perm) || HIGH_RISK_PERMISSIONS.has(perm);
                  return (
                    <li
                      key={perm}
                      className={cn(
                        'flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
                        risky
                          ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
                          : 'bg-muted/50 text-foreground',
                      )}
                    >
                      {risky ? <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-50" />}
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {text && <span className="font-medium">{text.title}</span>}
                          <code className="font-mono text-xs opacity-80">{perm}</code>
                          {addedPermissions.has(perm) && <Badge tone="warning">New in this version</Badge>}
                        </div>
                        {text?.body && <p className="mt-0.5 text-xs opacity-90">{text.body}</p>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {frameOrigins.length > 0 && (
              <div className="border-t border-border pt-3">
                <h4 className="text-xs font-medium text-foreground">Iframe origins</h4>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The plugin will be allowed to embed content from these origins.
                </p>
                <ul className="mt-2 space-y-1">
                  {frameOrigins.map(origin => (
                    <li key={origin} className="rounded bg-muted/50 px-2 py-1 font-mono text-xs text-foreground">
                      {origin}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </SettingsSection>
        )}

        {isPlugin && settingsSchema && Object.keys(settingsSchema).length > 0 && (
          <SettingsSection id="user-settings" title="User settings" description="Settings users will be able to configure after install.">
            <ul className="divide-y divide-border">
              {Object.entries(settingsSchema).map(([key, field]) => (
                <li key={key} className="py-2">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-xs text-foreground">{key}</code>
                    <Badge>{field.type}</Badge>
                  </div>
                  <div className="mt-0.5 text-sm text-foreground">{field.label}</div>
                  {field.description && (
                    <div className="mt-0.5 text-xs text-muted-foreground">{field.description}</div>
                  )}
                </li>
              ))}
            </ul>
          </SettingsSection>
        )}

        {bundle.manifest && (
          <SettingsSection id="manifest" title="Manifest">
            <div className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setShowManifest(v => !v)}
                aria-expanded={showManifest}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-start transition-colors hover:bg-muted/30"
              >
                <span className="flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">manifest.json</span>
                </span>
                {showManifest ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
              {showManifest && (
                <pre className="overflow-x-auto whitespace-pre px-4 pb-4 font-mono text-xs text-foreground">
                  {JSON.stringify(bundle.manifest, null, 2)}
                </pre>
              )}
            </div>
          </SettingsSection>
        )}

        {bundle.source && (
          <SettingsSection id="source" title="Source">
            <div className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setShowSource(v => !v)}
                aria-expanded={showSource}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-start transition-colors hover:bg-muted/30"
              >
                <span className="flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">{bundle.source.name}</span>
                  {bundle.source.truncated && <Badge tone="warning">truncated</Badge>}
                </span>
                {showSource ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
              {showSource && (
                <pre className="max-h-[600px] overflow-x-auto overflow-y-auto whitespace-pre px-4 pb-4 font-mono text-xs text-foreground">
                  {bundle.source.content}
                </pre>
              )}
            </div>
          </SettingsSection>
        )}
      </div>
    </div>
  );
}

const NOTICE_TONES = {
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300',
  info: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300',
} as const;

function Notice({ tone, title, children }: { tone: 'info' | 'warning' | 'danger'; title: string; children?: React.ReactNode }) {
  const Icon = tone === 'danger' ? ShieldAlert : tone === 'warning' ? AlertTriangle : Info;
  return (
    <div className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm', NOTICE_TONES[tone])}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        {children && <p className="mt-0.5 text-xs opacity-90">{children}</p>}
      </div>
    </div>
  );
}

function ThemeColorSwatch({ preview }: { preview: { variant: 'light' | 'dark'; colors: Record<string, string> | null } }) {
  const colors = preview.colors || {};
  const bg = colors.background || (preview.variant === 'dark' ? '#0f0f10' : '#ffffff');
  const fg = colors.foreground || (preview.variant === 'dark' ? '#fafafa' : '#0a0a0a');
  const accent = colors.primary || colors.accent || '#7c5cff';
  const muted = colors.muted || (preview.variant === 'dark' ? '#1a1a1c' : '#f5f5f5');
  const border = colors.border || (preview.variant === 'dark' ? '#27272a' : '#e5e5e5');

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/30 border-b border-border capitalize">
        {preview.variant}
      </div>
      <div className="p-3 space-y-2" style={{ background: bg, color: fg }}>
        <div className="flex items-center gap-2">
          <span className="inline-block w-6 h-6 rounded" style={{ background: accent }} />
          <span className="text-sm font-medium" style={{ color: fg }}>Sample text</span>
        </div>
        <div className="rounded p-2 text-xs" style={{ background: muted, border: `1px solid ${border}` }}>
          <span style={{ color: fg }}>Card surface</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(colors).slice(0, 6).map(([key, value]) => (
            <span
              key={key}
              title={`${key}: ${value}`}
              className="inline-block w-4 h-4 rounded border"
              style={{ background: value, borderColor: border }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
