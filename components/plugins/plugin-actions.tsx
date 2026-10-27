'use client';

import { useSyncExternalStore, useState } from 'react';
import { useTranslations } from 'next-intl';
import { iconForName, MoreHorizontal, Puzzle } from '@/components/icons';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { cn } from '@/lib/utils';
import {
  actionApplies,
  actionsFor,
  badgeText,
  runAction,
  subscribeActions,
  type RegisteredAction,
} from '@/lib/plugin-sandbox/actions';

const EMPTY: RegisteredAction[] = [];

/** The actions plugins declared for a surface, filtered by folder role or MIME type. */
export function usePluginActions(surface: string, filter: { mailboxRole?: string | null; mimeType?: string | null } = {}) {
  const all = useSyncExternalStore(subscribeActions, () => actionsFor(surface), () => EMPTY);
  return all.filter((a) => actionApplies(a, filter));
}

interface PluginActionsProps {
  /** A surface of kind 'action' in lib/plugin-slot-catalog.ts. */
  surface: string;
  /** What the click is about (ids of the message, files, ...). Filtered per plugin before it is sent. */
  context: Record<string, unknown>;
  /** Buttons in a toolbar row, or entries in a menu. */
  variant?: 'buttons' | 'menu';
  mailboxRole?: string | null;
  mimeType?: string | null;
  className?: string;
  /** Icon-only buttons with the label as tooltip (narrow toolbars). */
  compact?: boolean;
  /** No room for buttons: one "more" button that opens the actions as a menu. */
  overflow?: boolean;
  /** Called after a click, e.g. to close the menu the entry sits in. */
  onRan?: () => void;
}

/**
 * Buttons or menu entries plugins declared with api.ui.setActions. The host
 * draws them so they match the app; the plugin gets the click.
 */
export function PluginActions({ surface, context, variant = 'buttons', mailboxRole, mimeType, className, compact, overflow, onRan }: PluginActionsProps) {
  const actions = usePluginActions(surface, { mailboxRole, mimeType });
  const [busy, setBusy] = useState<string | null>(null);
  if (actions.length === 0) return null;
  if (overflow && variant === 'buttons') {
    return <PluginActionsOverflow surface={surface} context={context} mailboxRole={mailboxRole} mimeType={mimeType} className={className} />;
  }

  const run = async (action: RegisteredAction) => {
    const key = `${action.pluginId}:${action.id}`;
    setBusy(key);
    try {
      onRan?.();
      await runAction(action, surface, context);
    } finally {
      setBusy((current) => (current === key ? null : current));
    }
  };

  if (variant === 'menu') {
    return (
      <>
        {actions.map((action) => (
          <ContextMenuItem
            key={`${action.pluginId}:${action.id}`}
            icon={iconForName(action.icon) ?? Puzzle}
            label={action.label}
            title={action.pluginName}
            destructive={action.danger}
            shortcut={action.badge ? badgeText(action.badge) : undefined}
            onClick={() => { void run(action); }}
          />
        ))}
      </>
    );
  }

  return (
    <div className={cn('inline-flex flex-wrap items-center gap-1', className)} data-plugin-actions={surface}>
      {actions.map((action) => {
        const Icon = iconForName(action.icon) ?? Puzzle;
        const key = `${action.pluginId}:${action.id}`;
        return (
          <button
            key={key}
            type="button"
            disabled={busy === key}
            title={compact ? `${action.label} (${action.pluginName})` : action.pluginName}
            aria-label={action.label}
            onClick={(e) => { e.stopPropagation(); void run(action); }}
            className={cn(
              'relative inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:opacity-50',
              action.badge && 'bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary',
              action.danger && 'text-destructive hover:bg-destructive/10 hover:text-destructive',
            )}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {!compact && <span className="whitespace-nowrap">{action.label}</span>}
            {/* The count as the search's filter button draws its own. */}
            {action.badge ? (
              <span
                data-plugin-action-badge=""
                className="absolute -top-1 -end-1 flex items-center justify-center min-w-4 h-4 px-1 text-[10px] font-bold rounded-full bg-primary text-primary-foreground"
              >
                {badgeText(action.badge)}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The actions of a surface behind one "more" button, for toolbars without room for them. */
function PluginActionsOverflow({ surface, context, mailboxRole, mimeType, className }: Pick<PluginActionsProps, 'surface' | 'context' | 'mailboxRole' | 'mimeType' | 'className'>) {
  const t = useTranslations('email_viewer');
  const { contextMenu, openContextMenu, closeContextMenu, menuRef } = useContextMenu<true>();
  return (
    <div className={cn('inline-flex items-center', className)} data-plugin-actions={surface} data-plugin-actions-overflow="">
      <button
        type="button"
        title={t('more_actions')}
        aria-label={t('more_actions')}
        aria-haspopup="menu"
        aria-expanded={contextMenu.isOpen}
        onClick={(e) => { e.stopPropagation(); openContextMenu(e, true); }}
        className={cn(
          'inline-flex h-8 items-center rounded-md px-2 text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        <PluginActions
          surface={surface}
          variant="menu"
          context={context}
          mailboxRole={mailboxRole}
          mimeType={mimeType}
          onRan={closeContextMenu}
        />
      </ContextMenu>
    </div>
  );
}
