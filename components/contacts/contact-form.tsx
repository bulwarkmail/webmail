"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { X, Plus, ChevronDown, ChevronRight, User, Building, MapPin, Globe, Cake, Heart, Tag, StickyNote, Mail, Phone, Calendar, UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ContactCard, ContactOnlineService, ContactAnniversary, ContactPersonalInfo } from "@/lib/jmap/types";

interface EmailEntry {
  address: string;
  context: "work" | "private" | "";
}

interface PhoneEntry {
  number: string;
  context: "work" | "private" | "";
  feature: "voice" | "cell" | "fax" | "pager" | "video" | "text" | "";
}

interface OnlineServiceEntry {
  uri: string;
  service: string;
  label: string;
}

interface AnniversaryEntry {
  date: string;
  kind: "birth" | "death" | "wedding" | "other";
}

interface PersonalInfoEntry {
  value: string;
  kind: "expertise" | "hobby" | "interest" | "other";
  level: "high" | "medium" | "low" | "";
}

interface AddressEntry {
  street: string;
  locality: string;
  region: string;
  postcode: string;
  country: string;
  context: "work" | "private" | "";
}

interface ContactFormProps {
  contact?: ContactCard | null;
  onSave: (data: Partial<ContactCard>) => Promise<void>;
  onCancel: () => void;
}

type FormCategory = "contact" | "work" | "location" | "personal" | "digital" | "calendar" | "notes";

const formCategoryStyles: Record<FormCategory, string> = {
  contact: "border-l-blue-400 dark:border-l-blue-500",
  work: "border-l-amber-400 dark:border-l-amber-500",
  location: "border-l-emerald-400 dark:border-l-emerald-500",
  personal: "border-l-violet-400 dark:border-l-violet-500",
  digital: "border-l-cyan-400 dark:border-l-cyan-500",
  calendar: "border-l-rose-400 dark:border-l-rose-500",
  notes: "border-l-stone-400 dark:border-l-stone-500",
};

function FormSection({ icon: Icon, title, children, collapsible, defaultOpen = false, category = "contact" }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  category?: FormCategory;
}) {
  const [open, setOpen] = useState(defaultOpen || !collapsible);

  return (
    <div className={cn("rounded-lg border border-border bg-card border-l-[3px] px-4 py-3", formCategoryStyles[category])}>
      <button
        type="button"
        className={cn(
          "flex items-center gap-2 w-full py-0.5 text-sm font-medium text-foreground transition-colors",
          collapsible && "hover:text-muted-foreground cursor-pointer",
          !collapsible && "cursor-default"
        )}
        onClick={() => collapsible && setOpen(!open)}
        tabIndex={collapsible ? 0 : -1}
      >
        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="flex-1 text-left">{title}</span>
        {collapsible && (
          open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="space-y-3 pt-3 pb-1">
          {children}
        </div>
      )}
    </div>
  );
}

function Select({ value, onChange, children, className }: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      className={cn(
        "text-sm bg-transparent border border-input rounded-md px-2.5 py-2 text-foreground",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
        "hover:border-muted-foreground/50 transition-colors",
        className
      )}
    >
      {children}
    </select>
  );
}

export function ContactForm({ contact, onSave, onCancel }: ContactFormProps) {
  const t = useTranslations("contacts.form");
  const isEditing = !!contact;

  const findComponent = (kind: string) => contact?.name?.components?.find(c => c.kind === kind)?.value || "";

  const [prefix, setPrefix] = useState(findComponent("prefix"));
  const [givenName, setGivenName] = useState(findComponent("given"));
  const [additionalName, setAdditionalName] = useState(findComponent("additional"));
  const [surname, setSurname] = useState(findComponent("surname"));
  const [suffix, setSuffix] = useState(findComponent("suffix"));

  const [nickname, setNickname] = useState(
    contact?.nicknames ? Object.values(contact.nicknames)[0]?.name || "" : ""
  );

  const [emails, setEmails] = useState<EmailEntry[]>(() => {
    if (contact?.emails) {
      return Object.values(contact.emails).map(e => ({
        address: e.address,
        context: e.contexts?.work ? "work" : e.contexts?.private ? "private" : "",
      }));
    }
    return [{ address: "", context: "" }];
  });

  const [phones, setPhones] = useState<PhoneEntry[]>(() => {
    if (contact?.phones) {
      return Object.values(contact.phones).map(p => ({
        number: p.number,
        context: p.contexts?.work ? "work" : p.contexts?.private ? "private" : "",
        feature: p.features?.cell ? "cell" : p.features?.fax ? "fax" : p.features?.pager ? "pager" : p.features?.video ? "video" : p.features?.text ? "text" : p.features?.voice ? "voice" : "",
      }));
    }
    return [];
  });

  const [organization, setOrganization] = useState(
    contact?.organizations ? Object.values(contact.organizations)[0]?.name || "" : ""
  );
  const [department, setDepartment] = useState(
    contact?.organizations ? (Object.values(contact.organizations)[0]?.units?.[0]?.name || "") : ""
  );

  const [jobTitle, setJobTitle] = useState(() => {
    if (contact?.titles) {
      const t = Object.values(contact.titles).find(t => t.kind !== "role");
      return t?.name || "";
    }
    return "";
  });
  const [role, setRole] = useState(() => {
    if (contact?.titles) {
      const r = Object.values(contact.titles).find(t => t.kind === "role");
      return r?.name || "";
    }
    return "";
  });

  const [addresses, setAddresses] = useState<AddressEntry[]>(() => {
    if (contact?.addresses) {
      return Object.values(contact.addresses).map(a => ({
        street: a.street || "",
        locality: a.locality || "",
        region: a.region || "",
        postcode: a.postcode || "",
        country: a.country || "",
        context: a.contexts?.work ? "work" : a.contexts?.private ? "private" : "",
      }));
    }
    return [];
  });

  const [onlineServices, setOnlineServices] = useState<OnlineServiceEntry[]>(() => {
    if (contact?.onlineServices) {
      return Object.values(contact.onlineServices).map(s => ({
        uri: s.uri,
        service: s.service || "",
        label: s.label || "",
      }));
    }
    return [];
  });

  const [anniversaries, setAnniversaries] = useState<AnniversaryEntry[]>(() => {
    if (contact?.anniversaries) {
      return Object.values(contact.anniversaries).map(a => ({
        date: a.date,
        kind: a.kind,
      }));
    }
    return [];
  });

  const [personalInfoEntries, setPersonalInfoEntries] = useState<PersonalInfoEntry[]>(() => {
    if (contact?.personalInfo) {
      return Object.values(contact.personalInfo).map(p => ({
        value: p.value,
        kind: p.kind,
        level: p.level || "",
      }));
    }
    return [];
  });

  const [keywordsStr, setKeywordsStr] = useState(
    contact?.keywords ? Object.keys(contact.keywords).filter(k => contact.keywords![k]).join(", ") : ""
  );

  const [note, setNote] = useState(
    contact?.notes ? Object.values(contact.notes)[0]?.note || "" : ""
  );

  const [genderSex, setGenderSex] = useState(contact?.speakToAs?.grammaticalGender || "");
  const [genderIdentity, setGenderIdentity] = useState(
    contact?.speakToAs?.pronouns ? Object.values(contact.speakToAs.pronouns)[0]?.pronouns || "" : ""
  );
  const [calendarUri, setCalendarUri] = useState(contact?.calendarUri || "");
  const [schedulingUri, setSchedulingUri] = useState(contact?.schedulingUri || "");
  const [freeBusyUri, setFreeBusyUri] = useState(contact?.freeBusyUri || "");

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailErrors, setEmailErrors] = useState<Record<number, string>>({});

  const validateEmail = (address: string): boolean => {
    if (!address.trim()) return true;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());
  };

  const handleEmailBlur = (index: number, address: string) => {
    if (address.trim() && !validateEmail(address)) {
      setEmailErrors(prev => ({ ...prev, [index]: t("email_error_inline") }));
    } else {
      setEmailErrors(prev => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!givenName.trim() && !surname.trim()) {
      setError(t("name_required"));
      return;
    }

    const validEmails = emails.filter(e => e.address.trim());
    for (const entry of validEmails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.address.trim())) {
        setError(t("email_invalid"));
        return;
      }
    }

    const emailsMap: Record<string, { address: string; contexts?: Record<string, boolean> }> = {};
    validEmails.forEach((entry, i) => {
      const obj: { address: string; contexts?: Record<string, boolean> } = { address: entry.address.trim() };
      if (entry.context) {
        obj.contexts = { [entry.context]: true };
      }
      emailsMap[`e${i}`] = obj;
    });

    const validPhones = phones.filter(p => p.number.trim());
    const phonesMap: Record<string, { number: string; contexts?: Record<string, boolean>; features?: Record<string, boolean> }> = {};
    validPhones.forEach((entry, i) => {
      const obj: { number: string; contexts?: Record<string, boolean>; features?: Record<string, boolean> } = { number: entry.number.trim() };
      if (entry.context) {
        obj.contexts = { [entry.context]: true };
      }
      if (entry.feature) {
        obj.features = { [entry.feature]: true };
      }
      phonesMap[`p${i}`] = obj;
    });

    const nameComponents = [];
    if (prefix.trim()) nameComponents.push({ kind: "prefix" as const, value: prefix.trim() });
    if (givenName.trim()) nameComponents.push({ kind: "given" as const, value: givenName.trim() });
    if (additionalName.trim()) nameComponents.push({ kind: "additional" as const, value: additionalName.trim() });
    if (surname.trim()) nameComponents.push({ kind: "surname" as const, value: surname.trim() });
    if (suffix.trim()) nameComponents.push({ kind: "suffix" as const, value: suffix.trim() });

    const titlesMap: Record<string, { name: string; kind?: "title" | "role" }> = {};
    if (jobTitle.trim()) titlesMap["t0"] = { name: jobTitle.trim(), kind: "title" };
    if (role.trim()) titlesMap["t1"] = { name: role.trim(), kind: "role" };

    const orgUnits = department.trim() ? [{ name: department.trim() }] : undefined;

    const addressesMap: Record<string, ContactCard["addresses"] extends Record<string, infer V> ? V : never> = {};
    addresses.filter(a => a.street.trim() || a.locality.trim() || a.country.trim()).forEach((a, i) => {
      const obj: Record<string, unknown> = {};
      if (a.street.trim()) obj.street = a.street.trim();
      if (a.locality.trim()) obj.locality = a.locality.trim();
      if (a.region.trim()) obj.region = a.region.trim();
      if (a.postcode.trim()) obj.postcode = a.postcode.trim();
      if (a.country.trim()) obj.country = a.country.trim();
      if (a.context) obj.contexts = { [a.context]: true };
      // @ts-expect-error - dynamic build
      addressesMap[`a${i}`] = obj;
    });

    const onlineServicesMap: Record<string, ContactOnlineService> = {};
    onlineServices.filter(s => s.uri.trim()).forEach((s, i) => {
      const obj: ContactOnlineService = { uri: s.uri.trim() };
      if (s.service.trim()) obj.service = s.service.trim();
      if (s.label.trim()) obj.label = s.label.trim();
      onlineServicesMap[`os${i}`] = obj;
    });

    const anniversariesMap: Record<string, ContactAnniversary> = {};
    anniversaries.filter(a => a.date.trim()).forEach((a, i) => {
      anniversariesMap[`an${i}`] = { date: a.date.trim(), kind: a.kind };
    });

    const personalInfoMap: Record<string, ContactPersonalInfo> = {};
    personalInfoEntries.filter(p => p.value.trim()).forEach((p, i) => {
      const obj: ContactPersonalInfo = { value: p.value.trim(), kind: p.kind };
      if (p.level) obj.level = p.level as "high" | "medium" | "low";
      personalInfoMap[`pi${i}`] = obj;
    });

    const keywordsMap: Record<string, boolean> = {};
    if (keywordsStr.trim()) {
      keywordsStr.split(",").map(k => k.trim()).filter(Boolean).forEach(k => {
        keywordsMap[k] = true;
      });
    }

    const data: Partial<ContactCard> = {
      name: { components: nameComponents, isOrdered: true },
      nicknames: nickname.trim() ? { n0: { name: nickname.trim() } } : undefined,
      emails: Object.keys(emailsMap).length > 0 ? emailsMap : undefined,
      phones: Object.keys(phonesMap).length > 0 ? phonesMap : undefined,
      titles: Object.keys(titlesMap).length > 0 ? titlesMap : undefined,
      organizations: organization.trim()
        ? { o0: { name: organization.trim(), units: orgUnits } }
        : undefined,
      addresses: Object.keys(addressesMap).length > 0 ? addressesMap : undefined,
      onlineServices: Object.keys(onlineServicesMap).length > 0 ? onlineServicesMap : undefined,
      anniversaries: Object.keys(anniversariesMap).length > 0 ? anniversariesMap : undefined,
      personalInfo: Object.keys(personalInfoMap).length > 0 ? personalInfoMap : undefined,
      keywords: Object.keys(keywordsMap).length > 0 ? keywordsMap : undefined,
      notes: note.trim()
        ? { n0: { note: note.trim() } }
        : undefined,
      speakToAs: (genderSex.trim() || genderIdentity.trim())
        ? {
            grammaticalGender: genderSex.trim() || undefined,
            pronouns: genderIdentity.trim() ? { p0: { pronouns: genderIdentity.trim() } } : undefined,
          }
        : undefined,
      calendarUri: calendarUri.trim() || undefined,
      schedulingUri: schedulingUri.trim() || undefined,
      freeBusyUri: freeBusyUri.trim() || undefined,
    };

    setIsSaving(true);
    try {
      await onSave(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("save_failed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <h2 className="text-lg font-semibold">
          {isEditing ? t("edit_title") : t("create_title")}
        </h2>
        <button type="button" onClick={onCancel} className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4">
          {error && (
            <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 px-3 py-2 rounded-lg border border-red-200 dark:border-red-900 mb-4">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

          {/* Name & Identity — full width */}
          <div className="md:col-span-2 xl:col-span-3">
          <FormSection icon={User} title={t("section_identity")} category="contact">
            <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("prefix")}</label>
                <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder={t("prefix_placeholder")} className="w-20" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("given_name")} <span className="text-red-500">*</span>
                </label>
                <Input value={givenName} onChange={(e) => setGivenName(e.target.value)} placeholder={t("given_name")} autoFocus />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  {t("surname")} <span className="text-red-500">*</span>
                </label>
                <Input value={surname} onChange={(e) => setSurname(e.target.value)} placeholder={t("surname")} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("suffix")}</label>
                <Input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder={t("suffix_placeholder")} className="w-20" />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("middle_name")}</label>
                <Input value={additionalName} onChange={(e) => setAdditionalName(e.target.value)} placeholder={t("middle_name")} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("nickname")}</label>
                <Input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder={t("nickname_placeholder")} />
              </div>
            </div>
          </FormSection>
          </div>

          {/* Email */}
          <FormSection icon={Mail} title={t("email")} collapsible defaultOpen category="contact">
            <div className="space-y-2">
              {emails.map((entry, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <Input
                      type="email"
                      inputMode="email"
                      value={entry.address}
                      onChange={(e) => {
                        const next = [...emails];
                        next[i] = { ...next[i], address: e.target.value };
                        setEmails(next);
                        if (emailErrors[i]) {
                          setEmailErrors(prev => { const n = { ...prev }; delete n[i]; return n; });
                        }
                      }}
                      onBlur={() => handleEmailBlur(i, entry.address)}
                      placeholder={t("email_placeholder")}
                      className={cn("flex-1", emailErrors[i] && "border-red-500 focus:ring-red-500")}
                    />
                    <Select
                      value={entry.context}
                      onChange={(e) => {
                        const next = [...emails];
                        next[i] = { ...next[i], context: e.target.value as EmailEntry["context"] };
                        setEmails(next);
                      }}
                    >
                      <option value="">—</option>
                      <option value="work">{t("context_work")}</option>
                      <option value="private">{t("context_private")}</option>
                    </Select>
                    {emails.length > 1 && (
                      <Button type="button" variant="ghost" size="icon" onClick={() => setEmails(emails.filter((_, j) => j !== i))} className="h-8 w-8 shrink-0">
                        <X className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                  {emailErrors[i] && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-1 ml-1">{emailErrors[i]}</p>
                  )}
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setEmails([...emails, { address: "", context: "" }])} className="text-xs">
                <Plus className="w-3 h-3 mr-1" />
                {t("add_email")}
              </Button>
            </div>
          </FormSection>

          {/* Phone */}
          <FormSection icon={Phone} title={t("phone")} collapsible defaultOpen category="contact">
            <div className="space-y-2">
              {phones.map((entry, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    type="tel"
                    inputMode="tel"
                    value={entry.number}
                    onChange={(e) => {
                      const next = [...phones];
                      next[i] = { ...next[i], number: e.target.value };
                      setPhones(next);
                    }}
                    placeholder={t("phone_placeholder")}
                    className="flex-1"
                  />
                  <Select
                    value={entry.feature}
                    onChange={(e) => {
                      const next = [...phones];
                      next[i] = { ...next[i], feature: e.target.value as PhoneEntry["feature"] };
                      setPhones(next);
                    }}
                    className="w-[5.5rem]"
                  >
                    <option value="">{t("phone_type")}</option>
                    <option value="voice">{t("phone_voice")}</option>
                    <option value="cell">{t("phone_cell")}</option>
                    <option value="fax">{t("phone_fax")}</option>
                    <option value="pager">{t("phone_pager")}</option>
                    <option value="video">{t("phone_video")}</option>
                    <option value="text">{t("phone_text")}</option>
                  </Select>
                  <Select
                    value={entry.context}
                    onChange={(e) => {
                      const next = [...phones];
                      next[i] = { ...next[i], context: e.target.value as PhoneEntry["context"] };
                      setPhones(next);
                    }}
                  >
                    <option value="">—</option>
                    <option value="work">{t("context_work")}</option>
                    <option value="private">{t("context_private")}</option>
                  </Select>
                  <Button type="button" variant="ghost" size="icon" onClick={() => setPhones(phones.filter((_, j) => j !== i))} className="h-8 w-8 shrink-0">
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setPhones([...phones, { number: "", context: "", feature: "" }])} className="text-xs">
                <Plus className="w-3 h-3 mr-1" />
                {t("add_phone")}
              </Button>
            </div>
          </FormSection>

          {/* Work & Organization */}
          <FormSection icon={Building} title={t("section_work")} collapsible defaultOpen category="work">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("organization")}</label>
                <Input value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder={t("organization_placeholder")} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("department")}</label>
                <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder={t("department_placeholder")} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("job_title")}</label>
                <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder={t("job_title_placeholder")} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("role")}</label>
                <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t("role_placeholder")} />
              </div>
            </div>
          </FormSection>

          {/* Addresses — full width */}
          <div className="md:col-span-2 xl:col-span-3">
          <FormSection icon={MapPin} title={t("addresses")} collapsible defaultOpen category="location">
            <div className="space-y-3">
              {addresses.map((addr, i) => (
                <div key={i} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2 relative">
                  <Button type="button" variant="ghost" size="icon" onClick={() => setAddresses(addresses.filter((_, j) => j !== i))} className="h-6 w-6 absolute top-2 right-2">
                    <X className="w-3 h-3" />
                  </Button>
                  <Input value={addr.street} onChange={(e) => { const n = [...addresses]; n[i] = { ...n[i], street: e.target.value }; setAddresses(n); }} placeholder={t("street")} />
                  <div className="grid grid-cols-2 gap-2">
                    <Input value={addr.locality} onChange={(e) => { const n = [...addresses]; n[i] = { ...n[i], locality: e.target.value }; setAddresses(n); }} placeholder={t("city")} />
                    <Input value={addr.region} onChange={(e) => { const n = [...addresses]; n[i] = { ...n[i], region: e.target.value }; setAddresses(n); }} placeholder={t("region")} />
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <Input value={addr.postcode} onChange={(e) => { const n = [...addresses]; n[i] = { ...n[i], postcode: e.target.value }; setAddresses(n); }} placeholder={t("postcode")} />
                    <Input value={addr.country} onChange={(e) => { const n = [...addresses]; n[i] = { ...n[i], country: e.target.value }; setAddresses(n); }} placeholder={t("country")} />
                    <Select
                      value={addr.context}
                      onChange={(e) => { const n = [...addresses]; n[i] = { ...n[i], context: e.target.value as AddressEntry["context"] }; setAddresses(n); }}
                    >
                      <option value="">—</option>
                      <option value="work">{t("context_work")}</option>
                      <option value="private">{t("context_private")}</option>
                    </Select>
                  </div>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setAddresses([...addresses, { street: "", locality: "", region: "", postcode: "", country: "", context: "" }])} className="text-xs">
                <Plus className="w-3 h-3 mr-1" />
                {t("add_address")}
              </Button>
            </div>
          </FormSection>
          </div>

          {/* Online Services */}
          <FormSection icon={Globe} title={t("online_services")} collapsible defaultOpen category="digital">
            <div className="space-y-2">
              {onlineServices.map((svc, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={svc.uri}
                    onChange={(e) => { const n = [...onlineServices]; n[i] = { ...n[i], uri: e.target.value }; setOnlineServices(n); }}
                    placeholder={t("url_placeholder")}
                    className="flex-1"
                  />
                  <Input
                    value={svc.service}
                    onChange={(e) => { const n = [...onlineServices]; n[i] = { ...n[i], service: e.target.value }; setOnlineServices(n); }}
                    placeholder={t("service_placeholder")}
                    className="w-24"
                  />
                  <Button type="button" variant="ghost" size="icon" onClick={() => setOnlineServices(onlineServices.filter((_, j) => j !== i))} className="h-8 w-8 shrink-0">
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setOnlineServices([...onlineServices, { uri: "", service: "", label: "" }])} className="text-xs">
                <Plus className="w-3 h-3 mr-1" />
                {t("add_online_service")}
              </Button>
            </div>
          </FormSection>

          {/* Anniversaries */}
          <FormSection icon={Cake} title={t("anniversaries")} collapsible defaultOpen category="personal">
            <div className="space-y-2">
              {anniversaries.map((ann, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={ann.date}
                    onChange={(e) => { const n = [...anniversaries]; n[i] = { ...n[i], date: e.target.value }; setAnniversaries(n); }}
                    className="flex-1"
                  />
                  <Select
                    value={ann.kind}
                    onChange={(e) => { const n = [...anniversaries]; n[i] = { ...n[i], kind: e.target.value as AnniversaryEntry["kind"] }; setAnniversaries(n); }}
                  >
                    <option value="birth">{t("anniversary_birth")}</option>
                    <option value="wedding">{t("anniversary_wedding")}</option>
                    <option value="death">{t("anniversary_death")}</option>
                    <option value="other">{t("anniversary_other")}</option>
                  </Select>
                  <Button type="button" variant="ghost" size="icon" onClick={() => setAnniversaries(anniversaries.filter((_, j) => j !== i))} className="h-8 w-8 shrink-0">
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setAnniversaries([...anniversaries, { date: "", kind: "birth" }])} className="text-xs">
                <Plus className="w-3 h-3 mr-1" />
                {t("add_anniversary")}
              </Button>
            </div>
          </FormSection>

          {/* Personal Info */}
          <FormSection icon={Heart} title={t("personal_info")} collapsible defaultOpen category="personal">
            <div className="space-y-2">
              {personalInfoEntries.map((pi, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={pi.value}
                    onChange={(e) => { const n = [...personalInfoEntries]; n[i] = { ...n[i], value: e.target.value }; setPersonalInfoEntries(n); }}
                    placeholder={t("personal_info_placeholder")}
                    className="flex-1"
                  />
                  <Select
                    value={pi.kind}
                    onChange={(e) => { const n = [...personalInfoEntries]; n[i] = { ...n[i], kind: e.target.value as PersonalInfoEntry["kind"] }; setPersonalInfoEntries(n); }}
                  >
                    <option value="expertise">{t("personal_expertise")}</option>
                    <option value="hobby">{t("personal_hobby")}</option>
                    <option value="interest">{t("personal_interest")}</option>
                    <option value="other">{t("personal_other")}</option>
                  </Select>
                  <Select
                    value={pi.level}
                    onChange={(e) => { const n = [...personalInfoEntries]; n[i] = { ...n[i], level: e.target.value as PersonalInfoEntry["level"] }; setPersonalInfoEntries(n); }}
                  >
                    <option value="">{t("level")}</option>
                    <option value="high">{t("level_high")}</option>
                    <option value="medium">{t("level_medium")}</option>
                    <option value="low">{t("level_low")}</option>
                  </Select>
                  <Button type="button" variant="ghost" size="icon" onClick={() => setPersonalInfoEntries(personalInfoEntries.filter((_, j) => j !== i))} className="h-8 w-8 shrink-0">
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setPersonalInfoEntries([...personalInfoEntries, { value: "", kind: "hobby", level: "" }])} className="text-xs">
                <Plus className="w-3 h-3 mr-1" />
                {t("add_personal_info")}
              </Button>
            </div>
          </FormSection>

          {/* Categories */}
          <FormSection icon={Tag} title={t("categories")} collapsible defaultOpen category="digital">
            <div>
              <Input
                value={keywordsStr}
                onChange={(e) => setKeywordsStr(e.target.value)}
                placeholder={t("categories_placeholder")}
              />
              <p className="text-xs text-muted-foreground mt-1.5">{t("categories_hint")}</p>
            </div>
          </FormSection>

          {/* Gender */}
          <FormSection icon={UserCircle} title={t("gender")} collapsible defaultOpen category="personal">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("gender_sex")}</label>
                <Select value={genderSex} onChange={(e) => setGenderSex(e.target.value)} className="w-full">
                  <option value="">—</option>
                  <option value="masculine">{t("gender_male")}</option>
                  <option value="feminine">{t("gender_female")}</option>
                  <option value="other">{t("gender_other")}</option>
                  <option value="none">{t("gender_none")}</option>
                  <option value="unknown">{t("gender_unknown")}</option>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("gender_identity")}</label>
                <Input value={genderIdentity} onChange={(e) => setGenderIdentity(e.target.value)} placeholder={t("gender_identity_placeholder")} />
              </div>
            </div>
          </FormSection>

          {/* Calendar */}
          <FormSection icon={Calendar} title={t("calendar")} collapsible defaultOpen category="calendar">
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("calendar_uri")}</label>
                <Input value={calendarUri} onChange={(e) => setCalendarUri(e.target.value)} placeholder="https://..." />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("scheduling_uri")}</label>
                <Input value={schedulingUri} onChange={(e) => setSchedulingUri(e.target.value)} placeholder="https://..." />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("freebusy_uri")}</label>
                <Input value={freeBusyUri} onChange={(e) => setFreeBusyUri(e.target.value)} placeholder="https://..." />
              </div>
            </div>
          </FormSection>

          {/* Notes — full width */}
          <div className="md:col-span-2 xl:col-span-3">
          <FormSection icon={StickyNote} title={t("note")} collapsible defaultOpen category="notes">
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("note_placeholder")}
              className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-y outline-none focus:ring-2 focus:ring-ring"
            />
          </FormSection>
          </div>

          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border flex-shrink-0">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={isSaving}>
          {isSaving ? (isEditing ? t("updating") : t("creating")) : t("save")}
        </Button>
      </div>
    </form>
  );
}
