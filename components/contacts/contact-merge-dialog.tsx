"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatAddressLines } from "@/lib/address-format";
import { formatContactDate } from "@/lib/contact-dates";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { memberKeys, planMerge, type MergePlan } from "@/lib/contacts/merge";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";

/** Lines of one value, shown with whitespace-pre-line. */
const NEWLINE = String.fromCharCode(10);

interface ContactMergeDialogProps {
  /** Two or more cards: the dialog opens on what the merge keeps. */
  cards?: ContactCard[];
  /** "Merge with…": the other card is picked first. */
  pickFor?: ContactCard;
  /** What can be picked: cards of the same account that can be changed. */
  candidates?: ContactCard[];
  /** Likely duplicates of `pickFor`, listed first. */
  suggested?: ContactCard[];
  /** All groups, to show the ones the kept card will be in. */
  groups: ContactCard[];
  onMerge: (plan: MergePlan) => Promise<boolean>;
  onClose: () => void;
}

function PickRow({ card, onPick }: { card: ContactCard; onPick: () => void }) {
  const name = getContactDisplayName(card);
  const email = getContactPrimaryEmail(card);
  return (
    <button
      type="button"
      onClick={onPick}
      className="w-full flex flex-col items-start px-3 py-2 text-start hover:bg-muted transition-colors"
    >
      <span className="text-sm font-medium truncate max-w-full">{name || email || "-"}</span>
      {name && email && <span className="text-xs text-muted-foreground truncate max-w-full">{email}</span>}
    </button>
  );
}

/** "Merge with…" and "Merge…": pick the other card if needed, then show what stays before merging. */
export function ContactMergeDialog({ cards: initialCards, pickFor, candidates = [], suggested = [], groups, onMerge, onClose }: ContactMergeDialogProps) {
  const t = useTranslations("ux_pim_cimport");
  const tc = useTranslations("contacts");
  const tm = useTranslations("ux_p2_pim_cm");
  const locale = useLocale();
  const [cards, setCards] = useState<ContactCard[] | null>(initialCards && initialCards.length > 1 ? initialCards : null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => (cards ? planMerge(cards) : null), [cards]);
  const collator = useMemo(() => new Intl.Collator(locale, { sensitivity: "base", numeric: true }), [locale]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const suggestedIds = new Set(suggested.map((c) => c.id));
    return candidates
      .filter((c) => !suggestedIds.has(c.id))
      .filter((c) => !q || `${getContactDisplayName(c)} ${Object.values(c.emails ?? {}).map((e) => e.address).join(" ")}`.toLowerCase().includes(q))
      // By name, as the contact list sorts, in the UI language's order.
      .sort((a, b) => collator.compare(getContactDisplayName(a) || getContactPrimaryEmail(a) || "", getContactDisplayName(b) || getContactPrimaryEmail(b) || ""))
      .slice(0, 200);
  }, [candidates, suggested, query, collator]);

  if (!plan) {
    const name = pickFor ? getContactDisplayName(pickFor) || getContactPrimaryEmail(pickFor) : "";
    const pick = (card: ContactCard) => { if (pickFor) setCards([pickFor, card]); };
    return (
      <Dialog
        isOpen
        onClose={onClose}
        title={t("pick_title", { name })}
        footer={<Button variant="outline" onClick={onClose}>{tc("form.cancel")}</Button>}
      >
        <div className="space-y-3 pt-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("pick_search")}
              aria-label={t("pick_search")}
              className="ps-8"
            />
          </div>
          <div className="border rounded-md max-h-80 overflow-y-auto divide-y divide-border" data-testid="merge-pick-list">
            {suggested.length > 0 && !query.trim() && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-muted-foreground bg-muted/40">{t("pick_suggested")}</div>
                {suggested.map((card) => <PickRow key={card.id} card={card} onPick={() => pick(card)} />)}
              </div>
            )}
            {filtered.length > 0 && (
              <div>
                {suggested.length > 0 && !query.trim() && (
                  <div className="px-3 py-1 text-xs font-medium text-muted-foreground bg-muted/40">{t("pick_all")}</div>
                )}
                {filtered.map((card) => <PickRow key={card.id} card={card} onPick={() => pick(card)} />)}
              </div>
            )}
            {filtered.length === 0 && (suggested.length === 0 || query.trim()) && (
              <p className="px-3 py-6 text-sm text-center text-muted-foreground">{t("pick_none")}</p>
            )}
          </div>
        </div>
      </Dialog>
    );
  }

  const r = plan.result;
  const keys = new Set([plan.keep, ...plan.others].flatMap(memberKeys));
  const groupNames = groups
    .filter((g) => Object.entries(g.members ?? {}).some(([k, on]) => on && keys.has(k)))
    .map((g) => getContactDisplayName(g))
    .filter(Boolean);
  const rows: Array<{ label: string; values: string[]; multiline?: boolean }> = [
    { label: t("group_name"), values: [getContactDisplayName(r)].filter(Boolean) },
    { label: t("group_email"), values: Object.values(r.emails ?? {}).map((e) => e.address) },
    { label: t("group_phone"), values: Object.values(r.phones ?? {}).map((p) => p.number) },
    // Laid out as the card shows it ("Hauptstraße 5" / "10115 Berlin"), not the parts in stored order.
    { label: t("group_adr_any"), values: Object.values(r.addresses ?? {}).map((a) => formatAddressLines(a, locale).join(NEWLINE)).filter(Boolean), multiline: true },
    {
      label: t("group_org"),
      values: [
        ...Object.values(r.organizations ?? {}).map((o) => [o.name, ...(o.units ?? []).map((u) => u.name)].filter(Boolean).join(", ")),
        ...Object.values(r.titles ?? {}).map((ti) => ti.name),
      ].filter(Boolean),
    },
    { label: t("t_nickname"), values: Object.values(r.nicknames ?? {}).map((n) => n.name).filter(Boolean) },
    // Every date the kept card will have, each under its own name ("Birthday").
    ...(["birth", "wedding", "death", "other"] as const).map((kind) => ({
      label: tc(`detail.anniversary_${kind}`),
      values: Object.values(r.anniversaries ?? {}).filter((a) => a.kind === kind && a.date).map((a) => formatContactDate(a.date, locale)),
    })),
    {
      label: tc("detail.gender"),
      values: [
        r.speakToAs?.grammaticalGender ? tc(`detail.gender_${r.speakToAs.grammaticalGender}`, { defaultValue: r.speakToAs.grammaticalGender }) : "",
        ...Object.values(r.speakToAs?.pronouns ?? {}).map((p) => p.pronouns),
      ].filter(Boolean),
    },
    { label: tc("detail.language_label"), values: Object.values(r.preferredLanguages ?? {}).map((l) => l.language).filter(Boolean) },
    { label: tc("detail.personal_info"), values: Object.values(r.personalInfo ?? {}).map((pi) => pi.value).filter(Boolean) },
    { label: t("t_web"), values: Object.values(r.onlineServices ?? {}).map((s) => s.uri || s.user || "").filter(Boolean) },
    { label: tm("merge_links"), values: [...Object.values(r.links ?? {}), ...Object.values(r.directories ?? {})].map((l) => l.uri).filter(Boolean) },
    { label: tc("detail.calendar_uri"), values: Object.values(r.calendars ?? {}).map((c) => c.uri).filter(Boolean) },
    { label: tc("detail.scheduling_uri"), values: Object.values(r.schedulingAddresses ?? {}).map((c) => c.uri).filter(Boolean) },
    { label: tc("detail.related_contacts"), values: Object.keys(r.relatedTo ?? {}) },
    { label: tc("detail.crypto_keys"), values: Object.keys(r.cryptoKeys ?? {}).length > 0 ? [tm("merge_kept")] : [] },
    { label: tm("merge_photo"), values: Object.keys(r.media ?? {}).length > 0 ? [tm("merge_kept")] : [] },
    { label: t("t_notes"), values: Object.values(r.notes ?? {}).map((n) => n.note).filter(Boolean), multiline: true },
    { label: t("t_categories"), values: Object.keys(r.keywords ?? {}).filter((k) => r.keywords?.[k]) },
    { label: t("groups"), values: groupNames },
  ].filter((row) => row.values.length > 0);

  const merge = async () => {
    setBusy(true);
    try {
      if (await onMerge(plan)) onClose();
    } finally {
      setBusy(false);
    }
  };

  // Merged cards often share the name: then the address says which one goes (pim-p3-17).
  const keptName = getContactDisplayName(plan.keep);
  const otherNames = plan.others.map((c) => {
    const name = getContactDisplayName(c);
    const email = getContactPrimaryEmail(c);
    if (!name) return email || "-";
    return name === keptName && email ? `${name} (${email})` : name;
  }).join(", ");

  return (
    <Dialog
      isOpen
      onClose={busy ? () => {} : onClose}
      title={t("preview_title", { count: plan.others.length + 1 })}
      description={t("preview_hint")}
      size="lg"
      footer={
        <>
          {pickFor && !initialCards && (
            <Button variant="outline" onClick={() => setCards(null)} disabled={busy} className="me-auto">{t("back")}</Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={busy}>{tc("form.cancel")}</Button>
          <Button onClick={() => void merge()} disabled={busy}>{busy ? t("merging") : t("merge")}</Button>
        </>
      }
    >
      <div className="space-y-3 pt-4" data-testid="merge-preview">
        <dl className="border rounded-md divide-y divide-border max-h-96 overflow-y-auto">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[8rem_1fr] gap-3 px-3 py-2 text-sm">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0">
                {row.values.map((value, i) => (
                  <div key={i} className={cn("break-words", row.multiline && "whitespace-pre-line")}>{value}</div>
                ))}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted-foreground">{t("preview_deleted", { names: otherNames })}</p>
      </div>
    </Dialog>
  );
}
