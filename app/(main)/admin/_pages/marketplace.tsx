'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Search, Download, Check, Loader2, Store, Puzzle, SwatchBook, Star, Eye, AlertTriangle,
  ArrowUpCircle, ExternalLink, RefreshCw, Ban, ShieldAlert, Info, Upload,
} from '@/components/icons';
import { apiFetch } from '@/lib/browser-navigation';
import { compareVersions } from '@/lib/version-compare';
import type { MarketplaceListing } from '@/lib/admin/marketplace-directory';
import { adminPageDef, adminPath } from '@/lib/admin/admin-nav';
import { cn } from '@/lib/utils';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { AdminPageHeader } from '@/components/admin/page-header';
import { AdminLink } from '@/components/admin/admin-link';
import { AdminButtonLink } from '@/components/admin/button-link';
import { AdminList, AdminListRow } from '@/components/admin/list';
import { Badge } from '@/components/admin/badge';
import { EmptyState } from '@/components/admin/empty-state';
import { useAdminFeedback } from '@/components/admin/feedback';
import { ConfigNote, inputClass } from '@/components/admin/config-items';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { ChangelogBadges, ChangelogEntries, anyFlag, type ChangelogEntry, type ChangelogFlags } from '@/components/admin/changelog';
import { PluginPermissionList } from '@/components/plugins/plugin-permission-list';
import { offerToTurnOnPlugins, pluginsOffForUsers, turnOnNote, type TurnOnOutcome } from './turn-on-plugins';
import { pluginTypeLabel } from './plugin-type-label';

const CURRENT_APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';

interface SearchResult {
  data: MarketplaceListing[];
  meta: { page: number; perPage: number; total: number };
  channel: 'stable' | 'beta';
  directoryUrl: string;
}

interface InstalledEntry {
  id: string;
  kind: 'plugin' | 'theme';
  name: string;
  version: string;
  enabled: boolean;
  source: { kind: 'marketplace'; slug: string; directoryUrl: string } | { kind: 'upload' } | null;
}

interface UpdatesResult {
  installed: InstalledEntry[];
  updates: Array<{
    addedPermissions?: string[];
    slug: string; currentVersion: string; version: string; channel: 'stable' | 'beta'; publishedAt: string | null;
    changelog: string | null; notes?: ChangelogFlags; changelogs?: ChangelogEntry[];
  }>;
  yanked: Array<{ slug: string; version: string; reason: string | null; at: string }>;
  deprecated: Array<{ slug: string; message: string | null; replacement: string | null }>;
  suspended: string[];
  advisories: Array<{ id: string; extension: string; severity: string; summary: string; fixedIn: string | null; installedVersion?: string }>;
  unknown: string[];
  directoryUrl: string;
  channel: 'stable' | 'beta';
  error: string | null;
}

type TypeFilter = 'all' | 'plugin' | 'theme';
type Sort = 'created' | 'downloads' | 'updated' | 'name';
type View = 'browse' | 'installed';

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'created', label: 'Newest' },
  { value: 'downloads', label: 'Most downloaded' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'name', label: 'Name' },
];

const PAGE = adminPageDef('marketplace');

export const detailHref = (slug: string, version?: string | null) =>
  `${adminPath('marketplace', slug)}${version ? `?version=${encodeURIComponent(version)}` : ''}`;

/**
 * The notes an update brings: every version between the installed one and
 * the offered one, or, from a directory older than 2026-10-30, the offered
 * version's alone.
 */
function updateNotes(u: UpdatesResult['updates'][number]): ChangelogEntry[] {
  if (u.changelogs?.length) return u.changelogs;
  return [{ version: u.version, publishedAt: u.publishedAt ?? null, changelog: u.changelog, notes: u.notes }];
}

/** The segmented Browse / Installed and All / Plugins / Themes switches. */
const pillGroupClass = 'flex items-center gap-0.5 rounded-md bg-muted p-0.5 self-start';
const pillClass = (active: boolean) => cn(
  'h-8 rounded px-3 text-sm font-medium transition-colors',
  active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
);

/**
 * Installs one version of an extension. A version the publisher withdrew,
 * or one older than the installed version, comes back as 409; the admin is
 * asked (in the page's ConfirmDialog), and the install is repeated with
 * `force` if they insist. A version that asks for more than the admin saw
 * (more permissions than the installed version, or on a first install than
 * the directory's listing) comes back the same way, and is repeated with the
 * ones the admin was then shown. `shown`: what the calling page already
 * showed for a first install, sent as accepted from the start. "Update all"
 * goes through here too, so it asks about each. Returns the error text to
 * show, or null.
 */
export interface InstallQuestion {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
}

export async function installVersion(
  body: { slug: string; version: string; type: 'plugin' | 'theme' },
  confirm: (question: InstallQuestion) => boolean | Promise<boolean>,
  opts: { shown?: { permissions: readonly string[] } } = {},
): Promise<{ ok: true; warnings: string[]; signature: string | null; updated: boolean } | { ok: false; error: string }> {
  let force = false;
  let acceptPermissions: string[] | undefined = opts.shown ? [...opts.shown.permissions] : undefined;
  let askedPermissions = false;
  const send = () => apiFetch('/api/admin/marketplace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...(force ? { force: true } : {}), ...(acceptPermissions ? { acceptPermissions } : {}) }),
  });
  try {
    let res = await send();
    // At most one of each question: withdrawn or older, then permissions.
    for (let asked = 0; res.status === 409 && asked < 3; asked += 1) {
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.permissionsAdded) && !askedPermissions) {
        askedPermissions = true;
        const added = data.permissionsAdded as string[];
        // What the calling page already showed is not asked about again.
        const fresh = added.filter((p) => !acceptPermissions?.includes(p));
        const names = (fresh.length > 0 ? fresh : added).join(', ');
        const firstInstall = data.compared === 'listing';
        const question = firstInstall
          ? {
              title: 'Allow what the listing did not show?',
              message: `${body.slug} ${body.version} asks for permissions that the directory's listing did not show: ${names}.`,
              confirmText: 'Install',
            }
          : {
              title: 'Allow the new permissions?',
              message: `${body.slug} ${body.version} asks for new permissions that the installed version doesn't have: ${names}.`,
              confirmText: 'Update',
            };
        if (!(await confirm({ ...question, cancelText: 'Cancel' }))) {
          return { ok: false, error: 'Not installed.' };
        }
        acceptPermissions = [...new Set([...(acceptPermissions ?? []), ...added])];
      } else if (data.yanked && !force) {
        if (!(await confirm({ title: 'Install it anyway?', message: data.error, confirmText: 'Install', cancelText: 'Cancel' }))) {
          return { ok: false, error: 'Not installed.' };
        }
        force = true;
      } else if (data.downgrade && !force) {
        if (!(await confirm({ title: 'Install the older version anyway?', message: data.error, confirmText: 'Install', cancelText: 'Cancel' }))) {
          return { ok: false, error: 'Not installed.' };
        }
        force = true;
      } else {
        return { ok: false, error: data.error || 'Installation failed' };
      }
      res = await send();
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || 'Installation failed' };
    return { ok: true, warnings: data.warnings ?? [], signature: data.signature ?? null, updated: !!data.updated };
  } catch {
    return { ok: false, error: 'Installation failed - network error' };
  }
}

export function MarketplacePage() {
  const { dialogProps: confirmProps, confirm } = useConfirmDialog();
  const [extensions, setExtensions] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [sort, setSort] = useState<Sort>('created');
  const [view, setView] = useState<View>('browse');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [perPage] = useState(12);
  const [directoryUrl, setDirectoryUrl] = useState<string | null>(null);
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const setMessage = useAdminFeedback();
  const [error, setError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<UpdatesResult | null>(null);
  const [updatesLoading, setUpdatesLoading] = useState(true);
  // A plugin's quick install asks first, with what it may do (themes don't).
  const [quickInstall, setQuickInstall] = useState<MarketplaceListing | null>(null);
  // Whether plugins are off for users, so the one quick-install dialog can offer to
  // turn them on too instead of asking again after installing. null: not known yet.
  const [quickPluginsOff, setQuickPluginsOff] = useState<boolean | null>(null);
  useEffect(() => {
    if (!quickInstall) return;
    let current = true;
    setQuickPluginsOff(null);
    void pluginsOffForUsers().then((off) => { if (current) setQuickPluginsOff(off); });
    return () => { current = false; };
  }, [quickInstall]);

  const fetchExtensions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (typeFilter !== 'all') params.set('type', typeFilter);
      params.set('page', String(page));
      params.set('perPage', String(perPage));
      params.set('sort', sort);
      params.set('order', sort === 'name' ? 'asc' : 'desc');

      const res = await apiFetch(`/api/admin/marketplace?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to connect to extension directory');
        setExtensions([]);
        return;
      }

      const data: SearchResult = await res.json();
      setExtensions(data.data || []);
      setTotal(data.meta?.total || 0);
      setDirectoryUrl(data.directoryUrl ?? null);
      setChannel(data.channel ?? 'stable');
    } catch {
      setError('Failed to connect to extension directory. Make sure it is running.');
      setExtensions([]);
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter, page, perPage, sort]);

  const fetchUpdates = useCallback(async () => {
    setUpdatesLoading(true);
    try {
      const res = await apiFetch('/api/admin/marketplace/updates');
      if (res.ok) setUpdates(await res.json());
    } catch { /* the strip just stays empty */ } finally {
      setUpdatesLoading(false);
    }
  }, []);

  useEffect(() => { fetchExtensions(); }, [fetchExtensions]);
  useEffect(() => { fetchUpdates(); }, [fetchUpdates]);

  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const markInstalling = (slug: string, on: boolean) => setInstalling((prev) => {
    const next = new Set(prev);
    if (on) next.add(slug); else next.delete(slug);
    return next;
  });

  /** `turnOn`: the admin already said whether to turn plugins on for users; otherwise they're asked after installing. */
  async function install(ext: { slug: string; name: string; type: 'plugin' | 'theme' }, version: string, isUpdate: boolean, turnOn?: boolean) {
    markInstalling(ext.slug, true);
    setMessage(null);
    const result = await installVersion({ slug: ext.slug, version, type: ext.type }, confirm);
    markInstalling(ext.slug, false);
    if (!result.ok) {
      setMessage({ type: 'error', text: result.error });
      return false;
    }
    const warnings = result.warnings.length ? ` (${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'})` : '';
    const signed = result.signature === 'verified' ? ', signed by the directory' : '';
    const outcome: TurnOnOutcome = !isUpdate && ext.type === 'plugin'
      ? await offerToTurnOnPlugins(turnOn === undefined ? confirm : () => turnOn)
      : 'already-on';
    setMessage({
      type: 'success',
      text: isUpdate
        ? `"${ext.name}" updated to v${version}${signed}${warnings}`
        : `"${ext.name}" installed (v${version})${signed}${warnings}.${turnOnNote(outcome)}`,
    });
    setExtensions((prev) => prev.map((e) => (e.slug === ext.slug
      ? { ...e, installed: true, installedVersion: version, installedSource: { kind: 'marketplace', slug: ext.slug, directoryUrl: directoryUrl ?? '' } }
      : e)));
    fetchUpdates();
    return true;
  }

  async function updateAll() {
    if (!updates) return;
    const byId = new Map(updates.installed.map((e) => [e.id, e]));
    let failed = 0;
    for (const u of updates.updates) {
      const entry = byId.get(u.slug);
      if (!entry) continue;
      const ok = await install({ slug: u.slug, name: entry.name, type: entry.kind }, u.version, true);
      if (!ok) failed++;
    }
    setMessage(failed
      ? { type: 'error', text: `${failed} update${failed === 1 ? '' : 's'} failed; see above` }
      : { type: 'success', text: `All ${updates.updates.length} update${updates.updates.length === 1 ? '' : 's'} installed` });
  }

  const totalPages = Math.ceil(total / perPage);
  const installedCount = updates?.installed.length ?? 0;
  const noticeCount = updates
    ? updates.updates.length + updates.yanked.length + updates.advisories.length + updates.deprecated.length + updates.suspended.length
    : 0;

  return (
    <div>
      <AdminPageHeader
        title={PAGE.label}
        description={PAGE.description}
        actions={(
          <>
            {channel === 'beta' && (
              <Badge tone="info" title="Pre-release versions are offered (extensionDirectoryChannel)">Beta channel</Badge>
            )}
            {directoryUrl && (
              <AdminButtonLink external href={directoryUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" />
                Open directory
              </AdminButtonLink>
            )}
          </>
        )}
      />

      <ConfirmDialog {...confirmProps} />
      <Dialog
        isOpen={quickInstall !== null}
        onClose={() => setQuickInstall(null)}
        role="alertdialog"
        showClose={false}
        title={`Install ${quickInstall?.name ?? ''}?`}
        description={`${quickInstall?.author ? `By ${quickInstall.author.displayName}. ` : ''}${quickPluginsOff
          ? 'It is installed for every user. Plugins are off for users, so it only runs once you turn them on.'
          : 'It is installed for every user and turned on for them; they can turn it off in their settings.'} What it may do in each mailbox:`}
        footer={(
          <>
            <Button variant="outline" onClick={() => setQuickInstall(null)}>Cancel</Button>
            {quickPluginsOff && (
              <Button
                variant="outline"
                onClick={() => {
                  const ext = quickInstall;
                  setQuickInstall(null);
                  if (ext?.latestVersion) void install(ext, ext.latestVersion, false, false);
                }}
              >
                Install only
              </Button>
            )}
            <Button
              disabled={quickPluginsOff === null}
              onClick={() => {
                const ext = quickInstall;
                const turnOn = quickPluginsOff ?? false;
                setQuickInstall(null);
                if (ext?.latestVersion) void install(ext, ext.latestVersion, false, turnOn);
              }}
            >
              {quickPluginsOff ? 'Install and turn on plugins' : 'Install'}
            </Button>
          </>
        )}
      >
        {quickInstall && (
          <div className="mt-3 max-h-64 overflow-y-auto" data-testid="quick-install-permissions">
            <PluginPermissionList permissions={quickInstall.permissions ?? []} compact />
          </div>
        )}
      </Dialog>

      <div className="space-y-10">
        {updates && noticeCount > 0 && (
          <UpdatesSection
            updates={updates}
            installing={installing}
            onUpdate={(u) => {
              const entry = updates.installed.find((e) => e.id === u.slug);
              if (entry) install({ slug: u.slug, name: entry.name, type: entry.kind }, u.version, true);
            }}
            onUpdateAll={updateAll}
          />
        )}

        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className={pillGroupClass}>
              {([['browse', 'Browse'], ['installed', `Installed${installedCount ? ` (${installedCount})` : ''}`]] as const).map(([v, label]) => (
                <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} className={pillClass(view === v)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="relative min-w-0 flex-1 sm:min-w-56">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder={view === 'browse' ? 'Search extensions...' : 'Filter installed...'}
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                aria-label={view === 'browse' ? 'Search extensions' : 'Filter installed'}
                className={cn(inputClass, 'w-full ps-9')}
              />
            </div>
            {view === 'browse' && (
              <>
                <div className={cn(pillGroupClass, 'sm:self-auto')}>
                  {(['all', 'plugin', 'theme'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { setTypeFilter(t); setPage(1); }}
                      aria-pressed={typeFilter === t}
                      className={pillClass(typeFilter === t)}
                    >
                      {t === 'all' ? 'All' : t === 'plugin' ? 'Plugins' : 'Themes'}
                    </button>
                  ))}
                </div>
                <select
                  value={sort}
                  onChange={(e) => { setSort(e.target.value as Sort); setPage(1); }}
                  aria-label="Sort"
                  className={cn(inputClass, 'cursor-pointer self-start pe-8 sm:self-auto')}
                >
                  {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </>
            )}
          </div>

          {view === 'installed' ? (
            <InstalledView
              updates={updates}
              loading={updatesLoading}
              filter={query}
              installing={installing}
              onUpdate={(entry, version) => install({ slug: entry.id, name: entry.name, type: entry.kind }, version, true)}
            />
          ) : (
            <>
              {error && (
                <EmptyState
                  icon={Store}
                  title={error}
                  hint="The directory needs its v2 API (extensions.bulwarkmail.org has it; a self-hosted one must be from October 2026 or later)"
                  action={<Button size="sm" onClick={fetchExtensions}>Retry</Button>}
                />
              )}

              {loading && !error && (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                  <Loader2 className="me-2 h-4 w-4 animate-spin" /> Loading
                </div>
              )}

              {!loading && !error && extensions.length === 0 && (
                <EmptyState
                  icon={Store}
                  title="No extensions found"
                  hint={query ? 'Try a different search term' : undefined}
                />
              )}

              {!loading && !error && extensions.length > 0 && (
                <>
                  <div className="text-xs text-muted-foreground">
                    {total} extension{total !== 1 ? 's' : ''} found
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {extensions.map((ext) => (
                      <ExtensionCard
                        key={ext.slug}
                        extension={ext}
                        installing={installing.has(ext.slug)}
                        onInstall={() => {
                          if (!ext.latestVersion) return;
                          if (ext.type === 'plugin' && !ext.installed) setQuickInstall(ext);
                          else void install(ext, ext.latestVersion, ext.installed);
                        }}
                      />
                    ))}
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 pt-2">
                      <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
                        Previous
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        Page {page} of {totalPages}
                      </span>
                      <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
                        Next
                      </Button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Updates and warnings for what is installed, from one directory request. */
function UpdatesSection({
  updates,
  installing,
  onUpdate,
  onUpdateAll,
}: {
  updates: UpdatesResult;
  installing: Set<string>;
  onUpdate: (u: UpdatesResult['updates'][number]) => void;
  onUpdateAll: () => void;
}) {
  const names = new Map(updates.installed.map((e) => [e.id, e.name]));
  const name = (slug: string) => names.get(slug) ?? slug;
  const busy = installing.size > 0;
  const hasNotices = updates.advisories.length > 0 || updates.yanked.length > 0 || updates.suspended.length > 0 || updates.deprecated.length > 0;
  const title = updates.updates.length > 0
    ? `${updates.updates.length} update${updates.updates.length === 1 ? '' : 's'} available`
    : 'Notices';

  return (
    <SettingsSection id="updates" title={title}>
      {updates.updates.length > 0 && (
        <div className="space-y-3">
          {updates.updates.length > 1 && (
            <div className="flex justify-end">
              <Button size="sm" className="gap-1.5" onClick={onUpdateAll} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Update all
              </Button>
            </div>
          )}
          <ul className="divide-y divide-border rounded-lg border border-border">
            {updates.updates.map((u) => {
              const entries = updateNotes(u);
              const withNotes = entries.filter((e) => e.changelog);
              return (
                <li key={u.slug} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <AdminLink href={detailHref(u.slug, u.version)} className="font-medium text-foreground hover:underline">{name(u.slug)}</AdminLink>
                      <span className="text-muted-foreground">v{u.currentVersion} → v{u.version}</span>
                      {u.channel === 'beta' && <Badge tone="info">beta</Badge>}
                      <ChangelogBadges flags={{ security: anyFlag(entries, 'security'), breaking: anyFlag(entries, 'breaking') }} />
                    </div>
                    {(u.addedPermissions?.length ?? 0) > 0 && (
                      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300" data-testid={`update-permissions-${u.slug}`}>
                        New permissions: <span className="font-mono">{u.addedPermissions!.join(', ')}</span>
                      </p>
                    )}
                    {withNotes.length > 0 ? (
                      <details className="mt-1" data-testid={`update-notes-${u.slug}`}>
                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                          {entries.length > 1 ? `What's new in ${entries.length} versions` : "What's new"}
                        </summary>
                        <div className="mt-2 max-h-80 overflow-y-auto pe-2">
                          <ChangelogEntries entries={entries} />
                        </div>
                      </details>
                    ) : (
                      <p className="mt-0.5 text-xs text-muted-foreground">No changelog for this update.</p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 self-start text-xs"
                    onClick={() => onUpdate(u)}
                    disabled={installing.has(u.slug)}
                  >
                    {installing.has(u.slug) ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
                    Update
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {hasNotices && (
        <ul className="space-y-2 text-sm">
          {updates.advisories.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-destructive">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <AdminLink href={detailHref(a.extension)} className="font-medium hover:underline">{name(a.extension)}</AdminLink>
                {' '}has a security advisory ({a.severity}): {a.summary}
                {a.fixedIn ? ` Fixed in v${a.fixedIn}.` : ' No fixed version yet.'}
              </span>
            </li>
          ))}
          {updates.suspended.map((slug) => (
            <li key={slug} className="flex items-start gap-2 text-destructive">
              <Ban className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <AdminLink href={detailHref(slug)} className="font-medium hover:underline">{name(slug)}</AdminLink>
                {' '}was suspended by the directory. Consider removing it.
              </span>
            </li>
          ))}
          {updates.yanked.map((y) => (
            <li key={`${y.slug}@${y.version}`} className="flex items-start gap-2 text-amber-800 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The installed v{y.version} of{' '}
                <AdminLink href={detailHref(y.slug)} className="font-medium hover:underline">{name(y.slug)}</AdminLink>
                {' '}was withdrawn by its publisher{y.reason ? `: ${y.reason}` : '.'}
              </span>
            </li>
          ))}
          {updates.deprecated.map((d) => (
            <li key={d.slug} className="flex items-start gap-2 text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <AdminLink href={detailHref(d.slug)} className="font-medium text-foreground hover:underline">{name(d.slug)}</AdminLink>
                {' '}is deprecated{d.message ? `: ${d.message}` : '.'}
                {d.replacement && <> Use <AdminLink href={detailHref(d.replacement)} className="underline">{d.replacement}</AdminLink> instead.</>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

/** Everything installed here, with where it came from and whether it can be updated. */
function InstalledView({
  updates,
  loading,
  filter,
  installing,
  onUpdate,
}: {
  updates: UpdatesResult | null;
  loading: boolean;
  filter: string;
  installing: Set<string>;
  onUpdate: (entry: InstalledEntry, version: string) => void;
}) {
  const rows = useMemo(() => {
    if (!updates) return [];
    const q = filter.trim().toLowerCase();
    const newer = new Map(updates.updates.map((u) => [u.slug, u.version]));
    const yanked = new Set(updates.yanked.map((y) => y.slug));
    const advisories = new Set(updates.advisories.map((a) => a.extension));
    return updates.installed
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q))
      .map((e) => ({ entry: e, newer: newer.get(e.id) ?? null, yanked: yanked.has(e.id), advisory: advisories.has(e.id) }));
  }, [updates, filter]);

  if (loading && !updates) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        <Loader2 className="me-2 h-4 w-4 animate-spin" /> Loading
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState icon={Store} title={filter ? 'Nothing installed matches' : 'Nothing installed yet'} />
    );
  }

  return (
    <div className="space-y-3">
      {updates?.error && (
        <ConfigNote tone="warning">Could not check for updates: {updates.error}</ConfigNote>
      )}
      <AdminList>
        {rows.map(({ entry, newer, yanked, advisory }) => {
          const fromMarketplace = entry.source?.kind === 'marketplace' || entry.source === null;
          const manageHref = entry.kind === 'plugin' ? adminPath('plugins', entry.id) : adminPath('themes', entry.id);
          return (
            <AdminListRow
              key={`${entry.kind}:${entry.id}`}
              href={fromMarketplace ? detailHref(entry.id) : undefined}
              icon={entry.kind === 'plugin' ? <Puzzle /> : <SwatchBook />}
              title={entry.name}
              wideControl
              titleExtra={(
                <>
                  <span className="text-xs text-muted-foreground">v{entry.version}</span>
                  {!entry.enabled && <Badge>Off</Badge>}
                  {entry.source?.kind === 'upload'
                    ? <Badge icon={<Upload className="h-3 w-3" />}>Uploaded</Badge>
                    : <Badge icon={<Store className="h-3 w-3" />}>Marketplace</Badge>}
                  {advisory && <Badge tone="danger" icon={<ShieldAlert className="h-3 w-3" />}>Advisory</Badge>}
                  {yanked && <Badge tone="warning" icon={<AlertTriangle className="h-3 w-3" />}>Withdrawn</Badge>}
                </>
              )}
              control={(
                <>
                  {newer && (
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => onUpdate(entry, newer)}
                      disabled={installing.has(entry.id)}
                    >
                      {installing.has(entry.id) ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
                      Update to v{newer}
                    </Button>
                  )}
                  <AdminButtonLink href={manageHref} className="h-8 text-xs">Manage</AdminButtonLink>
                </>
              )}
            />
          );
        })}
      </AdminList>
    </div>
  );
}

function Rating({ rating }: { rating: { average: number; count: number } }) {
  if (!rating.count) return null;
  return (
    <span className="inline-flex items-center gap-1" title={`${rating.average} out of 5 from ${rating.count} rating${rating.count === 1 ? '' : 's'}`}>
      <Star className="w-3 h-3 fill-current" />
      {rating.average.toFixed(1)}
      <span className="opacity-70">({rating.count})</span>
    </span>
  );
}

function ExtensionCard({
  extension,
  installing,
  onInstall,
}: {
  extension: MarketplaceListing;
  installing: boolean;
  onInstall: () => void;
}) {
  const isPlugin = extension.type === 'plugin';
  const previewHref = detailHref(extension.slug);
  const offered = extension.latest;
  const updateAvailable = extension.installed
    && !!extension.installedVersion
    && !!offered
    && compareVersions(offered.version, extension.installedVersion) > 0;

  return (
    <div className="group relative border border-border rounded-lg overflow-hidden hover:border-ring/30 transition-colors">
      {extension.bannerUrl && (
        <AdminLink href={previewHref} className="block focus:outline-none">
          <img
            src={extension.bannerUrl}
            alt=""
            className="block h-24 w-full object-cover border-b border-border"
            loading="lazy"
          />
        </AdminLink>
      )}
      <AdminLink href={previewHref} className="block p-4 focus:outline-hidden rounded-lg">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center shrink-0 overflow-hidden">
            {extension.iconUrl ? (
              <img
                src={extension.iconUrl}
                alt=""
                className="w-10 h-10 object-cover"
                loading="lazy"
              />
            ) : isPlugin ? (
              <Puzzle className="w-5 h-5 text-muted-foreground" />
            ) : (
              <SwatchBook className="w-5 h-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-foreground truncate group-hover:underline">
                {extension.name}
              </span>
              {extension.featured && (
                <Star className="w-3.5 h-3.5 text-warning shrink-0 fill-warning" />
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <Badge tone={isPlugin ? 'info' : 'accent'}>
                {isPlugin ? pluginTypeLabel(extension.pluginType) : 'Theme'}
              </Badge>
              {offered?.channel === 'beta' && <Badge tone="info">beta</Badge>}
              {extension.deprecated && <Badge>deprecated</Badge>}
              {extension.author && (
                <span className="text-xs text-muted-foreground truncate">
                  by {extension.author.displayName}
                </span>
              )}
            </div>
          </div>
        </div>

        <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
          {extension.description}
        </p>

        {extension.tags && extension.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {extension.tags.slice(0, 3).map(tag => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Download className="w-3 h-3" />
              {extension.totalDownloads.toLocaleString()}
            </span>
            <Rating rating={extension.rating} />
            {extension.permissions && extension.permissions.length > 0 && (
              <span title={extension.permissions.join(', ')}>
                {extension.permissions.length} permission{extension.permissions.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
            <Eye className="w-3 h-3" />
            Details
          </span>
        </div>
      </AdminLink>

      <div className="px-4 pb-4 -mt-1 flex items-center gap-2 flex-wrap">
        {extension.installed && updateAvailable && offered ? (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onInstall(); }}
            disabled={installing}
            title={`Update from v${extension.installedVersion} to v${offered.version}`}
          >
            {installing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <ArrowUpCircle className="w-3 h-3" />
            )}
            Update to v{offered.version}
          </Button>
        ) : extension.installed ? (
          <Badge
            tone="success"
            icon={<Check className="w-3 h-3" />}
            title={extension.installedVersion ? `Installed: v${extension.installedVersion}` : undefined}
          >
            Installed{extension.installedVersion ? ` v${extension.installedVersion}` : ''}
          </Badge>
        ) : !offered ? (
          <Badge
            tone="warning"
            icon={<AlertTriangle className="w-3 h-3" />}
            title={`No published version runs on Bulwark v${CURRENT_APP_VERSION}. Open the details to see what the newest version needs.`}
          >
            Not for v{CURRENT_APP_VERSION}
          </Badge>
        ) : (
          <Button
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onInstall(); }}
            disabled={installing}
            title={`Install v${offered.version}`}
          >
            {installing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            Quick install
          </Button>
        )}
      </div>
    </div>
  );
}
