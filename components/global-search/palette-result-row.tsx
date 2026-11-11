"use client";

import { CalendarDays, FileText, Folder, Repeat } from "@/components/icons";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/avatar";
import { useSenderWarning } from "@/hooks/use-sender-warning";
import { useBrandDomain } from "@/hooks/use-brand-domain";
import { parseSearchSnippet, type SnippetSegment } from "@/lib/search-snippet";
import type { GlobalSearchHit } from "@/lib/global-search/types";
import { getContactDisplayName, getContactPhotoRef, getContactPrimaryEmail } from "@/stores/contact-store";
import { cn } from "@/lib/utils";
import { useHitSubtitle } from "./hit-subtitle";

function MailSenderAvatar({ email }: { email: Extract<GlobalSearchHit, { kind: 'mail' }>['email'] }) {
  const from = email.from?.[0];
  const senderWarning = useSenderWarning(email);
  const brandDomain = useBrandDomain(email);
  return <Avatar name={from?.name || undefined} email={from?.email || undefined} size="sm" className="mt-0.5 shrink-0" senderWarning={senderWarning} brandDomain={brandDomain} />;
}

/**
 * Leading visual, mirroring the mail list's identity language: real avatars
 * for people (sender / contact), kind-tinted icon chips for events and files.
 */
function LeadingVisual({ hit }: { hit: GlobalSearchHit }) {
  if (hit.kind === 'mail') return <MailSenderAvatar email={hit.email} />;
  if (hit.kind === 'contacts') {
    return (
      <Avatar
        name={getContactDisplayName(hit.contact) || undefined}
        email={getContactPrimaryEmail(hit.contact) || undefined}
        contactPhoto={getContactPhotoRef(hit.contact) ?? null}
        size="sm"
        className="mt-0.5 shrink-0"
      />
    );
  }
  const [Icon, tint] = hit.kind === 'calendar'
    ? [CalendarDays, "bg-violet-500/15 text-violet-600 dark:text-violet-400"]
    : hit.isFolder
      ? [Folder, "bg-amber-500/15 text-amber-600 dark:text-amber-400"]
      : [FileText, "bg-amber-500/15 text-amber-600 dark:text-amber-400"];
  return (
    <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", tint)}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function Snippet({ value }: { value: string }) {
  const segments: SnippetSegment[] = parseSearchSnippet(value);
  return (
    <span className="truncate">
      {segments.map((segment, i) => segment.marked
        ? <mark key={i} className="bg-primary/20 text-foreground rounded-sm px-px">{segment.text}</mark>
        : <span key={i}>{segment.text}</span>)}
    </span>
  );
}

function formatHitDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export interface PaletteResultRowProps {
  hit: GlobalSearchHit;
  onOpen: (hit: GlobalSearchHit) => void;
  className?: string;
  /** DOM id, for a listbox's aria-activedescendant. */
  id?: string;
  /** The highlighted option of the palette's listbox. */
  selected?: boolean;
  /** -1 in the palette, where the focus stays in the search field. */
  tabIndex?: number;
  onMouseMove?: () => void;
}

/**
 * One search hit: avatar/icon, title with the date right-aligned, account ·
 * context subtitle, and the server snippet with its `<mark>`ed terms when
 * mail search returned one. Used by both the palette and the search tab.
 */
export function PaletteResultRow({ hit, onOpen, className, id, selected = false, tabIndex, onMouseMove }: PaletteResultRowProps) {
  const t = useTranslations('global_search');
  const title = hit.title || (hit.kind === 'mail' ? t('no_subject') : hit.id);
  const subtitle = useHitSubtitle()(hit);
  const snippet = hit.kind === 'mail' && hit.snippet?.preview ? hit.snippet.preview : null;
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={tabIndex}
      onMouseMove={onMouseMove}
      onClick={() => onOpen(hit)}
      data-hit-kind={hit.kind}
      className={cn(
        "w-full flex items-start gap-3 px-3 py-2 text-left rounded-md transition-colors duration-150",
        "hover:bg-muted/50 focus:bg-muted focus:outline-none",
        className,
      )}
    >
      <LeadingVisual hit={hit} />
      <span className="flex-1 min-w-0">
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="flex-1 min-w-0 flex items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {hit.kind === 'mail' && hit.snippet?.subject ? <Snippet value={hit.snippet.subject} /> : title}
            </span>
            {hit.kind === 'calendar' && hit.isRecurring && (
              <Repeat aria-label={t('recurring')} className="w-3 h-3 shrink-0 text-muted-foreground" />
            )}
          </span>
          {hit.date && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatHitDate(hit.date)}</span>
          )}
        </span>
        <span className="block truncate text-xs text-muted-foreground mt-0.5">{subtitle}</span>
        {snippet && (
          <span className="block truncate text-xs text-muted-foreground mt-0.5"><Snippet value={snippet} /></span>
        )}
      </span>
    </button>
  );
}
