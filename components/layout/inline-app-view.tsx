'use client';

import { X } from '@/components/icons';
import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';

interface InlineAppViewProps {
  apps: InlineAppState[];
  activeAppId: string;
  onClose: () => void;
  className?: string;
}

export function InlineAppView({ apps, activeAppId, onClose, className }: InlineAppViewProps) {
  const activeApp = apps.find((a) => a.id === activeAppId);

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-secondary/50 flex-shrink-0">
        <h3 className="text-sm font-medium truncate">{activeApp?.name}</h3>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
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
