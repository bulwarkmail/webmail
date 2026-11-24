'use client';

import { useLayoutEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X } from '@/components/icons';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';
import type { InlineAppState } from '@/hooks/use-sidebar-apps';
import { useCloseBesideControls } from '@/hooks/use-close-beside-controls';
import { useSidebarAppFramesStore } from '@/stores/sidebar-app-frames-store';

interface InlineAppViewProps {
  app: InlineAppState;
  onClose: () => void;
  className?: string;
}

/**
 * The pane of an open inline app: its title bar, and the place its frame is
 * shown. The frame itself lives in the layout (SidebarAppFramesHost) and is
 * laid over this pane, so it keeps its document across pages.
 */
export function InlineAppView({ app, onClose, className }: InlineAppViewProps) {
  const tCommon = useTranslations('common');
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(header);

  useLayoutEffect(() => {
    if (!slot) return;
    const store = useSidebarAppFramesStore.getState();
    store.show(app.id, slot);
    return () => useSidebarAppFramesStore.getState().hide(slot);
  }, [app.id, slot]);

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
        <h3 className="min-w-0 flex-1 text-sm font-medium truncate">{app.name}</h3>
        {!closeFirst && close}
      </div>
      <div ref={setSlot} data-inline-app-slot={app.id} className="flex-1 relative" />
    </div>
  );
}
