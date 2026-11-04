'use client';

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useBottomControls } from '@/hooks/use-bottom-controls';
import { useAdminShell } from './shell-context';

interface AdminSaveBarProps {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  /** Drops the edits; without it the bar offers only Save. */
  onDiscard?: () => void;
  saveLabel?: string;
  /** What the save does, e.g. "Users get the change within 15 minutes". */
  note?: ReactNode;
}

/**
 * The one place a page saves from. It appears at the bottom of the panel
 * while something is unsaved (through the shell's portal host, so it sits
 * below the scrolling content and above the mobile rail) and takes Ctrl+S.
 * It registers as a bottom bar, so toasts sit above it instead of over its
 * buttons.
 */
export function AdminSaveBar({ dirty, saving = false, onSave, onDiscard, saveLabel = 'Save changes', note }: AdminSaveBarProps) {
  const host = useAdminShell()?.saveBarHost ?? null;
  const barRef = useBottomControls(dirty);

  useEffect(() => {
    if (!dirty) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!saving) onSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dirty, saving, onSave]);

  if (!dirty) return null;

  const bar = (
    <div
      ref={barRef}
      role="region"
      aria-label="Unsaved changes"
      data-testid="admin-save-bar"
      className="border-t border-border bg-background px-4 py-3 sm:px-6"
    >
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <span className="font-medium text-foreground">Unsaved changes</span>
          {note && <span className="text-muted-foreground"> &middot; {note}</span>}
        </div>
        <div className="flex items-center gap-2">
          {onDiscard && (
            <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
          )}
          <Button type="button" size="sm" onClick={onSave} disabled={saving} className="gap-2">
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );

  return host ? createPortal(bar, host) : bar;
}
