"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Search } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ContactAddress, ContactCard } from "@/lib/jmap/types";
import { memberKeys, planMerge, type MergePlan } from "@/lib/contacts/merge";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";

/** One line for an address, as its parts and separators say. */
export function addressLine(address: ContactAddress): string {
  const components = address.components ?? [];
  if (components.length > 0) {
    let out = "";
    let lastWasValue = false;
    for (const c of components) {
      if (c.kind === "separator") {
        out += c.value;
        lastWasValue = false;
        continue;
      }
      if (!c.value) continue;
      if (lastWasValue) out += address.defaultSeparator ?? ", ";
      out += c.value.replace(/\s*\n\s*/g, ", ");
      lastWasValue = true;
    }
    return out;
  }
  const legacy = [address.street, [address.postcode, address.locality].filter(Boolean).join(" "), address.region, address.country]
    .filter(Boolean).join(", ");
  return legacy || address.full || address.fullAddress || "";
}

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
  const [cards, setCards] = useState<ContactCard[] | null>(initialCards && initialCards.length > 1 ? initialCards : null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => (cards ? planMerge(cards) : null), [cards]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const suggestedIds = new Set(suggested.map((c) => c.id));
    return candidates
      .filter((c) => !suggestedIds.has(c.id))
      .filter((c) => !q || `${getContactDisplayName(c)} ${Object.values(c.emails ?? {}).map((e) => e.address).join(" ")}`.toLowerCase().includes(q))
      .slice(0, 200);
  }, [candidates, suggested, query]);

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
  const rows: Array<{ label: string; values: string[] }> = [
    { label: t("group_name"), values: [getContactDisplayName(r)].filter(Boolean) },
    { label: t("group_email"), values: Object.values(r.emails ?? {}).map((e) => e.address) },
    { label: t("group_phone"), values: Object.values(r.phones ?? {}).map((p) => p.number) },
    { label: t("group_adr_any"), values: Object.values(r.addresses ?? {}).map(addressLine).filter(Boolean) },
    {
      label: t("group_org"),
      values: [
        ...Object.values(r.organizations ?? {}).map((o) => [o.name, ...(o.units ?? []).map((u) => u.name)].filter(Boolean).join(", ")),
        ...Object.values(r.titles ?? {}).map((ti) => ti.name),
      ].filter(Boolean),
    },
    { label: t("t_web"), values: Object.values(r.onlineServices ?? {}).map((s) => s.uri || s.user || "").filter(Boolean) },
    { label: t("t_notes"), values: Object.values(r.notes ?? {}).map((n) => n.note).filter(Boolean) },
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

  const otherNames = plan.others.map((c) => getContactDisplayName(c) || getContactPrimaryEmail(c) || "-").join(", ");

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
                  <div key={i} className={cn("break-words", row.label === t("t_notes") && "whitespace-pre-line")}>{value}</div>
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
