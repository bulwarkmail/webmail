import { Fragment, useMemo, type ReactNode } from 'react';
import { ShieldAlert, AlertTriangle } from '@/components/icons';
import { parseChangelog, type Inline } from '@/lib/admin/changelog-markdown';
import { cn } from '@/lib/utils';
import { Badge } from './badge';

export interface ChangelogFlags {
  security: boolean;
  breaking: boolean;
}

export interface ChangelogEntry {
  version: string;
  publishedAt: string | null;
  changelog: string | null;
  notes?: ChangelogFlags;
}

function inline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    if (n.t === 'text') return <Fragment key={i}>{n.v}</Fragment>;
    if (n.t === 'code') return <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.9em]">{n.v}</code>;
    if (n.t === 'strong') return <strong key={i} className="font-semibold text-foreground">{inline(n.c)}</strong>;
    return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">{inline(n.c)}</a>;
  });
}

/** An extension's changelog: a safe subset of Markdown, drawn as text. */
export function ChangelogNotes({ markdown, className }: { markdown: string; className?: string }) {
  const blocks = useMemo(() => parseChangelog(markdown), [markdown]);
  return (
    <div className={cn('space-y-1.5 text-xs text-muted-foreground', className)}>
      {blocks.map((b, i) => {
        if (b.t === 'heading') return <p key={i} className="pt-1 font-semibold text-foreground first:pt-0">{inline(b.c)}</p>;
        if (b.t === 'para') return <p key={i}>{inline(b.c)}</p>;
        if (b.t === 'code') return <pre key={i} className="overflow-x-auto rounded bg-muted p-2 font-mono text-[0.9em]">{b.v}</pre>;
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List key={i} className={cn('space-y-0.5 ps-4', b.ordered ? 'list-decimal' : 'list-disc')}>
            {b.items.map((item, j) => <li key={j}>{inline(item)}</li>)}
          </List>
        );
      })}
    </div>
  );
}

/** "Security" and "Breaking" next to an update, when its notes have those headings. */
export function ChangelogBadges({ flags }: { flags: ChangelogFlags | undefined }) {
  if (!flags?.security && !flags?.breaking) return null;
  return (
    <>
      {flags.security && <Badge tone="danger" icon={<ShieldAlert className="h-3 w-3" />}>Security</Badge>}
      {flags.breaking && <Badge tone="warning" icon={<AlertTriangle className="h-3 w-3" />}>Breaking</Badge>}
    </>
  );
}

export const anyFlag = (entries: ChangelogEntry[], key: keyof ChangelogFlags) => entries.some((e) => e.notes?.[key]);

/** The notes of several versions, newest first, each under its version. */
export function ChangelogEntries({ entries }: { entries: ChangelogEntry[] }) {
  return (
    <ol className="space-y-3">
      {entries.map((e) => (
        <li key={e.version}>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono font-medium text-foreground">v{e.version}</span>
            {e.publishedAt && <span className="text-muted-foreground">{new Date(e.publishedAt).toLocaleDateString()}</span>}
            <ChangelogBadges flags={e.notes} />
          </div>
          {e.changelog ? <ChangelogNotes markdown={e.changelog} /> : <p className="text-xs italic text-muted-foreground">No notes for this version.</p>}
        </li>
      ))}
    </ol>
  );
}
