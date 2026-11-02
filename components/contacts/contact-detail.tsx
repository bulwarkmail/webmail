"use client";

import { useEffect, useRef, useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { contactDateParts, formatContactDate } from "@/lib/contact-dates";
import { Mail, Phone, Building, MapPin, StickyNote, Pencil, BookUser, Copy, Send, Globe, Cake, KeyRound, Users, Briefcase, Heart, Languages, Calendar, UserCircle, MoreVertical, Printer } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { MailtoLink } from "@/components/ui/mailto-link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ContactCard, AnniversaryDate } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail, getContactPhotoRef } from "@/stores/contact-store";
import { ContactActivity } from "./contact-activity";
import { toast } from "@/stores/toast-store";
import { ContactContextMenu } from "./contact-context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { ToolbarButton } from "@/components/ui/toolbar";
import { usePluginSlotOffers } from "@/hooks/use-plugin-slot-offers";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { contactHooks } from "@/lib/plugin-hooks";
import { contactToView } from "@/lib/plugin-projection";
import { gateLinkClick } from "@/lib/plugin-hook-result";

interface ContactDetailProps {
  contact: ContactCard | null;
  onEdit: () => void;
  onDelete: () => void;
  onAddToGroup?: () => void;
  onDuplicate?: () => void;
  /** Move to another address book; undefined where there is none to move to. */
  onMoveTo?: () => void;
  /** Compose an email to this contact in the app (no OS mailto handoff). */
  onCompose?: () => void;
  /** Print the contact on a sheet of its own. */
  onPrint?: () => void;
  isMobile?: boolean;
  className?: string;
}

// Contexts and phone features the contact form offers, shown with the same
// labels here. Anything else (custom vCard types) is shown as stored.
const CONTEXT_LABEL_KEYS: Record<string, string> = {
  work: "form.context_work",
  private: "form.context_private",
};

const PHONE_FEATURE_LABEL_KEYS: Record<string, string> = {
  voice: "form.phone_voice",
  cell: "form.phone_cell",
  mobile: "form.phone_cell",
  fax: "form.phone_fax",
  pager: "form.phone_pager",
  video: "form.phone_video",
  text: "form.phone_text",
};

function formatPhoneFeatures(features: Record<string, boolean> | undefined, label: (key: string) => string): string {
  if (!features) return "";
  return Object.keys(features).filter(k => features[k]).map(label).join(", ");
}

function getCompletedYears(dateInput: AnniversaryDate): number | null {
  const { year, month, day } = contactDateParts(dateInput);
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


export function ContactDetail({ contact, onEdit, onDelete, onAddToGroup, onDuplicate, onMoveTo, onCompose, onPrint, isMobile, className }: ContactDetailProps) {
  const t = useTranslations("contacts");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  // The ⋮ shows the contact's menu, the one right-click shows in the list (R6).
  const moreMenu = useContextMenu<ContactCard>();
  const contextLabel = (key: string) => (CONTEXT_LABEL_KEYS[key] ? t(CONTEXT_LABEL_KEYS[key]) : key);
  const featureLabel = (key: string) => (PHONE_FEATURE_LABEL_KEYS[key] ? t(PHONE_FEATURE_LABEL_KEYS[key]) : key);

  const cryptoKeys = contact?.cryptoKeys ? Object.values(contact.cryptoKeys) : [];
  const hasCryptoKeysSlotOffers = usePluginSlotOffers('contact-cryptokeys').length > 0;
  const pluginContactProps = useMemo(() => (contact ? { contact: contactToView(contact) } : null), [contact]);

  // Tell plugins once per contact shown here, not on every edit of that card.
  const latestContact = useRef(contact);
  useEffect(() => { latestContact.current = contact; });
  const openedId = contact?.id;
  useEffect(() => {
    const opened = latestContact.current;
    if (!openedId || !opened) return;
    void contactHooks.onContactOpen.emit(contactToView(opened));
  }, [openedId]);

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
  const photo = getContactPhotoRef(contact) ?? null;
  const phone = contact.phones ? Object.values(contact.phones)[0]?.number : undefined;

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
  // On an organization card the org name is already the heading; don't repeat it.
  const orgName = orgs[0]?.name;
  const subtitleParts = [titleLine, orgName === name ? undefined : orgName].filter(Boolean) as string[];
  const hasContactDetails = emails.length > 0 || phones.length > 0 || addresses.length > 0 || onlineServices.length > 0;
  const hasWork = titles.length > 0 || orgs.length > 0;
  const hasGender = !!(contact.speakToAs && (contact.speakToAs.grammaticalGender || contact.speakToAs.pronouns));
  const hasPersonal = anniversaries.length > 0 || personalInfo.length > 0 || hasGender || preferredLanguages.length > 0;

  return (
    <div className={cn("flex flex-col h-full overflow-y-auto", className)}>
      <div className={cn("border-b border-border", isMobile ? "px-4 py-4" : "px-6 py-6")}>
        <div className={cn("flex gap-4", isMobile ? "flex-col" : "flex-wrap items-start justify-between")}>
          <div className={cn("flex items-center gap-4 min-w-0 flex-1", !isMobile && "basis-60")}>
            <Avatar name={name} email={email} contactPhoto={photo} size={isMobile ? "md" : "lg"} />
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
          <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
            {email && onCompose && (
              <Button variant="outline" size="xs" onClick={onCompose} className="gap-1.5 touch-manipulation">
                <Send />
                {t("detail.compose_email")}
              </Button>
            )}
            {phone && (
              <a
                href={`tel:${phone}`}
                className="inline-flex items-center justify-center gap-1.5 rounded-md font-medium h-8 px-2.5 text-sm border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors touch-manipulation"
              >
                <Phone className="w-4 h-4" />
                {t("context_menu.call")}
              </a>
            )}
            <Button variant="outline" size="xs" onClick={onEdit} className="gap-1.5 touch-manipulation">
              <Pencil />
              {t("form.edit_title")}
            </Button>
            {onPrint && (
              <ToolbarButton label={tCommon("print")} onClick={onPrint} className="touch-manipulation">
                <Printer />
              </ToolbarButton>
            )}
            <ToolbarButton
              label={t("detail.more_actions")}
              aria-haspopup="menu"
              aria-expanded={moreMenu.contextMenu.isOpen}
              active={moreMenu.contextMenu.isOpen}
              onClick={(e) => moreMenu.openContextMenuFrom(e.currentTarget, contact, "end")}
              className="touch-manipulation"
            >
              <MoreVertical />
            </ToolbarButton>
            {moreMenu.contextMenu.data && (
              <ContactContextMenu
                contact={moreMenu.contextMenu.data}
                position={moreMenu.contextMenu.position}
                isOpen={moreMenu.contextMenu.isOpen}
                onClose={moreMenu.closeContextMenu}
                menuRef={moreMenu.menuRef}
                inDetail
                onCompose={onCompose}
                onDelete={onDelete}
                onAddToGroup={onAddToGroup}
                onDuplicate={onDuplicate}
                onMoveTo={onMoveTo}
              />
            )}
          </div>
        </div>
      </div>

      <div className={cn("divide-y divide-border/60", isMobile ? "px-4" : "px-6")}>
        {hasContactDetails && (
          <Section title={t("detail.section_contact")}>
            <div className="space-y-3">
              {emails.map((e, i) => (
                <FieldRow key={`em${i}`} icon={Mail} label={e.label || formatContexts(e.contexts, contextLabel) || t("detail.email_default_label")}>
                  <div className="flex items-center gap-2 group">
                    <MailtoLink to={e.address} className="text-sm text-primary hover:underline break-all">
                      {e.address}
                    </MailtoLink>
                    <RowActions>
                      <MailtoLink
                        to={e.address}
                        className="p-1.5 rounded hover:bg-muted transition-colors touch-manipulation"
                        title={t("detail.compose_email")}
                        aria-label={t("detail.compose_email")}
                      >
                        <Send className="w-3.5 h-3.5 text-muted-foreground" />
                      </MailtoLink>
                      <CopyButton value={e.address} label={t("detail.copy_email")} successMsg={t("detail.copied")} failMsg={t("detail.copy_failed")} />
                    </RowActions>
                  </div>
                </FieldRow>
              ))}

              {phones.map((p, i) => {
                const features = formatPhoneFeatures(p.features, featureLabel);
                const labelParts = [p.label, formatContexts(p.contexts, contextLabel), features].filter(Boolean) as string[];
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
                  <FieldRow key={`ad${i}`} icon={MapPin} label={formatContexts(a.contexts, contextLabel) || t("detail.address_default_label")}>
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
                  label={[svc.service, formatContexts(svc.contexts, contextLabel)].filter(Boolean).join(" · ") || t("detail.online_service_default_label")}
                >
                  <div className="flex items-center gap-2 group">
                    {typeof svc.uri === 'string' && svc.uri.startsWith("http") ? (
                      <a href={svc.uri} target="_blank" rel="noopener noreferrer" onClick={gateLinkClick} onAuxClick={gateLinkClick} className="text-sm text-primary hover:underline break-all">
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
                      {formatContactDate(ann.date, locale)}
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
                  label={formatContexts(lang.contexts, contextLabel) || t("detail.language_label")}
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

             {hasCryptoKeysSlotOffers && (
              <PluginSlot name="contact-cryptokeys" extraProps={{ cryptoKeys }} />
              )}

              {!hasCryptoKeysSlotOffers &&cryptoKeys.map((key, i) => (
                <div key={i} className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1">
                  <div className="flex items-start gap-2 text-sm break-all">
                    <KeyRound className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                    {typeof key.uri === 'string' && key.uri.startsWith("http") ? (
                      <a href={key.uri} target="_blank" rel="noopener noreferrer" onClick={gateLinkClick} onAuxClick={gateLinkClick} className="text-primary hover:underline">
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
                  <a href={contact.calendarUri} target="_blank" rel="noopener noreferrer" onClick={gateLinkClick} onAuxClick={gateLinkClick} className="text-sm text-primary hover:underline break-all">
                    {contact.calendarUri}
                  </a>
                </FieldRow>
              )}
              {contact.schedulingUri && (
                <FieldRow icon={Calendar} label={t("detail.scheduling_uri")}>
                  <a href={contact.schedulingUri} target="_blank" rel="noopener noreferrer" onClick={gateLinkClick} onAuxClick={gateLinkClick} className="text-sm text-primary hover:underline break-all">
                    {contact.schedulingUri}
                  </a>
                </FieldRow>
              )}
              {contact.freeBusyUri && (
                <FieldRow icon={Calendar} label={t("detail.freebusy_uri")}>
                  <a href={contact.freeBusyUri} target="_blank" rel="noopener noreferrer" onClick={gateLinkClick} onAuxClick={gateLinkClick} className="text-sm text-primary hover:underline break-all">
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

        {pluginContactProps && (
          <PluginSlot name="contact-detail-section" className="w-full py-6" extraProps={pluginContactProps} />
        )}

        <ContactActivity contact={contact} />

        {(contact.created || contact.updated) && (
          <div className="py-4 text-xs text-muted-foreground space-y-1">
            {contact.created && <div>{t("detail.created")}: {formatContactDate(contact.created, locale)}</div>}
            {contact.updated && <div>{t("detail.updated")}: {formatContactDate(contact.updated, locale)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function formatContexts(contexts: Record<string, boolean> | undefined, label: (key: string) => string): string {
  if (!contexts) return "";
  return Object.keys(contexts).filter(k => contexts[k]).map(label).join(", ");
}

export function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("py-6", className)}>
      <h3 className="text-xs font-semibold text-muted-foreground mb-3">{title}</h3>
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
  // Shown on hover, while the keyboard is in the row and always on touch
  // screens, which have no hover (WCAG 2.1.1, 2.4.7).
  return (
    <div data-row-actions className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
      {children}
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
