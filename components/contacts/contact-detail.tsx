"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Mail, Phone, Building, MapPin, StickyNote, Pencil, Trash2, BookUser, Copy, Send, Globe, Cake, Tag, KeyRound, Link, Users, Briefcase, Heart, Languages, MessageCircle, User, Calendar, UserCircle, ShieldCheck, ShieldAlert, Download } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";
import { useSmimeStore } from "@/stores/smime-store";
import { parseCertificatePemOrDer, extractCertificateInfo } from "@/lib/smime/certificate-utils";
import type { CertificateInfo } from "@/lib/smime/types";
import { toast } from "@/stores/toast-store";

interface ContactDetailProps {
  contact: ContactCard | null;
  onEdit: () => void;
  onDelete: () => void;
  isMobile?: boolean;
  className?: string;
}

function formatPhoneFeatures(features?: Record<string, boolean>): string {
  if (!features) return "";
  return Object.keys(features).filter(k => features[k]).join(", ");
}

function formatDate(dateInput: string | Record<string, unknown>): string {
  // Handle RFC 9553 PartialDate objects: { year?, month?, day?, calendarScale? }
  if (typeof dateInput === 'object' && dateInput !== null) {
    const year = dateInput.year as number | undefined;
    const month = dateInput.month as number | undefined;
    const day = dateInput.day as number | undefined;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const parts: string[] = [];
    if (month && monthNames[month - 1]) parts.push(monthNames[month - 1]);
    if (day) parts.push(String(day));
    if (year) parts.push(String(year));
    return parts.join(' ') || String(dateInput);
  }
  const dateStr = String(dateInput);
  // Handle both ISO dates and partial dates like 1990-01-15 or --01-15
  if (dateStr.startsWith("--")) {
    // Partial date without year
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

export function ContactDetail({ contact, onEdit, onDelete, isMobile, className }: ContactDetailProps) {
  const t = useTranslations("contacts");
  const smimeStore = useSmimeStore();
  const [parsedCerts, setParsedCerts] = useState<Map<number, CertificateInfo>>(new Map());

  const cryptoKeys = contact?.cryptoKeys ? Object.values(contact.cryptoKeys) : [];

  useEffect(() => {
    if (!contact) return;
    let cancelled = false;
    const parseCerts = async () => {
      const results = new Map<number, CertificateInfo>();
      for (let i = 0; i < cryptoKeys.length; i++) {
        const key = cryptoKeys[i];
        if (typeof key.uri !== 'string') continue;
        try {
          let derBytes: ArrayBuffer | string | null = null;
          if (key.uri.startsWith('data:')) {
            // data URI — extract base64 content
            const commaIdx = key.uri.indexOf(',');
            if (commaIdx === -1) continue;
            const b64 = key.uri.substring(commaIdx + 1);
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
            derBytes = bytes.buffer;
          } else if (key.uri.startsWith('-----BEGIN')) {
            // PEM-encoded certificate inline
            derBytes = key.uri;
          }
          if (!derBytes) continue;
          const cert = parseCertificatePemOrDer(derBytes);
          const der = typeof derBytes === 'string' ? cert.toSchema(true).toBER(false) : derBytes;
          const info = await extractCertificateInfo(cert, der);
          if (!cancelled) results.set(i, info);
        } catch { /* skip unparseable keys */ }
      }
      if (!cancelled) setParsedCerts(results);
    };
    if (cryptoKeys.length > 0) {
      parseCerts();
    } else {
      setParsedCerts(new Map());
    }
    return () => { cancelled = true; };
  }, [contact?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const titles = contact.titles ? Object.values(contact.titles) : [];
  const jobTitles = titles.filter(t => t.kind !== "role");
  const roles = titles.filter(t => t.kind === "role");
  const onlineServices = contact.onlineServices ? Object.values(contact.onlineServices) : [];
  const anniversaries = contact.anniversaries ? Object.values(contact.anniversaries) : [];
  const keywords = contact.keywords ? Object.keys(contact.keywords).filter(k => contact.keywords![k]) : [];

  const handleImportContactCert = async (keyIndex: number) => {
    const key = cryptoKeys[keyIndex];
    if (!key?.uri || typeof key.uri !== 'string') return;
    try {
      let derBytes: ArrayBuffer | string;
      if (key.uri.startsWith('data:')) {
        const commaIdx = key.uri.indexOf(',');
        if (commaIdx === -1) return;
        const b64 = key.uri.substring(commaIdx + 1);
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
        derBytes = bytes.buffer;
      } else if (key.uri.startsWith('-----BEGIN')) {
        derBytes = key.uri;
      } else {
        return;
      }
      await smimeStore.importPublicCert(derBytes, 'contact', contact.id);
      toast.success(t("detail.cert_imported"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("detail.cert_import_failed"));
    }
  };
  const relatedTo = contact.relatedTo ? Object.entries(contact.relatedTo) : [];
  const preferredLanguages = contact.preferredLanguages ? Object.values(contact.preferredLanguages) : [];
  const personalInfo = contact.personalInfo ? Object.values(contact.personalInfo) : [];
  const nicknames = contact.nicknames ? Object.values(contact.nicknames) : [];

  const hasNickname = nicknames.length > 0;
  const titleLine = jobTitles.length > 0 ? jobTitles.map(t => t.name).join(", ") : undefined;

  return (
    <div className={cn("flex flex-col h-full overflow-y-auto", className)}>
      <div className={cn("border-b border-border", isMobile ? "px-4 py-4" : "px-6 py-6")}>
        <div className={cn("flex gap-4", isMobile ? "flex-col" : "items-start justify-between")}>
          <div className="flex items-center gap-4">
            <Avatar name={name} email={email} size={isMobile ? "md" : "lg"} />
            <div className="min-w-0 flex-1">
              <h2 className={cn("font-semibold truncate", isMobile ? "text-lg" : "text-xl")}>{name || "—"}</h2>
              {hasNickname && (
                <p className="text-sm text-muted-foreground truncate">&ldquo;{nicknames.map(n => n.name).join(", ")}&rdquo;</p>
              )}
              {titleLine && (
                <p className="text-sm text-muted-foreground truncate">{titleLine}</p>
              )}
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

      <div className="px-6 py-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {/* Contact info */}
          {emails.length > 0 && (
            <Section icon={Mail} title={t("detail.emails")} category="contact">
              {emails.map((e, i) => (
                <div key={i} className="flex items-center gap-2 group">
                  <a href={`mailto:${e.address}`} className="text-sm text-primary hover:underline">
                    {e.address}
                  </a>
                  {e.contexts && <ContextBadge contexts={e.contexts} />}
                  {e.label && <span className="text-xs text-muted-foreground">({e.label})</span>}
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
                    <CopyButton value={e.address} label={t("detail.copy_email")} successMsg={t("detail.copied")} failMsg={t("detail.copy_failed")} />
                  </div>
                </div>
              ))}
            </Section>
          )}

          {phones.length > 0 && (
            <Section icon={Phone} title={t("detail.phones")} category="contact">
              {phones.map((p, i) => {
                const featureStr = formatPhoneFeatures(p.features);
                return (
                  <div key={i} className="flex items-center gap-2 group">
                    <a href={`tel:${p.number}`} className="text-sm text-primary hover:underline">
                      {p.number}
                    </a>
                    {p.contexts && <ContextBadge contexts={p.contexts} />}
                    {featureStr && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{featureStr}</span>
                    )}
                    <CopyButton
                      value={p.number}
                      label={t("detail.copy_phone")}
                      successMsg={t("detail.copied")}
                      failMsg={t("detail.copy_failed")}
                      className={isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"}
                    />
                  </div>
                );
              })}
            </Section>
          )}

          {(roles.length > 0 || jobTitles.length > 1) && (
            <Section icon={Briefcase} title={t("detail.titles")} category="work">
              {titles.map((tl, i) => (
                <div key={i} className="text-sm flex items-center gap-2">
                  <span>{tl.name}</span>
                  {tl.kind && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{tl.kind}</span>
                  )}
                </div>
              ))}
            </Section>
          )}

          {orgs.length > 0 && (
            <Section icon={Building} title={t("detail.organizations")} category="work">
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

          {/* Addresses span full width */}
          {addresses.length > 0 && (
            <div className="md:col-span-2 xl:col-span-3">
              <Section icon={MapPin} title={t("detail.addresses")} category="location">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {addresses.map((a, i) => (
                    <div key={i} className="text-sm space-y-0.5 rounded-md border border-border/60 bg-muted/30 p-3">
                      <div>
                        {a.fullAddress
                          ? a.fullAddress
                          : [a.street, a.locality, a.region, a.postcode, a.country].filter(Boolean).join(", ")}
                        {a.contexts && <ContextBadge contexts={a.contexts} />}
                      </div>
                      {a.timeZone && (
                        <div className="text-xs text-muted-foreground">{t("detail.timezone")}: {a.timeZone}</div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            </div>
          )}

          {onlineServices.length > 0 && (
            <Section icon={Globe} title={t("detail.online_services")} category="digital">
              {onlineServices.map((svc, i) => (
                <div key={i} className="flex items-center gap-2 group">
                  {typeof svc.uri === 'string' && svc.uri.startsWith("http") ? (
                    <a href={svc.uri} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline break-all">
                      {svc.user || svc.uri}
                    </a>
                  ) : (
                    <span className="text-sm break-all">{svc.user || String(svc.uri ?? '')}</span>
                  )}
                  {svc.service && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{svc.service}</span>
                  )}
                  {svc.contexts && <ContextBadge contexts={svc.contexts} />}
                  <CopyButton
                    value={svc.user || svc.uri}
                    label={t("detail.copy_url")}
                    successMsg={t("detail.copied")}
                    failMsg={t("detail.copy_failed")}
                    className={isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"}
                  />
                </div>
              ))}
            </Section>
          )}

          {anniversaries.length > 0 && (
            <Section icon={Cake} title={t("detail.anniversaries")} category="personal">
              {anniversaries.map((ann, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span>{formatDate(ann.date)}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    {t(`detail.anniversary_${ann.kind}`)}
                  </span>
                </div>
              ))}
            </Section>
          )}

          {personalInfo.length > 0 && (
            <Section icon={Heart} title={t("detail.personal_info")} category="personal">
              {personalInfo.map((pi, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span>{pi.value}</span>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{t(`detail.personal_${pi.kind}`)}</span>
                  {pi.level && (
                    <span className="text-xs text-muted-foreground">({pi.level})</span>
                  )}
                </div>
              ))}
            </Section>
          )}

          {contact.speakToAs && (contact.speakToAs.grammaticalGender || contact.speakToAs.pronouns) && (
            <Section icon={UserCircle} title={t("detail.gender")} category="personal">
              <div className="text-sm">
                {contact.speakToAs.grammaticalGender && <span>{t(`detail.gender_${contact.speakToAs.grammaticalGender}`, { defaultValue: contact.speakToAs.grammaticalGender })}</span>}
                {contact.speakToAs.pronouns && (() => {
                  const firstPronoun = Object.values(contact.speakToAs!.pronouns!)[0]?.pronouns;
                  return firstPronoun ? (
                    <span className="text-muted-foreground">{contact.speakToAs!.grammaticalGender ? " — " : ""}{firstPronoun}</span>
                  ) : null;
                })()}
              </div>
            </Section>
          )}

          {preferredLanguages.length > 0 && (
            <Section icon={Languages} title={t("detail.languages")} category="personal">
              {preferredLanguages.map((lang, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span>{lang.language}</span>
                  {lang.contexts && <ContextBadge contexts={lang.contexts} />}
                </div>
              ))}
            </Section>
          )}

          {keywords.length > 0 && (
            <Section icon={Tag} title={t("detail.categories")} category="digital">
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
            <Section icon={Users} title={t("detail.related_contacts")} category="personal">
              {relatedTo.map(([uri, rel], i) => {
                const relType = rel.relation ? Object.keys(rel.relation).find(k => rel.relation![k]) : undefined;
                return (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span>{uri}</span>
                    {relType && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{relType}</span>
                    )}
                  </div>
                );
              })}
            </Section>
          )}

          {cryptoKeys.length > 0 && (
            <Section icon={KeyRound} title={t("detail.crypto_keys")} category="digital">
              {cryptoKeys.map((key, i) => {
                const certInfo = parsedCerts.get(i);
                const isExpired = certInfo ? new Date(certInfo.notAfter) < new Date() : false;
                const alreadyImported = certInfo?.emailAddresses?.[0]
                  ? !!smimeStore.getPublicCertForEmail(certInfo.emailAddresses[0])
                  : false;

                return (
                  <div key={i} className="p-3 rounded-lg border border-border space-y-1">
                    {certInfo ? (
                      <>
                        <div className="flex items-center gap-2">
                          {isExpired ? (
                            <ShieldAlert className="w-4 h-4 text-destructive flex-shrink-0" />
                          ) : (
                            <ShieldCheck className="w-4 h-4 text-primary flex-shrink-0" />
                          )}
                          <span className="text-sm font-medium truncate">{certInfo.subject}</span>
                        </div>
                        <div className="text-xs text-muted-foreground space-y-0.5 pl-6">
                          <p>{t("detail.cert_issuer")}: {certInfo.issuer}</p>
                          <p>
                            {t("detail.cert_expires")}: {new Date(certInfo.notAfter).toLocaleDateString()}
                            {isExpired && <span className="text-destructive ml-1">({t("detail.cert_expired")})</span>}
                          </p>
                          <p>{t("detail.cert_fingerprint")}: {certInfo.fingerprint.substring(0, 20)}...</p>
                          {certInfo.algorithm && <p>{t("detail.cert_algorithm")}: {certInfo.algorithm}</p>}
                        </div>
                        {!alreadyImported && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-4 mt-1"
                            onClick={() => handleImportContactCert(i)}
                          >
                            <Download className="w-3 h-3 mr-1" />
                            {t("detail.import_to_smime")}
                          </Button>
                        )}
                        {alreadyImported && (
                          <p className="text-xs text-green-600 pl-6 mt-1">{t("detail.cert_already_imported")}</p>
                        )}
                      </>
                    ) : (
                      <div className="text-sm break-all">
                        {typeof key.uri === 'string' && key.uri.startsWith("http") ? (
                          <a href={key.uri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                            {key.uri}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">{typeof key.uri === 'string' ? `${key.uri.substring(0, 80)}${key.uri.length > 80 ? "…" : ""}` : String(key.uri ?? '')}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </Section>
          )}

          {(contact.calendarUri || contact.schedulingUri || contact.freeBusyUri) && (
            <Section icon={Calendar} title={t("detail.calendar")} category="calendar">
              {contact.calendarUri && (
                <div className="text-sm">
                  <span className="text-muted-foreground">{t("detail.calendar_uri")}: </span>
                  <a href={contact.calendarUri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{contact.calendarUri}</a>
                </div>
              )}
              {contact.schedulingUri && (
                <div className="text-sm">
                  <span className="text-muted-foreground">{t("detail.scheduling_uri")}: </span>
                  <a href={contact.schedulingUri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{contact.schedulingUri}</a>
                </div>
              )}
              {contact.freeBusyUri && (
                <div className="text-sm">
                  <span className="text-muted-foreground">{t("detail.freebusy_uri")}: </span>
                  <a href={contact.freeBusyUri} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">{contact.freeBusyUri}</a>
                </div>
              )}
            </Section>
          )}

          {/* Notes span full width */}
          {notes.length > 0 && (
            <div className="md:col-span-2 xl:col-span-3">
              <Section icon={StickyNote} title={t("detail.notes")} category="notes">
                {notes.map((n, i) => (
                  <p key={i} className="text-sm whitespace-pre-wrap">{n.note}</p>
                ))}
              </Section>
            </div>
          )}

          {/* Timestamps span full width */}
          {(contact.created || contact.updated) && (
            <div className="md:col-span-2 xl:col-span-3 pt-2 border-t border-border text-xs text-muted-foreground space-y-1">
              {contact.created && <div>{t("detail.created")}: {formatDate(contact.created)}</div>}
              {contact.updated && <div>{t("detail.updated")}: {formatDate(contact.updated)}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type SectionCategory = "contact" | "work" | "location" | "personal" | "digital" | "calendar" | "notes";

const categoryStyles: Record<SectionCategory, string> = {
  contact: "border-l-blue-400 dark:border-l-blue-500",
  work: "border-l-amber-400 dark:border-l-amber-500",
  location: "border-l-emerald-400 dark:border-l-emerald-500",
  personal: "border-l-violet-400 dark:border-l-violet-500",
  digital: "border-l-cyan-400 dark:border-l-cyan-500",
  calendar: "border-l-rose-400 dark:border-l-rose-500",
  notes: "border-l-stone-400 dark:border-l-stone-500",
};

function Section({ icon: Icon, title, children, category = "contact" }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode; category?: SectionCategory }) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4 border-l-[3px]", categoryStyles[category])}>
      <div className="flex items-center gap-2 mb-2.5">
        <Icon className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      </div>
      <div className="space-y-1.5 pl-6">{children}</div>
    </div>
  );
}

function ContextBadge({ contexts }: { contexts: Record<string, boolean> }) {
  const labels = Object.keys(contexts).filter(k => contexts[k]);
  if (labels.length === 0) return null;

  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground ml-1">
      {labels.join(", ")}
    </span>
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
      className={cn("p-1.5 rounded hover:bg-muted transition-colors touch-manipulation transition-opacity", className)}
      title={label}
      aria-label={label}
    >
      <Copy className="w-3.5 h-3.5 text-muted-foreground" />
    </button>
  );
}
