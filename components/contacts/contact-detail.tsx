"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Mail, Phone, Building, MapPin, StickyNote, Pencil, Trash2, BookUser, Copy, Send, Globe, Cake, KeyRound, Users, Briefcase, Heart, Languages, Calendar, UserCircle, Download, MoreHorizontal, Printer } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContactCard, AnniversaryDate, PartialDate } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail, getContactPhotoUri } from "@/stores/contact-store";
import { ContactActivity } from "./contact-activity";
import { toast } from "@/stores/toast-store";
import { exportContact } from "./contact-export";
import { printContact } from "./contact-print";

type MoreItem =
  | {
      icon: React.ComponentType<{ className?: string }>;
      label: string;
      onClick: () => void;
      destructive?: boolean;
      separator?: false;
    }
  | { separator: true };

interface ContactDetailProps {
  contact: ContactCard | null;
  onEdit: () => void;
  onDelete: () => void;
  onAddToGroup?: () => void;
  onDuplicate?: () => void;
  /** Compose an email to this contact in the app (no OS mailto handoff). */
  onCompose?: () => void;
  isMobile?: boolean;
  className?: string;
}

function formatPhoneFeatures(features?: Record<string, boolean>): string {
  if (!features) return "";
  return Object.keys(features).filter(k => features[k]).join(", ");
}

function getDateParts(dateInput: AnniversaryDate): { year?: number; month?: number; day?: number } {
  if (typeof dateInput === "object" && dateInput !== null) {
    if (dateInput["@type"] === "Timestamp" && typeof dateInput.utc === "string") {
      const d = new Date(dateInput.utc);
      if (!isNaN(d.getTime())) {
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
      }
      return {};
    }
    const pd = dateInput as PartialDate;
    return { year: pd.year, month: pd.month, day: pd.day };
  }
  const s = String(dateInput);
  if (s.startsWith("--")) {
    const parts = s.substring(2).split("-");
    return { month: parseInt(parts[0], 10), day: parts[1] ? parseInt(parts[1], 10) : undefined };
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return {};
}

function getCompletedYears(dateInput: AnniversaryDate): number | null {
  const { year, month, day } = getDateParts(dateInput);
  if (!year) return null;
  const now = new Date();
  let years = now.getFullYear() - year;
  const m = month ?? 1;
  const d = day ?? 1;
  const nowM = now.getMonth() + 1;
  const nowD = now.getDate();
  if (nowM < m || (nowM === m && nowD < d)) years -= 1;
  if (years < 0) return null;
  return years;
}

function formatDate(dateInput: AnniversaryDate): string {
  if (typeof dateInput === 'object' && dateInput !== null) {
    if (dateInput['@type'] === 'Timestamp' && typeof dateInput.utc === 'string') {
      try {
        const d = new Date(dateInput.utc as string);
        if (!isNaN(d.getTime())) {
          return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
        }
      } catch { /* fallback */ }
      return String(dateInput.utc);
    }
    const pd = dateInput as PartialDate;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const parts: string[] = [];
    if (pd.month && monthNames[pd.month - 1]) parts.push(monthNames[pd.month - 1]);
    if (pd.day) parts.push(String(pd.day));
    if (pd.year) parts.push(String(pd.year));
    return parts.join(' ') || String(dateInput);
  }
  const dateStr = String(dateInput);
  if (dateStr.startsWith("--")) {
    const parts = dateStr.substring(2).split("-");
    const month = parseInt(parts[0], 10);
    const day = parts[1] ? parseInt(parts[1], 10) : undefined;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return day ? `${monthNames[month - 1]} ${day}` : monthNames[month - 1];
  }
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    }
  } catch { /* fallback */ }
  return dateStr;
}

export function ContactDetail({ contact, onEdit, onDelete, onAddToGroup, onDuplicate, onCompose, isMobile, className }: ContactDetailProps) {
  const t = useTranslations("contacts");

  const cryptoKeys = contact?.cryptoKeys ? Object.values(contact.cryptoKeys) : [];

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
  const photoUri = getContactPhotoUri(contact);
  const phone = contact.phones ? Object.values(contact.phones)[0]?.number : undefined;

  const handleExport = () => {
    exportContact(contact);
    toast.success(t("export.success", { count: 1 }));
  };

  const handlePrint = () => {
    printContact(contact, name);
  };

  const moreItems: MoreItem[] = [];
  if (onAddToGroup) {
    moreItems.push({ icon: Users, label: t("context_menu.add_to_group"), onClick: onAddToGroup });
  }
  if (onDuplicate) {
    moreItems.push({ icon: Copy, label: t("context_menu.duplicate"), onClick: onDuplicate });
  }
  moreItems.push({ icon: Download, label: t("context_menu.export_vcard"), onClick: handleExport });
  moreItems.push({ icon: Printer, label: t("context_menu.print"), onClick: handlePrint });
  moreItems.push({ separator: true });
  moreItems.push({ icon: Trash2, label: t("context_menu.delete"), onClick: onDelete, destructive: true });
  const emails = contact.emails ? Object.values(contact.emails) : [];
  const phones = contact.phones ? Object.values(contact.phones) : [];
  const orgs = contact.organizations ? Object.values(contact.organizations) : [];
  const addresses = contact.addresses ? Object.values(contact.addresses) : [];
  const notes = contact.notes ? Object.values(contact.notes) : [];
  const titles = contact.titles ? Object.values(contact.titles) : [];
  const jobTitles = titles.filter(t => t.kind !== "role");
  const onlineServices = contact.onlineServices ? Object.values(contact.onlineServices) : [];
  const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries) : [];
  const keywords = contact.keywords ? Object.keys(contact.keywords).filter(k => contact.keywords![k]) : [];

  const relatedTo = contact.relatedTo ? Object.entries(contact.relatedTo) : [];
  const preferredLanguages = contact.preferredLanguages ? Object.values(contact.preferredLanguages) : [];
  const personalInfo = contact.personalInfo ? Object.values(contact.personalInfo) : [];
  const nicknames = contact.nicknames ? Object.values(contact.nicknames) : [];

  const hasNickname = nicknames.length > 0;
  const titleLine = jobTitles.length > 0 ? jobTitles.map(t => t.name).join(", ") : undefined;
  const subtitleParts = [titleLine, orgs[0]?.name].filter(Boolean) as string[];
  const hasContactDetails = emails.length > 0 || phones.length > 0 || addresses.length > 0 || onlineServices.length > 0;
  const hasWork = titles.length > 0 || orgs.length > 0;
  const hasGender = !!(contact.speakToAs && (contact.speakToAs.grammaticalGender || contact.speakToAs.pronouns));
  const hasPersonal = anniversaries.length > 0 || personalInfo.length > 0 || hasGender || preferredLanguages.length > 0;

  return (
    <div className={cn("flex flex-col h-full overflow-y-auto", className)}>
      <div className={cn("border-b border-border", isMobile ? "px-4 py-4" : "px-6 py-6")}>
        <div className={cn("flex gap-4", isMobile ? "flex-col" : "items-start justify-between")}>
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <Avatar name={name} email={email} contactPhotoUri={photoUri} size={isMobile ? "md" : "lg"} />
            <div className="min-w-0 flex-1">
              <h2 className={cn("font-semibold truncate", isMobile ? "text-lg" : "text-xl")}>{name || "-"}</h2>
              {hasNickname && (
                <p className="text-sm text-muted-foreground truncate">&ldquo;{nicknames.map(n => n.name).join(", ")}&rdquo;</p>
              )}
              {subtitleParts.length > 0 && (
                <p className="text-sm text-muted-foreground truncate">{subtitleParts.join(" · ")}</p>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0 flex-wrap">
            {email && onCompose && (
              <Button
                variant="outline"
                size="sm"
                onClick={onCompose}
                className="touch-manipulation"
              >
                <Send className="w-4 h-4 me-1" />
                {t("detail.compose_email")}
              </Button>
            )}
            {phone && (
              <a
                href={`tel:${phone}`}
                className="inline-flex items-center justify-center rounded-md font-medium h-9 px-3 text-sm border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors touch-manipulation"
              >
                <Phone className="w-4 h-4 me-1" />
                {t("context_menu.call")}
              </a>
            )}
            <Button variant="outline" size="sm" onClick={onEdit} className="touch-manipulation">
              <Pencil className="w-4 h-4 me-1" />
              {t("form.edit_title")}
            </Button>
            <MoreActionsMenu items={moreItems} label={t("detail.more_actions")} />
          </div>
        </div>
      </div>

      <div className={cn("divide-y divide-border/60", isMobile ? "px-4" : "px-6")}>
        {hasContactDetails && (
          <Section title={t("detail.section_contact")}>
            <div className="space-y-3">
              {emails.map((e, i) => (
                <FieldRow key={`em${i}`} icon={Mail} label={e.label || formatContexts(e.contexts) || t("detail.email_default_label")}>
                  <div className="flex items-center gap-2 group">
                    <a href={`mailto:${e.address}`} className="text-sm text-primary hover:underline break-all">
                      {e.address}
                    </a>
                    <RowActions>
                      <a
                        href={`mailto:${e.address}`}
                        className="p-1.5 rounded hover:bg-muted transition-colors touch-manipulation"
                        title={t("detail.compose_email")}
                        aria-label={t("detail.compose_email")}
                      >
                        <Send className="w-3.5 h-3.5 text-muted-foreground" />
                      </a>
                      <CopyButton value={e.address} label={t("detail.copy_email")} successMsg={t("detail.copied")} failMsg={t("detail.copy_failed")} />
                    </RowActions>
                  </div>
                </FieldRow>
              ))}

              {phones.map((p, i) => {
                const features = formatPhoneFeatures(p.features);
                const labelParts = [p.label, formatContexts(p.contexts), features].filter(Boolean) as string[];
                return (
                  <FieldRow key={`ph${i}`} icon={Phone} label={labelParts.length ? labelParts.join(" · ") : t("detail.phone_default_label")}>
                    <div className="flex items-center gap-2 group">
                      <a href={`tel:${p.number}`} className="text-sm text-primary hover:underline">
                        {p.number}
                      </a>
                      <RowActions>
                        <CopyButton value={p.number} label={t("detail.copy_phone")} successMsg={t("detail.copied")} failMsg={t("detail.copy_failed")} />
                      </RowActions>
                    </div>
                  </FieldRow>
                );
              })}

              {addresses.map((a, i) => {
                const lines: string[] = [];
                if (a.full || a.fullAddress) {
                  lines.push((a.full || a.fullAddress) as string);
                } else if (a.components && a.components.length > 0) {
                  const joined = a.components.filter(c => c.kind !== 'separator').map(c => c.value).filter(Boolean).join(", ");
                  if (joined) lines.push(joined);
                } else {
                  const parts = [a.street, [a.postcode, a.locality].filter(Boolean).join(" "), a.region, a.country]
                    .map(s => (typeof s === "string" ? s.trim() : ""))
                    .filter(Boolean) as string[];
                  lines.push(...parts);
                }
                return (
                  <FieldRow key={`ad${i}`} icon={MapPin} label={formatContexts(a.contexts) || t("detail.address_default_label")}>
                    <div className="text-sm space-y-0.5">
                      {lines.map((line, idx) => (
                        <div key={idx}>{line}</div>
                      ))}
                      {a.timeZone && (
                        <div className="text-xs text-muted-foreground">{t("detail.timezone")}: {a.timeZone}</div>
                      )}
                    </div>
                  </FieldRow>
                );
              })}

              {onlineServices.map((svc, i) => (
                <FieldRow
                  key={`os${i}`}
                  icon={Globe}
                  label={[svc.service, formatContexts(svc.contexts)].filter(Boolean).join(" · ") || t("detail.online_service_default_label")}
                >
                  <div className="flex items-center gap-2 group">
                    {typeof svc.uri === 'string' && svc.uri.startsWith("http") ? (
                      <a href={svc.uri} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">
                        {svc.user || svc.uri}
                      </a>
                    ) : (
                      <span className="text-sm break-all">{svc.user || String(svc.uri ?? '')}</span>
                    )}
                    <RowActions>
                      <CopyButton value={svc.user || svc.uri} label={t("detail.copy_url")} successMsg={t("detail.copied")} failMsg={t("detail.copy_failed")} />
                    </RowActions>
                  </div>
                </FieldRow>
              ))}
            </div>
          </Section>
        )}

        {hasWork && (
          <Section title={t("detail.section_work")}>
            <div className="space-y-3">
              {orgs.map((o, i) => (
                <FieldRow key={`org${i}`} icon={Building} label={t("detail.organization_label")}>
                  <div className="text-sm">
                    {o.name}
                    {o.units && o.units.length > 0 && (
                      <span className="text-muted-foreground"> · {o.units.map(u => u.name).join(", ")}</span>
                    )}
                  </div>
                </FieldRow>
              ))}
              {titles.map((tl, i) => (
                <FieldRow
                  key={`tl${i}`}
                  icon={Briefcase}
                  label={tl.kind === "role" ? t("detail.role_label") : t("detail.title_label")}
                >
                  <div className="text-sm">{tl.name}</div>
                </FieldRow>
              ))}
            </div>
          </Section>
        )}

        {hasPersonal && (
          <Section title={t("detail.section_personal")}>
            <div className="space-y-3">
              {anniversaries.map((ann, i) => {
                const years = getCompletedYears(ann.date);
                const suffixKey = ann.kind === "birth" ? "detail.age_years" : "detail.years_since";
                return (
                  <FieldRow key={`an${i}`} icon={Cake} label={t(`detail.anniversary_${ann.kind}`)}>
                    <div className="text-sm">
                      {formatDate(ann.date)}
                      {years !== null && (
                        <span className="text-muted-foreground"> · {t(suffixKey, { count: years })}</span>
                      )}
                    </div>
                  </FieldRow>
                );
              })}
              {hasGender && (
                <FieldRow icon={UserCircle} label={t("detail.gender")}>
                  <div className="text-sm">
                    {contact.speakToAs?.grammaticalGender && (
                      <span>{t(`detail.gender_${contact.speakToAs.grammaticalGender}`, { defaultValue: contact.speakToAs.grammaticalGender })}</span>
                    )}
                    {contact.speakToAs?.pronouns && (() => {
                      const firstPronoun = Object.values(contact.speakToAs!.pronouns!)[0]?.pronouns;
                      return firstPronoun ? (
                        <span className="text-muted-foreground">{contact.speakToAs!.grammaticalGender ? " · " : ""}{firstPronoun}</span>
                      ) : null;
                    })()}
                  </div>
                </FieldRow>
              )}
              {preferredLanguages.map((lang, i) => (
                <FieldRow
                  key={`lg${i}`}
                  icon={Languages}
                  label={formatContexts(lang.contexts) || t("detail.language_label")}
                >
                  <div className="text-sm">{lang.language}</div>
                </FieldRow>
              ))}
              {personalInfo.map((pi, i) => (
                <FieldRow
                  key={`pi${i}`}
                  icon={Heart}
                  label={`${t(`detail.personal_${pi.kind}`)}${pi.level ? ` · ${pi.level}` : ""}`}
                >
                  <div className="text-sm">{pi.value}</div>
                </FieldRow>
              ))}
            </div>
          </Section>
        )}

        {keywords.length > 0 && (
          <Section title={t("detail.categories")}>
            <div className="flex flex-wrap gap-1.5">
              {keywords.map((kw, i) => (
                <span key={i} className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary">
                  {kw}
                </span>
              ))}
            </div>
          </Section>
        )}

        {relatedTo.length > 0 && (
          <Section title={t("detail.related_contacts")}>
            <div className="space-y-2">
              {relatedTo.map(([uri, rel], i) => {
                const relType = rel.relation ? Object.keys(rel.relation).find(k => rel.relation![k]) : undefined;
                return (
                  <FieldRow key={`rel${i}`} icon={Users} label={relType || t("detail.related_default_label")}>
                    <div className="text-sm break-all">{uri}</div>
                  </FieldRow>
                );
              })}
            </div>
          </Section>
        )}

        {cryptoKeys.length > 0 && (
          <Section title={t("detail.crypto_keys")}>
            <div className="space-y-3">
              {cryptoKeys.map((key, i) => (
                <div key={i} className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1">
                  <div className="flex items-start gap-2 text-sm break-all">
                    <KeyRound className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                    {typeof key.uri === 'string' && key.uri.startsWith("http") ? (
                      <a href={key.uri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {key.uri}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{typeof key.uri === 'string' ? `${key.uri.substring(0, 80)}${key.uri.length > 80 ? "…" : ""}` : String(key.uri ?? '')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {(contact.calendarUri || contact.schedulingUri || contact.freeBusyUri) && (
          <Section title={t("detail.calendar")}>
            <div className="space-y-3">
              {contact.calendarUri && (
                <FieldRow icon={Calendar} label={t("detail.calendar_uri")}>
                  <a href={contact.calendarUri} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">
                    {contact.calendarUri}
                  </a>
                </FieldRow>
              )}
              {contact.schedulingUri && (
                <FieldRow icon={Calendar} label={t("detail.scheduling_uri")}>
                  <a href={contact.schedulingUri} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">
                    {contact.schedulingUri}
                  </a>
                </FieldRow>
              )}
              {contact.freeBusyUri && (
                <FieldRow icon={Calendar} label={t("detail.freebusy_uri")}>
                  <a href={contact.freeBusyUri} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">
                    {contact.freeBusyUri}
                  </a>
                </FieldRow>
              )}
            </div>
          </Section>
        )}

        {notes.length > 0 && (
          <Section title={t("detail.notes")}>
            <div className="flex items-start gap-3">
              <StickyNote className="w-4 h-4 text-muted-foreground mt-1 flex-shrink-0" />
              <div className="text-sm space-y-2 flex-1 min-w-0">
                {notes.map((n, i) => (
                  <p key={i} className="whitespace-pre-wrap">{n.note}</p>
                ))}
              </div>
            </div>
          </Section>
        )}

        <ContactActivity contact={contact} />

        {(contact.created || contact.updated) && (
          <div className="py-4 text-xs text-muted-foreground space-y-1">
            {contact.created && <div>{t("detail.created")}: {formatDate(contact.created)}</div>}
            {contact.updated && <div>{t("detail.updated")}: {formatDate(contact.updated)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function formatContexts(contexts?: Record<string, boolean>): string {
  if (!contexts) return "";
  return Object.keys(contexts).filter(k => contexts[k]).join(", ");
}

export function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("py-6", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">{title}</h3>
      {children}
    </section>
  );
}

function FieldRow({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="w-4 h-4 text-muted-foreground mt-1 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        {label && <div className="text-xs text-muted-foreground mb-0.5">{label}</div>}
        {children}
      </div>
    </div>
  );
}

function RowActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {children}
    </div>
  );
}

function MoreActionsMenu({ items, label }: { items: MoreItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className="touch-manipulation"
      >
        <MoreHorizontal className="w-4 h-4" />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute end-0 top-full mt-1 z-30 min-w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 animate-in fade-in-0 zoom-in-95 duration-100"
        >
          {items.map((item, i) => {
            if (item.separator) {
              return <div key={i} role="separator" className="my-1 h-px bg-border" />;
            }
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                onClick={() => {
                  item.onClick();
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-start hover:bg-muted focus:bg-muted focus:outline-none transition-colors",
                  item.destructive && "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 focus:bg-red-50 dark:focus:bg-red-950",
                )}
              >
                <item.icon className={cn("w-4 h-4 flex-shrink-0", item.destructive ? "text-red-600 dark:text-red-400" : "text-muted-foreground")} />
                <span className="flex-1">{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CopyButton({ value, label, successMsg, failMsg, className }: { value: string; label: string; successMsg: string; failMsg: string; className?: string }) {
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast.success(successMsg);
        } catch {
          toast.error(failMsg);
        }
      }}
      className={cn("p-1.5 rounded hover:bg-muted transition-colors touch-manipulation", className)}
      title={label}
      aria-label={label}
    >
      <Copy className="w-3.5 h-3.5 text-muted-foreground" />
    </button>
  );
}
