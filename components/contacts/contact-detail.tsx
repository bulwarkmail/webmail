"use client";

import { useTranslations } from "next-intl";
import { Mail, Phone, Building, MapPin, StickyNote, Pencil, Trash2, BookUser, Copy, Send } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { toast } from "@/stores/toast-store";

interface ContactDetailProps {
  contact: ContactCard | null;
  onEdit: () => void;
  onDelete: () => void;
  isMobile?: boolean;
  className?: string;
}

export function ContactDetail({ contact, onEdit, onDelete, isMobile, className }: ContactDetailProps) {
  const t = useTranslations("contacts");

  if (!contact) {
    return (
      <div className={cn("flex flex-col items-center justify-center h-full text-muted-foreground", className)}>
        <BookUser className="w-16 h-16 mb-4 opacity-20" />
        <p className="text-sm">{t("detail.no_contact_selected")}</p>
      </div>
    );
  }

  const name = getContactDisplayName(contact);
  const email = getContactPrimaryEmail(contact);
  const emails = contact.emails ? Object.values(contact.emails) : [];
  const phones = contact.phones ? Object.values(contact.phones) : [];
  const orgs = contact.organizations ? Object.values(contact.organizations) : [];
  const addresses = contact.addresses ? Object.values(contact.addresses) : [];
  const notes = contact.notes ? Object.values(contact.notes) : [];

  return (
    <div className={cn("flex flex-col h-full overflow-y-auto", className)}>
      <div className={cn("border-b border-border", isMobile ? "px-4 py-4" : "px-6 py-6")}>
        <div className={cn("flex gap-4", isMobile ? "flex-col" : "items-start justify-between")}>
          <div className="flex items-center gap-4">
            <Avatar name={name} email={email} size={isMobile ? "md" : "lg"} />
            <div className="min-w-0 flex-1">
              <h2 className={cn("font-semibold truncate", isMobile ? "text-lg" : "text-xl")}>{name || "—"}</h2>
              {orgs.length > 0 && orgs[0].name && (
                <p className="text-sm text-muted-foreground truncate">{orgs[0].name}</p>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onEdit} className="touch-manipulation">
              <Pencil className="w-4 h-4 mr-1" />
              {t("form.edit_title")}
            </Button>
            <Button variant="outline" size="sm" onClick={onDelete} className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950 touch-manipulation">
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-6">
        {emails.length > 0 && (
          <Section icon={Mail} title={t("detail.emails")}>
            {emails.map((e, i) => (
              <div key={i} className="flex items-center gap-2 group">
                <a href={`mailto:${e.address}`} className="text-sm text-primary hover:underline">
                  {e.address}
                </a>
                {e.contexts && (
                  <ContextBadge contexts={e.contexts} />
                )}
                <div className={cn(
                  "flex items-center gap-0.5 transition-opacity",
                  isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}>
                  <a
                    href={`mailto:${e.address}`}
                    className="p-1.5 rounded hover:bg-muted transition-colors touch-manipulation"
                    title={t("detail.compose_email")}
                    aria-label={t("detail.compose_email")}
                  >
                    <Send className="w-3.5 h-3.5 text-muted-foreground" />
                  </a>
                  <button
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(e.address);
                        toast.success(t("detail.copied"));
                      } catch {
                        toast.error(t("detail.copy_failed"));
                      }
                    }}
                    className="p-1.5 rounded hover:bg-muted transition-colors touch-manipulation"
                    title={t("detail.copy_email")}
                    aria-label={t("detail.copy_email")}
                  >
                    <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
              </div>
            ))}
          </Section>
        )}

        {phones.length > 0 && (
          <Section icon={Phone} title={t("detail.phones")}>
            {phones.map((p, i) => (
              <div key={i} className="flex items-center gap-2 group">
                <a href={`tel:${p.number}`} className="text-sm text-primary hover:underline">
                  {p.number}
                </a>
                {p.contexts && (
                  <ContextBadge contexts={p.contexts} />
                )}
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(p.number);
                      toast.success(t("detail.copied"));
                    } catch {
                      toast.error(t("detail.copy_failed"));
                    }
                  }}
                  className={cn(
                    "p-1.5 rounded hover:bg-muted transition-colors touch-manipulation",
                    isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  )}
                  title={t("detail.copy_phone")}
                  aria-label={t("detail.copy_phone")}
                >
                  <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </div>
            ))}
          </Section>
        )}

        {orgs.length > 0 && (
          <Section icon={Building} title={t("detail.organizations")}>
            {orgs.map((o, i) => (
              <div key={i} className="text-sm">
                {o.name}
                {o.units && o.units.length > 0 && (
                  <span className="text-muted-foreground"> — {o.units.map(u => u.name).join(", ")}</span>
                )}
              </div>
            ))}
          </Section>
        )}

        {addresses.length > 0 && (
          <Section icon={MapPin} title={t("detail.addresses")}>
            {addresses.map((a, i) => (
              <div key={i} className="text-sm">
                {[a.street, a.locality, a.region, a.postcode, a.country].filter(Boolean).join(", ")}
                {a.contexts && (
                  <ContextBadge contexts={a.contexts} />
                )}
              </div>
            ))}
          </Section>
        )}

        {notes.length > 0 && (
          <Section icon={StickyNote} title={t("detail.notes")}>
            {notes.map((n, i) => (
              <p key={i} className="text-sm whitespace-pre-wrap">{n.note}</p>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      </div>
      <div className="space-y-1 pl-6">{children}</div>
    </div>
  );
}

function ContextBadge({ contexts }: { contexts: Record<string, boolean> }) {
  const labels = Object.keys(contexts).filter(k => contexts[k]);
  if (labels.length === 0) return null;

  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
      {labels.join(", ")}
    </span>
  );
}
