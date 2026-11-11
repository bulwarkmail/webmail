import type { ContactCard } from "@/lib/jmap/types";
import { formatContactDate } from "@/lib/contact-dates";
import { getContactPhotoRef, type DirectoryEntry } from "@/stores/contact-store";
import { loadContactMediaBlob } from "@/lib/contact-media";
import { blobToDataUri } from "@/lib/data-uri";
import { contactPhotoKey, peekContactPhoto } from "@/lib/contact-photo-cache";
import { getContactPhotoClient } from "@/hooks/use-contact-photo";
import { requestPrint, type PrintTarget } from "@/stores/print-store";
import { useSettingsStore } from "@/stores/settings-store";

const PHOTO_TIMEOUT_MS = 5000;

/**
 * The photo as something the print copy can show right away: a URI as it
 * is, a blob photo (Stalwart 1.0) from the photo cache, else downloaded into
 * a data: URI. Left out when that fails or takes too long.
 */
export async function printablePhotoUri(contact: ContactCard): Promise<string | undefined> {
  const photo = getContactPhotoRef(contact);
  if (!photo) return undefined;
  if ("uri" in photo) return photo.uri;
  const cached = peekContactPhoto(contactPhotoKey(photo.localAccountId, photo.blobId));
  if (cached) return cached;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const blob = await Promise.race([
    loadContactMediaBlob({ kind: "photo", blobId: photo.blobId, mediaType: photo.mediaType }, {
      client: getContactPhotoClient(photo.localAccountId),
      accountId: photo.accountId,
      localAccountId: photo.localAccountId,
    }).catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PHOTO_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  return blob ? blobToDataUri(blob, photo.mediaType).catch(() => undefined) : undefined;
}

/** The photo the page already has for the contact (Ctrl+P can't wait for a download). */
export function cachedPhotoUri(contact: ContactCard): string | undefined {
  const photo = getContactPhotoRef(contact);
  if (!photo) return undefined;
  if ("uri" in photo) return photo.uri;
  return peekContactPhoto(contactPhotoKey(photo.localAccountId, photo.blobId));
}

/** Prints one contact on a sheet of its own. */
export async function printContact(contact: ContactCard): Promise<void> {
  const photoUri = await printablePhotoUri(contact);
  await requestPrint({ kind: "contact", contact, photoUri });
}

export interface ContactSheetRow {
  label: string;
  value: string;
}

export interface ContactSheetSection {
  title: string;
  rows: ContactSheetRow[];
  /** Free text (notes) that may run over a page. */
  text?: boolean;
}

/** An address as the lines the contact page shows. */
export function contactAddressLines(a: NonNullable<ContactCard["addresses"]>[string]): string[] {
  const full = a.full || a.fullAddress;
  if (full) return [full];
  if (a.components && a.components.length > 0) {
    const joined = a.components.filter((c) => c.kind !== "separator").map((c) => c.value).filter(Boolean).join(", ");
    return joined ? [joined] : [];
  }
  return [a.street, [a.postcode, a.locality].filter(Boolean).join(" "), a.region, a.country]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
}

/**
 * The sections of a contact's print sheet, in the order of the contact page.
 * `t` is the "contacts" translator. Values are plain text; React escapes them.
 */
export function contactSheetSections(contact: ContactCard, t: (key: string) => string, locale: string): ContactSheetSection[] {
  const values = <T,>(record: Record<string, T> | undefined | null): T[] => (record ? Object.values(record) : []);
  const sections: ContactSheetSection[] = [];
  const add = (title: string, rows: ContactSheetRow[], text = false) => {
    const kept = rows.filter((r) => r.value.trim());
    if (kept.length > 0) sections.push({ title, rows: kept, text });
  };

  add(t("detail.emails"), values(contact.emails).map((e) => ({ label: e.label || t("detail.email_default_label"), value: e.address || "" })));
  add(t("detail.phones"), values(contact.phones).map((p) => ({ label: p.label || t("detail.phone_default_label"), value: p.number || "" })));
  add(t("detail.organizations"), values(contact.organizations).map((o) => {
    const units = (o.units ?? []).map((u) => u.name).filter(Boolean).join(", ");
    return { label: t("detail.organization_label"), value: [o.name, units].filter(Boolean).join(" · ") };
  }));
  add(t("detail.titles"), values(contact.titles).map((title) => ({
    label: title.kind === "role" ? t("detail.role_label") : t("detail.title_label"),
    value: title.name || "",
  })));
  add(t("detail.addresses"), values(contact.addresses).map((a) => ({
    label: a.label || t("detail.address_default_label"),
    value: contactAddressLines(a).join("\n"),
  })));
  // Websites and online services print their address: on paper it can't be clicked.
  add(t("detail.online_services"), values(contact.onlineServices).map((s) => ({
    label: s.label || s.service || t("detail.online_service_default_label"),
    value: [s.user, typeof s.uri === "string" ? s.uri : ""].filter(Boolean).join("\n"),
  })));
  add(t("detail.anniversaries"), values(contact.anniversaries).map((a) => ({
    label: t(`detail.anniversary_${["birth", "death", "wedding"].includes(a.kind || "") ? a.kind : "other"}`),
    value: a.date ? formatContactDate(a.date, locale, useSettingsStore.getState().dateLocale) : "",
  })));
  add(t("detail.notes"), values(contact.notes).map((n) => ({ label: "", value: n.note || "" })), true);
  return sections;
}

/** What the contacts page prints: the list, or the one item open. */
export type ContactsPrintContent =
  | { kind: "list" }
  | { kind: "contact"; contact: ContactCard; photoUri?: string }
  | { kind: "group"; group: ContactCard }
  | { kind: "directory-list" }
  | { kind: "directory-entry"; entry: DirectoryEntry };

export interface ContactsPrintState {
  /** The directory is the open category. */
  directory: boolean;
  /** The pane beside the list shows something (always on wide screens). */
  detailShown: boolean;
  view: string;
  selectedContact: ContactCard | null;
  selectedGroup: ContactCard | null;
  openDirectoryEntry: DirectoryEntry | null;
}

/**
 * The copy to print: what a Print action asked for, else (Ctrl+P) the open
 * contact, group or directory entry, else the list on screen.
 */
export function resolveContactsPrint(target: PrintTarget | null, state: ContactsPrintState): ContactsPrintContent {
  switch (target?.kind) {
    case "contact": return { kind: "contact", contact: target.contact, photoUri: target.photoUri };
    case "contact-group": return { kind: "group", group: target.group };
    case "directory-entry": return { kind: "directory-entry", entry: target.entry };
    case "directory-list": return { kind: "directory-list" };
    case "contact-list": return { kind: "list" };
  }
  if (state.directory) {
    return state.detailShown && state.openDirectoryEntry
      ? { kind: "directory-entry", entry: state.openDirectoryEntry }
      : { kind: "directory-list" };
  }
  if (state.detailShown) {
    if (state.view === "group-detail" && state.selectedGroup) return { kind: "group", group: state.selectedGroup };
    if ((state.view === "list" || state.view === "detail") && state.selectedContact) {
      return { kind: "contact", contact: state.selectedContact };
    }
  }
  return { kind: "list" };
}
