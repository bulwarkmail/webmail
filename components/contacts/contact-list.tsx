"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Search, BookUser, Trash2, Users, Download, X, UserPlus, CheckSquare, Square, Filter, Mail, Phone, Image as ImageIcon, RotateCcw, Menu, ArrowDownAZ, Loader2, FolderInput, Upload, Printer } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ToolbarButton, ToolbarSearch, ToolbarSearchAction } from "@/components/ui/toolbar";
import { ContactListItem } from "./contact-list-item";
import { ContactContextMenu } from "./contact-context-menu";
import { useContactExportBusy } from "./contact-export";
import { ContactListPrint } from "./contact-print-views";
import { PluginActions } from "@/components/plugins/plugin-actions";
import { isContextMenuKey, useContextMenu } from "@/hooks/use-context-menu";
import { PhoneHeaderActions } from "@/components/layout/phone-header-actions";
import { cn } from "@/lib/utils";
import type { AnniversaryDate, ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactSortName, hasContactPhoto } from "@/stores/contact-store";
import { useSettingsStore } from "@/stores/settings-store";
import { isAppShortcutBlocked } from "@/lib/keyboard";
import { isSingleKeyShortcutOff } from "@/lib/single-key-shortcuts";

type TriState = boolean | null;

interface ListFilters {
  organization: string;
  jobTitle: string;
  location: string;
  emailDomain: string;
  birthdayMonth: number | null;
  hasEmail: TriState;
  hasPhone: TriState;
  hasPhoto: TriState;
}

const EMPTY_FILTERS: ListFilters = {
  organization: "",
  jobTitle: "",
  location: "",
  emailDomain: "",
  birthdayMonth: null,
  hasEmail: null,
  hasPhone: null,
  hasPhoto: null,
};

function countActiveFilters(f: ListFilters): number {
  let n = 0;
  if (f.organization.trim()) n++;
  if (f.jobTitle.trim()) n++;
  if (f.location.trim()) n++;
  if (f.emailDomain.trim()) n++;
  if (f.birthdayMonth !== null) n++;
  if (f.hasEmail !== null) n++;
  if (f.hasPhone !== null) n++;
  if (f.hasPhoto !== null) n++;
  return n;
}

function matchTri(actual: boolean, filter: TriState): boolean {
  if (filter === null) return true;
  return actual === filter;
}

function getAnniversaryMonth(date: AnniversaryDate): number | null {
  if (typeof date === "string") {
    const iso = date.match(/^(\d{4})-(\d{2})/);
    if (iso) return parseInt(iso[2], 10);
    const partial = date.match(/^--(\d{2})/);
    if (partial) return parseInt(partial[1], 10);
    return null;
  }
  if ("month" in date && date.month) return date.month;
  if ("utc" in date && date.utc) {
    const d = new Date(date.utc);
    return isNaN(d.getTime()) ? null : d.getMonth() + 1;
  }
  return null;
}

function ContactPresenceFilter({ icon, label, value, onChange, anyLabel, yesLabel, noLabel }: {
  icon: React.ReactNode;
  label: string;
  value: TriState;
  onChange: (value: TriState) => void;
  anyLabel: string;
  yesLabel: string;
  noLabel: string;
}) {
  return (
    <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-xs">
      <span aria-hidden className="shrink-0 text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">{label}</span>
      <select aria-label={label} value={value === null ? "any" : String(value)}
        onChange={(event) => onChange(event.target.value === "any" ? null : event.target.value === "true")}
        className="max-w-[55%] min-w-0 rounded-md border border-input bg-background px-1 py-1 text-xs focus-visible:outline-2 focus-visible:outline-ring">
        <option value="any">{anyLabel}</option>
        <option value="true">{yesLabel}</option>
        <option value="false">{noLabel}</option>
      </select>
    </label>
  );
}

function ToggleChip({ icon, label, value, onClick }: { icon: React.ReactNode; label: string; value: TriState; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={value === true}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors border",
        value === true && "bg-primary/10 border-primary/30 text-primary",
        value === false && "bg-muted border-border text-muted-foreground line-through",
        value === null && "bg-background border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

interface ContactListProps {
  contacts: ContactCard[];
  selectedContactId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelectContact: (id: string) => void;
  onCreateNew: () => void;
  className?: string;
  selectedContactIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onSelectRangeContacts: (id: string, sortedIds: string[]) => void;
  onSelectAll: (ids: string[]) => void;
  onClearSelection: () => void;
  onBulkDelete: () => void;
  onBulkAddToGroup: () => void;
  onBulkExport: () => void;
  onEditContact: (id: string) => void;
  onDeleteContact: (contact: ContactCard) => void;
  onAddContactToGroup: (id: string) => void;
  /** Opens the app's composer to the contact. */
  onComposeContact?: (contact: ContactCard) => void;
  onDuplicateContact?: (contact: ContactCard) => void;
  /** Move contacts to another address book; undefined where there is none. */
  onMoveContacts?: (ids: string[]) => void;
  /** Show a burger button at the start that opens the (overlay) categories sidebar. */
  onMenuClick?: () => void;
  /** The list shows one address book, category or group, not the whole account. */
  emptyView?: boolean;
  onImport?: () => void;
  /** Contacts' own entries in the phone header's ⋮. */
  phoneMenuItems?: (close: () => void) => React.ReactNode;
  /** The first fetch is still running: show placeholders, not "No contacts yet". */
  isLoading?: boolean;
  /** Print the list as it is on screen (filtered, sorted, grouped). */
  onPrint?: () => void;
  /** Set while the list is being printed: the name of what it shows. */
  printTitle?: string | null;
}

export function ContactList({
  contacts,
  selectedContactId,
  searchQuery,
  onSearchChange,
  onSelectContact,
  onCreateNew,
  className,
  selectedContactIds,
  onToggleSelection,
  onSelectRangeContacts,
  onSelectAll,
  onClearSelection,
  onBulkDelete,
  onBulkAddToGroup,
  onBulkExport,
  onEditContact,
  onDeleteContact,
  onAddContactToGroup,
  onComposeContact,
  onDuplicateContact,
  onMoveContacts,
  onMenuClick,
  phoneMenuItems,
  emptyView = false,
  onImport,
  isLoading = false,
  onPrint,
  printTitle,
}: ContactListProps) {
  const t = useTranslations("contacts");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const density = useSettingsStore((state) => state.density);
  const groupByLetter = useSettingsStore((state) => state.groupContactsByLetter);
  const sortByLastName = useSettingsStore((state) => state.sortContactsByLastName);
  const updateSetting = useSettingsStore((state) => state.updateSetting);
  const { contextMenu, openContextMenu, openContextMenuFrom, closeContextMenu, menuRef } = useContextMenu<ContactCard>();
  // Opened by a long-press: the menu also offers Select, as touch has no Ctrl+click.
  const [menuByTouch, setMenuByTouch] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const filtersTrigger = useRef<HTMLButtonElement>(null);
  const closeFilters = () => {
    setFiltersOpen(false);
    filtersTrigger.current?.focus();
  };
  const [filters, setFilters] = useState<ListFilters>(EMPTY_FILTERS);
  const activeFilters = countActiveFilters(filters);
  const exporting = useContactExportBusy();

  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: "long" });
    return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2000, i, 1)));
  }, [locale]);

  const filtered = useMemo(() => {
    const lower = searchQuery.trim().toLowerCase();
    const orgLower = filters.organization.trim().toLowerCase();
    const jobLower = filters.jobTitle.trim().toLowerCase();
    const locLower = filters.location.trim().toLowerCase();
    const domainLower = filters.emailDomain.trim().toLowerCase().replace(/^@/, "");

    return contacts.filter((c) => {
      const emails = c.emails ? Object.values(c.emails) : [];
      const phones = c.phones ? Object.values(c.phones) : [];
      const orgs = c.organizations ? Object.values(c.organizations) : [];
      const titles = c.titles ? Object.values(c.titles) : [];
      const addresses = c.addresses ? Object.values(c.addresses) : [];
      const anniversaries = c.anniversaries ? Object.values(c.anniversaries) : [];

      if (!matchTri(emails.length > 0, filters.hasEmail)) return false;
      if (!matchTri(phones.length > 0, filters.hasPhone)) return false;
      if (!matchTri(hasContactPhoto(c), filters.hasPhoto)) return false;

      if (orgLower) {
        const match = orgs.some((o) => {
          if (o.name?.toLowerCase().includes(orgLower)) return true;
          if (o.units?.some((u) => u.name?.toLowerCase().includes(orgLower))) return true;
          return false;
        });
        if (!match) return false;
      }

      if (jobLower) {
        if (!titles.some((ti) => ti.name?.toLowerCase().includes(jobLower))) return false;
      }

      if (locLower) {
        const match = addresses.some((a) => {
          const parts: string[] = [];
          if (a.full) parts.push(a.full);
          if (a.fullAddress) parts.push(a.fullAddress);
          if (a.locality) parts.push(a.locality);
          if (a.region) parts.push(a.region);
          if (a.country) parts.push(a.country);
          if (a.postcode) parts.push(a.postcode);
          if (a.street) parts.push(a.street);
          if (a.components) {
            for (const comp of a.components) {
              if (comp.value) parts.push(comp.value);
            }
          }
          return parts.some((p) => p.toLowerCase().includes(locLower));
        });
        if (!match) return false;
      }

      if (domainLower) {
        const match = emails.some((e) => {
          const at = e.address?.toLowerCase().split("@");
          return at && at.length > 1 && at[1].includes(domainLower);
        });
        if (!match) return false;
      }

      if (filters.birthdayMonth !== null) {
        const target = filters.birthdayMonth;
        const match = anniversaries.some((a) => a.kind === "birth" && getAnniversaryMonth(a.date) === target);
        if (!match) return false;
      }

      if (!lower) return true;
      const name = getContactDisplayName(c).toLowerCase();
      if (name.includes(lower)) return true;
      if (emails.some((e) => e.address?.toLowerCase().includes(lower))) return true;
      if (phones.some((p) => p.number?.toLowerCase().includes(lower))) return true;
      if (orgs.some((o) => o.name?.toLowerCase().includes(lower))) return true;
      return false;
    });
  }, [contacts, searchQuery, filters]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const nameA = getContactSortName(a, sortByLastName).toLowerCase();
      const nameB = getContactSortName(b, sortByLastName).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [filtered, sortByLastName]);

  const sortedIds = useMemo(() => sorted.map(c => c.id), [sorted]);

  // Group sorted contacts by first letter of the sort name (display name, or
  // surname when sorting by last name). Non-letter starters (digits, symbols,
  // empty) collect under "#" which sorts last.
  const groupedSections = useMemo(() => {
    const collator = new Intl.Collator(locale, { sensitivity: "base" });
    const groups = new Map<string, ContactCard[]>();
    for (const contact of sorted) {
      const name = getContactSortName(contact, sortByLastName).trim();
      const first = name.charAt(0);
      const letter = first && first.toLocaleUpperCase(locale).match(/\p{L}/u)
        ? first.toLocaleUpperCase(locale)
        : "#";
      const bucket = groups.get(letter);
      if (bucket) bucket.push(contact);
      else groups.set(letter, [contact]);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === "#") return 1;
        if (b === "#") return -1;
        return collator.compare(a, b);
      })
      .map(([letter, items]) => ({ letter, items }));
  }, [sorted, locale, sortByLastName]);

  const hasSelection = selectedContactIds.size > 0;
  const pluginContext = useMemo(() => ({ contactIds: [...selectedContactIds] }), [selectedContactIds]);
  const allSelected = sorted.length > 0 && sorted.every(c => selectedContactIds.has(c.id));

  // ---- Keyboard (R8): the list keys Mail and Files share --------------------
  // One row takes Tab (roving focus): the open contact, else the first.
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const cursorId = focusedId && sortedIds.includes(focusedId)
    ? focusedId
    : selectedContactId && sortedIds.includes(selectedContactId) ? selectedContactId : sortedIds[0] ?? null;
  const focusRow = useCallback((id: string) => {
    setFocusedId(id);
    const row = listRef.current?.querySelector<HTMLElement>(`[data-contact-id="${CSS.escape(id)}"]`);
    row?.focus();
    row?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable=true]")) return;
    const mod = e.ctrlKey || e.metaKey;
    const index = cursorId ? sortedIds.indexOf(cursorId) : -1;
    const contact = cursorId ? sorted.find((c) => c.id === cursorId) : undefined;
    const moveTo = (next: number, extend: boolean) => {
      if (sortedIds.length === 0) return;
      const id = sortedIds[Math.max(0, Math.min(sortedIds.length - 1, next))];
      focusRow(id);
      if (extend) onSelectRangeContacts(id, sortedIds);
      else if (!hasSelection) onSelectContact(id);
    };
    if (isContextMenuKey(e) && contact) {
      e.preventDefault();
      const row = listRef.current?.querySelector<HTMLElement>(`[data-contact-id="${CSS.escape(contact.id)}"]`);
      if (row) openContextMenuFrom(row, contact);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveTo(index + (e.key === "ArrowDown" ? 1 : -1), e.shiftKey);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      moveTo(e.key === "Home" ? 0 : sortedIds.length - 1, e.shiftKey);
    } else if (e.key === "Enter" && contact) {
      e.preventDefault();
      onSelectContact(contact.id);
    } else if (e.key === " " && contact) {
      e.preventDefault();
      onToggleSelection(contact.id);
    } else if (mod && e.code === "KeyA") {
      e.preventDefault();
      onSelectAll(sortedIds);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.altKey) {
      // Backspace deletes too (⌘⌫ on a Mac), as in Mail and Files.
      if (hasSelection) {
        e.preventDefault();
        onBulkDelete();
      } else if (contact) {
        e.preventDefault();
        onDeleteContact(contact);
      }
    } else if (e.key === "Escape") {
      if (hasSelection) {
        e.preventDefault();
        onClearSelection();
      } else if (searchQuery) {
        e.preventDefault();
        onSearchChange("");
      }
    }
  };

  // "/" goes to the search from anywhere in Contacts, as in Mail.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isAppShortcutBlocked(e) || isSingleKeyShortcutOff(e)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div data-memail-contacts-list="" className={cn("flex min-h-0 min-w-0 flex-col h-full", className)}>
      {/* Toolbar: select / search / filter */}
      <div className="shrink-0 border-b border-border bg-background">
        <div className="px-3 h-12 flex items-center">
          <div className="flex items-center gap-1 w-full">
            {onMenuClick && (
              <ToolbarButton label={t("open_categories")} onClick={onMenuClick}>
                <Menu />
              </ToolbarButton>
            )}
            <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">{t("title")}</h2>
            <ToolbarButton
              label={hasSelection ? (allSelected ? t("bulk.clear") : t("bulk.select_all")) : t("filters.select")}
              onClick={() => {
                if (hasSelection) {
                  if (allSelected) onClearSelection();
                  else onSelectAll(sortedIds);
                } else if (sortedIds.length > 0) {
                  const target = selectedContactId && sortedIds.includes(selectedContactId)
                    ? selectedContactId
                    : sortedIds[0];
                  onToggleSelection(target);
                }
              }}
              active={hasSelection}
            >
              {hasSelection ? <CheckSquare /> : <Square />}
            </ToolbarButton>
            {onPrint && (
              <ToolbarButton label={tCommon("print")} onClick={onPrint} className="hidden md:inline-flex">
                <Printer />
              </ToolbarButton>
            )}
            <PhoneHeaderActions below="md" menuItems={phoneMenuItems} />
          </div>
        </div>
        <div className="px-3 pb-3">
          <ToolbarSearch
            ref={searchRef}
            className="flex-1"
            placeholder={t("search_placeholder")}
            aria-label={t("search_placeholder")}
            autoComplete="off"
            shortcut="/"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onClear={() => { onSearchChange(""); searchRef.current?.focus(); }}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.stopPropagation();
              onSearchChange("");
            }}
            clearLabel={t("clear_search")}
            trailing={
              <ToolbarSearchAction
                ref={filtersTrigger}
                aria-controls={filtersOpen ? filtersId : undefined}
                aria-label={t("filters.toggle")}
                title={t("filters.toggle")}
                onClick={() => setFiltersOpen((v) => !v)}
                aria-expanded={filtersOpen}
                active={filtersOpen || activeFilters > 0}
              >
                <Filter className="w-4 h-4" />
                {!filtersOpen && activeFilters > 0 && (
                  <span className="absolute -top-1 -end-1 flex items-center justify-center w-4 h-4 text-[0.625rem] font-bold rounded-full bg-primary text-primary-foreground">
                    {activeFilters}
                  </span>
                )}
              </ToolbarSearchAction>
            }
          />
        </div>
      </div>

      {filtersOpen && (
        <section id={filtersId} role="region" aria-label={t("filters.title")}
          data-memail-contact-filters=""
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            closeFilters();
          }}
          className="shrink-0 overflow-y-auto border-b border-border bg-muted/20">
          <div className="px-4 pb-4 space-y-3">
            <div className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-2 border-b border-border bg-background px-4 py-2">
              <span className="text-sm font-medium text-foreground">{t("filters.title")}</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                >
                  <RotateCcw className="w-3 h-3 me-1" />
                  {t("filters.clear")}
                </Button>
                <IconButton label={t("filters.close")} onClick={closeFilters}>
                  <X />
                </IconButton>
              </div>
            </div>

            <div className="memail-contact-filter-fields grid gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("filters.organization")}</label>
                <Input
                  aria-label={t("filters.organization")}
                  value={filters.organization}
                  onChange={(e) => setFilters((f) => ({ ...f, organization: e.target.value }))}
                  placeholder={t("filters.organization_placeholder")}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("filters.job_title")}</label>
                <Input
                  aria-label={t("filters.job_title")}
                  value={filters.jobTitle}
                  onChange={(e) => setFilters((f) => ({ ...f, jobTitle: e.target.value }))}
                  placeholder={t("filters.job_title_placeholder")}
                  className="h-8 text-sm"
                />
              </div>
            </div>

            <div className="memail-contact-filter-fields grid gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("filters.location")}</label>
                <Input
                  aria-label={t("filters.location")}
                  value={filters.location}
                  onChange={(e) => setFilters((f) => ({ ...f, location: e.target.value }))}
                  placeholder={t("filters.location_placeholder")}
                  className="h-8 text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">{t("filters.email_domain")}</label>
                <Input
                  aria-label={t("filters.email_domain")}
                  value={filters.emailDomain}
                  onChange={(e) => setFilters((f) => ({ ...f, emailDomain: e.target.value }))}
                  placeholder={t("filters.email_domain_placeholder")}
                  className="h-8 text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">{t("filters.birthday_month")}</label>
              <select
                value={filters.birthdayMonth ?? ""}
                onChange={(e) => setFilters((f) => ({ ...f, birthdayMonth: e.target.value === "" ? null : Number(e.target.value) }))}
                className="h-8 w-full text-sm rounded-md border border-input bg-background px-2"
                aria-label={t("filters.birthday_month")}
              >
                <option value="">{t("filters.any_month")}</option>
                {monthNames.map((name, i) => (
                  <option key={i} value={i + 1}>{name}</option>
                ))}
              </select>
            </div>

            <div className="memail-contact-presence-fields grid gap-2">
              {([
                ["hasEmail", "filters.has_email", Mail],
                ["hasPhone", "filters.has_phone", Phone],
                ["hasPhoto", "filters.has_photo", ImageIcon],
              ] as const).map(([key, label, Icon]) => (
                <ContactPresenceFilter key={key} icon={<Icon className="h-3.5 w-3.5" />}
                  label={t(label)} value={filters[key]}
                  anyLabel={t("tabs.all")} yesLabel={tCommon("yes")} noLabel={tCommon("no")}
                  onChange={(value) => setFilters((current) => ({ ...current, [key]: value }))} />
              ))}
            </div>

            {/* Sort order (persisted setting, also on /settings/contacts) */}
            <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/50">
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                <ArrowDownAZ className="w-3.5 h-3.5" />
                {t("filters.sort_by")}
              </span>
              <ToggleChip
                icon={null}
                label={t("filters.sort_first_name")}
                value={sortByLastName ? null : true}
                onClick={() => updateSetting("sortContactsByLastName", false)}
              />
              <ToggleChip
                icon={null}
                label={t("filters.sort_last_name")}
                value={sortByLastName ? true : null}
                onClick={() => updateSetting("sortContactsByLastName", true)}
              />
            </div>
          </div>
        </section>
      )}

      {/* Bulk action bar */}
      {hasSelection && (
        // One line at any width: below 28rem the buttons show only their icons.
        <div className="@container px-3 py-1.5 border-b border-border bg-accent/30 flex items-center gap-1 flex-nowrap min-w-0">
          <button
            type="button"
            role="checkbox"
            aria-checked={allSelected ? true : "mixed"}
            aria-label={allSelected ? t("bulk.clear") : t("bulk.select_all")}
            title={allSelected ? t("bulk.clear") : t("bulk.select_all")}
            onClick={() => {
              if (allSelected) {
                onClearSelection();
              } else {
                onSelectAll(sortedIds);
              }
            }}
            className="p-1 rounded hover:bg-muted/50 transition-colors"
          >
            {allSelected ? (
              <CheckSquare className="w-4 h-4 text-primary" />
            ) : (
              <Square className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
          <span className="text-xs font-medium text-foreground whitespace-nowrap">
            {t("bulk.selected", { count: selectedContactIds.size })}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="xs" onClick={onBulkAddToGroup} aria-label={t("bulk.add_to_group")} title={t("bulk.add_to_group")} className="shrink-0">
            <Users className="w-3.5 h-3.5 @md:me-1" />
            <span className="hidden @md:inline">{t("bulk.add_to_group")}</span>
          </Button>
          {onMoveContacts && (
            <Button variant="ghost" size="xs" onClick={() => onMoveContacts([...selectedContactIds])} aria-label={t("address_books.move_to")} title={t("address_books.move_to")} className="shrink-0">
              <FolderInput className="w-3.5 h-3.5 @md:me-1" />
              <span className="hidden @md:inline">{t("address_books.move_to")}</span>
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={onBulkExport} disabled={exporting} aria-busy={exporting} aria-label={t("bulk.export")} title={t("bulk.export")} className="shrink-0">
            {exporting
              ? <Loader2 className="w-3.5 h-3.5 @md:me-1 animate-spin" />
              : <Download className="w-3.5 h-3.5 @md:me-1" />}
            <span className="hidden @md:inline">{exporting ? t("export.exporting") : t("bulk.export")}</span>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={onBulkDelete}
            aria-label={t("bulk.delete")}
            title={t("bulk.delete")}
            className="shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="w-3.5 h-3.5 @md:me-1" />
            <span className="hidden @md:inline">{t("bulk.delete")}</span>
          </Button>
          <PluginActions surface="contact-list-actions" context={pluginContext} />
          <IconButton label={t("bulk.clear")} onClick={onClearSelection}>
            <X />
          </IconButton>
        </div>
      )}

      {/* Contact list */}
      <div
        ref={listRef}
        role="listbox"
        aria-label={t("title")}
        aria-multiselectable
        onKeyDown={handleListKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {sorted.length === 0 && isLoading && !searchQuery && activeFilters === 0 ? (
          <div aria-hidden className="py-1" data-testid="contact-list-skeleton">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <div className="w-9 h-9 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="h-3.5 rounded bg-muted animate-pulse" style={{ width: `${45 + ((i * 29) % 35)}%` }} />
                  <div className="h-3 rounded bg-muted/70 animate-pulse" style={{ width: `${30 + ((i * 17) % 30)}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : sorted.length === 0 ? (
          searchQuery || activeFilters > 0 ? (
            <EmptyState
              compact
              icon={activeFilters > 0 && !searchQuery ? Filter : Search}
              title={searchQuery ? t("empty_search") : t("empty_filtered")}
              description={searchQuery ? t("empty_search_hint") : t("empty_filtered_hint")}
              actions={
                <>
                  {searchQuery && (
                    <Button variant="outline" size="sm" onClick={() => { onSearchChange(""); searchRef.current?.focus(); }}>
                      {t("clear_search")}
                    </Button>
                  )}
                  {activeFilters > 0 && (
                    <Button variant="outline" size="sm" onClick={() => { setFilters(EMPTY_FILTERS); searchRef.current?.focus(); }}>
                      <RotateCcw className="w-3.5 h-3.5 me-1" />
                      {t("filters.clear")}
                    </Button>
                  )}
                </>
              }
            />
          ) : (
            // The whole account is empty, or only the address book, category
            // or group on screen: each says so, and both offer New and Import.
            <EmptyState
              compact
              icon={BookUser}
              title={emptyView ? t("empty_view_title") : t("empty_state_title")}
              description={emptyView ? t("empty_view_hint") : t("empty_state_subtitle")}
              actions={
                <>
                  <Button size="sm" onClick={onCreateNew}>
                    <UserPlus className="w-4 h-4 me-1.5" />
                    {t("create_new")}
                  </Button>
                  {onImport && (
                    <Button variant="outline" size="sm" onClick={onImport}>
                      <Upload className="w-4 h-4 me-1.5" />
                      {t("import.title")}
                    </Button>
                  )}
                </>
              }
            />
          )
        ) : (
          (() => {
            const renderItem = (contact: ContactCard) => (
              <ContactListItem
                key={contact.id}
                contact={contact}
                isSelected={contact.id === selectedContactId}
                isChecked={selectedContactIds.has(contact.id)}
                hasSelection={hasSelection}
                isFocused={contact.id === cursorId}
                onFocus={() => setFocusedId(contact.id)}
                density={density}
                selectedContactIds={selectedContactIds}
                onClick={(e) => {
                  // The open contact counts as selected, as a clicked file does
                  // in Files: Ctrl/⌘+click and Shift+click build on it.
                  const startFromOpen = !hasSelection && !!selectedContactId
                    && selectedContactId !== contact.id && sortedIds.includes(selectedContactId);
                  if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    if (startFromOpen) onToggleSelection(selectedContactId);
                    onToggleSelection(contact.id);
                  } else if (e.shiftKey) {
                    e.preventDefault();
                    if (startFromOpen) onToggleSelection(selectedContactId);
                    onSelectRangeContacts(contact.id, sortedIds);
                  } else {
                    if (hasSelection) onClearSelection();
                    onSelectContact(contact.id);
                  }
                }}
                onCheckboxClick={(e) => {
                  e.stopPropagation();
                  onToggleSelection(contact.id);
                }}
                onContextMenu={(e, c) => { setMenuByTouch(false); openContextMenu(e, c); }}
                onLongPress={(row) => { setMenuByTouch(true); openContextMenuFrom(row, contact); }}
              />
            );
            return groupByLetter ? (
              <div>
                {groupedSections.map(({ letter, items }) => (
                  <section key={letter} role="group" aria-label={letter}>
                    <div aria-hidden className="sticky top-0 z-10 px-4 py-0.5 bg-background/90 backdrop-blur-sm text-[0.6875rem] font-medium text-muted-foreground">
                      {letter}
                    </div>
                    {items.map(renderItem)}
                  </section>
                ))}
              </div>
            ) : (
              <div>{sorted.map(renderItem)}</div>
            );
          })()
        )}
      </div>

      {printTitle != null && (
        <ContactListPrint
          title={printTitle}
          contacts={sorted}
          sections={groupByLetter ? groupedSections : null}
          searchQuery={searchQuery}
        />
      )}

      {contextMenu.data && (
        <ContactContextMenu
          contact={contextMenu.data}
          position={contextMenu.position}
          isOpen={contextMenu.isOpen}
          onClose={closeContextMenu}
          menuRef={menuRef}
          isMultiSelect={selectedContactIds.has(contextMenu.data.id)}
          selectedCount={selectedContactIds.size}
          onOpen={() => onSelectContact(contextMenu.data!.id)}
          onSelect={menuByTouch ? () => onToggleSelection(contextMenu.data!.id) : undefined}
          onEdit={() => onEditContact(contextMenu.data!.id)}
          onDelete={() => onDeleteContact(contextMenu.data!)}
          onAddToGroup={() => onAddContactToGroup(contextMenu.data!.id)}
          onCompose={onComposeContact ? () => onComposeContact(contextMenu.data!) : undefined}
          onDuplicate={onDuplicateContact ? () => onDuplicateContact(contextMenu.data!) : undefined}
          onMoveTo={onMoveContacts ? () => onMoveContacts([contextMenu.data!.id]) : undefined}
          onBatchMoveTo={onMoveContacts ? () => onMoveContacts([...selectedContactIds]) : undefined}
          onBatchExport={onBulkExport}
          onBatchAddToGroup={onBulkAddToGroup}
          onBatchDelete={onBulkDelete}
        />
      )}
    </div>
  );
}
