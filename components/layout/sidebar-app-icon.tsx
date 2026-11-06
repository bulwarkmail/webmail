'use client';

import { useState } from 'react';
import { iconForName } from '@/components/icons';
import type { ResolvedSidebarApp } from '@/lib/sidebar-apps';
import { cn } from '@/lib/utils';

/**
 * A sidebar app's icon: the operator's image (`iconUrl`) for an app of the
 * policy, else the named icon, which also stands in when the image fails.
 */
export function SidebarAppIcon({ app, className }: { app: ResolvedSidebarApp; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = app.managed ? app.iconUrl : undefined;
  if (src && failed !== src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        draggable={false}
        className={cn(className, 'object-contain')}
        onError={() => setFailed(src)}
      />
    );
  }
  const Icon = iconForName(app.icon);
  return Icon ? <Icon className={className} /> : null;
}
