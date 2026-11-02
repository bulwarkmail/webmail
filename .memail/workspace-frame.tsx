'use client';

import type { ReactNode } from 'react';
import { Keyboard, Mail } from '../components/icons';

/** A downstream shell only: the native list and reader keep their identities. */
export function WorkspaceShell({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  if (!enabled) return <>{children}</>;
  return <div className="flex flex-1 flex-col min-h-0 min-w-0 gap-3" data-memail-workspace="">{children}</div>;
}

export function WorkspaceQueue({ count, unread, hasMore, loading, onShortcuts, onOpenUnread }: {
  count: number; unread: number; hasMore: boolean; loading: boolean; onShortcuts: () => void; onOpenUnread?: () => void;
}) {
  return <footer className="hidden shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-4 py-2 text-xs text-muted-foreground md:flex" aria-label="Conversation queue">
    <div className="flex items-center gap-4"><span role="status" className="tabular-nums">{loading ? 'Loading conversations…' : `${count}${hasMore ? '+' : ''} loaded · ${unread} unread`}</span>
      <button type="button" disabled={loading || !onOpenUnread} onClick={onOpenUnread} className="inline-flex items-center gap-2 font-medium text-foreground hover:text-primary disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring"><Mail className="size-4" aria-hidden="true" />Open unread</button>
    </div>
    <button type="button" onClick={onShortcuts} className="inline-flex items-center gap-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label="Show mail keyboard shortcuts"><Keyboard className="size-4" aria-hidden="true" /><span>Keyboard shortcuts</span></button>
  </footer>;
}
