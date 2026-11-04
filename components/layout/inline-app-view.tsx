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
              app.id !== activeAppId && 'hidden'
            )}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ))}
      </div>
    </div>
  );
}
