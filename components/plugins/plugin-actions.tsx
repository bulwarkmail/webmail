'use client';

import { useMemo, useSyncExternalStore, useState } from 'react';
import { useTranslations } from 'next-intl';
import { iconForName, Puzzle } from '@/components/icons';
import { ContextMenu, ContextMenuItem } from '@/components/ui/context-menu';
import { useContextMenu } from '@/hooks/use-context-menu';
import { cn } from '@/lib/utils';
import {
  actionApplies,
  actionsFor,
  badgeText,
  runAction,
  subscribeActions,
  type ActionFilter,
  type RegisteredAction,
} from '@/lib/plugin-sandbox/actions';
import { mailAccountKind, useConfirmedGroups, type MailAccountKind } from '@/lib/plugin-sandbox/account-kind';
import type { Email } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { resolveEmailBlobContext, useEmailStore } from '@/stores/email-store';

const EMPTY: RegisteredAction[] = [];

/** The actions plugins declared for a surface, filtered by folder role, MIME type, account and keywords. */
export function usePluginActions(surface: string, filter: ActionFilter = {}) {
  const all = useSyncExternalStore(subscribeActions, () => actionsFor(surface), () => EMPTY);
  return all.filter((a) => actionApplies(a, filter));
}

/** The message an action surface is about: its account and keywords. */
export interface MessageActionTarget {
  /** The JMAP account the message is in, when it isn't the signed-in account's own. */
  accountId?: string;
  accountKind: MailAccountKind | null;
  keywords: string[] | null;
}

type ActionEmail = Pick<Email, 'id' | 'keywords' | 'sourceAccountId' | 'sourceClientAccountId'>;

/**
 * The account and keywords of `email`, for the actions' `accounts`,
 * `hasKeyword` and `notKeyword` and the click's `accountId`. Follows the
 * server's answer on which accounts are groups, so a team mailbox's
 * actions appear once it is in.
 */
export function useMessageActionTarget(email: ActionEmail | null | undefined): MessageActionTarget {
  const groups = useConfirmedGroups((s) => s.revision);
  const client = useAuthStore((s) => s.client);
  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const keywords = email?.keywords;
  const keywordKey = keywords ? Object.keys(keywords).filter((k) => keywords[k]).sort().join(' ') : '';
  const sourceAccountId = email?.sourceAccountId;
  const sourceClientAccountId = email?.sourceClientAccountId;
  const hasEmail = !!email;
  return useMemo(() => {
    if (!hasEmail) return { accountKind: null, keywords: null };
    const owner = resolveEmailBlobContext({ sourceAccountId, sourceClientAccountId }, client);
    const own = owner.client?.getAccountId?.();
    const accountId = owner.accountId && owner.accountId !== own ? owner.accountId : undefined;
    return {
      ...(accountId ? { accountId } : {}),
      accountKind: owner.client ? mailAccountKind(owner.client, owner.accountId) : null,
      keywords: keywordKey ? keywordKey.split(' ') : [],
    };
    // The group lists, the open folder and its mailboxes decide the account
    // (resolveEmailBlobContext reads them from the stores).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEmail, keywordKey, sourceAccountId, sourceClientAccountId, client, groups, selectedMailbox, mailboxes]);
}

/** The account kind of the open folder, for surfaces about the selection (message-bulk-actions). */
export function useFolderAccountKind(): MailAccountKind | null {
  const groups = useConfirmedGroups((s) => s.revision);
  const client = useAuthStore((s) => s.client);
  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  return useMemo(() => {
    const owner = resolveEmailBlobContext({}, client);
    return owner.client ? mailAccountKind(owner.client, owner.accountId) : null;
    // See useMessageActionTarget.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, groups, selectedMailbox, mailboxes]);
}

/** The context a message action's click carries: the surface's, plus the message's account. */
function withTarget(context: Record<string, unknown>, target: MessageActionTarget | undefined): Record<string, unknown> {
  return target?.accountId ? { ...context, accountId: target.accountId } : context;
}

function targetFilter(target: MessageActionTarget | undefined, accountKind: MailAccountKind | null | undefined): Pick<ActionFilter, 'accountKind' | 'keywords'> {
  return { accountKind: target ? target.accountKind : accountKind ?? null, keywords: target?.keywords ?? null };
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
  /** The message the surface is about (useMessageActionTarget). */
  target?: MessageActionTarget;
  /** Surfaces about the selection: the open folder's account kind. */
  accountKind?: MailAccountKind | null;
  /**
   * The buttons join their toolbar's overflow measurement, on one line, and
   * give way before the toolbar's own items. Buttons that gave way are named
   * by `data-plugin-action-key`, for `only` on the toolbar's menu.
   */
  overflowItems?: boolean;
  /** Draw only these actions, by `data-plugin-action-key`. */
  only?: ReadonlySet<string>;
}

/** Above every item of a toolbar's own, so that a plugin's button gives way first. */
const PLUGIN_OVERFLOW_PRIORITY_BASE = 100;

/**
 * Buttons or menu entries plugins declared with api.ui.setActions. The host
 * draws them so they match the app; the plugin gets the click.
 */
export function PluginActions({ surface, context, variant = 'buttons', mailboxRole, mimeType, className, compact, overflow, onRan, target, accountKind, overflowItems, only }: PluginActionsProps) {
  const applicable = usePluginActions(surface, { mailboxRole, mimeType, ...targetFilter(target, accountKind) });
  const actions = only ? applicable.filter((a) => only.has(`${a.pluginId}:${a.id}`)) : applicable;
  const [busy, setBusy] = useState<string | null>(null);
  if (actions.length === 0) return null;
  if (overflow && variant === 'buttons') {
    return <PluginActionsOverflow surface={surface} context={context} mailboxRole={mailboxRole} mimeType={mimeType} className={className} target={target} accountKind={accountKind} />;
  }

  const run = async (action: RegisteredAction) => {
    const key = `${action.pluginId}:${action.id}`;
    setBusy(key);
    try {
      onRan?.();
      await runAction(action, surface, withTarget(context, target));
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
            badge={action.badge ? badgeText(action.badge) : undefined}
            onClick={() => { void run(action); }}
          />
        ))}
      </>
    );
  }

  return (
    <div className={cn('inline-flex items-center gap-1', overflowItems ? 'flex-nowrap' : 'flex-wrap', className)} data-plugin-actions={surface}>
      {actions.map((action, index) => {
        const Icon = iconForName(action.icon) ?? Puzzle;
        const key = `${action.pluginId}:${action.id}`;
        return (
          <button
            key={key}
            type="button"
            disabled={busy === key}
            title={compact ? `${action.label} (${action.pluginName})` : action.pluginName}
            aria-label={action.label}
            {...(overflowItems ? {
              'data-overflow-item': '',
              'data-overflow-priority': PLUGIN_OVERFLOW_PRIORITY_BASE + index,
              'data-plugin-action-key': key,
            } : {})}
            onClick={(e) => { e.stopPropagation(); void run(action); }}
            className={cn(
              'relative inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors',
              'hover:bg-muted hover:text-foreground focus-visible:outline-hidden',
              'disabled:opacity-50',
              action.badge && 'bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary',
              action.danger && 'text-destructive hover:bg-destructive/10 hover:text-destructive',
            )}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {!compact && <span data-toolbar-label="" className="whitespace-nowrap">{action.label}</span>}
            {/* The count as the search's filter button draws its own. */}
            {action.badge ? (
              <span
                data-plugin-action-badge=""
                className="absolute -top-1 -end-1 flex items-center justify-center min-w-4 h-4 px-1 text-[0.625rem] font-bold rounded-full bg-primary text-primary-foreground"
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
function PluginActionsOverflow({ surface, context, mailboxRole, mimeType, className, target, accountKind }: Pick<PluginActionsProps, 'surface' | 'context' | 'mailboxRole' | 'mimeType' | 'className' | 'target' | 'accountKind'>) {
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
          'hover:bg-muted hover:text-foreground focus-visible:outline-hidden',
        )}
      >
        {/* Not a second ⋮: toolbars have their own right next to this. */}
        <Puzzle className="h-4 w-4" />
      </button>
      <ContextMenu ref={menuRef} isOpen={contextMenu.isOpen} position={contextMenu.position} onClose={closeContextMenu}>
        <PluginActions
          surface={surface}
          variant="menu"
          context={context}
          mailboxRole={mailboxRole}
          mimeType={mimeType}
          target={target}
          accountKind={accountKind}
          onRan={closeContextMenu}
        />
      </ContextMenu>
    </div>
  );
}
