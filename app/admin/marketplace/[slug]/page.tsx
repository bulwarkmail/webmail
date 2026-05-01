'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
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
  AlertTriangle,
  FileCode,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { apiFetch } from '@/lib/browser-navigation';

interface PreviewData {
  extension: {
    slug: string;
    name: string;
    type: 'plugin' | 'theme';
    pluginType: string | null;
    description: string;
    longDescription: string | null;
    tags: string[];
    permissions: string[];
    totalDownloads: number;
    featured: boolean;
    githubRepo: string | null;
    license: string | null;
    minAppVersion: string | null;
    author: {
      displayName: string;
      githubLogin: string;
      avatarUrl: string | null;
      verified?: boolean;
    } | null;
    latestVersion: string | null;
    versions: Array<{
      version: string;
      changelog: string | null;
      bundleSize: number;
      minAppVersion: string | null;
      publishedAt: string | null;
      permissions: string[];
    }>;
    screenshots: Array<{ url: string; altText: string | null }>;
    themePreviews: Array<{
      variant: 'light' | 'dark';
      previewPath: string;
      colors: Record<string, string> | null;
    }>;
    createdAt: string | null;
    updatedAt: string | null;
  };
  bundle: {
    manifest: Record<string, unknown> | null;
    source: { name: string; content: string; truncated: boolean } | null;
    size: number;
    error: string | null;
  };
  installed: boolean;
}

const RISKY_PERMISSIONS = new Set([
  'mail:write',
  'mail:delete',
  'storage:write',
  'network',
  'admin',
]);

export default function MarketplacePreviewPage() {
  const params = useParams();
  const slug = params.slug as string;

  const [data, setData] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [showManifest, setShowManifest] = useState(false);

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/marketplace/${encodeURIComponent(slug)}`);
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

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  async function handleInstall() {
    if (!data) return;
    setInstalling(true);
    setMessage(null);
    try {
      const res = await apiFetch('/api/admin/marketplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: data.extension.slug,
          version: data.extension.latestVersion || '1.0.0',
          type: data.extension.type,
        }),
      });
      const body = await res.json();
      if (res.ok) {
        const warnings = body.warnings?.length ? ` (${body.warnings.length} warning(s))` : '';
        setMessage({ type: 'success', text: `"${data.extension.name}" installed${warnings}` });
        setData(prev => prev ? { ...prev, installed: true } : prev);
      } else {
        setMessage({ type: 'error', text: body.error || 'Installation failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Installation failed - network error' });
    } finally {
      setInstalling(false);
    }
  }

  async function handleUninstall() {
    if (!data) return;
    if (!confirm(`Remove "${data.extension.name}"? This cannot be undone.`)) return;

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
        setData(prev => prev ? { ...prev, installed: false } : prev);
      } else {
        setMessage({ type: 'error', text: body.error || 'Uninstall failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Uninstall failed - network error' });
    } finally {
      setUninstalling(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link
          href="/admin/marketplace"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Marketplace
        </Link>
        <p className="text-sm text-destructive">{error || 'Extension not found'}</p>
      </div>
    );
  }

  const ext = data.extension;
  const bundle = data.bundle;
  const isPlugin = ext.type === 'plugin';
  const manifestPerms = (bundle.manifest?.permissions as string[] | undefined) || ext.permissions || [];
  const frameOrigins = (bundle.manifest?.frameOrigins as string[] | undefined) || [];
  const settingsSchema = bundle.manifest?.settingsSchema as Record<string, { type: string; label: string; description?: string; default?: unknown }> | undefined;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Back link */}
      <Link
        href="/admin/marketplace"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Marketplace
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex items-start gap-4 flex-1 min-w-0">
          <div className="w-14 h-14 rounded-lg bg-muted flex items-center justify-center shrink-0">
            {isPlugin ? (
              <Puzzle className="w-7 h-7 text-muted-foreground" />
            ) : (
              <SwatchBook className="w-7 h-7 text-muted-foreground" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="text-2xl font-semibold text-foreground break-words min-w-0">{ext.name}</h1>
              {ext.featured && <Star className="w-4 h-4 text-warning fill-warning shrink-0" />}
              {data.installed && (
                <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400 font-medium">
                  <Check className="w-3 h-3" /> Installed
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground flex-wrap">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                isPlugin
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400'
                  : 'bg-purple-100 text-purple-700 dark:bg-purple-950/30 dark:text-purple-400'
              }`}>
                {isPlugin ? (ext.pluginType || 'plugin') : 'theme'}
              </span>
              {ext.author && (
                <span>by {ext.author.displayName}</span>
              )}
              {ext.latestVersion && <span>v{ext.latestVersion}</span>}
              {ext.license && <span>{ext.license}</span>}
              <span className="inline-flex items-center gap-1">
                <Download className="w-3 h-3" />
                {ext.totalDownloads.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {data.installed ? (
            <>
              <Link
                href={isPlugin ? `/admin/plugins/${ext.slug}` : '/admin/themes'}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                <SettingsIcon className="w-4 h-4" />
                Manage
              </Link>
              <button
                onClick={handleUninstall}
                disabled={uninstalling}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-50 transition-colors"
              >
                {uninstalling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Uninstall
              </button>
            </>
          ) : (
            <button
              onClick={handleInstall}
              disabled={installing || !!bundle.error}
              className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {installing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              Install
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className={`text-sm rounded-md px-3 py-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      {bundle.error && (
        <div className="flex items-start gap-2 text-sm rounded-md px-3 py-2 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Could not preview bundle</p>
            <p className="text-xs mt-0.5 opacity-90">{bundle.error}</p>
          </div>
        </div>
      )}

      {/* Description */}
      <section className="border border-border rounded-lg p-4">
        <h2 className="text-sm font-medium text-foreground">About</h2>
        <p className="text-sm text-muted-foreground mt-2">{ext.description}</p>
        {ext.longDescription && ext.longDescription !== ext.description && (
          <p className="text-sm text-muted-foreground mt-3 whitespace-pre-wrap">{ext.longDescription}</p>
        )}
        {ext.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {ext.tags.map(tag => (
              <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-4 pt-3 border-t border-border flex-wrap">
          {ext.minAppVersion && <span>Requires app v{ext.minAppVersion}+</span>}
          {bundle.size > 0 && <span>Bundle: {(bundle.size / 1024).toFixed(1)} KB</span>}
          {ext.githubRepo && (
            <a
              href={`https://github.com/${ext.githubRepo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ExternalLink className="w-3 h-3" />
              {ext.githubRepo}
            </a>
          )}
        </div>
      </section>

      {/* Screenshots */}
      {ext.screenshots.length > 0 && (
        <section className="border border-border rounded-lg p-4">
          <h2 className="text-sm font-medium text-foreground">Screenshots</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            {ext.screenshots.map((s, i) => (
              <img
                key={i}
                src={s.url}
                alt={s.altText || `Screenshot ${i + 1}`}
                className="w-full rounded-md border border-border bg-muted"
                loading="lazy"
              />
            ))}
          </div>
        </section>
      )}

      {/* Theme color preview */}
      {!isPlugin && ext.themePreviews.length > 0 && (
        <section className="border border-border rounded-lg p-4">
          <h2 className="text-sm font-medium text-foreground">Theme preview</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            {ext.themePreviews.map(preview => (
              <ThemeColorSwatch key={preview.variant} preview={preview} />
            ))}
          </div>
        </section>
      )}

      {/* Permissions */}
      {isPlugin && (
        <section className="border border-border rounded-lg p-4">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">Permissions</h2>
          </div>
          {manifestPerms.length === 0 ? (
            <p className="text-sm text-muted-foreground mt-2">This plugin requests no permissions.</p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {manifestPerms.map(perm => {
                const risky = RISKY_PERMISSIONS.has(perm);
                return (
                  <li
                    key={perm}
                    className={`flex items-center gap-2 text-sm rounded-md px-2 py-1 ${
                      risky
                        ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
                        : 'bg-muted/50 text-foreground'
                    }`}
                  >
                    {risky && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                    <code className="font-mono text-xs">{perm}</code>
                  </li>
                );
              })}
            </ul>
          )}
          {frameOrigins.length > 0 && (
            <div className="mt-4 pt-3 border-t border-border">
              <h3 className="text-xs font-medium text-foreground">Iframe origins</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                The plugin will be allowed to embed content from these origins.
              </p>
              <ul className="mt-2 space-y-1">
                {frameOrigins.map(origin => (
                  <li key={origin} className="text-xs font-mono text-foreground bg-muted/50 px-2 py-1 rounded">
                    {origin}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Settings schema preview */}
      {isPlugin && settingsSchema && Object.keys(settingsSchema).length > 0 && (
        <section className="border border-border rounded-lg p-4">
          <h2 className="text-sm font-medium text-foreground">User settings</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Settings users will be able to configure after install.</p>
          <ul className="mt-3 divide-y divide-border">
            {Object.entries(settingsSchema).map(([key, field]) => (
              <li key={key} className="py-2">
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono text-foreground">{key}</code>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{field.type}</span>
                </div>
                <div className="text-sm text-foreground mt-0.5">{field.label}</div>
                {field.description && (
                  <div className="text-xs text-muted-foreground mt-0.5">{field.description}</div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Source / manifest disclosure */}
      {bundle.manifest && (
        <section className="border border-border rounded-lg">
          <button
            onClick={() => setShowManifest(v => !v)}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-foreground">manifest.json</h2>
            </div>
            {showManifest ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
          {showManifest && (
            <pre className="px-4 pb-4 text-xs font-mono overflow-x-auto text-foreground whitespace-pre">
              {JSON.stringify(bundle.manifest, null, 2)}
            </pre>
          )}
        </section>
      )}

      {bundle.source && (
        <section className="border border-border rounded-lg">
          <button
            onClick={() => setShowSource(v => !v)}
            className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-center gap-2">
              <FileCode className="w-4 h-4 text-muted-foreground" />
              <h2 className="text-sm font-medium text-foreground">{bundle.source.name}</h2>
              {bundle.source.truncated && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">truncated</span>
              )}
            </div>
            {showSource ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>
          {showSource && (
            <pre className="px-4 pb-4 text-xs font-mono overflow-x-auto text-foreground whitespace-pre max-h-[600px] overflow-y-auto">
              {bundle.source.content}
            </pre>
          )}
        </section>
      )}

      {/* Version history */}
      {ext.versions.length > 0 && (
        <section className="border border-border rounded-lg p-4">
          <h2 className="text-sm font-medium text-foreground">Version history</h2>
          <ul className="mt-3 divide-y divide-border">
            {ext.versions.slice(0, 5).map(v => (
              <li key={v.version} className="py-2 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-foreground">v{v.version}</code>
                    {v.publishedAt && (
                      <span className="text-xs text-muted-foreground">
                        {new Date(v.publishedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {v.changelog && (
                    <p className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap">{v.changelog}</p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {(v.bundleSize / 1024).toFixed(1)} KB
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
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
