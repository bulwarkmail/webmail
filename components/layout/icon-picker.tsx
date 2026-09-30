'use client';

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { iconForName, loadAllIconNames, POPULAR_ICON_NAMES, toStoredIconName, toTablerName } from '@/components/icons';
import { Search, X } from '@/components/icons';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

interface IconPickerProps {
  value: string;
  onChange: (iconName: string) => void;
  className?: string;
}

export function IconPicker({ value, onChange, className }: IconPickerProps) {
  const t = useTranslations('sidebar_apps');
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // The full Tabler list is a separate chunk, fetched the first time "show all"
  // is opened. Names are Tabler's kebab-case names; the stored value carries a
  // `tabler:` prefix (older settings hold Lucide names, see toTablerName).
  const [allIconNames, setAllIconNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!showAll || allIconNames) return;
    let live = true;
    loadAllIconNames().then((names) => { if (live) setAllIconNames(names); });
    return () => { live = false; };
  }, [showAll, allIconNames]);

  const selected = toTablerName(value);

  const filteredIcons = useMemo(() => {
    const source = showAll ? allIconNames ?? POPULAR_ICON_NAMES : POPULAR_ICON_NAMES;
    const q = search.trim().toLowerCase().replace(/\s+/g, '-');
    // Without a search the full list is capped; typing narrows it.
    if (!q) return source.slice(0, 600);
    return source.filter(name => name.includes(q));
  }, [search, showAll, allIconNames]);

  const renderIcon = useCallback((name: string) => {
    const IconComponent = iconForName(toStoredIconName(name));
    if (!IconComponent) return null;
    return <IconComponent className="w-5 h-5" />;
  }, []);

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('search_icons')}
            className="ps-8 h-8 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowAll(!showAll)}
          className={cn(
            'text-xs px-2 py-1 rounded-md border transition-colors whitespace-nowrap',
            showAll
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'bg-muted text-muted-foreground border-border hover:text-foreground'
          )}
        >
          {showAll ? t('show_popular') : t('show_all')}
        </button>
      </div>
      <div
        ref={gridRef}
        className="grid grid-cols-8 gap-1 max-h-[200px] overflow-y-auto p-1 border rounded-md bg-muted/30"
      >
        {filteredIcons.map(name => (
          <button
            key={name}
            type="button"
            onClick={() => onChange(toStoredIconName(name))}
            title={name}
            className={cn(
              'flex items-center justify-center w-8 h-8 rounded-md transition-colors',
              selected === name
                ? 'bg-primary text-primary-foreground'
                : 'hover:bg-muted text-muted-foreground hover:text-foreground'
            )}
          >
            {renderIcon(name)}
          </button>
        ))}
        {filteredIcons.length === 0 && (
          <p className="col-span-8 py-4 text-center text-xs text-muted-foreground">
            {t('no_icons_found')}
          </p>
        )}
      </div>
    </div>
  );
}
