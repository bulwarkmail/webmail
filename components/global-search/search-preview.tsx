"use client";

import { AlignLeft, Building2, CalendarDays, Clock, ExternalLink, FileText, Folder, HardDrive, Mail, MapPin, Phone, Repeat, Users } from "@/components/icons";
import { useTranslations } from "next-intl";
import { Avatar } from "@/components/ui/avatar";
import { ProEmailView } from "@/components/pro/pro-email-tab-body";
import type { CalendarHit, ContactHit, FileHit, GlobalSearchHit } from "@/lib/global-search/types";
import { getContactDisplayName, getContactPhotoUri, getContactPrimaryEmail } from "@/stores/contact-store";
import { useAuthStore } from "@/stores/auth-store";
import { cn, formatFileSize } from "@/lib/utils";

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: iso.includes('T') ? 'short' : undefined }).format(date);
}

function OpenButton({ hit, onOpen, label }: { hit: GlobalSearchHit; onOpen: (hit: GlobalSearchHit) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(hit)}
      className="inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
    >
      <ExternalLink className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

/** Card header shared by the non-mail previews: visual, title, subtitle, Open. */
function PreviewHeader({ visual, title, badge, subtitle, action }: {
  visual: React.ReactNode;
  title: React.ReactNode;
  badge?: React.ReactNode;
  subtitle: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        {visual}
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <span className="truncate">{title}</span>
            {badge}
          </h2>
          <p className="text-sm text-muted-foreground truncate">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function IconChip({ icon: Icon, tint }: { icon: typeof CalendarDays; tint: string }) {
  return (
    <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", tint)}>
      <Icon className="h-5 w-5" />
    </span>
  );
}

/** One detail line: muted leading icon, wrapping value. */
function DetailRow({ icon: Icon, children, pre }: { icon: typeof Clock; children: React.ReactNode; pre?: boolean }) {
  return (
    <div className="flex items-start gap-2.5 text-sm">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className={cn("min-w-0 text-foreground break-words", pre && "whitespace-pre-wrap")}>{children}</span>
    </div>
  );
}

function ContactPreview({ hit, onOpen, openLabel }: { hit: ContactHit; onOpen: (hit: GlobalSearchHit) => void; openLabel: string }) {
  const contact = hit.contact;
  const name = getContactDisplayName(contact) || hit.title;
  const emails = Object.values(contact.emails ?? {}).map((e) => e.address).filter(Boolean);
  const phones = Object.values(contact.phones ?? {}).map((p) => (p as { number?: string }).number).filter(Boolean);
  const orgs = Object.values(contact.organizations ?? {}).map((o) => (o as { name?: string }).name).filter(Boolean);
  return (
    <div className="p-4 flex flex-col gap-4">
      <PreviewHeader
        visual={<Avatar name={name} email={getContactPrimaryEmail(contact) || undefined} contactPhotoUri={getContactPhotoUri(contact)} size="lg" className="shrink-0" />}
        title={name}
        subtitle={[hit.accountLabel, hit.subtitle].filter(Boolean).join(' · ')}
        action={<OpenButton hit={hit} onOpen={onOpen} label={openLabel} />}
      />
      <div className="border-t border-border" />
      <dl className="flex flex-col gap-2.5">
        {emails.map((email) => <DetailRow key={email} icon={Mail}>{email}</DetailRow>)}
        {phones.map((phone) => <DetailRow key={phone} icon={Phone}>{phone}</DetailRow>)}
        {orgs.map((org) => <DetailRow key={org} icon={Building2}>{org}</DetailRow>)}
      </dl>
    </div>
  );
}

function CalendarPreview({ hit, onOpen, openLabel, recurringLabel }: { hit: CalendarHit; onOpen: (hit: GlobalSearchHit) => void; openLabel: string; recurringLabel: string }) {
  const event = hit.event;
  const locations = Object.values(event.locations ?? {}).map((l) => l?.name).filter(Boolean);
  const participants = Object.values(event.participants ?? {})
    .map((p) => (p as { name?: string | null; email?: string | null }))
    .map((p) => p.name || p.email)
    .filter(Boolean);
  return (
    <div className="p-4 flex flex-col gap-4">
      <PreviewHeader
        visual={<IconChip icon={CalendarDays} tint="bg-violet-500/15 text-violet-600 dark:text-violet-400" />}
        title={hit.title}
        badge={hit.isRecurring ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            <Repeat className="h-3 w-3" />
            {recurringLabel}
          </span>
        ) : undefined}
        subtitle={[hit.accountLabel, hit.subtitle].filter(Boolean).join(' · ')}
        action={<OpenButton hit={hit} onOpen={onOpen} label={openLabel} />}
      />
      <div className="border-t border-border" />
      <dl className="flex flex-col gap-2.5">
        <DetailRow icon={Clock}>{formatDateTime(event.start)}</DetailRow>
        {locations.map((location) => <DetailRow key={location} icon={MapPin}>{location}</DetailRow>)}
        {event.description && <DetailRow icon={AlignLeft} pre>{event.description}</DetailRow>}
        {participants.length > 0 && <DetailRow icon={Users}>{participants.join(', ')}</DetailRow>}
      </dl>
    </div>
  );
}

function FilePreview({ hit, onOpen, openLabel }: { hit: FileHit; onOpen: (hit: GlobalSearchHit) => void; openLabel: string }) {
  return (
    <div className="p-4 flex flex-col gap-4">
      <PreviewHeader
        visual={<IconChip icon={hit.isFolder ? Folder : FileText} tint="bg-amber-500/15 text-amber-600 dark:text-amber-400" />}
        title={hit.title}
        subtitle={[hit.accountLabel, hit.folderPath].filter(Boolean).join(' · ')}
        action={<OpenButton hit={hit} onOpen={onOpen} label={openLabel} />}
      />
      <div className="border-t border-border" />
      <dl className="flex flex-col gap-2.5">
        {!hit.isFolder && <DetailRow icon={HardDrive}>{formatFileSize(hit.node.size)}{hit.node.type ? ` · ${hit.node.type}` : ''}</DetailRow>}
        {hit.date && <DetailRow icon={Clock}>{formatDateTime(hit.date)}</DetailRow>}
        <DetailRow icon={Folder}>{hit.folderPath}</DetailRow>
      </dl>
    </div>
  );
}

export interface SearchPreviewProps {
  hit: GlobalSearchHit | null;
  onOpen: (hit: GlobalSearchHit) => void;
  /** Called when the mail view's close affordance is used - clears the selection. */
  onClose: () => void;
}

/** Preview pane of the search tab: full mail view, summary card for the rest. */
export function SearchPreview({ hit, onOpen, onClose }: SearchPreviewProps) {
  const t = useTranslations('global_search');
  const getClientForAccount = useAuthStore((s) => s.getClientForAccount);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);

  if (!hit) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted-foreground text-center">{t('preview_empty')}</p>
      </div>
    );
  }

  if (hit.kind === 'mail') {
    const clientOverride = hit.localAccountId !== activeAccountId ? getClientForAccount(hit.localAccountId) ?? undefined : undefined;
    return (
      <ProEmailView
        key={`${hit.localAccountId}-${hit.id}`}
        emailId={hit.id}
        client={clientOverride}
        accountId={hit.jmapAccountId}
        onClose={onClose}
        className="w-full"
      />
    );
  }
  const openLabel = t('open_full');
  if (hit.kind === 'contacts') return <ContactPreview hit={hit} onOpen={onOpen} openLabel={openLabel} />;
  if (hit.kind === 'calendar') return <CalendarPreview hit={hit} onOpen={onOpen} openLabel={openLabel} recurringLabel={t('recurring')} />;
  return <FilePreview hit={hit} onOpen={onOpen} openLabel={openLabel} />;
}
