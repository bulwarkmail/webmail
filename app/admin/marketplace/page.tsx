'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Search, Download, Check, Loader2, Store, Puzzle, SwatchBook, Star, Eye } from 'lucide-react';
import { apiFetch } from '@/lib/browser-navigation';

interface Extension {
  slug: string;
  name: string;
  type: 'plugin' | 'theme';
  pluginType: string | null;
  description: string;
  permissions: string[];
  tags: string[];
  totalDownloads: number;
  featured: boolean;
  minAppVersion: string | null;
  latestVersion: string | null;
  installed: boolean;
  author: {
    displayName: string;
    githubLogin: string;
    avatarUrl: string | null;
  } | null;
}

interface SearchResult {
  data: Extension[];
  meta: {
    page: number;
    perPage: number;
    total: number;
  };
}

type TypeFilter = 'all' | 'plugin' | 'theme';

export default function AdminMarketplacePage() {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [perPage] = useState(12);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchExtensions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (typeFilter !== 'all') params.set('type', typeFilter);
      params.set('page', String(page));
      params.set('perPage', String(perPage));
      params.set('sort', 'newest');

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
    } catch {
      setError('Failed to connect to extension directory. Make sure it is running.');
      setExtensions([]);
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter, page, perPage]);

  useEffect(() => {
    fetchExtensions();
  }, [fetchExtensions]);

  // Debounced search
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  async function handleInstall(ext: Extension) {
    setInstalling(ext.slug);
    setMessage(null);

    try {
      const res = await apiFetch('/api/admin/marketplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: ext.slug,
          version: ext.latestVersion || '1.0.0',
          type: ext.type,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        const warnings = data.warnings?.length ? ` (${data.warnings.length} warning(s))` : '';
        setMessage({ type: 'success', text: `"${ext.name}" installed successfully${warnings}` });
        // Mark as installed in the UI
        setExtensions(prev => prev.map(e => e.slug === ext.slug ? { ...e, installed: true } : e));
      } else {
        setMessage({ type: 'error', text: data.error || 'Installation failed' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Installation failed - network error' });
    } finally {
      setInstalling(null);
    }
  }

  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Marketplace</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Browse and install plugins and themes from the BulwarkMail extension directory
        </p>
      </div>

      {message && (
        <div className={`text-sm rounded-md px-3 py-2 ${message.type === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-destructive/10 text-destructive'}`}>
          {message.text}
        </div>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search extensions..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/20 focus:border-ring"
          />
        </div>
        <div className="flex items-center gap-1 rounded-md border border-input bg-background p-0.5 self-start sm:self-auto">
          {(['all', 'plugin', 'theme'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTypeFilter(t); setPage(1); }}
              className={`h-8 px-3 rounded text-sm font-medium transition-colors ${
                typeFilter === t
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'all' ? 'All' : t === 'plugin' ? 'Plugins' : 'Themes'}
            </button>
          ))}
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="border border-border rounded-lg p-12 text-center">
          <Store className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Start the extension directory server on the configured port
          </p>
          <button
            onClick={fetchExtensions}
            className="mt-4 inline-flex items-center gap-2 h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading State */}
      {loading && !error && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">Searching extensions...</span>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && extensions.length === 0 && (
        <div className="border border-border rounded-lg p-12 text-center">
          <Store className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No extensions found</p>
          {query && (
            <p className="text-xs text-muted-foreground mt-1">
              Try a different search term
            </p>
          )}
        </div>
      )}

      {/* Extension Grid */}
      {!loading && !error && extensions.length > 0 && (
        <>
          <div className="text-xs text-muted-foreground">
            {total} extension{total !== 1 ? 's' : ''} found
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {extensions.map((ext) => (
              <ExtensionCard
                key={ext.slug}
                extension={ext}
                installing={installing === ext.slug}
                onInstall={() => handleInstall(ext)}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="h-8 px-3 rounded-md border border-border text-sm text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="h-8 px-3 rounded-md border border-border text-sm text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ExtensionCard({
  extension,
  installing,
  onInstall,
}: {
  extension: Extension;
  installing: boolean;
  onInstall: () => void;
}) {
  const isPlugin = extension.type === 'plugin';
  const previewHref = `/admin/marketplace/${encodeURIComponent(extension.slug)}`;

  return (
    <div className="group relative border border-border rounded-lg overflow-hidden hover:border-ring/30 transition-colors">
      <Link href={previewHref} className="block p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-lg">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-md bg-muted flex items-center justify-center shrink-0">
            {isPlugin ? (
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
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                isPlugin
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400'
                  : 'bg-purple-100 text-purple-700 dark:bg-purple-950/30 dark:text-purple-400'
              }`}>
                {isPlugin ? (extension.pluginType || 'plugin') : 'theme'}
              </span>
              {extension.author && (
                <span className="text-xs text-muted-foreground truncate">
                  by {extension.author.displayName}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
          {extension.description}
        </p>

        {/* Tags */}
        {extension.tags && extension.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {extension.tags.slice(0, 3).map(tag => (
              <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Footer (download count + permissions) */}
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Download className="w-3 h-3" />
              {extension.totalDownloads.toLocaleString()}
            </span>
            {extension.permissions && extension.permissions.length > 0 && (
              <span title={extension.permissions.join(', ')}>
                {extension.permissions.length} permission{extension.permissions.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
            <Eye className="w-3 h-3" />
            Preview
          </span>
        </div>
      </Link>

      {/* Quick install button (sits over the link, stops navigation) */}
      <div className="px-4 pb-4 -mt-1">
        {extension.installed ? (
          <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400 text-xs font-medium">
            <Check className="w-3 h-3" />
            Installed
          </span>
        ) : (
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onInstall(); }}
            disabled={installing}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {installing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            Quick install
          </button>
        )}
      </div>
    </div>
  );
}
