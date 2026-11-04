'use client';

import type { ReactNode } from 'react';
import { ArrowLeft } from '@/components/icons';
import { cn } from '@/lib/utils';
import { AdminLink } from './admin-link';

interface AdminPageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Buttons on the end side of the header. */
  actions?: ReactNode;
  /** A link back to the parent page, for detail pages. */
  back?: { href: string; label: string };
  /** Something between the back link and the title, such as an icon. */
  leading?: ReactNode;
  className?: string;
}

/**
 * The header of an admin page. The mobile shell already shows the page name
 * in its top bar, so the title itself is desktop-only there; the
 * description and the actions stay.
 */
export function AdminPageHeader({ title, description, actions, back, leading, className }: AdminPageHeaderProps) {
  return (
    <div className={cn('mb-6 space-y-3', className)}>
      {back && (
        <AdminLink
          href={back.href}
          // The phone shell's top bar already has the back arrow.
          className="hidden desk:inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {back.label}
        </AdminLink>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          {leading}
          <div className="min-w-0">
            <h1 className={cn('text-xl font-semibold text-foreground leading-tight', !back && 'hidden desk:block')}>{title}</h1>
            {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
