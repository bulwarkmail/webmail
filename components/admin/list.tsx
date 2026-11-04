'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from '@/components/icons';
import { cn } from '@/lib/utils';
import { AdminLink } from './admin-link';

interface AdminListProps {
  children: ReactNode;
  className?: string;
}

/** Rows of things the admin manages: plugins, themes, requests. */
export function AdminList({ children, className }: AdminListProps) {
  return (
    <div className={cn('divide-y divide-border rounded-lg border border-border', className)}>
      {children}
    </div>
  );
}

interface AdminListRowProps {
  /** Makes the whole row open this admin path; the title becomes the link. */
  href?: string;
  icon?: ReactNode;
  title: ReactNode;
  /** Badges and other inline bits after the title. */
  titleExtra?: ReactNode;
  description?: ReactNode;
  /** The small line under the description: author, version, dates. */
  meta?: ReactNode;
  /** Controls on the end side; they sit above the row link. */
  control?: ReactNode;
  /** The control is wider than a switch: on a phone it gets its own line under the text. */
  wideControl?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function AdminListRow({ href, icon, title, titleExtra, description, meta, control, wideControl, className, ...rest }: AdminListRowProps) {
  return (
    <div
      data-testid={rest['data-testid']}
      className={cn(
        'relative flex items-center gap-3 px-4 py-3 transition-colors',
        href && 'hover:bg-muted/40',
        wideControl && 'max-sm:flex-wrap',
        className,
      )}
    >
      {icon && (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&>svg]:h-[18px] [&>svg]:w-[18px]">
          {icon}
        </div>
      )}
      <div className={cn('min-w-0 flex-1', wideControl && 'max-sm:basis-0')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {href ? (
            <AdminLink
              href={href}
              className="text-sm font-medium text-foreground after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
            >
              {title}
            </AdminLink>
          ) : (
            <span className="text-sm font-medium text-foreground">{title}</span>
          )}
          {titleExtra}
        </div>
        {description && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{description}</p>}
        {meta && <div className="mt-0.5 text-xs text-muted-foreground">{meta}</div>}
      </div>
      {control && (
        <div className={cn('relative z-10 flex shrink-0 items-center gap-2', wideControl && 'max-sm:order-last max-sm:w-full max-sm:flex-wrap max-sm:ps-12')}>
          {control}
        </div>
      )}
      {href && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
    </div>
  );
}
