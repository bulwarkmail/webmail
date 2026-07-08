"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Search, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { ContactCard } from "@/lib/jmap/types";
import { getContactDisplayName, getContactPrimaryEmail } from "@/stores/contact-store";

interface ContactGroupFormProps {
  group?: ContactCard | null;
  individuals: ContactCard[];
  currentMemberIds?: string[];
  onSave: (name: string, memberIds: string[]) => Promise<void>;
  onCancel: () => void;
}

export function ContactGroupForm({
  group,
  individuals,
  currentMemberIds = [],
  onSave,
  onCancel,
}: ContactGroupFormProps) {
  const t = useTranslations("contacts");
  const isEditing = !!group;

  const [name, setName] = useState(
    group ? getContactDisplayName(group) : ""
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(currentMemberIds)
  );
  const [memberSearch, setMemberSearch] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredIndividuals = useMemo(() => {
    if (!memberSearch) return individuals;
    const lower = memberSearch.toLowerCase();
    return individuals.filter((c) => {
      const n = getContactDisplayName(c).toLowerCase();
      const e = getContactPrimaryEmail(c).toLowerCase();
      return n.includes(lower) || e.includes(lower);
    });
  }, [individuals, memberSearch]);

  const toggleMember = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedIds(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError(t("groups.name_required"));
      return;
    }

    setIsSaving(true);
    try {
      await onSave(name.trim(), Array.from(selectedIds));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("groups.save_failed"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border">
        <h2 className="text-lg font-semibold">
          {isEditing ? t("groups.edit") : t("groups.create")}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 px-3 py-2 rounded">
            {error}
          </div>
        )}

        <div>
          <label className="text-sm text-muted-foreground mb-1 block">
            {t("groups.name_label")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("groups.name_placeholder")}
            autoFocus
          />
        </div>

        <div>
          <label className="text-sm text-muted-foreground mb-2 block">
            {t("groups.members_label")} ({selectedIds.size})
          </label>
          <div className="relative mb-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t("groups.search_members")}
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              className="ps-9"
            />
          </div>

          <div className="border rounded-md max-h-64 overflow-y-auto divide-y divide-border">
            {filteredIndividuals.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground text-center">
                {t("empty_search")}
              </div>
            ) : (
              filteredIndividuals.map((contact) => {
                const cName = getContactDisplayName(contact);
                const cEmail = getContactPrimaryEmail(contact);
                const isSelected = selectedIds.has(contact.id);
                return (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => toggleMember(contact.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2.5 text-start transition-colors",
                      "hover:bg-muted",
                      isSelected && "bg-primary/5"
                    )}
                  >
                    <div className={cn(
                      "w-5 h-5 rounded border flex items-center justify-center flex-shrink-0 transition-colors",
                      isSelected
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-border"
                    )}>
                      {isSelected && <Check className="w-3 h-3" />}
                    </div>
                    <Avatar name={cName} email={cEmail} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{cName}</div>
                      {cEmail && (
                        <div className="text-xs text-muted-foreground truncate">{cEmail}</div>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {selectedIds.size > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {Array.from(selectedIds).map((id) => {
              const contact = individuals.find((c) => c.id === id);
              if (!contact) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-primary/10 text-primary"
                >
                  {getContactDisplayName(contact)}
                  <button
                    type="button"
                    onClick={() => toggleMember(id)}
                    className="hover:text-red-600 dark:hover:text-red-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
          {t("form.cancel")}
        </Button>
        <Button type="submit" disabled={isSaving}>
          {isSaving ? (isEditing ? t("form.updating") : t("form.creating")) : t("form.save")}
        </Button>
      </div>
    </form>
  );
}
