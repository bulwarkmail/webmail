"use client";

import { useState, useMemo, useCallback, useRef, useEffect, useId } from "react";
import { useCloseBesideControls } from "@/hooks/use-close-beside-controls";
import { useLocale, useTranslations } from "next-intl";
import { X, Plus, ChevronDown, ChevronRight, User, Building, MapPin, Globe, Cake, Heart, Tag, StickyNote, Mail, Phone, Calendar, UserCircle, Book, Camera, Trash2, MoreHorizontal } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { findContactPhotoEntry, getContactPhotoRef, type ContactPhotoRef } from "@/stores/contact-store";
import type { ContactSaveOptions } from "@/lib/contact-media";
import { cn } from "@/lib/utils";
import { addressStyle, addressToParts, countryCodeFromName, partsToComponents, type AddressStyle } from "@/lib/address-format";
import { useBottomControls } from "@/hooks/use-bottom-controls";
import type { ContactCard, ContactOnlineService, ContactAnniversary, ContactPersonalInfo, AddressBook, AnniversaryDate, PartialDate, ContactAddress, ContactMedia } from "@/lib/jmap/types";

// Each row of a list field keeps the `key` of the card's entry it was read
// from, so Save can send an entry the user didn't touch back unchanged.
interface EmailEntry {
  key?: string;
  address: string;
  context: "work" | "private" | "";
}

interface PhoneEntry {
  key?: string;
  number: string;
  context: "work" | "private" | "";
  feature: "voice" | "mobile" | "fax" | "pager" | "video" | "text" | "";
}

interface OnlineServiceEntry {
  key?: string;
  uri: string;
  service: string;
  label: string;
}

interface AnniversaryEntry {
  key?: string;
  date: string;
  kind: "birth" | "death" | "wedding" | "other";
}

interface PersonalInfoEntry {
  key?: string;
  value: string;
  kind: "expertise" | "hobby" | "interest" | "other";
  level: "high" | "medium" | "low" | "";
}

interface AddressEntry {
  key?: string;
  street: string;
  locality: string;
  region: string;
  postcode: string;
  country: string;
  context: "work" | "private" | "";
}

interface ContactFormProps {
  contact?: ContactCard | null;
  addressBooks?: AddressBook[];
  allKeywords?: string[];
  defaultAddressBookId?: string;
  /** Prefills the create form (ignored when `contact` is set). */
  prefill?: { email?: string; name?: string };
  /** `options.photoKey` names the `media` entry holding a newly picked photo. */
  onSave: (data: Partial<ContactCard>, options?: ContactSaveOptions) => Promise<void>;
  onCancel: () => void;
  /**
   * Reads the card as the server has it now, or null when it can't. When the
   * photo changed, `media` is rebuilt on it instead of on `contact`, which
   * may be older.
   */
  loadCurrentMedia?: () => Promise<Pick<ContactCard, "media"> | null>;
  /** Reports whether the form holds changes not yet saved. */
  onDirtyChange?: (dirty: boolean) => void;
}

/** What the user did to the photo: nothing, picked a new one (a data: URI), or removed it. */
type PhotoEdit =
  | { kind: "unchanged" }
  | { kind: "new"; uri: string; mediaType: string }
  | { kind: "removed" };

/** A `media` key for a new photo that no other entry uses. */
function freeMediaKey(media: Record<string, ContactMedia>): string {
  let key = "photo";
  for (let n = 1; key in media; n++) key = `photo${n}`;
  return key;
}

/**
 * The `media` map to send for a photo edit, built on `base`: the card's media
 * as the server has it now when it could be read, else the form's copy
 * (`known`). `shownKey` is the photo the form showed.
 *
 * - A new photo takes the shown one's key and place, with its `pref`,
 *   `label` and `contexts`, so on a card with several photos it is still the
 *   one shown (the lowest pref wins).
 * - Removing the photo removes every photo the form's copy had, not only the
 *   shown one: the next would otherwise take its place after the save, while
 *   the form showed none. Logos and sounds stay; so do photos added
 *   elsewhere since.
 */
function mediaForPhotoEdit(
  base: Record<string, ContactMedia>,
  known: Record<string, ContactMedia>,
  shownKey: string | undefined,
  edit: Exclude<PhotoEdit, { kind: "unchanged" }>,
): { media: Record<string, ContactMedia> | null; photoKey?: string } {
  if (edit.kind === "removed") {
    const others = Object.fromEntries(Object.entries(base).filter(
      ([key, entry]) => !(entry?.kind === "photo" && known[key]?.kind === "photo"),
    ));
    return { media: Object.keys(others).length > 0 ? others : null };
  }
  const shown = shownKey ? (base[shownKey]?.kind === "photo" ? base[shownKey] : known[shownKey]) : undefined;
  const photoKey = shownKey && (!base[shownKey] || base[shownKey]?.kind === "photo") ? shownKey : freeMediaKey(base);
  const photo: ContactMedia = {
    kind: "photo",
    uri: edit.uri,
    mediaType: edit.mediaType,
    ...(shown?.pref !== undefined ? { pref: shown.pref } : {}),
    ...(shown?.label !== undefined ? { label: shown.label } : {}),
    ...(shown?.contexts !== undefined ? { contexts: shown.contexts } : {}),
  };
  const media: Record<string, ContactMedia> = {};
  for (const [key, entry] of Object.entries(base)) media[key] = key === photoKey ? photo : entry;
  media[photoKey] = photo;
  return { media, photoKey };
}

/**
 * The map to save for a list field (emails, phones, addresses...). A row the
 * user didn't touch goes back exactly as the card had it, under its key. An
 * edited row is built on the card's entry (`previous`), so properties the
 * form doesn't show stay; a new row gets a key no other entry uses.
 */
function entriesToSave<E extends { key?: string }, V>(
  rows: E[],
  initialRows: E[],
  original: Record<string, V> | undefined,
  prefix: string,
  build: (row: E, previous: V | undefined, before: E | undefined) => V,
): Record<string, V> {
  const out: Record<string, V> = {};
  const taken = new Set(rows.map(r => r.key).filter((k): k is string => !!k && !!original?.[k]));
  let n = 0;
  const freshKey = () => {
    let key = `${prefix}${n++}`;
    while (taken.has(key)) key = `${prefix}${n++}`;
    taken.add(key);
    return key;
  };
  for (const row of rows) {
    const previous = row.key ? original?.[row.key] : undefined;
    const before = previous !== undefined ? initialRows.find(r => r.key === row.key) : undefined;
    if (previous !== undefined && before && JSON.stringify(before) === JSON.stringify(row)) {
      out[row.key!] = previous;
    } else {
      out[previous !== undefined ? row.key! : freshKey()] = build(row, previous, before);
    }
  }
  return out;
}

/** A row the card had and the user left as it was. */
function isUntouchedRow<E extends { key?: string }>(row: E, initialRows: E[], original: Record<string, unknown> | undefined): boolean {
  if (!row.key || original?.[row.key] === undefined) return false;
  const before = initialRows.find(r => r.key === row.key);
  return !!before && JSON.stringify(before) === JSON.stringify(row);
}

/** `contexts` for a row: the card's own when the select wasn't changed. */
function contextsToSave(context: string, previous: Record<string, boolean> | undefined, before: { context: string } | undefined): Record<string, boolean> | undefined {
  if (before && before.context === context) return previous;
  return context ? { [context]: true } : undefined;
}

/** A card's first entry of a map with one field changed, the others kept; undefined when none is left. */
function firstEntryToSave<V extends object>(original: Record<string, V> | undefined, fallbackKey: string, value: V | null): Record<string, V> | undefined {
  const entries = Object.entries(original ?? {});
  const [firstKey, first] = entries[0] ?? [fallbackKey, undefined];
  const rest = entries.slice(1);
  const out: Record<string, V> = {};
  if (value) out[firstKey] = { ...(first ?? {}), ...value } as V;
  for (const [k, v] of rest) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Drops keys whose value is undefined, so a built entry has no empty properties. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function FormSection({ icon: Icon, title, children, collapsible, defaultOpen = true }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="py-5">
      <button
        type="button"
        className={cn(
          "flex items-center gap-2 w-full text-start",
          collapsible ? "cursor-pointer" : "cursor-default"
        )}
        onClick={() => collapsible && setOpen(!open)}
        tabIndex={collapsible ? 0 : -1}
      >
        <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
        <h3 className="flex-1 text-xs font-semibold text-muted-foreground">{title}</h3>
        {collapsible && (
          open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>
      {(open || !collapsible) && (
        <div className="space-y-3 mt-3">
          {children}
        </div>
      )}
    </section>
  );
}

const MAX_PHOTO_DIM = 512;
const PHOTO_QUALITY = 0.85;

async function processImageFile(file: File): Promise<{ uri: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(1, MAX_PHOTO_DIM / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * ratio));
        const h = Math.max(1, Math.round(img.height * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas-unsupported"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        const uri = canvas.toDataURL("image/jpeg", PHOTO_QUALITY);
        resolve({ uri, mediaType: "image/jpeg" });
      };
      img.onerror = () => reject(new Error("invalid-image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });
}

function Select({ value, onChange, children, className, id, "aria-label": ariaLabel }: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
  className?: string;
  id?: string;
  "aria-label"?: string;
}) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      value={value}
      onChange={onChange}
      className={cn(
        "text-sm bg-transparent border border-input rounded-md px-2.5 py-2 text-foreground",
        "focus:outline-hidden",
        "hover:border-muted-foreground/50 transition-colors",
        className
      )}
    >
      {children}
    </select>
  );
}

export function ContactForm({ contact, addressBooks, allKeywords, defaultAddressBookId, prefill, onSave, onCancel, loadCurrentMedia, onDirtyChange }: ContactFormProps) {
  const t = useTranslations("contacts.form");
  const tx = useTranslations("ux_pim_contact");
  const locale = useLocale();
  const isEditing = !!contact;
  // The header's close goes to its start when the window's own close is at its end.
  const [header, setHeader] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(header);
  // Ids that tie each visible label to its field.
  const fieldIdBase = useId();
  const fieldId = (key: string) => `${fieldIdBase}-${key}`;

  // Split a free-form display name into given/surname for prefill.
  const prefillGivenName = (() => {
    if (contact || !prefill?.name) return "";
    const parts = prefill.name.trim().split(/\s+/);
    return parts[0] || "";
  })();
  const prefillSurname = (() => {
    if (contact || !prefill?.name) return "";
    const parts = prefill.name.trim().split(/\s+/);
    return parts.slice(1).join(" ");
  })();

  // Accept JSContact-standard kinds (RFC 9553) and legacy vCard-style aliases.
  const findComponent = (...kinds: string[]) =>
    contact?.name?.components?.find(c => kinds.includes(c.kind))?.value || "";

  // Convert RFC 9553 AnniversaryDate to ISO date string for HTML date input
  function anniversaryDateToString(date: AnniversaryDate): string {
    if (typeof date === 'string') return date;
    if (date && typeof date === 'object') {
      if ('@type' in date && date['@type'] === 'Timestamp' && 'utc' in date) {
        return (date as { utc: string }).utc.split('T')[0];
      }
      const pd = date as PartialDate;
      if (pd.year && pd.month && pd.day) {
        return `${String(pd.year).padStart(4, '0')}-${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
      }
      if (pd.month && pd.day) {
        return `--${String(pd.month).padStart(2, '0')}-${String(pd.day).padStart(2, '0')}`;
      }
      if (pd.year && pd.month) {
        return `${String(pd.year).padStart(4, '0')}-${String(pd.month).padStart(2, '0')}`;
      }
      if (pd.year) return String(pd.year);
    }
    return String(date);
  }

  // Convert ISO date string back to RFC 9553 PartialDate for the server
  function stringToPartialDate(str: string): PartialDate {
    if (str.startsWith('--')) {
      const parts = str.substring(2).split('-');
      const pd: PartialDate = { month: parseInt(parts[0], 10) };
      if (parts[1]) pd.day = parseInt(parts[1], 10);
      return pd;
    }
    const parts = str.split('-');
    const pd: PartialDate = {};
    if (parts[0]) pd.year = parseInt(parts[0], 10);
    if (parts[1]) pd.month = parseInt(parts[1], 10);
    if (parts[2]) pd.day = parseInt(parts[2], 10);
    return pd;
  }

  // The form's fields for an address: street name and house number in one
  // field, in the order of the address's country ("Hauptstraße 1").
  function addressToFlat(key: string, a: ContactAddress): AddressEntry {
    return {
      key,
      ...addressToParts(a, locale),
      context: a.contexts?.work ? 'work' : a.contexts?.private ? 'private' : '',
    };
  }

  const [prefix, setPrefix] = useState(findComponent("title", "prefix"));
  const [givenName, setGivenName] = useState(findComponent("given") || prefillGivenName);
  const [additionalName, setAdditionalName] = useState(findComponent("given2", "additional", "middle"));
  const [surname, setSurname] = useState(findComponent("surname") || prefillSurname);
  const [suffix, setSuffix] = useState(findComponent("generation", "suffix"));

  const [nickname, setNickname] = useState(
    contact?.nicknames ? Object.values(contact.nicknames)[0]?.name || "" : ""
  );

  const [emails, setEmails] = useState<EmailEntry[]>(() => {
    if (contact?.emails) {
      return Object.entries(contact.emails).map(([key, e]) => ({
        key,
        address: e.address,
        context: e.contexts?.work ? "work" : e.contexts?.private ? "private" : "",
      }));
    }
    return [{ address: prefill?.email || "", context: "" }];
  });

  const [phones, setPhones] = useState<PhoneEntry[]>(() => {
    if (contact?.phones) {
      return Object.entries(contact.phones).map(([key, p]) => ({
        key,
        number: p.number,
        context: p.contexts?.work ? "work" : p.contexts?.private ? "private" : "",
        // RFC 9553 calls it "mobile"; cards saved by older versions of this form say "cell".
        feature: p.features?.mobile || p.features?.cell ? "mobile" : p.features?.fax ? "fax" : p.features?.pager ? "pager" : p.features?.video ? "video" : p.features?.text ? "text" : p.features?.voice ? "voice" : "",
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

  // A card may describe an organization instead of a person (RFC 9553 kind "org").
  // Older cards predate the explicit kind, so fall back to "has an org name but no
  // personal name".
  const [isOrg, setIsOrg] = useState(() => {
    if (!contact) return false;
    if (contact.kind) return contact.kind === "org";
    const hasPersonName = !!(findComponent("given") || findComponent("surname"));
    return !hasPersonName && !!Object.values(contact.organizations || {})[0]?.name;
  });

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
      return Object.entries(contact.addresses).map(([key, a]) => addressToFlat(key, a));
    }
    return [];
  });

  const [onlineServices, setOnlineServices] = useState<OnlineServiceEntry[]>(() => {
    if (contact?.onlineServices) {
      return Object.entries(contact.onlineServices).map(([key, s]) => ({
        key,
        uri: s.uri,
        service: s.service || "",
        label: s.label || "",
      }));
    }
    return [];
  });

  const [anniversaries, setAnniversaries] = useState<AnniversaryEntry[]>(() => {
    if (contact?.anniversaries) {
      return Object.entries(contact.anniversaries).map(([key, a]) => ({
        key,
        date: anniversaryDateToString(a.date),
        kind: a.kind,
      }));
    }
    return [];
  });

  const [personalInfoEntries, setPersonalInfoEntries] = useState<PersonalInfoEntry[]>(() => {
    if (contact?.personalInfo) {
      return Object.entries(contact.personalInfo).map(([key, p]) => ({
        key,
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
  // Text typed in the Categories field but not added with Enter yet: Save
  // adds it, so it isn't lost.
  const [categoryDraft, setCategoryDraft] = useState("");

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

  // Address book selection
  const currentBookId = useMemo(() => {
    if (contact?.addressBookIds) {
      const ids = Object.keys(contact.addressBookIds).filter(k => contact.addressBookIds[k]);
      if (ids.length > 0) {
        // addressBookIds are already namespaced for shared contacts (e.g. "accountId:bookId")
        // so we can use them directly to match addressBook entries
        return ids[0];
      }
    }
    if (defaultAddressBookId && addressBooks?.some(b => b.id === defaultAddressBookId)) {
      return defaultAddressBookId;
    }
    // New contacts land in the account's default book unless told otherwise -
    // preselect it so the form shows where the contact will actually go.
    if (!contact) {
      const ownDefault = addressBooks?.find(b => b.isDefault && !b.isShared);
      if (ownDefault) return ownDefault.id;
    }
    return "";
  }, [contact, defaultAddressBookId, addressBooks]);
  const [selectedBookId, setSelectedBookId] = useState(currentBookId);

  // The stored photo may be a data: URI (Stalwart 0.16) or a blob (1.0); the
  // form only ever writes the photo the user picks, never the one it shows.
  const initialPhotoKey = useMemo(() => (contact ? findContactPhotoEntry(contact)?.[0] : undefined), [contact]);
  const [photoEdit, setPhotoEdit] = useState<PhotoEdit>({ kind: "unchanged" });
  const previewPhoto: ContactPhotoRef | null =
    photoEdit.kind === "new" ? { uri: photoEdit.uri }
      : photoEdit.kind === "unchanged" && contact ? getContactPhotoRef(contact) ?? null
        : null;
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailErrors, setEmailErrors] = useState<Record<number, string>>({});

  // Everything the user can edit, to tell whether anything changed since the
  // form opened (R5: leaving asks first).
  const fields = JSON.stringify([
    prefix, givenName, additionalName, surname, suffix, nickname, emails, phones, organization,
    department, isOrg, jobTitle, role, addresses, onlineServices, anniversaries, personalInfoEntries,
    keywordsStr, categoryDraft, note, genderSex, genderIdentity, calendarUri, schedulingUri, freeBusyUri, selectedBookId,
  ]);
  const [initialFields] = useState(fields);

  // What each card property is built from. Saving an existing card sends only
  // the properties whose fields changed, so the rest stay exactly as stored,
  // structured address parts included (#pim-4).
  const personNamed = !!(givenName.trim() || surname.trim());
  const propertyFields: Record<string, unknown> = {
    name: [prefix, givenName, additionalName, surname, suffix, isOrg, isOrg || !personNamed ? organization : ""],
    nicknames: nickname,
    emails,
    phones,
    titles: [jobTitle, role],
    organizations: [organization, department],
    addresses,
    onlineServices,
    anniversaries,
    personalInfo: personalInfoEntries,
    keywords: [keywordsStr, categoryDraft],
    notes: note,
    speakToAs: [genderSex, genderIdentity],
    calendarUri: [calendarUri, freeBusyUri],
    freeBusyUri: [calendarUri, freeBusyUri],
    schedulingUri,
    addressBookIds: selectedBookId,
  };
  const [initialPropertyFields] = useState(() => JSON.stringify(propertyFields));
  const [initialRows] = useState(() => ({ emails, phones, addresses, onlineServices, anniversaries, personalInfoEntries, department }));
  const dirty = fields !== initialFields || photoEdit.kind !== "unchanged";
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const footerRef = useBottomControls();
  const [hasMoreFields] = useState(() => onlineServices.length > 0 || personalInfoEntries.length > 0
    || !!(genderSex || genderIdentity) || !!(calendarUri || schedulingUri || freeBusyUri));

  const handlePhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setPhotoError(t("photo_invalid"));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setPhotoError(t("photo_too_large"));
      return;
    }
    setPhotoError(null);
    setPhotoUploading(true);
    try {
      const { uri, mediaType } = await processImageFile(file);
      setPhotoEdit({ kind: "new", uri, mediaType });
    } catch {
      setPhotoError(t("photo_invalid"));
    } finally {
      setPhotoUploading(false);
    }
  };

  const handlePhotoRemove = () => {
    setPhotoEdit({ kind: "removed" });
    setPhotoError(null);
  };

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

    // An organization name identifies the card just as well as a personal name.
    const orgName = organization.trim();
    const hasPersonName = !!(givenName.trim() || surname.trim());
    if (isOrg ? !orgName : (!hasPersonName && !orgName)) {
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

    type Email = NonNullable<ContactCard["emails"]>[string];
    type PhoneValue = NonNullable<ContactCard["phones"]>[string];
    const emailsMap = entriesToSave<EmailEntry, Email>(validEmails, initialRows.emails, contact?.emails, "e", (row, previous, before) => compact({
      ...previous,
      address: row.address.trim(),
      contexts: contextsToSave(row.context, previous?.contexts, before),
    }));

    const validPhones = phones.filter(p => p.number.trim());
    const phonesMap = entriesToSave<PhoneEntry, PhoneValue>(validPhones, initialRows.phones, contact?.phones, "p", (row, previous, before) => compact({
      ...previous,
      number: row.number.trim(),
      contexts: contextsToSave(row.context, previous?.contexts, before),
      features: before && before.feature === row.feature ? previous?.features : row.feature ? { [row.feature]: true } : undefined,
    }));

    // Emit JSContact-standard kinds (RFC 9553) so the JMAP server stores them losslessly.
    const nameComponents = [];
    if (!isOrg) {
      if (prefix.trim()) nameComponents.push({ kind: "title" as const, value: prefix.trim() });
      if (givenName.trim()) nameComponents.push({ kind: "given" as const, value: givenName.trim() });
      if (additionalName.trim()) nameComponents.push({ kind: "given2" as const, value: additionalName.trim() });
      if (surname.trim()) nameComponents.push({ kind: "surname" as const, value: surname.trim() });
      if (suffix.trim()) nameComponents.push({ kind: "generation" as const, value: suffix.trim() });
    }

    // Always set `name.full` (RFC 9553): the vCard FN property is derived from it,
    // and FN is mandatory (RFC 6350 §6.2.1) — strict CardDAV clients like Apple
    // Contacts silently drop cards without it (#430).
    const fullName = [prefix, givenName, additionalName, surname, suffix]
      .map(s => s.trim())
      .filter(Boolean)
      .join(" ");

    // Without personal name components, carry the organization name in `name.full`
    // so servers and other clients have something to display.
    const nameValue: ContactCard["name"] = nameComponents.length > 0
      ? { components: nameComponents, isOrdered: true, full: fullName || undefined }
      : { full: orgName };

    const titlesMap: Record<string, { name: string; kind?: "title" | "role" }> = {};
    if (jobTitle.trim()) titlesMap["t0"] = { name: jobTitle.trim(), kind: "title" };
    if (role.trim()) titlesMap["t1"] = { name: role.trim(), kind: "role" };

    const firstOrg = Object.values(contact?.organizations ?? {})[0];
    const orgUnits = firstOrg && department === initialRows.department
      ? firstOrg.units
      : department.trim() ? [{ name: department.trim() }] : undefined;

    // An address the user didn't touch goes back as the card had it. An edited
    // one is rebuilt in its country's order ("Hauptstraße" + "1", then
    // postcode and city), keeping the parts the form doesn't show.
    const addressesMap = entriesToSave<AddressEntry, ContactAddress>(
      // An address the form can't show (only `full` text, a PO box) has empty
      // rows here; untouched, it stays.
      addresses.filter(a => a.street.trim() || a.locality.trim() || a.region.trim() || a.postcode.trim() || a.country.trim()
        || isUntouchedRow(a, initialRows.addresses, contact?.addresses)),
      initialRows.addresses, contact?.addresses, "a",
      (row, previous, before) => {
        const { components: previousComponents, full: _full, fullAddress: _fullAddress, street: _s, locality: _l, region: _r, postcode: _p, country: _c, ...kept } = previous ?? {};
        void _full; void _fullAddress; void _s; void _l; void _r; void _p; void _c;
        const countryCode = before && before.country === row.country
          ? previous?.countryCode
          : countryCodeFromName(row.country) ?? undefined;
        return compact({
          ...kept,
          components: partsToComponents(row, previousComponents ?? [], locale, countryCode),
          isOrdered: true,
          defaultSeparator: previous?.defaultSeparator ?? ", ",
          countryCode,
          contexts: contextsToSave(row.context, previous?.contexts, before),
        });
      },
    );

    const onlineServicesMap = entriesToSave<OnlineServiceEntry, ContactOnlineService>(
      onlineServices.filter(s => s.uri.trim()), initialRows.onlineServices, contact?.onlineServices, "os",
      (row, previous) => compact({
        ...previous,
        uri: row.uri.trim(),
        service: row.service.trim() || undefined,
        label: row.label.trim() || undefined,
      }),
    );

    const anniversariesMap = entriesToSave<AnniversaryEntry, ContactAnniversary>(
      anniversaries.filter(a => a.date.trim()), initialRows.anniversaries, contact?.anniversaries, "an",
      (row, previous) => ({ ...previous, date: stringToPartialDate(row.date.trim()), kind: row.kind }),
    );

    const personalInfoMap = entriesToSave<PersonalInfoEntry, ContactPersonalInfo>(
      personalInfoEntries.filter(p => p.value.trim()), initialRows.personalInfoEntries, contact?.personalInfo, "pi",
      (row, previous) => compact({
        ...previous,
        value: row.value.trim(),
        kind: row.kind,
        level: (row.level || undefined) as ContactPersonalInfo["level"],
      }),
    );

    const keywordsMap: Record<string, boolean> = {};
    keywordsStr.split(",").map(k => k.trim()).filter(Boolean).forEach(k => {
      keywordsMap[k] = true;
    });
    // A typed category that matches an existing one takes its spelling.
    categoryDraft.split(",").map(k => k.trim()).filter(Boolean).forEach(k => {
      const existing = (allKeywords || []).find(kw => kw.toLowerCase() === k.toLowerCase());
      keywordsMap[existing ?? k] = true;
    });

    // Only send `kind` when this form owns the answer: switching a card between
    // person and organization. Leave other kinds (group, location, ...) untouched.
    const kindValue: ContactCard["kind"] | undefined =
      isOrg ? "org" : (contact?.kind === "org" ? "individual" : undefined);

    const data: Partial<ContactCard> = {
      name: nameValue,
      ...(kindValue ? { kind: kindValue } : {}),
      // The form edits the first nickname, note and organization; others stay.
      nicknames: firstEntryToSave(contact?.nicknames, "n0", nickname.trim() ? { name: nickname.trim() } : null),
      emails: Object.keys(emailsMap).length > 0 ? emailsMap : undefined,
      phones: Object.keys(phonesMap).length > 0 ? phonesMap : undefined,
      titles: Object.keys(titlesMap).length > 0 ? titlesMap : undefined,
      organizations: firstEntryToSave(contact?.organizations, "o0", orgName ? { name: orgName, units: orgUnits } : null),
      addresses: Object.keys(addressesMap).length > 0 ? addressesMap : undefined,
      onlineServices: Object.keys(onlineServicesMap).length > 0 ? onlineServicesMap : undefined,
      anniversaries: Object.keys(anniversariesMap).length > 0 ? anniversariesMap : undefined,
      personalInfo: Object.keys(personalInfoMap).length > 0 ? personalInfoMap : undefined,
      keywords: Object.keys(keywordsMap).length > 0 ? keywordsMap : undefined,
      notes: firstEntryToSave(contact?.notes, "n0", note.trim() ? { note: note.trim() } : null),
      speakToAs: (genderSex.trim() || genderIdentity.trim())
        ? {
            grammaticalGender: genderSex.trim() || undefined,
            pronouns: genderIdentity.trim() ? { p0: { pronouns: genderIdentity.trim() } } : undefined,
          }
        : undefined,
      calendarUri: calendarUri.trim() || undefined,
      schedulingUri: schedulingUri.trim() || undefined,
      freeBusyUri: freeBusyUri.trim() || undefined,
      ...(selectedBookId ? { addressBookIds: { [selectedBookId]: true } } : {}),
    };

    // An existing card gets only what changed: every property left out stays
    // on the server exactly as it is.
    if (contact) {
      const before = JSON.parse(initialPropertyFields) as Record<string, unknown>;
      for (const [property, value] of Object.entries(propertyFields)) {
        if (JSON.stringify(value) === JSON.stringify(before[property])) delete data[property as keyof ContactCard];
      }
    }

    setIsSaving(true);
    try {
      // `media` goes out only when the photo changed. An update without it
      // keeps every entry on the server, while a map replaces them all, and
      // `null` deletes them. The other entries go back as the server has them
      // now: a data: URI on 0.16, a blobId on 1.0, which resolves it again. A
      // blobId from an older copy of the card, say of a logo changed
      // elsewhere since, makes 1.0 refuse the whole update ("The following
      // blobIds do not exist or are not accessible").
      let photoKey: string | undefined;
      if (photoEdit.kind === "new" || (photoEdit.kind === "removed" && initialPhotoKey)) {
        const current = contact && loadCurrentMedia ? await loadCurrentMedia().catch(() => null) : null;
        const known = contact?.media ?? {};
        const edited = mediaForPhotoEdit(current ? current.media ?? {} : known, known, initialPhotoKey, photoEdit);
        // Absent, not undefined: contactToWire sends an undefined key as null.
        data.media = edited.media as Record<string, ContactMedia>;
        photoKey = edited.photoKey;
      }
      await (photoKey ? onSave(data, { photoKey }) : onSave(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("save_failed"));
    } finally {
      setIsSaving(false);
    }
  };

  const previewName = (isOrg ? "" : [givenName, surname].filter(Boolean).join(" ").trim()) || organization.trim();
  const previewEmail = emails.find(e => e.address.trim())?.address.trim() || "";

  const close = (
    <IconButton label={t("close")} onClick={onCancel}>
      <X />
    </IconButton>
  );

  return (
    // The app checks the fields itself and says what is wrong inline; the
    // browser's own bubble covered that message.
    <form onSubmit={handleSubmit} noValidate className="flex flex-col h-full bg-background">
      <div ref={setHeader} data-window-top-row="" className="flex items-center gap-2 px-6 py-4 border-b border-border flex-shrink-0">
        {closeFirst && close}
        <h2 className="min-w-0 flex-1 text-lg font-semibold">
          {isEditing ? t("edit_title") : t("create_title")}
        </h2>
        {!closeFirst && close}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="@container px-6 py-4 max-w-3xl">
          {error && (
            <div role="alert" className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md mb-4">
              {error}
            </div>
          )}

          <div className="flex items-center gap-4 pb-4">
            <button
              type="button"
              onClick={() => photoInputRef.current?.click()}
              disabled={photoUploading}
              className="relative group rounded-full focus:outline-hidden disabled:opacity-60"
              title={t("upload_photo")}
              aria-label={t("upload_photo")}
            >
              <Avatar
                name={previewName || undefined}
                email={previewEmail || undefined}
                contactPhoto={previewPhoto}
                // Nothing typed yet: a neutral circle, not a coloured "?".
                fallbackColor={previewName || previewEmail ? undefined : "var(--color-muted-foreground)"}
                size="lg"
                className="!w-20 !h-20 !text-xl"
              />
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-black/55 text-white flex flex-col items-center justify-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
              >
                <Camera className="w-5 h-5" />
                <span className="text-[0.625rem] font-medium leading-none">{t("change_photo")}</span>
              </span>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePhotoSelect}
              />
            </button>
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">{t("photo_hint")}</p>
              {photoError && (
                <p className="text-xs text-destructive">{photoError}</p>
              )}
              {previewPhoto && (
                <button
                  type="button"
                  onClick={handlePhotoRemove}
                  className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  {t("remove_photo")}
                </button>
              )}
            </div>
          </div>

          <div className="divide-y divide-border/60">

          {addressBooks && addressBooks.length > 1 && (
            <FormSection icon={Book} title={t("section_address_book")}>
              <select
                aria-label={t("section_address_book")}
                value={selectedBookId}
                onChange={(e) => setSelectedBookId(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-hidden"
              >
                <option value="">{t("select_address_book")}</option>
                {addressBooks.map((book) => (
                  <option key={book.id} value={book.id}>
                    {/* A shared book says whose it is, unless its name already does. */}
                    {book.isShared && book.accountName && !book.name.includes(book.accountName) ? `${book.name} (${book.accountName})` : book.name}
                  </option>
                ))}
              </select>
            </FormSection>
          )}

          <FormSection icon={User} title={t("section_identity")}>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">{t("contact_type")}</span>
              <div role="radiogroup" aria-label={t("contact_type")} className="inline-flex gap-0.5 rounded-md border border-input p-0.5">
                {[
                  { org: false, label: t("type_person"), icon: User },
                  { org: true, label: t("type_organization"), icon: Building },
                ].map(({ org, label, icon: Icon }) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={isOrg === org}
                    onClick={() => setIsOrg(org)}
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors",
                      isOrg === org
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {isOrg ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor={fieldId("organization-required")} className="text-xs text-muted-foreground mb-1 block">
                    {t("organization")} <span className="text-destructive" aria-hidden="true">*</span>
                  </label>
                  <Input id={fieldId("organization-required")} aria-required value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder={t("organization_placeholder")} autoFocus />
                </div>
                <div>
                  <label htmlFor={fieldId("nickname")} className="text-xs text-muted-foreground mb-1 block">{t("nickname")}</label>
                  <Input id={fieldId("nickname")} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder={t("nickname_placeholder")} />
                </div>
              </div>
            ) : (
              <>
                {/* Two columns in a narrow pane (title and first name, last name and
                    suffix), one row once there is room, so no name gets cut. */}
                <div className="grid grid-cols-2 @lg:grid-cols-[auto_1fr_1fr_auto] gap-2">
                  <div>
                    <label htmlFor={fieldId("prefix")} className="text-xs text-muted-foreground mb-1 block">{t("prefix")}</label>
                    <Input id={fieldId("prefix")} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder={t("prefix_placeholder")} className="@lg:w-20" />
                  </div>
                  <div>
                    <label htmlFor={fieldId("given_name")} className="text-xs text-muted-foreground mb-1 block">{t("given_name")}</label>
                    <Input id={fieldId("given_name")} value={givenName} onChange={(e) => setGivenName(e.target.value)} placeholder={t("given_name")} autoFocus />
                  </div>
                  <div>
                    <label htmlFor={fieldId("surname")} className="text-xs text-muted-foreground mb-1 block">{t("surname")}</label>
                    <Input id={fieldId("surname")} value={surname} onChange={(e) => setSurname(e.target.value)} placeholder={t("surname")} />
                  </div>
                  <div>
                    <label htmlFor={fieldId("suffix")} className="text-xs text-muted-foreground mb-1 block">{t("suffix")}</label>
                    <Input id={fieldId("suffix")} value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder={t("suffix_placeholder")} className="@lg:w-20" />
                  </div>
                </div>
                {/* Either name is enough (or an organization), so neither is starred. */}
                <p className="text-xs text-muted-foreground -mt-1">{t("name_required")}</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={fieldId("middle_name")} className="text-xs text-muted-foreground mb-1 block">{t("middle_name")}</label>
                    <Input id={fieldId("middle_name")} value={additionalName} onChange={(e) => setAdditionalName(e.target.value)} placeholder={t("middle_name")} />
                  </div>
                  <div>
                    <label htmlFor={fieldId("nickname-1")} className="text-xs text-muted-foreground mb-1 block">{t("nickname")}</label>
                    <Input id={fieldId("nickname-1")} value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder={t("nickname_placeholder")} />
                  </div>
                </div>
              </>
            )}
          </FormSection>

          {/* Email */}
          <FormSection icon={Mail} title={t("email")}>
            <div className="space-y-2 @container">
              {emails.map((entry, i) => (
                <div key={i}>
                  <div className="flex flex-wrap @md:flex-nowrap items-center gap-2">
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
                      aria-label={t("email")}
                      aria-invalid={emailErrors[i] ? true : undefined}
                      aria-describedby={emailErrors[i] ? fieldId(`email-error-${i}`) : undefined}
                      className={cn("grow basis-full @md:basis-0", emailErrors[i] && "border-destructive focus-visible:border-destructive")}
                    />
                    <Select
                      value={entry.context}
                      onChange={(e) => {
                        const next = [...emails];
                        next[i] = { ...next[i], context: e.target.value as EmailEntry["context"] };
                        setEmails(next);
                      }}
                      aria-label={t("context_label")}
                    >
                      <option value="">-</option>
                      <option value="work">{t("context_work")}</option>
                      <option value="private">{tx("context_private")}</option>
                    </Select>
                    {emails.length > 1 && (
                      <IconButton label={t("remove_entry")} onClick={() => setEmails(emails.filter((_, j) => j !== i))} className="shrink-0">
                        <X />
                      </IconButton>
                    )}
                  </div>
                  {emailErrors[i] && (
                    <p id={fieldId(`email-error-${i}`)} className="text-xs text-destructive mt-1 ms-1">{emailErrors[i]}</p>
                  )}
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setEmails([...emails, { address: "", context: "" }])} className="text-xs">
                <Plus className="w-3 h-3 me-1" />
                {t("add_email")}
              </Button>
            </div>
          </FormSection>

          {/* Phone */}
          <FormSection icon={Phone} title={t("phone")}>
            <div className="space-y-2 @container">
              {/* In a narrow pane the number takes a line of its own: beside the two selects it was cut to two digits. */}
              {phones.map((entry, i) => (
                <div key={i} className="flex flex-wrap @md:flex-nowrap items-center gap-2">
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
                    aria-label={t("phone")}
                    className="grow basis-full @md:basis-0"
                  />
                  <Select
                    value={entry.feature}
                    onChange={(e) => {
                      const next = [...phones];
                      next[i] = { ...next[i], feature: e.target.value as PhoneEntry["feature"] };
                      setPhones(next);
                    }}
                    className="w-28"
                    aria-label={t("phone_type")}
                  >
                    <option value="">{t("phone_type")}</option>
                    <option value="voice">{tx("phone_voice")}</option>
                    <option value="mobile">{t("phone_cell")}</option>
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
                    aria-label={t("context_label")}
                  >
                    <option value="">-</option>
                    <option value="work">{t("context_work")}</option>
                    <option value="private">{tx("context_private")}</option>
                  </Select>
                  <IconButton label={t("remove_entry")} onClick={() => setPhones(phones.filter((_, j) => j !== i))} className="shrink-0">
                    <X />
                  </IconButton>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setPhones([...phones, { number: "", context: "", feature: "" }])} className="text-xs">
                <Plus className="w-3 h-3 me-1" />
                {t("add_phone")}
              </Button>
            </div>
          </FormSection>

          {/* Work & Organization */}
          <FormSection icon={Building} title={t("section_work")} collapsible defaultOpen={!!((organization && !isOrg) || department || jobTitle || role)}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* In organization mode the org name is the card's identity, edited above. */}
              {!isOrg && (
                <div>
                  <label htmlFor={fieldId("organization")} className="text-xs text-muted-foreground mb-1 block">{t("organization")}</label>
                  <Input id={fieldId("organization")} value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder={t("organization_placeholder")} />
                </div>
              )}
              <div>
                <label htmlFor={fieldId("department")} className="text-xs text-muted-foreground mb-1 block">{t("department")}</label>
                <Input id={fieldId("department")} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder={t("department_placeholder")} />
              </div>
              <div>
                <label htmlFor={fieldId("job_title")} className="text-xs text-muted-foreground mb-1 block">{t("job_title")}</label>
                <Input id={fieldId("job_title")} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder={t("job_title_placeholder")} />
              </div>
              <div>
                <label htmlFor={fieldId("role")} className="text-xs text-muted-foreground mb-1 block">{t("role")}</label>
                <Input id={fieldId("role")} value={role} onChange={(e) => setRole(e.target.value)} placeholder={t("role_placeholder")} />
              </div>
            </div>
          </FormSection>

          {/* Addresses */}
          <FormSection icon={MapPin} title={t("addresses")} collapsible defaultOpen={addresses.length > 0}>
            <div className="space-y-3">
              {addresses.map((addr, i) => {
                const set = (name: keyof Omit<AddressEntry, "key">) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
                  const n = [...addresses];
                  n[i] = { ...n[i], [name]: e.target.value };
                  setAddresses(n);
                };
                const original = addr.key ? contact?.addresses?.[addr.key] : undefined;
                const initialCountry = addr.key ? initialRows.addresses.find(a => a.key === addr.key)?.country : undefined;
                const style: AddressStyle = addressStyle(addr.country, initialCountry === addr.country ? original?.countryCode : null, locale);
                const field = (name: "locality" | "region" | "postcode", label: string, className?: string) => (
                  <Input key={name} value={addr[name]} onChange={set(name)} placeholder={label} aria-label={label} className={className} />
                );
                const country = <Input key="country" value={addr.country} onChange={set("country")} placeholder={t("country")} aria-label={t("country")} />;
                const context = (
                  <Select key="context" value={addr.context} onChange={set("context")} aria-label={t("context_label")}>
                    <option value="">-</option>
                    <option value="work">{t("context_work")}</option>
                    <option value="private">{tx("context_private")}</option>
                  </Select>
                );
                return (
                  <div key={addr.key ?? `new-${i}`} data-address-layout={style.town} className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-2 relative">
                    <IconButton label={t("remove_entry")} onClick={() => setAddresses(addresses.filter((_, j) => j !== i))} className="absolute top-1 end-1">
                      <X />
                    </IconButton>
                    {/* Street and house number in one field, in the order the country writes them. */}
                    <Input value={addr.street} onChange={set("street")} placeholder={t("street")} aria-label={t("street")} className="pe-10" />
                    {style.town === "postcode-city" ? (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          {field("postcode", t("postcode"))}
                          {field("locality", t("city"), "col-span-2")}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {field("region", t("region"))}
                          {country}
                          {context}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          {field("locality", t("city"))}
                          {field("region", t("region"))}
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {field("postcode", t("postcode"))}
                          {country}
                          {context}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              <Button type="button" variant="ghost" size="sm" onClick={() => setAddresses([...addresses, { street: "", locality: "", region: "", postcode: "", country: "", context: "" }])} className="text-xs">
                <Plus className="w-3 h-3 me-1" />
                {t("add_address")}
              </Button>
            </div>
          </FormSection>

          {/* Anniversaries */}
          <FormSection icon={Cake} title={t("anniversaries")} collapsible defaultOpen={anniversaries.length > 0}>
            <div className="space-y-2">
              {anniversaries.map((ann, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={ann.date}
                    onChange={(e) => { const n = [...anniversaries]; n[i] = { ...n[i], date: e.target.value }; setAnniversaries(n); }}
                    aria-label={t("anniversary_date")}
                    className="flex-1"
                  />
                  <Select
                    value={ann.kind}
                    onChange={(e) => { const n = [...anniversaries]; n[i] = { ...n[i], kind: e.target.value as AnniversaryEntry["kind"] }; setAnniversaries(n); }}
                    aria-label={t("anniversary_kind")}
                  >
                    <option value="birth">{t("anniversary_birth")}</option>
                    <option value="wedding">{t("anniversary_wedding")}</option>
                    <option value="death">{t("anniversary_death")}</option>
                    <option value="other">{t("anniversary_other")}</option>
                  </Select>
                  <IconButton label={t("remove_entry")} onClick={() => setAnniversaries(anniversaries.filter((_, j) => j !== i))} className="shrink-0">
                    <X />
                  </IconButton>
                </div>
              ))}
              <Button type="button" variant="ghost" size="sm" onClick={() => setAnniversaries([...anniversaries, { date: "", kind: "birth" }])} className="text-xs">
                <Plus className="w-3 h-3 me-1" />
                {t("add_anniversary")}
              </Button>
            </div>
          </FormSection>

          {/* Categories */}
          <FormSection icon={Tag} title={t("categories")} collapsible defaultOpen={!!keywordsStr}>
            <CategoryComboBox
              keywordsStr={keywordsStr}
              onChange={setKeywordsStr}
              inputValue={categoryDraft}
              onInputChange={setCategoryDraft}
              allKeywords={allKeywords || []}
              placeholder={t("categories_placeholder")}
              hint={t("categories_hint")}
              addLabel={t("category_add")}
            />
          </FormSection>

          {/* Notes */}
          <FormSection icon={StickyNote} title={t("note")} collapsible defaultOpen={!!note}>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("note_placeholder")}
              aria-label={t("note")}
              className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-y outline-none"
            />
          </FormSection>

          {/* Fields most cards don't use, collapsed unless one has a value. */}
          <FormSection icon={MoreHorizontal} title={tx("more_fields")} collapsible defaultOpen={hasMoreFields}>
            <div className="divide-y divide-border/60 -my-5">
            {/* Online Services */}
            <FormSection icon={Globe} title={t("online_services")}>
              <div className="space-y-2">
                {onlineServices.map((svc, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={svc.uri}
                      onChange={(e) => { const n = [...onlineServices]; n[i] = { ...n[i], uri: e.target.value }; setOnlineServices(n); }}
                      placeholder={t("url_placeholder")}
                      aria-label={t("online_service_url")}
                      className="flex-1"
                    />
                    <Input
                      value={svc.service}
                      onChange={(e) => { const n = [...onlineServices]; n[i] = { ...n[i], service: e.target.value }; setOnlineServices(n); }}
                      placeholder={t("service_placeholder")}
                      aria-label={t("service_placeholder")}
                      className="w-24"
                    />
                    <IconButton label={t("remove_entry")} onClick={() => setOnlineServices(onlineServices.filter((_, j) => j !== i))} className="shrink-0">
                      <X />
                    </IconButton>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="sm" onClick={() => setOnlineServices([...onlineServices, { uri: "", service: "", label: "" }])} className="text-xs">
                  <Plus className="w-3 h-3 me-1" />
                  {t("add_online_service")}
                </Button>
              </div>
            </FormSection>

            {/* Personal Info */}
            <FormSection icon={Heart} title={t("personal_info")}>
              <div className="space-y-2">
                {personalInfoEntries.map((pi, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={pi.value}
                      onChange={(e) => { const n = [...personalInfoEntries]; n[i] = { ...n[i], value: e.target.value }; setPersonalInfoEntries(n); }}
                      placeholder={t("personal_info_placeholder")}
                      aria-label={t("personal_info")}
                      className="flex-1"
                    />
                    <Select
                      value={pi.kind}
                      onChange={(e) => { const n = [...personalInfoEntries]; n[i] = { ...n[i], kind: e.target.value as PersonalInfoEntry["kind"] }; setPersonalInfoEntries(n); }}
                      aria-label={t("personal_info_kind")}
                    >
                      <option value="expertise">{t("personal_expertise")}</option>
                      <option value="hobby">{t("personal_hobby")}</option>
                      <option value="interest">{t("personal_interest")}</option>
                      <option value="other">{t("personal_other")}</option>
                    </Select>
                    <Select
                      value={pi.level}
                      onChange={(e) => { const n = [...personalInfoEntries]; n[i] = { ...n[i], level: e.target.value as PersonalInfoEntry["level"] }; setPersonalInfoEntries(n); }}
                      aria-label={t("level")}
                    >
                      <option value="">{t("level")}</option>
                      <option value="high">{t("level_high")}</option>
                      <option value="medium">{t("level_medium")}</option>
                      <option value="low">{t("level_low")}</option>
                    </Select>
                    <IconButton label={t("remove_entry")} onClick={() => setPersonalInfoEntries(personalInfoEntries.filter((_, j) => j !== i))} className="shrink-0">
                      <X />
                    </IconButton>
                  </div>
                ))}
                <Button type="button" variant="ghost" size="sm" onClick={() => setPersonalInfoEntries([...personalInfoEntries, { value: "", kind: "hobby", level: "" }])} className="text-xs">
                  <Plus className="w-3 h-3 me-1" />
                  {t("add_personal_info")}
                </Button>
              </div>
            </FormSection>

            {/* Gender */}
            <FormSection icon={UserCircle} title={t("gender")}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label htmlFor={fieldId("gender_sex")} className="text-xs text-muted-foreground mb-1 block">{t("gender_sex")}</label>
                  <Select id={fieldId("gender_sex")} value={genderSex} onChange={(e) => setGenderSex(e.target.value)} className="w-full">
                    <option value="">-</option>
                    <option value="masculine">{t("gender_male")}</option>
                    <option value="feminine">{t("gender_female")}</option>
                    <option value="other">{t("gender_other")}</option>
                    <option value="none">{t("gender_none")}</option>
                    <option value="unknown">{t("gender_unknown")}</option>
                  </Select>
                </div>
                <div>
                  <label htmlFor={fieldId("gender_identity")} className="text-xs text-muted-foreground mb-1 block">{t("gender_identity")}</label>
                  <Input id={fieldId("gender_identity")} value={genderIdentity} onChange={(e) => setGenderIdentity(e.target.value)} placeholder={t("gender_identity_placeholder")} />
                </div>
              </div>
            </FormSection>

            {/* Calendar */}
            <FormSection icon={Calendar} title={t("calendar")}>
              <div className="space-y-3">
                <div>
                  <label htmlFor={fieldId("calendar_uri")} className="text-xs text-muted-foreground mb-1 block">{t("calendar_uri")}</label>
                  <Input id={fieldId("calendar_uri")} value={calendarUri} onChange={(e) => setCalendarUri(e.target.value)} placeholder="https://..." />
                </div>
                <div>
                  <label htmlFor={fieldId("scheduling_uri")} className="text-xs text-muted-foreground mb-1 block">{t("scheduling_uri")}</label>
                  <Input id={fieldId("scheduling_uri")} value={schedulingUri} onChange={(e) => setSchedulingUri(e.target.value)} placeholder="https://..." />
                </div>
                <div>
                  <label htmlFor={fieldId("freebusy_uri")} className="text-xs text-muted-foreground mb-1 block">{t("freebusy_uri")}</label>
                  <Input id={fieldId("freebusy_uri")} value={freeBusyUri} onChange={(e) => setFreeBusyUri(e.target.value)} placeholder="https://..." />
                </div>
              </div>
            </FormSection>
            </div>
          </FormSection>

          </div>
        </div>
      </div>

      {/* Toasts sit above Save and Cancel, not on them. */}
      <div ref={footerRef} className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border flex-shrink-0">
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

function CategoryComboBox({
  keywordsStr,
  onChange,
  inputValue,
  onInputChange: setInputValue,
  allKeywords,
  placeholder,
  hint,
  addLabel,
}: {
  keywordsStr: string;
  onChange: (value: string) => void;
  /** The text typed but not added yet; the form adds it on Save. */
  inputValue: string;
  onInputChange: (value: string) => void;
  allKeywords: string[];
  placeholder: string;
  hint: string;
  addLabel: string;
}) {
  const t = useTranslations("contacts.form");
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  // Parse current keywords from comma-separated string
  const currentKeywords = useMemo(() => {
    return keywordsStr.split(",").map(k => k.trim()).filter(Boolean);
  }, [keywordsStr]);

  // Suggestions: existing keywords not already selected
  const suggestions = useMemo(() => {
    const lower = inputValue.toLowerCase();
    return allKeywords.filter(kw =>
      !currentKeywords.includes(kw) &&
      (!lower || kw.toLowerCase().includes(lower))
    );
  }, [allKeywords, currentKeywords, inputValue]);

  // Can add a new keyword if typed text is non-empty and not already in the list
  const canAddNew = inputValue.trim() &&
    !currentKeywords.includes(inputValue.trim()) &&
    !allKeywords.some(kw => kw.toLowerCase() === inputValue.trim().toLowerCase());

  const addKeyword = useCallback((keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed || currentKeywords.includes(trimmed)) return;
    const next = [...currentKeywords, trimmed].join(", ");
    onChange(next);
    setInputValue("");
  }, [currentKeywords, onChange, setInputValue]);

  const removeKeyword = useCallback((keyword: string) => {
    const next = currentKeywords.filter(k => k !== keyword).join(", ");
    onChange(next);
  }, [currentKeywords, onChange]);


  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (inputValue.trim()) {
        addKeyword(inputValue);
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <div className="relative">
      {/* Keyword badges */}
      {currentKeywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {currentKeywords.map(kw => (
            <span
              key={kw}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary border border-primary/20"
            >
              {kw}
              <button
                type="button"
                onClick={() => removeKeyword(kw)}
                aria-label={t("remove_category", { name: kw })}
                title={t("remove_category", { name: kw })}
                className="hover:text-destructive transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Input with dropdown */}
      <Input
        ref={inputRef}
        value={inputValue}
        onChange={(e) => { setInputValue(e.target.value); setIsOpen(true); }}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
        onKeyDown={handleKeyDown}
        placeholder={currentKeywords.length === 0 ? placeholder : ""}
        aria-label={t("categories")}
        aria-describedby={hintId}
      />
      <p id={hintId} className="text-xs text-muted-foreground mt-1.5">{hint}</p>

      {/* Dropdown */}
      {isOpen && (suggestions.length > 0 || canAddNew) && (
        <div className="absolute left-0 right-0 top-[calc(100%-1.5rem)] mt-1 rounded-md border border-border bg-popover text-popover-foreground shadow-md z-50 max-h-48 overflow-y-auto py-1" onMouseDown={(e) => e.preventDefault()}>
          {suggestions.map(kw => (
            <button
              key={kw}
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors text-start"
              onClick={() => { addKeyword(kw); inputRef.current?.focus(); }}
            >
              <Tag className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              {kw}
            </button>
          ))}
          {canAddNew && (
            <button
              type="button"
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors text-start text-primary"
              onClick={() => { addKeyword(inputValue); inputRef.current?.focus(); }}
            >
              <Plus className="w-3.5 h-3.5 flex-shrink-0" />
              {addLabel}: &quot;{inputValue.trim()}&quot;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
