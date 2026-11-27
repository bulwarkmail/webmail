'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { ExternalLink } from '@/components/icons';
import type { UnreadCountStyle } from '@/lib/accessibility-settings';
import { useSettingsStore } from '@/stores/settings-store';
import {
  appBadgeMark,
  useSidebarAppFramesStore,
  type AppBadge,
  type AppBadgeMark,
  type AppBadgeTrouble,
} from '@/stores/sidebar-app-frames-store';

/**
 * The mark drawn for an app's badge, following the user's `unreadCountStyle`
 * as the mail entry does. A count that cannot be trusted gets its mark
 * whatever the style (it is no count); offline keeps its last number beside
 * the "?" unless counts are hidden or drawn as dots.
 */
export function drawnAppMark(badge: AppBadge | undefined, style: UnreadCountStyle): AppBadgeMark | null {
  const mark = appBadgeMark(badge);
  if (!mark) return null;
  if ('state' in mark) return style === 'count' ? mark : { ...mark, last: null };
  if (style === 'hidden') return null;
  return style === 'dot' ? { dot: true } : mark;
}

/** The text a state's mark stands for, by the message key under `shell`. */
const STATE_TEXT: Record<AppBadgeTrouble, 'app_signed_out' | 'app_offline' | 'app_unknown' | 'app_silent'> = {
  'signed-out': 'app_signed_out',
  offline: 'app_offline',
  unknown: 'app_unknown',
  silent: 'app_silent',
};

export interface SidebarAppBadgeView {
  mark: AppBadgeMark | null;
  /** The entry's name for screen readers when it has a mark ("Chat, 3 unread", "Signed out of Chat"). */
  label: string | undefined;
  /** What a mark that is no count means, as the tooltip ("Signed out of Chat"). */
  stateText: string | undefined;
}

/** The badge of each inline app, as the rail, the phone's bar and Mountain View's app menu draw it. */
export function useSidebarAppBadges(): (app: { id: string; name: string }) => SidebarAppBadgeView {
  const tShell = useTranslations('shell');
  const badges = useSidebarAppFramesStore((s) => s.badges);
  const style = useSettingsStore((s) => s.unreadCountStyle);
  return (app) => {
    const badge = badges[app.id];
    const mark = drawnAppMark(badge, style);
    if (!mark) return { mark: null, label: undefined, stateText: undefined };
    if ('state' in mark) {
      const text = tShell(STATE_TEXT[mark.state], { name: app.name });
      return { mark, label: text, stateText: text };
    }
    return { mark, label: tShell('name_unread', { name: app.name, count: badge?.count ?? 0 }), stateText: undefined };
  };
}

/** Where the mark sits: as the mail entry's in the phone's bar and the app menu, or in the rail. */
type Placement = 'icon' | 'rail-collapsed' | 'rail-expanded';

const DOT: Record<Placement, string> = {
  icon: '-top-0.5 -end-1',
  'rail-collapsed': 'top-1 end-1',
  'rail-expanded': 'end-2.5',
};

const NUMBER: Record<Placement, string> = {
  icon: '-top-1.5 -end-2.5',
  'rail-collapsed': '-top-0.5 -end-0.5',
  'rail-expanded': 'end-1.5',
};

export function SidebarAppBadge({ mark, placement }: { mark: AppBadgeMark | null; placement: Placement }) {
  if (!mark) return null;
  if ('state' in mark) {
    // "!" amber: the user has to act (sign in). "?" grey: the count cannot be
    // trusted; offline with its last number, greyed, before it.
    return (
      <span
        aria-hidden="true"
        data-testid="rail-app-state"
        data-state={mark.state}
        className={cn(
          'absolute flex items-center justify-center min-w-[16px] h-4 text-[0.625rem] font-bold rounded-full px-1',
          mark.symbol === '!' ? 'bg-amber-500 text-white' : 'bg-muted-foreground text-background',
          NUMBER[placement]
        )}
      >
        {mark.last !== null && <span className="font-medium opacity-80">{mark.last > 99 ? '99+' : mark.last}</span>}
        {mark.symbol}
      </span>
    );
  }
  if ('dot' in mark) {
    return (
      <span
        aria-hidden="true"
        data-testid="rail-app-dot"
        className={cn('absolute w-2.5 h-2.5 rounded-full bg-red-500', DOT[placement])}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid="rail-app-count"
      className={cn(
        'absolute flex items-center justify-center min-w-[16px] h-4 text-[0.625rem] font-bold rounded-full bg-red-600 text-white px-1',
        NUMBER[placement]
      )}
    >
      {mark.number > 99 ? '99+' : mark.number}
    </span>
  );
}

/**
 * The line at the top of an opened app whose count cannot be trusted: what
 * its mark on the icon says, and, signed out, a link to sign in in a new tab
 * (a sign-in page may refuse to be framed, as Entra ID does); Bulwark loads
 * the app's frame anew when the user comes back. Nothing while the count is
 * current.
 */
export function SidebarAppStateLine({ app }: { app: { id: string; name: string; url: string } }) {
  const tShell = useTranslations('shell');
  const badge = useSidebarAppFramesStore((s) => s.badges[app.id]);
  const mark = appBadgeMark(badge);
  if (!mark || !('state' in mark)) return null;
  const text = tShell(STATE_TEXT[mark.state], { name: app.name });
  const signInUrl = mark.state === 'signed-out' && /^https?:\/\//i.test(app.url) ? app.url : null;
  return (
    <div
      role="status"
      data-testid="app-state-line"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 border-b border-border text-sm flex-shrink-0',
        mark.symbol === '!' ? 'bg-amber-500/10 text-foreground' : 'bg-muted text-muted-foreground'
      )}
    >
      <span className="min-w-0">{text}</span>
      {signInUrl && (
        <a
          href={signInUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
        >
          {tShell('app_sign_in')}
          <ExternalLink aria-hidden="true" className="w-3.5 h-3.5" />
        </a>
      )}
    </div>
  );
}
