'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from '@/components/icons';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';
import { useCloseBesideControls } from '@/hooks/use-close-beside-controls';

interface InlineAppViewProps {
  apps: InlineAppState[];
  activeAppId: string;
  onClose: () => void;
  className?: string;
}

export function InlineAppView({ apps, activeAppId, onClose, className }: InlineAppViewProps) {
  const tCommon = useTranslations('common');
  const activeApp = apps.find((a) => a.id === activeAppId);
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(header);
  // Until an app's first load its frame holds the initial about:blank. That
  // document's color scheme is "normal" while the frame element inherits the
  // theme's, and CSS Color Adjust gives such a mismatch an opaque canvas: in a
  // dark theme WebKit paints the app area white until the app arrives (#1517).
  // Each frame stays invisible until it has loaded, so this view's background
  // shows meanwhile.
  const [loadedAppIds, setLoadedAppIds] = useState<ReadonlySet<string>>(() => new Set());
  const markLoaded = (appId: string) =>
    setLoadedAppIds((prev) => (prev.has(appId) ? prev : new Set(prev).add(appId)));
  const close = (
    <IconButton label={tCommon("close")} onClick={onClose} className="shrink-0 text-muted-foreground">
      <X />
    </IconButton>
  );

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header bar */}
      <div ref={setHeader} data-window-top-row="" className="flex items-center gap-2 px-4 py-2 border-b border-border bg-secondary/50 flex-shrink-0">
        {closeFirst && close}
        <h3 className="min-w-0 flex-1 text-sm font-medium truncate">{activeApp?.name}</h3>
        {!closeFirst && close}
      </div>
      {/* Iframes - active one visible, rest hidden but alive */}
      <div className="flex-1 relative">
        {apps.map((app) => (
          <iframe
            key={app.id}
            src={app.url}
            title={app.name}
            className={cn(
              'absolute inset-0 w-full h-full border-0',
              app.id !== activeAppId && 'hidden',
              !loadedAppIds.has(app.id) && 'invisible'
            )}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            loading="lazy"
            onLoad={() => markLoaded(app.id)}
          />
        ))}
      </div>
    </div>
  );
}
