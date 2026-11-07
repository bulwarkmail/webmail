"use client";

// xenaxio step 118: small pieces the Projects section shares — initials of a
// person, a status chip, a modal frame and a picker of colleagues.
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { X } from "@/components/icons";
import { Input } from "@/components/ui/input";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { cn } from "@/lib/utils";
import { useXT } from "@/lib/xenaxio/i18n";
import { type CompanyPerson, usePeopleStore } from "@/lib/xenaxio/people";

const COLORS: Record<string, string> = {
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  green: "bg-green-600/15 text-green-700 dark:text-green-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  gray: "bg-muted text-muted-foreground",
};

export function StatusChip({ text, color }: { text: string; color?: string }) {
  return <span className={cn("inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium", COLORS[color ?? "gray"] ?? COLORS.gray)}>{text}</span>;
}

export function initials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

export function PersonBadge({ name, email, size = "sm" }: { name: string; email?: string; size?: "sm" | "md" }) {
  const person = usePeopleStore((s) => (email ? s.people.get(email.toLowerCase()) : undefined));
  const px = size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs";
  if (person?.avatarUrl) return <img src={person.avatarUrl} alt="" title={name} className={cn("shrink-0 rounded-full object-cover", px)} />;
  return (
    <span title={name} className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary", px)}>
      {initials(name)}
    </span>
  );
}

export function Modal({ open, title, onClose, children, wide = false }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const t = useXT();
  const id = useId();
  const ref = useFocusTrap({ isActive: open, onEscape: onClose, restoreFocus: true });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={cn("max-h-[90dvh] w-full overflow-y-auto rounded-t-xl border border-border bg-background p-4 shadow-xl sm:rounded-xl", wide ? "sm:max-w-2xl" : "sm:max-w-md")}
      >
        <div className="mb-3 flex items-center gap-2">
          <h2 id={id} className="min-w-0 flex-1 text-base font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={t("common.close")}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Colleagues of the company to choose from (by id); `exclude` are already in. */
export function PeoplePicker({ selected, onChange, exclude = [], single = false }: { selected: string[]; onChange: (ids: string[]) => void; exclude?: string[]; single?: boolean }) {
  const t = useXT();
  const people = usePeopleStore((s) => s.people);
  const load = usePeopleStore((s) => s.load);
  const [q, setQ] = useState("");
  useEffect(() => {
    void load();
  }, [load]);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return [...people.values()]
      .filter((p) => !exclude.includes(p.id))
      .filter((p) => words.every((w) => `${p.displayName} ${p.email}`.toLowerCase().includes(w)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [people, q, exclude]);
  const toggle = (p: CompanyPerson) => {
    if (single) onChange(selected.includes(p.id) ? [] : [p.id]);
    else onChange(selected.includes(p.id) ? selected.filter((x) => x !== p.id) : [...selected, p.id]);
  };
  return (
    <div className="space-y-2">
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("projects.people_search")} aria-label={t("projects.people_search")} />
      <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
        {list.map((p) => (
          <li key={p.id}>
            <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted">
              <input type={single ? "radio" : "checkbox"} checked={selected.includes(p.id)} onChange={() => toggle(p)} />
              <PersonBadge name={p.displayName} email={p.email} />
              <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
              <span className="hidden truncate text-xs text-muted-foreground sm:inline">{p.email}</span>
            </label>
          </li>
        ))}
        {list.length === 0 && <li className="px-2 py-2 text-sm text-muted-foreground">{t("projects.people_none")}</li>}
      </ul>
    </div>
  );
}

export const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";
