'use client';

import { useTranslations } from 'next-intl';
import { X } from '@/components/icons';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';

interface InlineAppViewProps {
  apps: InlineAppState[];
  activeAppId: string;
  onClose: () => void;
  className?: string;
}

export function InlineAppView({ apps, activeAppId, onClose, className }: InlineAppViewProps) {
  const tCommon = useTranslations('common');
  const activeApp = apps.find((a) => a.id === activeAppId);

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header bar */}
      <div data-window-top-row="" className="flex items-center justify-between px-4 py-2 border-b border-border bg-secondary/50 flex-shrink-0">
        <h3 className="text-sm font-medium truncate">{activeApp?.name}</h3>
        <IconButton label={tCommon("close")} onClick={onClose} className="text-muted-foreground" data-pane-close="">
          <X />
        </IconButton>
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
